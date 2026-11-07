/**
 * Centurion terminal backend v1 — `LegionSupervisor` over an `hc` terminal.
 *
 * Contract: `docs/contracts/centurion-terminal-backend-v1.md` (frozen).
 *
 * What this backend is: the transport for the ONE role that holds a worktree.
 * A terminal-hosted centurion is a real `pi` TUI inside `hc`, so it appears in
 * the window, can be attached, and can be interrupted without losing context.
 * Everything else — arbitration, worktree creation, verdict reading — stays
 * where it was; this module only replaces how the child is run.
 *
 * Boundaries this file keeps (D12): no event stream, no in-flight-tool read, no
 * blocked forwarding, no transcript re-scoping. Absence is the honest answer,
 * so those surface members are simply not implemented.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { formatChildTask } from "../extension/child-guard.ts";
import { buildPiArgs } from "../runs/args.ts";
import { ensureHostExtensions } from "../runs/extension-inheritance.ts";
import { TEMP_OWNER_FILE, writeOwnerFile } from "../runs/owner.ts";
import { childMemoryEnv } from "./child-memory.ts";
import { defaultPiCliPath } from "./rpc-supervisor.ts";
import { raceWithTimeout } from "./race-timeout.ts";
import { hcCliClient, HcRpcError, type HcClient } from "../hc/client.ts";
import { ErrorCodes, SubagentError, unknownChildError } from "../shared/types.ts";
import {
	DEFAULT_ABORT_TIMEOUT_MS,
	MAX_ABORT_TIMER_DELAY_MS,
	type AbortOutcome,
	type ChildHandle,
	type LegionSupervisor,
	type SettleResult,
	type SpawnInput,
	type SteerDisposition,
	type UsageSnapshot,
} from "./types.ts";

/** Both markers must be present for the host to be `hc` (D2). */
export const HC_TERMINAL_SOCKET_ENV = "HC_TERMINAL_SOCKET";
export const HC_TERMINAL_ID_ENV = "HC_TERMINAL_ID";

/** Parent space label copied so the child lands in the same window space (D6). */
export const HERDR_SPACE_LABEL = "herdr.space";

/** Labels every terminal child carries (D6). */
export const LEGION_ROLE_LABEL = "legion.role";
export const LEGION_RUN_LABEL = "legion.run";

/** `hc` requires 1–32 chars of `[a-z0-9_-]`, unique among live terminals (D7). */
export const TERMINAL_NAME_MAX = 32;
/** Name prefix every legion terminal carries. */
export const TERMINAL_NAME_PREFIX = "lgl";
/** Characters `hc` accepts in a terminal name; everything else becomes `-`. */
const ILLEGAL_NAME_CHARS = /[^a-z0-9_-]/g;

/** Poll cadence for `waitSettled` (D8). */
export const SETTLE_POLL_INTERVAL_MS = 1_000;

/** Parent terminal identity is forwarded to the child when present (D5). */
const TERMINAL_IDENTITY_ENV_KEYS = ["TERM", "TERM_PROGRAM", "COLORTERM"] as const;

/**
 * Is this process running inside an `hc` terminal? (D2)
 *
 * Exactly two env markers, both non-empty. Deliberately ZERO cost: no
 * subprocess, no socket probe, no git call. A launch-path probe here would make
 * `test/unit/launch-worktree-probe.test.ts` count a `git` that does not exist
 * (I3) and would put a fork on the hot launch path for every centurion.
 */
export function terminalHostAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	const socket = env[HC_TERMINAL_SOCKET_ENV];
	const id = env[HC_TERMINAL_ID_ENV];
	return typeof socket === "string" && socket.trim().length > 0 &&
		typeof id === "string" && id.trim().length > 0;
}

/**
 * Map one character class into what `hc` accepts (D7): lowercase, then every
 * remaining character outside `[a-z0-9_-]` becomes `-`.
 *
 * Uppercase is lower-cased rather than replaced because it is a case mapping,
 * not an illegal character: `Centurion` must not degrade to `-enturion`.
 */
export function sanitizeTerminalNamePart(value: string): string {
	return value.toLowerCase().replace(ILLEGAL_NAME_CHARS, "-");
}

/**
 * `<runId>-<handle>` → `lgl-<runId8>-<sanitized handle>`, total ≤ 32 (D7).
 *
 * The result is the ONLY name later `send`/`get`/`interrupt`/`kill`/`rm` calls
 * use, so it is computed once per child and stored on its record. Without a
 * runId the mapping degrades to `lgl-<handle>` instead of inventing one — the
 * runId is an input fact, never a guess (see {@link TerminalSupervisorOptions.runId}).
 */
export function terminalName(runId: string | undefined, handle: string): string {
	const run = sanitizeTerminalNamePart(runId ?? "").slice(0, 8);
	const prefix = run.length > 0 ? `${TERMINAL_NAME_PREFIX}-${run}-` : `${TERMINAL_NAME_PREFIX}-`;
	const room = Math.max(1, TERMINAL_NAME_MAX - prefix.length);
	// `hc` refuses an empty name; a handle made entirely of illegal characters
	// still has to become a usable one.
	const body = sanitizeTerminalNamePart(handle).slice(0, room) || "child";
	return `${prefix}${body}`.slice(0, TERMINAL_NAME_MAX);
}

/** Minimal shape of the core's `Terminal` / `RunResult` (what this backend reads). */
interface HcTerminalFacts {
	address?: string;
	name?: string | null;
	/** `"live"` or `"finished"`. */
	state?: string;
	/** Goes up each time the status leaves `working`. */
	turn?: number;
	status?: { state?: string } | null;
	labels?: Record<string, string>;
	pid?: number | null;
	exit_code?: number | null;
}

interface HcSendResult {
	turn?: number;
	started?: boolean | null;
	status?: string | null;
}

interface TerminalChildRecord {
	/** Legion registry key (the orchestrator's node name). */
	readonly name: string;
	/** `hc` terminal name — the only name later calls use (D7). */
	readonly terminalName: string;
	tempDir?: string;
	state: "live" | "finished" | "retired";
	/** Last observed turn counter. */
	turn: number;
	/** Last observed 7501 status word (`idle`, `working`, `done`, …). */
	statusState?: string;
	/** Turn the newest prompt belongs to (D8 settle gate). */
	promptTurn: number;
	retirePromise?: Promise<void>;
}

export interface TerminalSupervisorOptions {
	/**
	 * Test seam: build the protocol client. Production spawns `hc connect`.
	 *
	 * Injected fakes are the reason the unit tests never touch a real core.
	 */
	clientFactory?: () => HcClient;
	/** Environment read for host detection, parent identity and PATH/HOME (D5). */
	env?: NodeJS.ProcessEnv;
	/**
	 * Value for the `legion.run` label (D6), when the caller knows it.
	 *
	 * Omitted when unknown: a run id is a fact, and this backend will not derive
	 * one from a path or a node name. The wiring in `index.ts` has no run id at
	 * supervisor-construction time, so the label is simply absent there.
	 */
	runId?: string;
	/** Poll cadence for `waitSettled`; tests shrink it, production uses 1 s. */
	pollIntervalMs?: number;
	/** Per-call `hc` request bound. */
	requestTimeoutMs?: number;
}

/**
 * The terminal backend.
 *
 * Registration and lifetime follow the RPC backend's rules so the orchestrator
 * cannot tell them apart: one record per name, `isAlive` until retired, `retire`
 * idempotent. What differs is the truth behind each fact — a turn counter
 * reported by the program itself instead of an event stream we never receive.
 */
export class TerminalSupervisor implements LegionSupervisor {
	/**
	 * `terminal.send` cannot tell "a run started" from "it was queued behind the
	 * current one"; the send reports both as a turn boundary deposit (D10). So the
	 * backend does not claim a disposition distinction.
	 */
	readonly capabilities = { promptDisposition: false } as const;

	private readonly children = new Map<string, TerminalChildRecord>();
	private readonly clientFactory: () => HcClient;
	private readonly env: NodeJS.ProcessEnv;
	private readonly runId: string | undefined;
	private readonly pollIntervalMs: number;
	private client: HcClient | undefined;
	/** Parent space label; `null` = not read yet, `undefined` = no space known. */
	private parentSpace: string | null | undefined = null;

	constructor(options: TerminalSupervisorOptions = {}) {
		this.env = options.env ?? process.env;
		this.runId = options.runId;
		this.pollIntervalMs = options.pollIntervalMs ?? SETTLE_POLL_INTERVAL_MS;
		this.clientFactory =
			options.clientFactory ??
			(() => hcCliClient({ env: this.env, ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}) }));
	}

	// ── spawn (D4/D5/D6/D7) ─────────────────────────────────────────────

	async spawnChild(input: SpawnInput): Promise<ChildHandle> {
		// #280 parity with the rpc backend: the inherited `-e` set is read from the
		// warm discovery cache, and a cold cache yields a child with no provider
		// extension — i.e. status bar `0.0%/0` and never a turn (D4).
		await ensureHostExtensions();
		if (input.agent.kind !== "pi") {
			throw new SubagentError(
				`TerminalSupervisor only supports pi children (received kind '${input.agent.kind}'); migrate the role to kind: pi`,
				ErrorCodes.INVALID_PARAMS,
			);
		}
		const previous = this.children.get(input.name);
		if (previous && previous.state === "live") {
			throw new SubagentError(
				`child is already registered and alive: ${input.name}`,
				ErrorCodes.NAME_TAKEN,
			);
		}
		const client = await this.ensureClient();
		const terminalNameForChild = terminalName(this.runId, input.name);

		let tempDir: string | undefined;
		let argv: string[];
		try {
			// The system prompt is passed by file (0600), exactly like rpc. The task
			// is NOT written to a file: an hc terminal accepts a positional message,
			// and that is what starts turn 1 in the TUI (D4).
			const parentTempDir = path.resolve(input.tempDir);
			fs.mkdirSync(parentTempDir, { recursive: true });
			tempDir = fs.mkdtempSync(path.join(parentTempDir, "terminal-child-"));
			writeOwnerFile(path.join(tempDir, TEMP_OWNER_FILE));

			const {
				name: _name,
				cwd: _cwd,
				env: _env,
				cliPath: _cliPath,
				tempDir: _tempDir,
				stripLegionIdentity: _stripLegionIdentity,
				childLaunchContext: _childLaunchContext,
				...buildInput
			} = input;
			const built = buildPiArgs({ ...buildInput, tempDir, includeTask: false });
			const task = formatChildTask(input.task, {
				allowNested: input.allowNestedSubagents === true,
				...(input.worktreeBranch ? { worktreeBranch: input.worktreeBranch } : {}),
			});
			// `node <cli.js> <same flags as rpc> <task>`: the interpreter is the one
			// running this process, so the child never depends on `node` being on the
			// core's PATH; the flags are byte-identical to the rpc backend (D4).
			argv = [process.execPath, this.cliPath(input), ...built.args, task];
		} catch (error) {
			this.removeTempDir(tempDir);
			throw error;
		}

		const params = {
			name: terminalNameForChild,
			argv,
			cwd: input.cwd,
			env: this.childEnv(input),
			labels: await this.childLabels(input),
			...(this.caller ? { caller: this.caller } : {}),
		};

		let run: HcTerminalFacts;
		try {
			run = await this.runTerminal(client, params, terminalNameForChild);
		} catch (error) {
			this.removeTempDir(tempDir);
			throw this.failure("terminal.run", terminalNameForChild, error);
		}

		// An address in the reply is the proof the terminal really started. Later
		// calls address the child by its mapped NAME (D7) — the address is hc's own
		// stable id, and v1 keeps exactly one handle per child.
		const address = typeof run.address === "string" ? run.address : "";
		if (address.length === 0) {
			this.removeTempDir(tempDir);
			throw new SubagentError(
				`terminal.run for '${terminalNameForChild}' returned no address`,
				ErrorCodes.START_FAILED,
			);
		}
		const turn = normalizedTurn(run.turn);
		// D7: the mapping is the only handle later calls use. The core may report
		// the name it actually created (it shortens an over-long or colliding one),
		// so the returned name wins over the requested one when present.
		const mappedName =
			typeof run.name === "string" && run.name.length > 0 ? run.name : terminalNameForChild;
		const record: TerminalChildRecord = {
			name: input.name,
			terminalName: mappedName,
			...(tempDir ? { tempDir } : {}),
			state: "live",
			turn,
			...(typeof run.status?.state === "string" ? { statusState: run.status.state } : {}),
			// D8: the task is delivered as argv, not through `terminal.send`, so the
			// turn the task belongs to is the one observed at launch (0 at boot).
			// The boot-time `turn == promptTurn, idle` reading therefore never settles.
			promptTurn: turn,
		};
		this.children.set(input.name, record);
		return {
			name: input.name,
			sessionFile: input.sessionFile,
			...(typeof run.pid === "number" ? { pid: run.pid } : {}),
		};
	}

	// ── prompt / steer / followUp (D10) ─────────────────────────────────

	async prompt(name: string, text: string): Promise<void> {
		await this.sendText(this.requireChild(name), text);
	}

	/**
	 * A send lands at the child's next turn boundary (verified in the spike): the
	 * weak, always-true disposition is `"queued"`. Claiming `"accepted"` would
	 * need a distinction this backend cannot observe (D10 / #323 D1).
	 */
	async steer(name: string, text: string): Promise<SteerDisposition> {
		await this.sendText(this.requireChild(name), text);
		return "queued";
	}

	async followUp(name: string, text: string): Promise<void> {
		await this.sendText(this.requireChild(name), text);
	}

	private async sendText(child: TerminalChildRecord, text: string): Promise<void> {
		const client = await this.ensureClient();
		// D8: refresh and record the turn the text belongs to BEFORE it goes in, so
		// a settle can never be satisfied by the turn that was already over.
		await this.observe(child);
		child.promptTurn = child.turn;
		const result = await client.request<HcSendResult>("terminal.send", {
			terminal: child.terminalName,
			text,
			...(this.caller ? { caller: this.caller } : {}),
		});
		// The send reports the turn it landed in; it is never lower than what we
		// saw, and it is the more precise of the two readings.
		const sentTurn = normalizedTurn(result?.turn);
		if (sentTurn > child.promptTurn) child.promptTurn = sentTurn;
		child.state = "live";
	}

	// ── abort (D10) ─────────────────────────────────────────────────────

	/**
	 * `terminal.interrupt` = Esc: the process survives, its context survives, its
	 * turn counter advances.
	 *
	 * `clearQueued` is NOT supported and is never claimed: `cleared` stays all
	 * zeros whatever the caller asked for, because this transport has no queue
	 * primitive to call (D10).
	 */
	async abort(
		name: string,
		opts?: { clearQueued?: boolean; timeoutMs?: number },
	): Promise<AbortOutcome> {
		const child = this.requireChild(name);
		const requested = opts?.timeoutMs;
		const bound = Math.min(
			Number.isFinite(requested) && (requested as number) > 0
				? (requested as number)
				: DEFAULT_ABORT_TIMEOUT_MS,
			MAX_ABORT_TIMER_DELAY_MS,
		);
		// A stale `working` reading must not manufacture a turn: ask the core now. A
		// terminal the core no longer knows is not running a turn either, so it is
		// `no-turn` — nothing is done, nothing is interrupted.
		try {
			await this.observe(child);
		} catch (error) {
			if (isNotFound(error)) {
				return { status: "no-turn", cleared: { steering: 0, followUp: 0 }, timeoutMs: bound };
			}
			throw this.failure("terminal.get", child.terminalName, error);
		}
		if (child.statusState !== "working") {
			return { status: "no-turn", cleared: { steering: 0, followUp: 0 }, timeoutMs: bound };
		}
		const client = await this.ensureClient();
		const work = client
			.request("terminal.interrupt", {
				terminal: child.terminalName,
				// `hc` counts its observation window in seconds; the caller's bound is
				// the ceiling that matters, so the observation is capped by it.
				timeout: Math.max(1, Math.ceil(bound / 1000)),
			})
			.then((): "interrupted" => "interrupted");
		const status = await raceWithTimeout<"interrupted" | "timeout">(work, bound, () => "timeout");
		if (status === "interrupted") {
			// The interrupt left `working`; the next turn boundary is not known yet,
			// so stop claiming one until the next observation says otherwise.
			child.statusState = undefined;
		}
		return { status, cleared: { steering: 0, followUp: 0 }, timeoutMs: bound };
	}

	// ── settle (D8) ─────────────────────────────────────────────────────

	/**
	 * Poll `terminal.get` until the turn the prompt belongs to is over.
	 *
	 * Settled means `turn > promptTurn && status.state === "done"`, or the
	 * terminal itself is `finished`. The spike's trap is the reason for the turn
	 * gate: at startup `hc` reports `turn 0, idle`, which is a fact about boot,
	 * not about the task. A timeout resolves
	 * `{settled:false, abnormal:false, reason:"timeout"}` — it throws nothing and
	 * kills nothing.
	 */
	async waitSettled(
		name: string,
		timeoutMs = 900_000,
		signal?: AbortSignal,
	): Promise<SettleResult> {
		const child = this.requireChild(name);
		if (signal?.aborted) {
			return { settled: false, abnormal: false, reason: "aborted by parent" };
		}
		const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
			? Date.now() + timeoutMs
			: Number.POSITIVE_INFINITY;
		for (;;) {
			let facts: HcTerminalFacts;
			try {
				facts = await this.readTerminal(child);
			} catch (error) {
				if (isNotFound(error)) {
					child.state = "finished";
					return { settled: false, abnormal: true, reason: "terminal not found" };
				}
				throw this.failure("terminal.get", child.terminalName, error);
			}
			this.applyFacts(child, facts);
			if (facts.state === "finished") {
				return {
					settled: true,
					abnormal: false,
					...(typeof facts.exit_code === "number" ? { exitCode: facts.exit_code } : {}),
				};
			}
			if (child.turn > child.promptTurn && facts.status?.state === "done") {
				return { settled: true, abnormal: false };
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				return { settled: false, abnormal: false, reason: "timeout" };
			}
			const interrupted = await this.sleep(Math.min(this.pollIntervalMs, remaining), signal);
			if (interrupted) {
				return { settled: false, abnormal: false, reason: "aborted by parent" };
			}
		}
	}

	// ── liveness / stats / retire (D11) ─────────────────────────────────

	isAlive(name: string): boolean {
		const child = this.children.get(name);
		return child !== undefined && child.state === "live";
	}

	/**
	 * No usage facts travel over this channel (D12): `null` is the honest answer,
	 * and both callers already treat it as "unknown".
	 */
	async stats(_name: string): Promise<UsageSnapshot | null> {
		return null;
	}

	/**
	 * End the terminal (D11): kill the program, then remove the terminal record
	 * best-effort so it does not linger in `hc ls --all` forever. The `rm` path
	 * never throws — a kill that already succeeded must not be reported as a
	 * failed retire.
	 */
	retire(name: string, _opts: { graceful?: boolean } = {}): Promise<void> {
		const child = this.requireChild(name);
		if (child.retirePromise) return child.retirePromise;
		const pending = this.retireChild(child);
		child.retirePromise = pending;
		void pending.catch(() => {
			if (child.retirePromise === pending) child.retirePromise = undefined;
		});
		return pending;
	}

	private async retireChild(child: TerminalChildRecord): Promise<void> {
		const client = await this.ensureClient();
		try {
			await client.request("terminal.kill", {
				terminal: child.terminalName,
				...(this.caller ? { caller: this.caller } : {}),
			});
		} catch (error) {
			// A terminal the core no longer knows is already gone; anything else is
			// a real failure to end the child and must surface.
			if (!isNotFound(error)) throw this.failure("terminal.kill", child.terminalName, error);
		}
		try {
			await client.request("terminal.rm", {
				terminal: child.terminalName,
				...(this.caller ? { caller: this.caller } : {}),
			});
		} catch {
			/* D11: best effort — a killed terminal that cannot be removed is not an error */
		}
		child.state = "retired";
		this.removeTempDir(child.tempDir);
	}

	// ── internals ───────────────────────────────────────────────────────

	private async ensureClient(): Promise<HcClient> {
		try {
			if (!this.client) this.client = this.clientFactory();
			await this.client.start();
		} catch (error) {
			throw new SubagentError(
				`cannot reach the hc core: ${error instanceof Error ? error.message : String(error)}`,
				ErrorCodes.START_FAILED,
			);
		}
		return this.client;
	}

	/** The parent terminal's address, when this process runs inside one. */
	private get caller(): string | undefined {
		const id = this.env[HC_TERMINAL_ID_ENV];
		const trimmed = typeof id === "string" ? id.trim() : "";
		return trimmed.length > 0 ? trimmed : undefined;
	}

	/** `HC_BIN` is honoured by the client; `PI_SUBAGENT_CLI`/host argv decide pi. */
	private cliPath(input: SpawnInput): string {
		return input.cliPath ? path.resolve(input.cliPath) : defaultPiCliPath();
	}

	/**
	 * Environment overlay for `terminal.run` (D5).
	 *
	 * `terminal.run` merges this over the core's environment, and the core's PATH
	 * is only `/usr/local/bin:/usr/bin` — no `node` — so the parent's PATH is
	 * passed explicitly. Then memory flags, then `input.env` last: lineage,
	 * identity, phases and budgets are facts the orchestrator just computed and
	 * nothing here may overwrite them.
	 */
	private childEnv(input: SpawnInput): Record<string, string> {
		const env: Record<string, string> = {};
		const parentPath = this.env.PATH;
		if (typeof parentPath === "string" && parentPath.length > 0) env.PATH = parentPath;
		const home = this.env.HOME;
		if (typeof home === "string" && home.length > 0) env.HOME = home;
		for (const key of TERMINAL_IDENTITY_ENV_KEYS) {
			const value = this.env[key];
			if (typeof value === "string" && value.length > 0) env[key] = value;
		}
		// `childMemoryEnv` reports `undefined` to mean "remove"; `terminal.run` can
		// only ADD to the core's environment, so a removal is dropped rather than
		// sent as a bogus value.
		for (const [key, value] of Object.entries(childMemoryEnv(this.env))) {
			if (typeof value === "string") env[key] = value;
		}
		for (const [key, value] of Object.entries(input.env ?? {})) {
			if (typeof value === "string") env[key] = value;
		}
		// `stripLegionIdentity` deletes keys (an rpc env can remove); `terminal.run`
		// only ADDS. It cannot occur here in practice — the only stripped dispatch is
		// vexillatio, and the arbitration reaches `terminal` for centurions only
		// (D1) — so v1 inherits rather than pretending the keys were removed.
		return env;
	}

	/**
	 * Labels that make the child visible next to its parent (D6): the parent's
	 * `herdr.space` (read once per supervisor, cached), the role, and the run
	 * when one is known. `herdr.tab` is deliberately NOT copied — each child gets
	 * its own tab.
	 */
	private async childLabels(input: SpawnInput): Promise<Record<string, string>> {
		const labels: Record<string, string> = { [LEGION_ROLE_LABEL]: input.agent.name };
		if (this.runId !== undefined && this.runId.length > 0) {
			labels[LEGION_RUN_LABEL] = this.runId;
		}
		const space = await this.parentSpaceLabel();
		if (space !== undefined) labels[HERDR_SPACE_LABEL] = space;
		return labels;
	}

	/**
	 * Read `herdr.space` off the parent terminal, once.
	 *
	 * Both outcomes are cached: a parent with no space is a fact like any other,
	 * and re-reading it per child would put a round trip on every launch. A failed
	 * read also caches "no space" — inventing a label would be worse than a child
	 * that stays hidden.
	 */
	private async parentSpaceLabel(): Promise<string | undefined> {
		if (this.parentSpace !== null) return this.parentSpace;
		const parent = this.caller;
		if (parent === undefined) {
			this.parentSpace = undefined;
			return undefined;
		}
		try {
			const client = await this.ensureClient();
			const facts = await client.request<HcTerminalFacts>("terminal.get", { terminal: parent });
			const space = facts?.labels?.[HERDR_SPACE_LABEL];
			this.parentSpace = typeof space === "string" && space.length > 0 ? space : undefined;
		} catch {
			this.parentSpace = undefined;
		}
		return this.parentSpace;
	}

	/**
	 * `terminal.run` with the one documented retry (D7): a *finished* terminal may
	 * still hold the name; remove it and try once more. A live holder is a real
	 * conflict and becomes `NAME_TAKEN`.
	 */
	private async runTerminal(
		client: HcClient,
		params: Record<string, unknown>,
		name: string,
	): Promise<HcTerminalFacts> {
		try {
			return await client.request<HcTerminalFacts>("terminal.run", params);
		} catch (error) {
			if (!isNameTaken(error)) throw error;
			let holder: HcTerminalFacts | undefined;
			try {
				holder = await client.request<HcTerminalFacts>("terminal.get", { terminal: name });
			} catch {
				holder = undefined;
			}
			if (holder?.state !== "finished") {
				throw new SubagentError(
					`terminal name '${name}' is already taken by a live terminal`,
					ErrorCodes.NAME_TAKEN,
				);
			}
			try {
				await client.request("terminal.rm", {
					terminal: name,
					...(this.caller ? { caller: this.caller } : {}),
				});
			} catch {
				/* the retry below reports the real failure */
			}
			try {
				return await client.request<HcTerminalFacts>("terminal.run", params);
			} catch (retryError) {
				if (isNameTaken(retryError)) {
					throw new SubagentError(
						`terminal name '${name}' is already taken`,
						ErrorCodes.NAME_TAKEN,
					);
				}
				throw retryError;
			}
		}
	}

	private async readTerminal(child: TerminalChildRecord): Promise<HcTerminalFacts> {
		const client = await this.ensureClient();
		return client.request<HcTerminalFacts>("terminal.get", { terminal: child.terminalName });
	}

	/** Read the core's current view of a child and fold it into the record. */
	private async observe(child: TerminalChildRecord): Promise<void> {
		const facts = await this.readTerminal(child);
		this.applyFacts(child, facts);
	}

	private applyFacts(child: TerminalChildRecord, facts: HcTerminalFacts): void {
		child.turn = normalizedTurn(facts.turn);
		if (typeof facts.status?.state === "string") child.statusState = facts.status.state;
		if (facts.state === "finished") child.state = "finished";
	}

	private requireChild(name: string): TerminalChildRecord {
		const child = this.children.get(name);
		if (!child) throw unknownChildError(name);
		return child;
	}

	/** Wrap a transport failure so callers see one error vocabulary. */
	private failure(operation: string, terminal: string, error: unknown): Error {
		if (error instanceof SubagentError) return error;
		const detail =
			error instanceof HcRpcError
				? `${error.kind}: ${error.message}`
				: error instanceof Error
					? error.message
					: String(error);
		return new SubagentError(
			`${operation} failed for terminal '${terminal}': ${detail}`,
			ErrorCodes.START_FAILED,
		);
	}

	private removeTempDir(tempDir: string | undefined): void {
		if (!tempDir) return;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* a leftover temp dir is cleaned by the startup sweep via its owner file */
		}
	}

	/** Sleep `ms`, resolving `true` early when the caller's signal aborts. */
	private sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
		return new Promise((resolve) => {
			if (signal?.aborted) {
				resolve(true);
				return;
			}
			const timer = setTimeout(() => {
				cleanup();
				resolve(false);
			}, Math.max(0, ms));
			const onAbort = (): void => {
				cleanup();
				resolve(true);
			};
			const cleanup = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}

function normalizedTurn(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isNameTaken(error: unknown): boolean {
	return error instanceof HcRpcError && error.kind === "name_taken";
}

function isNotFound(error: unknown): boolean {
	return error instanceof HcRpcError && error.kind === "not_found";
}
