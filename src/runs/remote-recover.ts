/**
 * Session recovery for a cross-machine child (schema v5, `nodes.remote_dir` +
 * `nodes.remote_terminal`).
 *
 * The case this module exists for: a parent's launch ends — the process exits, a
 * headless run finishes, the user closes the session — while the child keeps
 * working on the OTHER machine. The next session has no in-memory handle on that
 * child at all (no supervisor entry, no run-store record worth trusting, no
 * `(host, terminalName)` pair), so `collect` cannot reach it and `/legion status`
 * shows a row nobody can act on. Adopting the child into a live supervisor is
 * deliberately NOT attempted here (that is S5's problem, and a half-adoption would
 * be a second process writing one child's ledger row).
 *
 * What recovery IS, and nothing more:
 *
 *   1. locate the row by name among the cross-machine rows this ledger holds;
 *   2. ask that machine two things at once — the transcript (`file.read`, through
 *      the EXISTING read-back seam in `remote-artifact.ts`) and the terminal
 *      (`terminal.get`, through `createRemoteTerminalProbe`);
 *   3. grade the transcript with `deriveOutcome` / `deriveAcceptance`, i.e. the
 *      exact rules `collect` uses, so a recovered verdict cannot differ from a
 *      collected one;
 *   4. settle the row (`settledStatusFor` + the same `node_settled` /
 *      `node_failed` / `node_retired` event a collect writes) so it stops
 *      advertising itself as a leftover.
 *
 * Three outcomes deliberately do NOT settle, because settling is a claim:
 *
 *   - a LIVE terminal over there (the work is not over — say so, write nothing);
 *   - a transcript that could not be read (`unknown` is not a verdict, and the
 *     render names the file plus the `hc exec --cat` line that fetches it);
 *   - a machine that could not be asked about the terminal (liveness unknown).
 *
 * The ledger is the only state this module reads and writes, which is what makes
 * it work from a process that never launched the child.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync, SqliteRow } from "../legion/db.ts";
import { legionDbPath, openLegionDb } from "../legion/db.ts";
import { appendEvent } from "../legion/events.ts";
import {
	hasEnded,
	listRemoteNodesNamed,
	listUnsettledRemoteNodes,
	sanitizeNodeSlug,
	updateNode,
	type LegionNode,
	type NodeStatus,
} from "../legion/nodes.ts";
import { orphanFateOf, orphanMarkFor, type OrphanFate } from "../legion/orphan.ts";
import { upsertUsage } from "../legion/usage.ts";
import { deriveOutcome, parseSessionFile, parseSessionText } from "../shared/session.ts";
import type { AcceptanceResult, CrossMachineSettings, Execution, ExecutionStatus } from "../shared/types.ts";
import { deriveAcceptance, settledStatusFor, transcriptNotRetrievedReason } from "./orchestrator.ts";
import type { RunStore } from "./store.ts";
import {
	createRemoteSessionReadback,
	createRemoteTerminalProbe,
	remoteMirrorPathFor,
	type RemoteReadbackResult,
	type RemoteSessionRequest,
	type RemoteTerminalProbe,
	type RemoteTerminalProbeRequest,
} from "./remote-artifact.ts";
import { normalizeHost } from "./remote.ts";
import { readOwnerFile, isPidAlive, RUN_OWNER_FILE } from "./owner.ts";
import { formatDuration } from "../extension/summary.ts";

/** The action name and the exact call a leftover is collected with. */
export const RECOVERY_ACTION = "recover";

/** `subagent({ action: "recover", name: "worker-0" })` — the one string a user copies. */
export function recoveryCallFor(name: string): string {
	return `subagent({ action: "recover", name: ${JSON.stringify(name)} })`;
}

/**
 * 6.2.5 / D1+D4: the ONE ownership block, shared by every surface that lists a
 * cross-machine leftover (`/legion status`'s block, `recover`'s headline, and
 * `recover`'s miss).
 *
 * Why one renderer: the three used to describe the same row differently, and the
 * block is where a human learns WHOSE leftover this is. Six facts were printed
 * and zero of them said which session, which checkout, or which run owned the
 * thing — the reader had a name and a machine and nothing else.
 *
 * The time facts are split on purpose (D1):
 *   - `launched` is `createdAt`, the launch moment. It is immutable, and it is
 *     the ONLY honest answer to "how old is this leftover";
 *   - `heartbeat` is `updatedAt`, the last write to the row. Hygiene's
 *     `markAbandoned` used to rewrite `updated_at` on every sweep, so an
 *     age computed from it reported "2m old" for something abandoned a week
 *     ago. As a heartbeat it is a perfectly good fact — as an age it was a lie.
 *
 * `owner pid` is the run dir's `owner.json`. `gone since <ISO>` is the last
 * heartbeat (the last moment anyone is known to have been alive there); it is a
 * bound derived from evidence, never a measured death time.
 */
export interface RemoteOwnershipFacts {
	name: string;
	nodeId: string;
	host: string;
	/** `orphaned` / `unfetched` / a node status (`running`, `failed`, …). */
	state: string;
	terminal?: string;
	launchedAt?: number;
	heartbeatAt?: number;
	runId?: string;
	cwd?: string;
	sessionFile?: string;
	ownerPid?: number;
	ownerAlive?: boolean;
	now: number;
}

/** The ownership block, as lines (no trailing newline). */
export function renderRemoteOwnershipBlock(facts: RemoteOwnershipFacts): string[] {
	const age = (at: number | undefined): string =>
		at === undefined || !Number.isFinite(at) ? "age unknown" : `${formatDuration(Math.max(0, facts.now - at))} old`;
	const iso = (at: number | undefined): string | undefined =>
		at === undefined || !Number.isFinite(at) ? undefined : new Date(at).toISOString();
	const launchedIso = iso(facts.launchedAt);
	const lines = [
		`- ${facts.name} · ${facts.nodeId} · host ${facts.host} · ${facts.state} · terminal ${facts.terminal ?? "(terminal not recorded)"}`,
		`  launched ${launchedIso ?? "(not recorded)"} (${age(facts.launchedAt)})  · run ${facts.runId ?? "(run not recorded)"} · cwd ${facts.cwd ?? "(cwd not recorded)"} · session ${facts.sessionFile ? path.basename(facts.sessionFile) : "(session not recorded)"}`,
	];
	if (facts.ownerPid !== undefined) {
		const heartbeatIso = iso(facts.heartbeatAt);
		lines.push(
			`  owner pid ${facts.ownerPid} (${facts.ownerAlive ? "alive" : `gone since ${heartbeatIso ?? "an unrecorded time"}`})`,
		);
	} else {
		lines.push("  owner pid (not recorded)");
	}
	if (facts.heartbeatAt !== undefined) {
		lines.push(`  heartbeat ${iso(facts.heartbeatAt) ?? "(not recorded)"} (${age(facts.heartbeatAt)})`);
	}
	lines.push(`  collect: ${recoveryCallFor(facts.name)}`);
	return lines;
}

/** The state word D4 freezes: the fate wins over the row status. */
export function recoveryStateWord(node: LegionNode & { orphaned?: "orphaned" | "unfetched" }): string {
	if (node.orphaned === "orphaned") return "orphaned";
	if (node.orphaned === "unfetched") return "unfetched";
	return node.status;
}

/**
 * One ledger a `recover` / `/legion status` call may read, and the run it belongs to.
 *
 * Read as a READER of the store, not as a root runtime: recovery needs the `nodes`
 * table and nothing else, so it deliberately does not become an
 * `OrchestratorLegionContext`/`LegionRuntimeIdentity` (no postman, no phase machine,
 * no tools, no second writer for one child).
 */
export interface RecoveryLedger {
	db: DatabaseSync;
	dbPath: string;
	runId: string;
}

/**
 * The store surface this module reads: `listRuns` + the two path helpers, spelled
 * structurally so a caller that only holds a `Pick<RunStore, …>` (the `recover` tool
 * call, a test double) fits without widening its own type.
 */
export type RecoveryStore = Pick<RunStore, "listRuns" | "runDir" | "rootDir">;

/**
 * Which ledger a `recover` call reads, in priority order (defect D1).
 *
 * The defect: `recover` used to read only the identity THIS process had created,
 * i.e. `ownLegionIdentity()` — which a fresh process does not have, because a root
 * runtime is created by a launch (`createRootLegion`/`reopenSessionRun`) and by
 * nothing else. So the one situation recovery exists for — the previous process is
 * GONE — was exactly the situation where it answered `No legion ledger in this
 * session`.
 *
 * The source of truth is therefore the STORE on disk, not this process's memory:
 *
 *  1. **this session's own run** (`run.sessionFile` === our transcript path): the
 *     reopen case, and the only one where the ledger is unambiguously "ours";
 *  2. **the newest other run in this store root** (`<cwd>/.pi-subagents/runs/*`)
 *     that holds a cross-machine row with this NAME — settled or not, so a second
 *     `recover` finds the same ledger and can answer `already settled`;
 *  3. nothing: no row anywhere in this store root has that name.
 *
 * Priority 2 is deliberately scoped to the store root, i.e. to this cwd: "a
 * leftover is the tree a PREVIOUS session of this conversation left behind", and a
 * different project's ledger is never consulted, adopted or written (invariant I1).
 *
 * #450: I1 is about ONE call never mixing two projects' rows, not about a session
 * seeing only one tree. A session that launched in `~/code/anotify` yesterday and
 * runs in `~/agents` today still owns that leftover — {@link findRecoveryLedgerAcrossStores}
 * is the same priority list widened to the bounded store surface, and the ledger it
 * finds is still the ONLY one written.
 */
export function findRecoveryLedgerForName(
	store: RecoveryStore,
	name: string,
	opts: { sessionFile?: string | undefined; ownRunOnly?: boolean } = {},
): RecoveryLedger | undefined {
	return findLedgerInStore(store, name, opts);
}

/**
 * The read half of {@link findRecoveryLedgerForName}, reused by the cross-store walk.
 *
 * `ownRunOnly` narrows the search to runs whose `run.json` names OUR transcript —
 * priority 1 without its fallback. That is what lets the cross-store lookup be
 * "our own run anywhere first, then any store's newest leftover with this name"
 * without a second copy of the open/query/close dance (a copy would eventually drift
 * on `sanitizeNodeSlug` or on closing a handle it did not take).
 */
function findLedgerInStore(
	store: RecoveryStore,
	name: string,
	opts: { sessionFile?: string | undefined; ownRunOnly?: boolean } = {},
): RecoveryLedger | undefined {
	const slug = sanitizeNodeSlug(name);
	const own = opts.sessionFile !== undefined ? path.resolve(opts.sessionFile) : undefined;
	// No transcript to match means no run can be "ours": the narrowed pass finds nothing
	// rather than silently widening to every run.
	if (opts.ownRunOnly === true && own === undefined) return undefined;
	for (const run of runsInRecoveryOrder(store, opts.sessionFile)) {
		if (opts.ownRunOnly === true) {
			if (run.sessionFile === undefined || path.resolve(run.sessionFile) !== own) continue;
		}
		const dbPath = path.resolve(legionDbPath(store.runDir(run.runId)));
		if (!fs.existsSync(dbPath)) continue;
		let db: DatabaseSync | undefined;
		try {
			db = openLegionDb(dbPath);
			if (listRemoteNodesNamed(db, slug).length === 0) {
				db.close();
				db = undefined;
				continue;
			}
			return { db, dbPath, runId: run.runId };
		} catch {
			// An unreadable ledger is not this call's verdict; keep looking.
			try { db?.close(); } catch { /* already closed */ }
		}
	}
	return undefined;
}

/** A ledger found under one of several stores, plus the store that owns it. */
export interface CrossStoreRecoveryLedger extends RecoveryLedger {
	/** The `rootDir` of the store holding this ledger — the run to reconcile with. */
	storeRoot: string;
}

/**
 * #450: {@link findRecoveryLedgerForName} over the bounded store surface
 * (`discoverLocalStores`), session store first.
 *
 * Two passes, and the order is the contract:
 *
 *  1. **a run whose `sessionFile` is OUR transcript, in any store.** This is the
 *     reopen case, and it must win everywhere: a name is reused across runs by
 *     design, so the run this process is continuing is the only one whose ledger is
 *     unambiguously ours, whichever directory it was launched from;
 *  2. **the first store (session store first, then discovery order) holding a
 *     ledger row with that name** — settled or not, so a second `recover` answers
 *     `already settled` about the SAME ledger instead of picking a fresher stranger.
 *
 * A miss (`undefined`) is answered by the caller, which knows the labels to print.
 * Nothing is adopted: the handle returned here is opened and closed by that caller.
 */
export function findRecoveryLedgerAcrossStores(
	stores: readonly RecoveryStore[],
	name: string,
	opts: { sessionFile?: string | undefined } = {},
): CrossStoreRecoveryLedger | undefined {
	for (const store of stores) {
		const own = findLedgerInStore(store, name, { ...opts, ownRunOnly: true });
		if (own) return { ...own, storeRoot: path.resolve(store.rootDir) };
	}
	for (const store of stores) {
		const hit = findLedgerInStore(store, name, opts);
		if (hit) return { ...hit, storeRoot: path.resolve(store.rootDir) };
	}
	return undefined;
}

/**
 * Every cross-machine leftover in this store root, newest run first.
 *
 * The discovery half of `recover`: a session that never launched anything still has
 * to be able to LIST what the previous process left (the `/legion status` block),
 * otherwise the only way to learn a leftover's name is to guess it. Deduplicated by
 * `runId\0nodeId` so one ledger reached twice cannot be listed twice, and every
 * handle is closed before returning (this is a read-only scan).
 */
export interface RecoverableLeftover {
	node: LegionNode;
	runId: string;
	dbPath: string;
	/** `run.json`'s cwd: the checkout the owning session worked in (D4). */
	cwd?: string;
	/** `run.json`'s sessionFile: the transcript of the session that owns the row (D4). */
	sessionFile?: string;
	/** Pid recorded in that run dir's `owner.json`, when it has one (D4). */
	ownerPid?: number;
	/** Whether that pid is alive — the difference between "waiting" and "abandoned". */
	ownerAlive?: boolean;
	orphaned?: OrphanFate;
}

export function listRecoverableLeftovers(
	store: RecoveryStore,
	opts: { sessionFile?: string | undefined } = {},
): RecoverableLeftover[] {
	const out: RecoverableLeftover[] = [];
	const seen = new Set<string>();
	for (const run of runsInRecoveryOrder(store, opts.sessionFile)) {
		const dbPath = path.resolve(legionDbPath(store.runDir(run.runId)));
		if (!fs.existsSync(dbPath)) continue;
		let db: DatabaseSync | undefined;
		try {
			db = openLegionDb(dbPath);
			for (const node of listUnsettledRemoteNodes(db)) {
				const key = `${run.runId}\u0000${node.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				// 6.2.4 / D2: read the exit's fate while the handle is already open, so
				// `/legion status` does not have to reopen every run's ledger for it.
				const orphaned = orphanFateOf(db, node.id);
				// 6.2.5 / D4: the ownership facts. `cwd`/`sessionFile` were already in
				// run.json — `runsNewestFirst` was dropping them, which is why the block
				// could not say whose leftover this is without a migration.
				const runDir = store.runDir(run.runId);
				const owner = readOwnerFile(path.join(runDir, RUN_OWNER_FILE));
				out.push({
					node,
					runId: run.runId,
					dbPath,
					...(run.cwd ? { cwd: run.cwd } : {}),
					...(run.sessionFile ? { sessionFile: run.sessionFile } : {}),
					...(owner ? { ownerPid: owner.pid, ownerAlive: isPidAlive(owner.pid) } : {}),
					...(orphaned ? { orphaned } : {}),
				});
			}
		} catch {
			// A corrupt/unreadable ledger contributes nothing; it must not cost the list.
		} finally {
			try { db?.close(); } catch { /* already closed */ }
		}
	}
	return out;
}

/**
 * The store's runs in the order recovery reads them: THIS session's own run first,
 * then every other run newest-first.
 *
 * The split is priority 1/2 of {@link findRecoveryLedgerForName} and is explicit
 * rather than implied by timestamps: a session that reopened its own tree must read
 * that tree even when a launch in a newer run holds the same name (a name is reused
 * across runs by design).
 */
function runsInRecoveryOrder(
	store: RecoveryStore,
	sessionFile: string | undefined,
): Array<{ runId: string; sessionFile?: string; cwd?: string }> {
	const all = runsNewestFirst(store);
	const target = sessionFile !== undefined ? path.resolve(sessionFile) : undefined;
	if (target === undefined) return all;
	const own = all.filter((run) => run.sessionFile !== undefined && path.resolve(run.sessionFile) === target);
	if (own.length === 0) return all;
	const rest = all.filter((run) => !own.includes(run));
	return [...own, ...rest];
}

/**
 * `store.listRuns()` newest-first, in a stable order.
 *
 * `listRuns()` is documented oldest-first, but "the newest run that has the name"
 * must be true by construction, not by luck (the same reason `findSessionRun`
 * compares timestamps explicitly). `RunRecord.createdAt` is an ISO string, so it is
 * parsed for the comparison and the `runId` breaks ties: two runs written in the
 * same millisecond cannot make `recover` answer about a different ledger on the
 * second call, which is exactly what "already settled is idempotent" forbids.
 */
function runsNewestFirst(store: RecoveryStore): Array<{ runId: string; sessionFile?: string; cwd?: string }> {
	const runs = store.listRuns().map((run) => ({
		runId: run.runId,
		stamp: Date.parse(run.createdAt) || 0,
		...(typeof run.sessionFile === "string" ? { sessionFile: run.sessionFile } : {}),
		...(typeof run.cwd === "string" && run.cwd.length > 0 ? { cwd: run.cwd } : {}),
	}));
	return runs
		.sort((a, b) => (b.stamp - a.stamp) || a.runId.localeCompare(b.runId))
		.map(({ runId, sessionFile, cwd }) => ({ runId, ...(sessionFile ? { sessionFile } : {}), ...(cwd ? { cwd } : {}) }));
}

/**
 * `CollectResult.remoteReadback`, minus the parts a recovered child cannot have.
 *
 * Deliberately the same field set `renderCollect` already understands: the recovery
 * path renders through that function, so the `read-back from host '<h>': N of M
 * lines (…)` line is produced by ONE formatter, not two.
 */
export interface RecoveryReadbackFacts {
	host: string;
	lines: number;
	returned: number;
	truncated: boolean;
	byteCapped?: boolean;
	localPath?: string;
	remotePath?: string;
	reason?: string;
	fate?: "no-child" | "no-session" | "path" | "unreachable";
	evidence?: string[];
	nextStep?: string;
	screenTail?: string[];
}

/**
 * What a recovery call produced, as facts (the rendering happens in `index.ts`,
 * where `renderCollect` lives — this module never formats a collect).
 */
export type RecoveryKind =
	/** The row was unsettled, the work is over: this call settled it. */
	| "settled-now"
	/** The row was already terminal; nothing was written, the recorded outcome is returned. */
	| "already-settled"
	/** The machine still holds a live terminal for this child: the work is NOT over. */
	| "live"
	/** The transcript could not be read: no verdict, and the row stays unsettled. */
	| "unreadable"
	/** The transcript was graded (or was empty), but nothing was settled — see `holdReason`. */
	| "unsettled";

export interface CrossMachineRecovery {
	kind: RecoveryKind;
	node: LegionNode;
	execution: Execution;
	acceptance: AcceptanceResult;
	/** The child's own text (the last turn), empty when nothing readable was fetched. */
	output: string;
	readback: RecoveryReadbackFacts;
	/** What the machine said about the terminal, when it could be asked. */
	terminal?: {
		address: string;
		/** The TERMINAL's state (`live` / `finished`), exactly as the core said. */
		state: string;
		/** The PROGRAM's own last word (`done`, `error`, `working`), when it said one. */
		program?: string;
		/** The core's exit code, once the program ended. */
		exitCode?: number;
		unreachable?: string;
	};
	/** The status this call wrote to the ledger (set only for `settled-now`). */
	settledStatus?: Extract<NodeStatus, "settled" | "failed" | "retired">;
	/** The one-line summary recorded in the settle event. */
	summary?: string;
	/** Why nothing was written, for the `unsettled` kind. */
	holdReason?: string;
	/** Timestamp of the settle event a SECOND recovery read back. */
	recordedAt?: number;
	/** Age of the row from its LAUNCH moment (D1) — not from the last write. */
	ageMs: number;
	/** D4: the ownership facts this row was found with, when the caller knew them. */
	ownership?: RemoteOwnershipFacts;
}

export type RecoveryOutcome =
	| { ok: true; recovery: CrossMachineRecovery }
	| { ok: false; text: string };

export interface RecoverCrossMachineChildInput {
	db: DatabaseSync;
	/**
	 * 6.2.5 / D4: the run context this ledger belongs to (`runId`/`cwd`/`sessionFile`
	 * from run.json, `ownerPid`/`ownerAlive` from the run dir's owner.json). Optional
	 * so the recovery core keeps working for a caller that only holds the ledger; the
	 * ownership block is then omitted rather than invented.
	 */
	ownership?: Omit<RemoteOwnershipFacts, "name" | "nodeId" | "host" | "state" | "terminal" | "launchedAt" | "heartbeatAt" | "now">;
	/** The child's handle (the name it was launched under). */
	name: string;
	/** Cross-machine settings, so the read-back resolves the same target the launch did. */
	crossMachine: CrossMachineSettings | undefined;
	/**
	 * Directory the fetched transcript is mirrored into; `remoteMirrorPathFor` adds
	 * `<name>.jsonl`. The caller passes the LEDGER's own directory, so the mirror of
	 * a previous collect is the one this read refreshes.
	 */
	mirrorDir: string;
	/** Test seam: the read-back. Defaults to the production `hc` client. */
	readback?: (request: RemoteSessionRequest) => Promise<RemoteReadbackResult>;
	/** Test seam: the terminal probe. Defaults to the production `hc` client. */
	probeTerminal?: (request: RemoteTerminalProbeRequest) => Promise<RemoteTerminalProbe>;
	now?: () => number;
}

/**
 * Recover one cross-machine child from the ledger alone.
 *
 * Idempotent by construction: a second call finds the row terminal (`hasEnded`) and
 * answers `already-settled` with the outcome the FIRST call recorded in the ledger,
 * writing nothing. The transcript is re-read on that second call (best effort) only
 * so the child's text can travel with the answer; a machine that no longer has the
 * file costs the text, not the recorded verdict.
 */
export async function recoverCrossMachineChild(
	input: RecoverCrossMachineChildInput,
): Promise<RecoveryOutcome> {
	const now = (input.now ?? Date.now)();
	const rows = listRemoteNodesNamed(input.db, input.name);
	if (rows.length === 0) return { ok: false, text: unknownRecoveryMessage(input.db, input.name, { now, ...(input.ownership ? { ownership: input.ownership } : {}) }) };
	// The newest unsettled row wins; a settled one is only ever consulted for the
	// idempotent answer (`already-settled`) below.
	const unsettled = rows.filter((row) => !hasEnded(row));
	const node = unsettled.at(-1) ?? rows[rows.length - 1]!;
	const host = normalizeHost(node.host);
	if (host === undefined) {
		// Unreachable through the query above (it requires a host); kept so the type
		// survives a future caller that hands in a row directly.
		return { ok: false, text: `node ${node.id} has no host: it did not run on another machine, so there is nothing to recover there` };
	}
	const alreadySettled = hasEnded(node);
	// 6.2.5 / D1: age from the LAUNCH moment. `updatedAt` is rewritten by the
	// hygiene sweep, so an age computed from it turned a week-old leftover into
	// "2m old"; it is reported as the heartbeat instead.
	const ageMs = Math.max(0, now - node.createdAt);


	// 6.2.4 / D2: an ENDED row is only "already settled" when it actually recorded
	// an outcome. Two kinds of row are ended and still owe a fetch:
	//
	//   - the exit left it behind (`orphan_detected{reason:"session-shutdown"}`,
	//     written when a parent session walked away from work still running over
	//     there). The marker is only current while it is NEWER than the last settle
	//     event, so the `settled-now` write below turns the next call back into a
	//     zero-fetch `already settled`;
	//   - it was retired WITHOUT a verdict (any `node_retired` with no `execution`,
	//     including every row 6.2.3's shutdown stamped aborted). Nothing was graded,
	//     so there is nothing to be idempotent about — the transcript is on that
	//     machine and it is the answer.
	//
	// A row that DID record an outcome (settled / failed / aborted-with-execution)
	// is untouched: that is 6.2.3's idempotency, and it still touches no wire.
	const recorded = recordedSettle(input.db, node.id);
	const orphan = orphanMarkFor(input.db, node.id);
	const graded = recorded?.status !== undefined;
	const settledAlready = alreadySettled && orphan === undefined && graded;

	// 1. A terminal row comes FIRST and touches NO wire (defect D3, idempotency).
	//
	//    Two reasons, and the order is load-bearing for both:
	//      - the recorded verdict is a fact about the past, so liveness over there
	//        cannot change what this call answers — a kept terminal stays
	//        `state: "live"` forever (see `terminalProgramEnd`), and asking liveness
	//        first made a SECOND `recover` of a settled child answer `still live …`;
	//      - a settled row needs no fetch at all. It used to do one anyway, which
	//        made "already settled is idempotent" true only for the TEXT, not for the
	//        wire: every repeat call re-read the transcript and re-probed the machine.
	//        Measured in the fake core's request log (`no second fetch`).
	//    The transcript this machine already holds is a LOCAL file, so reading it
	//    costs nothing and still gives the caller the child's own words.
	if (settledAlready) {
		const mirrorPath = remoteMirrorPathFor(input.mirrorDir, node.name);
		let parsedMirror: ReturnType<typeof parseSessionFile> | undefined;
		try {
			if (fs.existsSync(mirrorPath)) parsedMirror = parseSessionFile(mirrorPath);
		} catch {
			// A part-written mirror is not a verdict: the recorded reason still answers.
			parsedMirror = undefined;
		}
		const base: Execution = parsedMirror
			? deriveOutcome(parsedMirror)
			: {
				status: "unknown",
				reason: transcriptNotRetrievedReason(
					host,
					`the row was already settled, so this call fetched nothing (the transcript, if needed, is on that machine)`,
				),
			};
		const reason = recorded?.reason ?? base.reason;
		const execution: Execution = {
			...base,
			status: recorded?.status ?? base.status,
			...(reason ? { reason } : {}),
		};
		return {
			ok: true,
			recovery: {
				kind: "already-settled",
				node,
				execution,
				acceptance: acceptanceFor(parsedMirror, execution),
				output: outputOf(parsedMirror, execution),
				...(parsedMirror
					? { readback: mirrorFacts(host, mirrorPath) }
					: {
						readback: {
							host,
							lines: 0,
							returned: 0,
							truncated: false,
							reason: `not fetched: the row was already settled${node.remoteDir ? "" : " (the record has no remote_dir)"}`,
							fate: "no-session",
							...(node.remoteDir ? { remotePath: path.posix.join(node.remoteDir, "session.jsonl") } : {}),
							evidence: [`no local mirror at ${mirrorPath}`],
							nextStep: `nothing to do — the verdict above is the recorded one. For the prose: hc exec --on ${host} -- cat ${node.remoteDir ? path.posix.join(node.remoteDir, "session.jsonl") : "<remote dir>/session.jsonl"}`,
						},
					}),
				...(recorded?.ts !== undefined ? { recordedAt: recorded.ts } : {}),
				ageMs,
			},
		};
	}

	const read = (input.readback ?? createRemoteSessionReadback({ crossMachine: input.crossMachine }))({
		host,
		name: node.name,
		localPath: remoteMirrorPathFor(input.mirrorDir, node.name),
		...(node.remoteDir ? { remoteDir: node.remoteDir } : {}),
		...(node.remoteTerminal ? { remoteTerminal: node.remoteTerminal } : {}),
	});
	const probe = (input.probeTerminal ?? createRemoteTerminalProbe({ crossMachine: input.crossMachine }))({
		host,
		name: node.name,
		...(node.remoteTerminal ? { remoteTerminal: node.remoteTerminal } : {}),
	});
	const [readback, terminal] = await Promise.all([read, probe]);
	const facts = readbackFacts(readback);
	const terminalFacts: CrossMachineRecovery["terminal"] = {
		address: terminal.address,
		state: terminal.state,
		...(terminal.program !== undefined ? { program: terminal.program } : {}),
		...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
		...(terminal.unreachable !== undefined ? { unreachable: terminal.unreachable } : {}),
	};
	const parsed = readback.ok ? parseSessionFile(readback.localPath) : undefined;

	// 2. A LIVE program outranks every other fact about an UNSETTLED row: the child is
	//    still working over there, so there is no verdict to settle whatever the
	//    transcript's tail says.
	if (terminal.live) {
		const execution: Execution = {
			status: "running",
			reason: `terminal '${terminal.address}' is still '${terminal.state}' on host '${host}': the child is still working there, so nothing was graded`,
		};
		return {
			ok: true,
			recovery: {
				kind: "live",
				node,
				execution,
				// Deliberately NOT `deriveAcceptance` here: that ladder reads a verdict line
				// out of the text first, and the text of a child still working is a PREVIOUS
				// turn's report. Accepting unfinished work is the one claim this action must
				// never make, so liveness speaks before the verdict does.
				acceptance: { status: "unknown", level: "none", reason: execution.reason },
				output: parsed?.output ?? "",
				readback: facts,
				terminal: terminalFacts,
				ageMs,
			},
		};
	}

	// 3. No transcript = no verdict. `unknown` is the honest answer and the render
	//    names the file plus the command that fetches it; the row stays unsettled so
	//    the operator can fix the path and call recover again.
	if (parsed === undefined) {
		const execution: Execution = {
			status: "unknown",
			reason: transcriptNotRetrievedReason(host, readback.ok ? "no text" : readback.reason),
		};
		return {
			ok: true,
			recovery: {
				kind: "unreadable",
				node,
				execution,
				acceptance: acceptanceFor(undefined, execution),
				output: "",
				readback: facts,
				terminal: terminalFacts,
				ageMs,
			},
		};
	}

	const execution = deriveOutcome(parsed);
	const acceptance = deriveAcceptance(parsed, execution, undefined);
	const output = outputOf(parsed, execution);

	// 4. A machine we could not ask is a machine whose terminal may still be live:
	//    grading is fine, settling would be a claim about liveness nobody made.
	if (terminal.unreachable !== undefined) {
		return {
			ok: true,
			recovery: {
				kind: "unsettled",
				node,
				execution,
				acceptance,
				output,
				readback: facts,
				terminal: terminalFacts,
				holdReason: `host '${host}' could not be asked about terminal '${terminal.address}' (${terminal.unreachable}), so nothing was settled`,
				ageMs,
			},
		};
	}

	// 5. A transcript with no messages at all is not a verdict either (`unknown`),
	//    and neither is a status that never terminates.
	if (execution.status === "unknown" || execution.status === "running") {
		return {
			ok: true,
			recovery: {
				kind: "unsettled",
				node,
				execution,
				acceptance,
				output,
				readback: facts,
				terminal: terminalFacts,
				holdReason: `the transcript holds no gradeable turn (${execution.reason ?? execution.status}), so nothing was settled`,
				ageMs,
			},
		};
	}

	// 6. The work is over and it is gradeable: settle the row exactly the way a
	//    collect does, so a later reader cannot tell recovered from collected.
	const settledStatus = settledStatusFor(execution);
	const summary = summarize(host, execution, readback, terminal);
	settleNode(input.db, node, settledStatus, execution, summary, () => now, parsed);
	return {
		ok: true,
		recovery: {
			kind: "settled-now",
			node,
			execution,
			acceptance,
			output,
			readback: facts,
			terminal: terminalFacts,
			settledStatus,
			summary,
			ageMs,
		},
	};
}

/**
 * One line, in the recovery header — the sentence that says whether the row moved.
 *
 * Kept here (not in `index.ts`) so the `/legion` block and the tool answer cannot
 * describe the same recovery differently.
 */
export function recoveryHeadline(recovery: CrossMachineRecovery): string {
	const name = recovery.node.name;
	const host = normalizeHost(recovery.node.host) ?? "(unknown host)";
	const address = recovery.terminal?.address ?? recovery.node.remoteTerminal ?? "(not recorded)";
	const headline = recoveryHeadlineSentence(recovery, name, host, address);
	// 6.2.5 / D4: the SAME ownership block `/legion status` prints, so a recover
	// headline answers "whose leftover was that" without a second call.
	return recovery.ownership ? `${renderRemoteOwnershipBlock(recovery.ownership).join("\n")}\n${headline}` : headline;
}

function recoveryHeadlineSentence(recovery: CrossMachineRecovery, name: string, host: string, address: string): string {
	switch (recovery.kind) {
		case "settled-now":
			// `program` first: a kept terminal reports `state: live` long after its program
			// ended, so "is over" next to "(terminal is live)" would contradict itself.
			return `recover: '${name}' is over on '${host}' (terminal '${address}' is ${recovery.terminal?.program ?? recovery.terminal?.state ?? "gone"}); settled node ${recovery.node.id} as ${recovery.settledStatus} — ${recovery.summary ?? "recovered from the transcript"}`;
		case "already-settled":
			// No wire, and it says so: the verdict is the recorded one, and the transcript
			// text (when this machine holds it) is the local mirror. That sentence is the
			// difference between "idempotent" and "looks like it fetched again".
			return `recover: '${name}' is already settled (${recovery.node.status}) — nothing was written and nothing was fetched; this is the outcome the ledger recorded${recovery.recordedAt !== undefined ? ` at ${new Date(recovery.recordedAt).toISOString()}` : ""}.`;
		case "live":
			// The TERMINAL's own word here, not the program's: this line explains why
			// nothing was settled, and "the terminal is live" is that reason.
			return `recover: terminal '${address}' is still '${recovery.terminal?.state ?? "live"}' on '${host}' — the child is still working there, so nothing was settled.`;
		case "unreadable":
			return `recover: the transcript could not be read from '${host}' — nothing was settled (an unreadable transcript is not a verdict).`;
		case "unsettled":
			return `recover: graded from the transcript, but nothing was settled — ${recovery.holdReason ?? recovery.execution.reason ?? recovery.execution.status}.`;
	}
}

/**
 * The read-back facts for a mirror this machine ALREADY holds (`already-settled`).
 *
 * `ok`/`lines` describe a local file, and the renderer prints it as a read-back —
 * which is what it is, just an earlier one. `fetched: false` keeps the claim honest
 * for anyone reading the JSON body: this call did not go to the wire.
 */
function mirrorFacts(host: string, localPath: string): RecoveryReadbackFacts {
	// The mirror's own line count, not a reconstruction from the parse: the render
	// prints "N of M lines (complete)", and M has to be the file's count or it means
	// something else here than it does in `collect`.
	let lines = 0;
	try {
		lines = fs.readFileSync(localPath, "utf8").split("\n").filter((line) => line.trim().length > 0).length;
	} catch {
		lines = 0;
	}
	return { host, lines, returned: lines, truncated: false, localPath };
}

/** The `read-back from host …` facts, in the shape `renderCollect` reads. */
function readbackFacts(readback: RemoteReadbackResult): RecoveryReadbackFacts {
	if (readback.ok) {
		return {
			host: readback.host,
			lines: readback.lines,
			returned: readback.returned,
			truncated: readback.truncated,
			byteCapped: readback.byteCapped,
			localPath: readback.localPath,
			remotePath: readback.remotePath,
		};
	}
	return {
		host: readback.host,
		lines: 0,
		returned: 0,
		truncated: false,
		reason: readback.reason,
		fate: readback.fate,
		...(readback.remotePath ? { remotePath: readback.remotePath } : {}),
		evidence: readback.evidence,
		nextStep: readback.nextStep,
		...(readback.screenTail && readback.screenTail.length > 0 ? { screenTail: readback.screenTail } : {}),
	};
}

/** The child's own text, or nothing when the turn produced none (same rule as `collect`). */
function outputOf(
	parsed: ReturnType<typeof parseSessionFile> | undefined,
	execution: Execution,
): string {
	if (!parsed) return "";
	return execution.status !== "running" && parsed.lastTurnOutput === null ? "" : parsed.output;
}

/**
 * `collect`'s acceptance ladder, with "no transcript at all" handled by handing it
 * an empty parse: `deriveAcceptance` then reports the execution's own reason as
 * `unknown`/`rejected`, which is exactly what the missing text can support.
 */
function acceptanceFor(
	parsed: ReturnType<typeof parseSessionFile> | undefined,
	execution: Execution,
): AcceptanceResult {
	return deriveAcceptance(parsed ?? parseSessionText(""), execution, undefined);
}

/** `recovered from host 'h': execution success, 3 turn(s), read-back 11 of 11 lines`. */
function summarize(
	host: string,
	execution: Execution,
	readback: RemoteReadbackResult,
	terminal: RemoteTerminalProbe,
): string {
	const lines = readback.ok
		? `read-back ${readback.returned} of ${readback.lines} lines${readback.truncated ? " (truncated)" : ""}`
		: "read-back failed";
	const turns = execution.turns !== undefined ? `, ${execution.turns} turn(s)` : "";
	return `recovered from host '${host}': execution ${execution.status}${turns}, ${lines}, terminal ${terminal.state}`;
}

/**
 * Write the settle exactly as `Orchestrator.recordSettled` does: the status on the
 * node, one ledger event carrying the verdict, and the token totals the turn
 * actually spent.
 *
 * The event name follows the status, not the recovery path, so every existing
 * reader (`interruptedChildren`, the mail postman, `legion_tree`) sees a recovered
 * child as an ordinary settled one. `recovered: true` is the only extra fact, and
 * it is additive: no reader keys on it.
 */
function settleNode(
	db: DatabaseSync,
	node: LegionNode,
	status: Extract<NodeStatus, "settled" | "failed" | "retired">,
	execution: Execution,
	summary: string,
	now: () => number,
	parsed: ReturnType<typeof parseSessionFile>,
): void {
	updateNode(db, node.id, { status }, now);
	appendEvent(
		db,
		node.id,
		status === "settled" ? "node_settled" : status === "failed" ? "node_failed" : "node_retired",
		{
			execution: execution.status,
			...(execution.reason ? { reason: execution.reason } : {}),
			recovered: true,
			...(node.host ? { host: node.host } : {}),
			...(node.remoteTerminal ? { remoteTerminal: node.remoteTerminal } : {}),
			summary,
		},
		{ now },
	);
	const usage = parsed.usage;
	if (usage) {
		upsertUsage(
			db,
			{
				nodeId: node.id,
				tokensIn: usage.input + usage.cacheRead + usage.cacheWrite,
				tokensOut: usage.output,
				costUsd: usage.cost,
			},
			now,
		);
	}
}

/** The last settle event written for a node, decoded (`already-settled` reads it). */
function recordedSettle(
	db: DatabaseSync,
	nodeId: string,
): { status?: ExecutionStatus; reason?: string; ts: number } | undefined {
	// Raw SQL on purpose: this is the settle fact itself, and `readEventsAfter` is a
	// cursor API (ascending from a cursor) while recovery asks for the LAST one.
	const row = db
		.prepare(
			`SELECT type, data, ts FROM events
			 WHERE node_id = ? AND type IN ('node_settled', 'node_failed', 'node_retired', 'node_abandoned')
			 ORDER BY id DESC LIMIT 1`,
		)
		.get(nodeId) as SqliteRow | undefined;
	if (row === undefined) return undefined;
	let data: unknown;
	try {
		data = row.data === null || row.data === undefined ? undefined : JSON.parse(String(row.data));
	} catch {
		data = undefined;
	}
	const fields = (data ?? {}) as { execution?: unknown; reason?: unknown };
	const status = isExecutionStatus(fields.execution) ? fields.execution : undefined;
	const reason = typeof fields.reason === "string" ? fields.reason : undefined;
	return { ...(status ? { status } : {}), ...(reason ? { reason } : {}), ts: Number(row.ts) };
}

function isExecutionStatus(value: unknown): value is ExecutionStatus {
	return value === "success" || value === "failed" || value === "aborted" || value === "truncated" || value === "running" || value === "unknown";
}

/**
 * What a `recover` on an unknown name answers: the name, and the names that WOULD
 * work — a leftover is discovered by reading, so a miss has to say where to look.
 */
function unknownRecoveryMessage(
	db: DatabaseSync,
	name: string,
	context: {
		now: number;
		ownership?: Omit<RemoteOwnershipFacts, "name" | "nodeId" | "host" | "state" | "terminal" | "launchedAt" | "heartbeatAt" | "now">;
	} = { now: Date.now() },
): string {
	const rows = listUnsettledRemoteNodes(db);
	if (rows.length === 0) {
		return `unknown cross-machine child ${JSON.stringify(sanitizeNodeSlug(name))}: no row in this ledger has that name and a host. Nothing is waiting for recovery: no cross-machine node in this ledger is unsettled.`;
	}
	// 6.2.5 / D4: the miss lists the SAME ownership block the status block prints, so
	// the names that WOULD work come with the facts needed to choose one (D4: one
	// format, three surfaces).
	const blocks = rows.map((node) => renderRemoteOwnershipBlock({
		name: node.name,
		nodeId: node.id,
		host: normalizeHost(node.host) ?? "(unknown host)",
		state: recoveryStateWord(node),
		...(node.remoteTerminal ? { terminal: node.remoteTerminal } : {}),
		launchedAt: node.createdAt,
		...(Number.isFinite(node.updatedAt) ? { heartbeatAt: node.updatedAt } : {}),
		...(context.ownership?.runId ? { runId: context.ownership.runId } : {}),
		...(context.ownership?.cwd ? { cwd: context.ownership.cwd } : {}),
		...(context.ownership?.sessionFile ? { sessionFile: context.ownership.sessionFile } : {}),
		...(context.ownership?.ownerPid !== undefined ? { ownerPid: context.ownership.ownerPid } : {}),
		...(context.ownership?.ownerAlive !== undefined ? { ownerAlive: context.ownership.ownerAlive } : {}),
		now: context.now,
	}).join("\n"));
	return `unknown cross-machine child ${JSON.stringify(sanitizeNodeSlug(name))}: no row in this ledger has that name and a host.\nWaiting for recovery:\n${blocks.join("\n")}`;
}
