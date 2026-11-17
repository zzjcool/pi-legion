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
import { LEGION_IDENTITY_ENV_KEYS, buildPiArgs } from "../runs/args.ts";
import { ensureHostExtensions } from "../runs/extension-inheritance.ts";
import { TEMP_OWNER_FILE, writeOwnerFile } from "../runs/owner.ts";
import {
	ensureRemoteDir,
	mapRemoteArgPath,
	mirrorRemoteFile,
	normalizeHost,
	remoteDirFor,
	remotePreflight,
	terminalAddress,
	type HostTarget,
} from "../runs/remote.ts";
import {
	createRemoteChildWorktree,
	provisionRemoteWorktree,
	remotePathIsDirectory,
	removeRemoteChildWorktree,
} from "../runs/remote-worktree.ts";
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
/**
 * The machine a remote terminal runs on (cross-machine contract D8).
 *
 * Only a remote child carries it: a local child's labels stay exactly as they
 * were, so adding "which machine" to a window label cannot change a local
 * launch. It replaces `herdr.space` on the remote side — a bare space id belongs
 * to the PARENT's document and would only create an orphan label there.
 */
export const LEGION_HOST_LABEL = "legion.host";

/**
 * Parent facts that must not be projected onto another machine (D7).
 *
 * `terminal.run`'s `env` is an overlay (merge-only, no delete), so these are
 * never added in the first place; on the remote branch the overlay is built
 * from scratch and this list is also applied as a delete, so an `input.env`
 * that carries one of them cannot smuggle it across either.
 */
const PARENT_ENV_KEYS = ["PATH", "HOME", "TERM", "TERM_PROGRAM", "COLORTERM"] as const;
/**
 * Legion facts that describe THIS machine's ledger, not the child's.
 *
 * `PI_LEGION_CHILD_EXTENSIONS` is the one exception: it is a request to the
 * child about which extensions to load, not a path into this host's state.
 */
const LEGION_ENV_PREFIX = "PI_LEGION_";
const REMOTE_KEPT_LEGION_ENV = "PI_LEGION_CHILD_EXTENSIONS";

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
	/**
	 * Worktree the child really got, and the machine that owns it (S2/D13).
	 *
	 * Recorded here as well as on the handle: a `retire`/`resume` in this process
	 * must be able to say which machine the path belongs to without reading the
	 * parent's ledger back.
	 */
	worktreePath?: string;
	worktreeBranch?: string;
	worktreeHost?: string;
	/**
	 * Machine the terminal runs on; absent = this host.
	 *
	 * Kept on the record because every later call (`get`/`send`/`interrupt`/
	 * `kill`/`rm`) must address a remote terminal as `host/name`; the bare name is
	 * unique per core, not across machines (contract D2).
	 */
	host?: string;
	/**
	 * The mirrored temp dir on `host` (D9), when this is a remote child.
	 *
	 * Recorded so an operator (and `legion-doctor`) can find the files a remote
	 * child was pointed at. `retire` does NOT delete it: the same posture as a
	 * worktree or a session file — a finished child leaves its evidence behind.
	 */
	remoteDir?: string;
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
		// Absent/blank = this host (contract D4). Normalized ONCE here: `on`, the
		// record and every later address all read this one value.
		const host = normalizeHost(input.host);
		// A named host without a resolved target is unreachable through the public API
		// (the orchestrator refuses it, D1) and there is no correct fallback: the
		// target carries the remote cwd, the remote programs and the preflight.
		// Half-crossing — sending `on` with THIS machine's argv, env and cwd — is the
		// exact shape D6/D7 forbid, so it is refused here too rather than existing as
		// a silent second mode nobody declared.
		if (host !== undefined && input.hostTarget === undefined) {
			throw new SubagentError(
				`host '${host}': the terminal backend needs a resolved target (cwd, node, piCli); resolve it with resolveHostTarget() and pass hostTarget`,
				ErrorCodes.INVALID_PARAMS,
				{ host },
			);
		}
		// The resolved target is what makes a named host ACTUALLY remote: the
		// remote cwd, the remote interpreter/CLI and the preflight all come from it
		// (`resolveHostTarget` in `../runs/remote.ts`).
		const target: HostTarget | undefined = host !== undefined ? input.hostTarget : undefined;
		const remote = target !== undefined;

		// D11: a remote worktree is created ON THAT MACHINE, by the only layer that
		// holds both the `hc` client and the target. It runs BEFORE the preflight
		// because the preflight's `cd -- <cwd>` cannot tell "no checkout" from "no
		// program" (the spike's constraint): `createRemoteChildWorktree` asks the
		// three questions in an order that can name the failing one, and the
		// preflight still covers `node`/`pi` afterwards. A launch that ASKS for a
		// tree (createWorktree) must never fall through to the bare checkout: the
		// child would then write into the checkout its own parent reads.
		let remoteWorktree: { path: string; branch: string } | undefined;
		let createdRemoteWorktree = false;
		if (target !== undefined) {
			const requested = typeof input.worktreePath === "string" ? input.worktreePath.trim() : "";
			if (requested.length > 0) {
				// Resume (D17): the tree either still exists or the branch is all that
				// survived. Nothing is rebuilt automatically, and the existence check is
				// explicit here because `terminal.run`'s own error cannot distinguish a
				// missing cwd from a missing program (constraint 4).
				if (!(await remotePathIsDirectory(client, target, requested))) {
					throw new SubagentError(
						`host '${target.host}': worktree ${requested} does not exist on that machine (branch ${input.worktreeBranch ?? "<unknown>"} may still hold the work; fetch it from origin or retire the node)`,
						ErrorCodes.START_FAILED,
						{ host: target.host, worktreePath: requested },
					);
				}
				remoteWorktree = { path: requested, branch: input.worktreeBranch ?? "" };
			} else if (input.createWorktree === true) {
				try {
					const tree = await createRemoteChildWorktree({
						client,
						target,
						name: input.name,
						// The local checkout is what "one shared remote" is checked against.
						localRepo: input.cwd,
					});
					remoteWorktree = { path: tree.path, branch: tree.branch };
					createdRemoteWorktree = true;
				} catch (error) {
					throw this.failure("remote worktree", host ?? target.host, error);
				}
			}
		}

		// D11: the rollback that pairs with the tree created above. Best effort by
		// design: this runs on a failure path, and a cleanup error must never replace
		// the reason the launch actually failed.
		const rollbackRemoteWorktree = async (): Promise<void> => {
			if (!createdRemoteWorktree || target === undefined || remoteWorktree === undefined) return;
			const treePath = remoteWorktree.path;
			try {
				await removeRemoteChildWorktree({ client, target, path: treePath });
			} catch (error) {
				// Diagnostic only — the original failure is what the caller sees.
				process.stderr.write(
					`[pi-legion] host '${target.host}': could not roll back worktree ${treePath}: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			}
		};

		// D6/D9: prove the target can host this launch, and refuse rather than send
		// a parent path or a relative cwd. Runs BEFORE `terminal.run` so a bad cwd
		// never creates a terminal nobody can use.
		if (target !== undefined) {
			try {
				await remotePreflight(client, target);
			} catch (error) {
				await rollbackRemoteWorktree();
				throw this.failure("remote preflight", host ?? target.host, error);
			}
		}

		// D11: provision the remote tree here, because the orchestrator's
		// `provisionWorktree()` runs `bash -lc` on THIS machine and the tree is on
		// the other one. Same mode, same command parser, same idempotency marker.
		if (target !== undefined && remoteWorktree !== undefined && createdRemoteWorktree) {
			try {
				await provisionRemoteWorktree({
					client,
					target,
					worktreePath: remoteWorktree.path,
					...(input.worktreeBootstrap !== undefined ? { mode: input.worktreeBootstrap } : {}),
					...(input.worktreeBootstrapTimeoutMs !== undefined
						? { timeoutMs: input.worktreeBootstrapTimeoutMs }
						: {}),
				});
			} catch (error) {
				await rollbackRemoteWorktree();
				throw this.failure("remote worktree bootstrap", host ?? target.host, error);
			}
		}

		let tempDir: string | undefined;
		let remoteDir: string | undefined;
		let argv: string[];
		try {
			// The system prompt is passed by file (0600), exactly like rpc. The task
			// is NOT written to a file: an hc terminal accepts a positional message,
			// and that is what starts turn 1 in the TUI (D4).
			//
			// D9: this dir is the PARENT's cleanup right (owner file + startup sweep)
			// and is never migrated. A remote child gets a SECOND dir (below) that the
			// file copies land in.
			const parentTempDir = path.resolve(input.tempDir);
			fs.mkdirSync(parentTempDir, { recursive: true });
			tempDir = fs.mkdtempSync(path.join(parentTempDir, "terminal-child-"));
			writeOwnerFile(path.join(tempDir, TEMP_OWNER_FILE));

			if (target !== undefined) {
				remoteDir = remoteDirFor(target, this.runId, input.name);
				await ensureRemoteDir(client, target, remoteDir);
			}

			const {
				name: _name,
				cwd: _cwd,
				env: _env,
				cliPath: _cliPath,
				tempDir: _tempDir,
				stripLegionIdentity: _stripLegionIdentity,
				childLaunchContext: _childLaunchContext,
				// `host` is transport, not argv: it reaches the wire as `on` below and
				// must never leak into `buildPiArgs`. The resolved target is transport
				// too — `cwd`/`node`/`piCli` are read from it, never rebuilt here. The
				// worktree fields are the backend's own instructions (D11) and are
				// consumed above, so none of them may reach the argv builder either.
				host: _host,
				hostTarget: _hostTarget,
				worktree: _worktree,
				createWorktree: _createWorktree,
				worktreePath: _worktreePath,
				worktreeBootstrap: _worktreeBootstrap,
				worktreeBootstrapTimeoutMs: _worktreeBootstrapTimeoutMs,
				...buildInput
			} = input;

			// D6: EVERY parent-absolute path in `argv` is rewritten, because none of
			// them exists on the other machine. The session file is its own case (it
			// is not under the temp dir and must keep a name the child will write);
			// everything else keeps its basename inside the remote dir, which is
			// where the mirrored copies land.
			const remoteDirPath = remoteDir;
			const rewritePath = target !== undefined && remoteDirPath !== undefined
				? (absolutePath: string): string =>
					absolutePath === input.sessionFile
						? path.posix.join(remoteDirPath, "session.jsonl")
						: path.posix.join(remoteDirPath, path.posix.basename(absolutePath))
				: undefined;
			const built = buildPiArgs({
				...buildInput,
				tempDir,
				includeTask: false,
				...(rewritePath ? { pathRewrite: rewritePath } : {}),
			});
			if (target !== undefined && rewritePath !== undefined) {
				// Only the files THIS builder wrote are mirrored: they are the ones whose
				// names are already in `argv` (`system-prompt.md`, an oversized task).
				for (const localFile of built.tempFiles) {
					const remoteFile = rewritePath(localFile);
					if (remoteFile === localFile) continue;
					await mirrorRemoteFile(client, target, localFile, remoteFile);
				}
			}
			// The branch the child is told to commit on. For a remote tree it is the one
			// THIS launch just created (`worktree add -b` on that machine), which the
			// parent did not know until now (D11/D12).
			const branchForTask = remoteWorktree?.branch || input.worktreeBranch;
			const task = formatChildTask(input.task, {
				allowNested: input.allowNestedSubagents === true,
				...(branchForTask ? { worktreeBranch: branchForTask } : {}),
				// D10/D12: on another machine the branch is the DELIVERY, not a
				// convenience: the parent can only read it through the shared origin,
				// so the appendix says "push it" instead of "do not push".
				...(remote ? { remoteDelivery: true } : {}),
			});
			if (target !== undefined && rewritePath !== undefined && remoteDirPath !== undefined) {
				// D6's closing rule: NO parent-absolute path may survive, and none may be
				// mapped to a path that will not exist. Two classes are mappable:
				//
				//   - files this builder wrote (already rewritten into the mirrored dir);
				//   - paths inside this checkout, which the other machine has at ITS root
				//     (the git-remote delivery model: same content, different root).
				//
				// Anything else (`-e <plugin install>/index.ts`, `--skill <path>`) points
				// at a file that is not in the checkout and is not mirrored, so rewriting
				// it would hand the remote child a path to nothing. Refuse by name.
				argv = [
					target.node,
					target.piCli,
					...built.args.map((arg) => mapRemoteArgPath({
						arg,
						host: target.host,
						// A remote worktree child reads ITS tree, not the bare checkout:
						// the git-remote model says both machines hold the same content,
						// and the tree is this launch's copy of it.
						remoteCwd: remoteWorktree?.path ?? target.cwd,
						remoteDir: remoteDirPath,
						localCwd: input.cwd,
						pathMap: target.pathMap,
					})),
					task,
				];
			} else {
				// `node <cli.js> <same flags as rpc> <task>`: the interpreter is the one
				// running this process, so the child never depends on `node` being on the
				// core's PATH; the flags are byte-identical to the rpc backend (D4).
				argv = [process.execPath, this.cliPath(input), ...built.args, task];
			}
		} catch (error) {
			this.removeTempDir(tempDir);
			await rollbackRemoteWorktree();
			throw error;
		}

		const params = {
			name: terminalNameForChild,
			argv,
			// D6/D11: a remote child starts in the REMOTE directory — its own tree when
			// one was created for it, the target's checkout otherwise. It is never
			// `this.cwd` and never a local path that happens to exist here.
			cwd: target !== undefined ? remoteWorktree?.path ?? target.cwd : input.cwd,
			env: this.childEnv(input, remote ? host : undefined),
			labels: await this.childLabels(input, remote ? host : undefined),
			// Constraint 5: `caller` is a BARE terminal name in THIS core's
			// namespace. A remote terminal lives in another one, where that id either
			// does not exist or names somebody else's terminal — so a remote request
			// never carries it.
			...(this.callerFor(host) !== undefined ? { caller: this.callerFor(host) } : {}),
			// The ONE machine dimension crossing the wire (contract D2): legion says
			// `host`, `hc` says `on`. Absent ⇒ the key is absent, so the params are
			// byte-identical to the local launch (D4).
			...(host ? { on: host } : {}),
		};

		let run: HcTerminalFacts;
		try {
			run = await this.runTerminal(client, params, terminalAddress({ terminalName: terminalNameForChild, ...(host ? { host } : {}) }), host);
		} catch (error) {
			this.removeTempDir(tempDir);
			await rollbackRemoteWorktree();
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
		// D13: the ownership pair, in one value, so the record and the handle cannot
		// disagree about which machine a path belongs to.
		const worktreeFacts = remoteWorktree !== undefined && target !== undefined
			? {
				worktreePath: remoteWorktree.path,
				worktreeBranch: remoteWorktree.branch,
				worktreeHost: target.host,
			}
			: {};
		const record: TerminalChildRecord = {
			name: input.name,
			terminalName: mappedName,
			...(host ? { host } : {}),
			...(remoteDir ? { remoteDir } : {}),
			...(tempDir ? { tempDir } : {}),
			...worktreeFacts,
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
			// S2: the tree the BACKEND created comes back the same way `pid` does —
			// the orchestrator could not know this path before the spawn.
			...worktreeFacts,
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
		try {
			await this.observe(child);
		} catch (error) {
			// #392 (D392-6): the OTHER way a terminal ends. `retire()` kills and then
			// removes the record, so the core's answer to the next `terminal.get` is
			// `not_found`, not a `finished` reading — the guard below can never see it.
			// A terminal the core no longer knows is as ended as one that says so, so
			// it takes the same refusal instead of leaking a raw transport error. Only
			// this exact fact is rewritten: a protocol/transport failure keeps its own
			// shape, because rewriting it as "the child is over" would hide an
			// infrastructure problem behind a lifecycle verdict (the `abort` and
			// `waitSettled` calls fold `not_found` the same way).
			if (!isNotFound(error)) throw error;
			// `waitSettled` makes the same fold: gone from the core means terminal here.
			// `retired` is the more specific fact when the record already has it.
			if (child.state !== "retired") child.state = "finished";
			throw terminalChildError(child);
		}
		// #392 (D392-1): a terminal child that has already ended takes no new text.
		// `observe` just reported the truth — a `send` would go into a program that
		// is gone, `child.state` would be flipped back to `live` below, and the
		// settle that follows would read a last turn with no assistant message and
		// turn a legal `finished` into an `aborted` verdict (which retires the node
		// and refuses every later resume). Refuse here, before the send, and leave
		// the record saying what the core said: `finished`/`retired` are terminal
		// for this transport, so the answer is a new child, not a send.
		if (child.state === "finished" || child.state === "retired") {
			throw terminalChildError(child);
		}
		child.promptTurn = child.turn;
		const result = await client.request<HcSendResult>("terminal.send", {
			terminal: terminalAddress(child),
			text,
			...(this.callerFor(child.host) !== undefined ? { caller: this.callerFor(child.host) } : {}),
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
				terminal: terminalAddress(child),
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
		const address = terminalAddress(child);
		try {
			await client.request("terminal.kill", {
				terminal: address,
				...(this.callerFor(child.host) !== undefined ? { caller: this.callerFor(child.host) } : {}),
			});
		} catch (error) {
			// A terminal the core no longer knows is already gone; anything else is
			// a real failure to end the child and must surface.
			if (!isNotFound(error)) throw this.failure("terminal.kill", address, error);
		}
		try {
			await client.request("terminal.rm", {
				terminal: address,
				...(this.callerFor(child.host) !== undefined ? { caller: this.callerFor(child.host) } : {}),
			});
		} catch {
			/* D11: best effort — a killed terminal that cannot be removed is not an error */
		}
		child.state = "retired";
		// D9: the parent temp dir is ours to remove; the mirrored remote copy is
		// not (same posture as a child's worktree/session — it stays put).
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

	/**
	 * `caller`, but only for a request that addresses a terminal in THIS core's
	 * namespace (cross-machine constraint 5).
	 *
	 * A `caller` is a BARE terminal name, resolved by the core that receives the
	 * request. The remote core never heard of this process's terminal, so sending
	 * it there either fails the call or — worse — names an unrelated terminal on
	 * that machine. Absent host ⇒ unchanged local behaviour.
	 */
	private callerFor(host: string | undefined): string | undefined {
		return normalizeHost(host) === undefined ? this.caller : undefined;
	}

	/** `HC_BIN` is honoured by the client; `PI_SUBAGENT_CLI`/host argv decide pi. */
	private cliPath(input: SpawnInput): string {
		return input.cliPath ? path.resolve(input.cliPath) : defaultPiCliPath();
	}

	/**
	 * Environment overlay for `terminal.run` (D5 / cross-machine D7).
	 *
	 * LOCAL (today's order, byte for byte): `terminal.run` merges this over the
	 * core's environment, and the core's PATH is only `/usr/local/bin:/usr/bin` —
	 * no `node` — so the parent's PATH is passed explicitly. Then memory flags,
	 * then `input.env` last: lineage, identity, phases and budgets are facts the
	 * orchestrator just computed and nothing here may overwrite them.
	 *
	 * REMOTE: that reasoning inverts. The other machine's core already has its own
	 * login environment (its own PATH/HOME/TERM), so projecting the parent's is
	 * wrong on every count — a parent `/usr/bin/node` need not exist there, and a
	 * parent HOME points at a directory that machine does not have. The overlay is
	 * therefore built from nothing but the memory flags and the caller's own
	 * `input.env`, then stripped of (a) the parent-only keys above and (b) legion
	 * identity: those are paths into THIS host's ledger, and `hc`'s `env` is
	 * merge-only, so sending them would either create a forked root node there or
	 * point a remote child at a database it cannot open.
	 */
	private childEnv(input: SpawnInput, host: string | undefined): Record<string, string> {
		const env: Record<string, string> = {};
		if (host !== undefined) {
			for (const [key, value] of Object.entries(childMemoryEnv(this.env))) {
				if (typeof value === "string") env[key] = value;
			}
			for (const [key, value] of Object.entries(input.env ?? {})) {
				if (typeof value === "string") env[key] = value;
			}
			for (const key of PARENT_ENV_KEYS) delete env[key];
			for (const key of LEGION_IDENTITY_ENV_KEYS) delete env[key];
			// The memory companion key (`PI_LEGION_HOST_NODE_OPTIONS`) is a parent
			// fact like the rest of the prefix: it exists so a LOCAL child restores
			// the host's NODE_OPTIONS. One exception survives, because it is an
			// instruction to the child rather than a path into this host's state.
			for (const key of Object.keys(env)) {
				if (key.startsWith(LEGION_ENV_PREFIX) && key !== REMOTE_KEPT_LEGION_ENV) delete env[key];
			}
			return env;
		}
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
	 * Labels that make the child visible next to its parent (D6 / cross-machine
	 * D8): the parent's `herdr.space` (read once per supervisor, cached), the
	 * role, and the run when one is known. `herdr.tab` is deliberately NOT copied
	 * — each child gets its own tab.
	 *
	 * A REMOTE child gets no space label at all: a bare space id belongs to this
	 * machine's document, so on the other machine it would only be an orphan
	 * label pointing at a space that does not exist there. It carries
	 * `legion.host` instead, which is true on both sides. No `terminal.get` is
	 * issued for the parent on this branch — there is nothing to ask for.
	 */
	private async childLabels(input: SpawnInput, host: string | undefined): Promise<Record<string, string>> {
		const labels: Record<string, string> = { [LEGION_ROLE_LABEL]: input.agent.name };
		if (this.runId !== undefined && this.runId.length > 0) {
			labels[LEGION_RUN_LABEL] = this.runId;
		}
		if (host !== undefined) {
			labels[LEGION_HOST_LABEL] = host;
			return labels;
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
	 *
	 * `address` is the request's `terminal` value for the get/rm probes, in the
	 * `host/name` form for a remote child (cross-machine contract §3.6): the bare
	 * name is unique per core, not across machines.
	 */
	private async runTerminal(
		client: HcClient,
		params: Record<string, unknown>,
		address: string,
		host?: string,
	): Promise<HcTerminalFacts> {
		const name = typeof params.name === "string" ? params.name : address;
		try {
			return await client.request<HcTerminalFacts>("terminal.run", params);
		} catch (error) {
			if (!isNameTaken(error)) throw error;
			let holder: HcTerminalFacts | undefined;
			try {
				holder = await client.request<HcTerminalFacts>("terminal.get", { terminal: address });
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
					terminal: address,
					...(this.callerFor(host) !== undefined ? { caller: this.callerFor(host) } : {}),
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
		return client.request<HcTerminalFacts>("terminal.get", { terminal: terminalAddress(child) });
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

/**
 * The refusal for a send to a terminal child that has already ended (#392).
 *
 * `CHILD_TERMINAL` is the code the ledger already uses for "this child is over"
 * (`CHILD_TERMINAL`, #309 D4) — reused rather than minted, so a caller can tell
 * a dead terminal from a transport failure (`START_FAILED`) or a missing child
 * (`NOT_FOUND`). The text names the child, the state the core reported and the
 * ways forward that actually exist; the code itself stays out of the message
 * (codes ride in `details.error`).
 *
 * D392-6/F4: the next step used to promise `resume` (refused for a terminal
 * ledger node: `orchestrator.ts:648-650`) or "launch a new child that reuses
 * its session" (`launch` has no `sessionFile` parameter). Both were undeliverable,
 * so the message says only what is true: the turn is over, the result that was
 * already produced can be read, and continuing the work means a NEW child.
 */
function terminalChildError(child: TerminalChildRecord): SubagentError {
	const state = child.state === "retired" ? "retired" : "finished";
	return new SubagentError(
		`child '${child.name}' is ${state}: its terminal has already ended (or the core no longer knows it), ` +
			"so the turn it was running is over and it can take no further text — nothing was sent. " +
			"Read the result it already produced (collect); if more work is needed, launch a new child — " +
			"a terminal child cannot be resumed.",
		ErrorCodes.CHILD_TERMINAL,
	);
}
