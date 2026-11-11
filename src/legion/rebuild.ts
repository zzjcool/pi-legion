import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "./db.ts";
import { withTransaction } from "./db.ts";
import { appendEvent } from "./events.ts";
import { getNode, insertNode, nodeIdForChild, sanitizeNodeSlug } from "./nodes.ts";
import { recordArtifact } from "./ledger.ts";
import { upsertUsage } from "./usage.ts";
import { deriveOutcome, parseSessionFile } from "../shared/session.ts";
import type { ChildRecord, RunRecord, Usage } from "../shared/types.ts";

/** Directory under a run dir that holds one sub-directory per child name. */
const ARTIFACTS_DIRECTORY = "artifacts";
/** `<runDir>/artifacts/<name>/r<round>.md` — the round is part of the filename. */
const ARTIFACT_FILE_PATTERN = /^r(\d+)\.md$/;

export interface RebuildOptions {
	/** A run directory, its parent `runs/` directory, or the run's project root. */
	rootRunDir: string;
	db: DatabaseSync;
	now?: () => number;
	preserveMessages?: boolean;
}

export interface RebuildWarning {
	path: string;
	message: string;
}

export interface RebuildResult {
	runFiles: string[];
	nodesRebuilt: number;
	eventsRebuilt: number;
	usageRebuilt: number;
	/** Artifact rows re-derived from `<runDir>/artifacts/<name>/r<round>.md` (D10). */
	artifactsRebuilt: number;
	warnings: RebuildWarning[];
}

interface LoadedRun {
	file: string;
	run: RunRecord;
}

interface NodeSource {
	id: string;
	parentId: string | null;
	name: string;
	role: string;
	kind: string;
	depth: number;
	runId: string | null;
	sessionFile: string | null;
	worktreePath: string | null;
	model: string | null;
	team: string | null;
	status: "starting" | "running" | "blocked" | "settled" | "failed" | "retired";
	createdAt: number;
	updatedAt: number;
	executionStatus?: string;
	usage?: Usage;
	fromSession: boolean;
}

/** Best-effort reconstruction of ledger facts from per-run records and sessions. */
export function rebuildLegionDb(options: RebuildOptions): RebuildResult {
	if (!options.rootRunDir) throw new TypeError("rootRunDir must be a non-empty path");
	const clock = options.now ?? (() => Date.now());
	const warnings: RebuildWarning[] = [];
	const discoveredRuns = loadRuns(options.rootRunDir, warnings);
	const scope = selectTreeRuns(options.rootRunDir, discoveredRuns, options.db, warnings);
	if (scope.rootRunId === null) {
		return { runFiles: [], nodesRebuilt: 0, eventsRebuilt: 0, usageRebuilt: 0, artifactsRebuilt: 0, warnings };
	}
	const runs = scope.runs;
	const sources = collectSources(runs, scope.rootRunId, warnings, clock);
	if (!sources.some((source) => source.id === "root")) {
		warnings.push({ path: options.rootRunDir, message: "no root run.json was found" });
	}
	let nodesRebuilt = 0;
	let eventsRebuilt = 0;
	let usageRebuilt = 0;
	let artifactsRebuilt = 0;
	withTransaction(options.db, () => {
		options.db.exec("DELETE FROM usage;");
		options.db.exec("DELETE FROM events;");
		options.db.exec("DELETE FROM nodes;");
		// The result ledger is rebuilt from disk, not preserved: artifact rows are
		// re-derived below, and consumption facts are parent-process history with no
		// on-disk source (contract `result-ledger-v1.md` D10). Clearing both is what
		// makes "after a rebuild everything is unread" true — it can only cause an
		// extra notice, never a missing one.
		options.db.exec("DELETE FROM consumptions;");
		options.db.exec("DELETE FROM artifacts;");
		if (options.preserveMessages === false) options.db.exec("DELETE FROM messages;");
		for (const source of orderByParent(sources)) {
			try {
				insertNode(options.db, {
					id: source.id,
					parentId: source.parentId,
					name: source.name,
					role: source.role,
					kind: source.kind,
					depth: source.depth,
					runId: source.runId,
					sessionFile: source.sessionFile,
					worktreePath: source.worktreePath,
					model: source.model,
					team: source.team,
					status: source.status,
					createdAt: source.createdAt,
					updatedAt: source.updatedAt,
				}, () => source.createdAt);
				nodesRebuilt += 1;
			} catch (error) {
				warnings.push({ path: source.sessionFile ?? source.id, message: `could not rebuild node ${source.id}: ${messageOf(error)}` });
				continue;
			}
			appendRecoveredEvent(options.db, source);
			eventsRebuilt += 1;
			if ((source.executionStatus === "success" || source.executionStatus === "failed") && source.usage) {
				try {
					upsertUsage(options.db, {
						nodeId: source.id,
						tokensIn: source.usage.input + source.usage.cacheRead + source.usage.cacheWrite,
						tokensOut: source.usage.output,
						costUsd: source.usage.cost,
					}, () => source.updatedAt);
					usageRebuilt += 1;
				} catch (error) {
					warnings.push({ path: source.sessionFile ?? source.id, message: `could not rebuild usage: ${messageOf(error)}` });
				}
			}
		}
		// Artifacts are looked up against the nodes this rebuild just inserted:
		// a pointer whose node cannot be resolved is skipped, never guessed (D10).
		artifactsRebuilt = rebuildArtifacts(options.db, runs, warnings);
	});
	return { runFiles: runs.map((entry) => entry.file), nodesRebuilt, eventsRebuilt, usageRebuilt, artifactsRebuilt, warnings };
}

function loadRuns(input: string, warnings: RebuildWarning[]): LoadedRun[] {
	const resolved = path.resolve(input);
	const rootRunFile = path.join(resolved, "run.json");
	let runsDir: string | null = null;
	if (fs.existsSync(rootRunFile)) {
		const parent = path.dirname(resolved);
		runsDir = path.basename(parent) === "runs" ? parent : null;
	} else if (path.basename(resolved) === "runs") {
		runsDir = resolved;
	} else {
		const conventional = path.join(resolved, ".pi-subagents", "runs");
		if (fs.existsSync(conventional)) runsDir = conventional;
	}
	const candidates = runsDir
		? listDirectories(runsDir).map((directory) => path.join(runsDir!, directory, "run.json"))
		: fs.existsSync(rootRunFile)
			? [rootRunFile]
			: [];
	const files = [...new Set(candidates.filter((file) => fs.existsSync(file)))].sort();
	const loaded: LoadedRun[] = [];
	for (const file of files) {
		try {
			const decoded: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
			if (!isRunRecord(decoded)) throw new Error("run.json shape mismatch");
			loaded.push({ file, run: decoded });
		} catch (error) {
			warnings.push({ path: file, message: `skipped unreadable run.json: ${messageOf(error)}` });
		}
	}
	return loaded;
}

function selectTreeRuns(
	input: string,
	discovered: readonly LoadedRun[],
	db: DatabaseSync,
	warnings: RebuildWarning[],
): { rootRunId: string | null; runs: LoadedRun[] } {
	const explicitRunDir = path.resolve(input);
	const explicitRunId = path.basename(explicitRunDir);
	const inputIsRunDirectory = path.basename(path.dirname(explicitRunDir)) === "runs";
	const dbRootId = getNode(db, "root")?.runId ?? null;
	const emptyPathRoots = discovered.filter((entry) => entry.run.path.length === 0);
	const explicitRoot = discovered.find(
		(entry) => entry.file === path.join(explicitRunDir, "run.json") && entry.run.path.length === 0,
	);
	const rootRun = explicitRoot ??
		discovered.find((entry) => entry.run.path.length === 0 && entry.run.runId === dbRootId) ??
		discovered.find((entry) => entry.run.path.length === 0 && entry.run.runId === explicitRunId) ??
		(!inputIsRunDirectory && emptyPathRoots.length === 1 ? emptyPathRoots[0] : null);
	if (!rootRun) {
		warnings.push({ path: input, message: "could not identify a target root run.json; skipped all run records" });
		return { rootRunId: null, runs: [] };
	}
	const rootRunId = rootRun.run.runId;
	const byRunId = new Map(discovered.map((entry) => [entry.run.runId, entry]));
	const selected = new Map<string, LoadedRun>([[rootRunId, rootRun]]);
	for (const entry of discovered) {
		if (entry.run.runId === rootRunId) continue;
		if (entry.run.path.length === 0) {
			warnings.push({ path: entry.file, message: `skipped foreign root run ${entry.run.runId} (target root ${rootRunId})` });
			continue;
		}
		if (pathBelongsToRoot(entry.run, rootRunId, byRunId, db, warnings, entry.file)) {
			selected.set(entry.run.runId, entry);
		} else {
			warnings.push({ path: entry.file, message: `skipped run ${entry.run.runId} outside root ${rootRunId}` });
		}
	}
	return { rootRunId, runs: [...selected.values()].sort((left, right) => left.file.localeCompare(right.file)) };
}

function pathBelongsToRoot(
	run: RunRecord,
	rootRunId: string,
	byRunId: ReadonlyMap<string, LoadedRun>,
	db: DatabaseSync,
	warnings: RebuildWarning[],
	file: string,
): boolean {
	const parentRunId = run.path[0]?.runId;
	if (!parentRunId) return false;
	if (parentRunId === rootRunId) return true;

	// Names are optional path metadata; ancestry membership is established by
	// the parent run-id chain (or the persisted tree's run_id relation).
	const parentRun = byRunId.get(parentRunId);
	const inTree = parentRun
		? runPathChainReachesRoot(parentRun.run, rootRunId, byRunId, new Set())
		: persistedRunBelongsToRoot(db, parentRunId, rootRunId);
	if (!inTree) return false;
	if (run.path.some((entry) => !entry.agent)) {
		warnings.push({ path: file, message: `kept legacy lineage with optional path.agent omitted under root ${rootRunId}` });
	}
	return true;
}

function runPathChainReachesRoot(
	run: RunRecord,
	rootRunId: string,
	byRunId: ReadonlyMap<string, LoadedRun>,
	seen: Set<string>,
): boolean {
	if (run.runId === rootRunId) return run.path.length === 0;
	if (seen.has(run.runId) || run.path.length === 0) return false;
	seen.add(run.runId);
	const parentRunId = run.path[0]?.runId;
	if (!parentRunId) return false;
	if (parentRunId === rootRunId) return true;
	const parent = byRunId.get(parentRunId);
	return parent ? runPathChainReachesRoot(parent.run, rootRunId, byRunId, seen) : false;
}

function persistedRunBelongsToRoot(
	db: DatabaseSync,
	runId: string,
	rootRunId: string,
): boolean {
	const query = db.prepare("SELECT id, parent_id FROM nodes WHERE run_id = ? LIMIT 1");
	let row = query.get(runId);
	const seen = new Set<string>();
	while (row) {
		const id = String(row.id);
		if (seen.has(id)) return false;
		seen.add(id);
		if (id === "root") return getNode(db, "root")?.runId === rootRunId;
		const parentId = row.parent_id === null ? null : String(row.parent_id);
		if (!parentId) return false;
		row = db.prepare("SELECT id, parent_id FROM nodes WHERE id = ?").get(parentId);
	}
	return false;
}

function collectSources(
	runs: readonly LoadedRun[],
	rootRunId: string,
	warnings: RebuildWarning[],
	clock: () => number,
): NodeSource[] {
	const byId = new Map<string, NodeSource>();
	for (const { file, run } of runs) {
		const currentId = nodeIdFromPath(run.path);
		const isRootRun = run.path.length === 0 && run.runId === rootRunId;
		if (isRootRun) {
			mergeSource(byId, {
				id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0,
				runId: run.runId, sessionFile: null, worktreePath: null, model: null, team: null,
				status: "running", createdAt: toMillis(run.createdAt, clock),
				updatedAt: toMillis(run.updatedAt, clock), fromSession: false,
			});
		} else if (run.path.length > 0) {
			const lastIndex = lastNamedPathIndex(run.path);
			const last = lastIndex === null ? null : run.path[lastIndex];
			if (last && lastIndex !== null) {
				const parentId = nodeIdFromPath(run.path.slice(0, lastIndex));
				const slug = sanitizeNodeSlug(last.agent ?? "agent");
				const id = nodeIdForChild(parentId, slug);
				const parentRecord = findParentChild(runs, parentId, last.agent ?? slug);
				mergeSource(byId, {
					id,
					parentId,
					name: slug,
					role: parentRecord?.agent ?? slug,
					kind: parentRecord?.kind ?? "pi",
					depth: nodeDepth(id),
					runId: run.runId,
					sessionFile: findSessionForRun(runs, run),
					worktreePath: parentRecord?.worktreePath ?? null,
					model: parentRecord?.model ?? null,
					team: null,
					status: "running",
					createdAt: toMillis(run.createdAt, clock),
					updatedAt: toMillis(run.updatedAt, clock),
					fromSession: false,
				});
			} else {
				warnings.push({
					path: file,
					message: "retained in-tree run with optional path.agent omitted; its own node id cannot be reconstructed",
				});
			}
		}
		for (const child of run.children) {
			try {
				const childSource = sourceFromChild(currentId, child, file, run, clock);
				if (!childSource) continue;
				const nestedRun = runs.find((entry) => nodeIdFromPath(entry.run.path) === childSource.id);
				if (nestedRun) {
					childSource.runId = nestedRun.run.runId;
					childSource.updatedAt = Math.max(childSource.updatedAt, toMillis(nestedRun.run.updatedAt, clock));
				}
				mergeSource(byId, childSource);
			} catch (error) {
				warnings.push({ path: file, message: `skipped child ${child.name}: ${messageOf(error)}` });
			}
		}
	}
	for (const source of byId.values()) {
		if (!source.sessionFile || !fs.existsSync(source.sessionFile)) continue;
		const parsed = parseSessionFile(source.sessionFile);
		source.fromSession = true;
		source.usage = parsed.usage;
		const execution = deriveOutcome(parsed);
		source.executionStatus ??= execution.status;
		if (source.status !== "retired" && execution.status === "success") source.status = "settled";
		else if (source.status !== "retired" && execution.status === "failed") source.status = "failed";
	}
	ensureParents(byId, warnings, clock);
	return [...byId.values()];
}

function sourceFromChild(
	parentId: string,
	child: ChildRecord,
	runFile: string,
	parentRun: RunRecord,
	clock: () => number,
): NodeSource | undefined {
	// #266 D3/§4.4: a `queued` child was never started — it has no ledger row, no
	// run directory and only a placeholder session path. Rebuilding it into the
	// tree would invent a node (and a phantom leaf) for a launch that may still be
	// waiting or may have been dropped with the previous process.
	if (child.state === "queued") return undefined;
	const slug = sanitizeNodeSlug(child.name);
	const id = nodeIdForChild(parentId, slug);
	let status: NodeSource["status"] = "settled";
	if (child.state === "launching") status = "starting";
	else if (child.state === "working") status = "running";
	else if (child.state === "blocked" || child.state === "awaiting") status = "blocked";
	else if (child.state === "retired") status = "retired";
	else if (child.execution?.status === "failed" || child.execution?.status === "aborted") status = "failed";
	const createdAt = toMillis(child.spawnedAt, clock);
	let updatedAt = createdAt;
	if (child.retiredAt) updatedAt = toMillis(child.retiredAt, clock);
	else if (child.execution?.completedAt) updatedAt = toMillis(child.execution.completedAt, clock);
	else if (status === "settled" || status === "failed") updatedAt = toMillis(parentRun.updatedAt, clock);
	const sessionFile = absoluteFromRunDir(child.sessionFile, path.dirname(runFile));
	return {
		id,
		parentId,
		name: slug,
		role: child.agent ?? slug,
		kind: child.kind ?? "pi",
		depth: nodeDepth(id),
		runId: null,
		sessionFile,
		worktreePath: child.worktreePath ?? null,
		model: child.model ?? null,
		team: null,
		status,
		createdAt,
		updatedAt,
		...(child.execution?.usage ? { usage: child.execution.usage } : {}),
		...(child.execution?.status ? { executionStatus: child.execution.status } : {}),
		fromSession: fs.existsSync(sessionFile),
	};
}

function appendRecoveredEvent(db: DatabaseSync, source: NodeSource): void {
	let type: Parameters<typeof appendEvent>[2] = "node_launched";
	if (source.status === "retired") type = "node_retired";
	else if (source.status === "settled") type = "node_settled";
	else if (source.status === "failed") type = "node_failed";
	const timestamp = source.status === "starting" || source.status === "running" || source.status === "blocked"
		? source.createdAt
		: source.updatedAt;
	appendEvent(db, source.id, type, { recovered: true, fromSession: source.fromSession }, { now: () => timestamp });
}

function mergeSource(byId: Map<string, NodeSource>, next: NodeSource): void {
	const old = byId.get(next.id);
	if (!old) {
		byId.set(next.id, next);
		return;
	}
	const preferred = next.updatedAt >= old.updatedAt ? next : old;
	byId.set(next.id, {
		...preferred,
		createdAt: Math.min(old.createdAt, next.createdAt),
		updatedAt: Math.max(old.updatedAt, next.updatedAt),
		parentId: preferred.parentId,
		name: preferred.name,
		role: preferred.role,
		runId: next.runId ?? old.runId,
		sessionFile: next.sessionFile ?? old.sessionFile,
		worktreePath: next.worktreePath ?? old.worktreePath,
		model: next.model ?? old.model,
		team: next.team ?? old.team,
		executionStatus: next.executionStatus ?? old.executionStatus,
		usage: next.usage ?? old.usage,
		fromSession: old.fromSession || next.fromSession,
	});
}

function ensureParents(
	byId: Map<string, NodeSource>,
	warnings: RebuildWarning[],
	clock: () => number,
): void {
	for (const node of [...byId.values()]) {
		let parentId = node.parentId;
		while (parentId !== null && !byId.has(parentId)) {
			const pieces = parentId.split(".");
			const name = pieces.at(-1) ?? "unknown";
			const ancestorId = pieces.length > 1 ? pieces.slice(0, -1).join(".") : null;
			const createdAt = node.createdAt;
			byId.set(parentId, {
				id: parentId, parentId: ancestorId, name, role: "unknown", kind: "pi",
				depth: nodeDepth(parentId), runId: null, sessionFile: null,
				worktreePath: null, model: null, team: null, status: "failed",
				createdAt, updatedAt: Math.max(createdAt, clock()), fromSession: false,
			});
			warnings.push({ path: parentId, message: "reconstructed missing parent node from child lineage" });
			parentId = ancestorId;
		}
	}
}

function orderByParent(nodes: readonly NodeSource[]): NodeSource[] {
	const pending = new Map(nodes.map((node) => [node.id, node]));
	const ordered: NodeSource[] = [];
	const emitted = new Set<string>();
	while (pending.size) {
		const ready = [...pending.values()].filter((node) => node.parentId === null || emitted.has(node.parentId));
		if (!ready.length) return [...ordered, ...pending.values()];
		for (const node of ready) {
			pending.delete(node.id);
			emitted.add(node.id);
			ordered.push(node);
		}
	}
	return ordered;
}

function nodeIdFromPath(entries: readonly { agent?: string }[]): string {
	let id = "root";
	for (const entry of entries) {
		if (entry.agent) id = nodeIdForChild(id, entry.agent);
	}
	return id;
}

function lastNamedPathIndex(entries: RunRecord["path"]): number | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index]?.agent) return index;
	}
	return null;
}

function findParentChild(
	runs: readonly LoadedRun[],
	parentId: string,
	agentName: string,
): ChildRecord | null {
	for (const { run } of runs) {
		if (nodeIdFromPath(run.path) !== parentId) continue;
		const child = run.children.find((candidate) => candidate.agent === agentName || candidate.name === agentName);
		if (child) return child;
	}
	return null;
}

function findSessionForRun(runs: readonly LoadedRun[], childRun: RunRecord): string | null {
	const lastIndex = lastNamedPathIndex(childRun.path);
	if (lastIndex === null) return null;
	const parentPath = childRun.path.slice(0, lastIndex);
	const parentId = nodeIdFromPath(parentPath);
	const agentName = childRun.path[lastIndex]?.agent;
	if (!agentName) return null;
	for (const { file, run } of runs) {
		if (nodeIdFromPath(run.path) !== parentId) continue;
		const child = run.children.find((candidate) => candidate.agent === agentName || candidate.name === agentName);
		if (child) return absoluteFromRunDir(child.sessionFile, path.dirname(file));
	}
	const ownDirectory = runs.find((entry) => entry.run.runId === childRun.runId);
	return ownDirectory ? path.join(path.dirname(ownDirectory.file), `${sanitizeNodeSlug(agentName)}.jsonl`) : null;
}

function absoluteFromRunDir(file: string, runDir: string): string {
	return path.isAbsolute(file) ? file : path.resolve(runDir, file);
}

function nodeDepth(id: string): number {
	return id === "root" ? 0 : id.split(".").length - 1;
}

function toMillis(value: string, clock: () => number): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : clock();
}

/**
 * Artifact reconstruction (contract `result-ledger-v1.md` D10).
 *
 * An artifact is self-describing on disk: `<runDir>/artifacts/<name>/r<round>.md`
 * carries its own name and round in the path, its size in `stat`, and its
 * settlement moment in the file mtime. The consuming parent and the producing
 * node are resolved **in this run's scope only** ({@link resolveArtifactOwner}) —
 * a pointer that does not resolve uniquely there is skipped with a warning,
 * because the only alternative is guessing, and a wrong `parent_id` addresses a
 * notice to the wrong node.
 *
 * A 0-byte file is not an artifact (A1/D1: empty output never produces one), so
 * it is skipped rather than recorded — recording it would create a row whose
 * `bytes` is below the `>= 1` invariant `recordArtifact` enforces.
 *
 * `consumptions` is deliberately NOT rebuilt: consumption is a fact of the
 * parent process with no on-disk source, so after a rebuild every recovered
 * artifact counts as unread (D10 — over-delivery, never silent loss).
 */
function rebuildArtifacts(
	db: DatabaseSync,
	runs: readonly LoadedRun[],
	warnings: RebuildWarning[],
): number {
	const seen = new Set<string>();
	let rebuilt = 0;
	for (const { file, run } of runs) {
		const artifactsRoot = path.join(path.dirname(file), ARTIFACTS_DIRECTORY);
		if (!fs.existsSync(artifactsRoot)) continue;
		for (const name of listDirectories(artifactsRoot)) {
			const nameDirectory = path.join(artifactsRoot, name);
			// One lookup per (run, name): every round under this directory belongs to
			// the same producing node.
			const owner = resolveArtifactOwner(db, run.runId, name);
			for (const entry of readDirectoryEntries(nameDirectory, warnings)) {
				const match = ARTIFACT_FILE_PATTERN.exec(entry);
				if (!match) continue;
				const round = Number(match[1]);
				const artifactPath = path.join(nameDirectory, entry);
				const id = `${run.runId}/${name}/r${round}`;
				if (seen.has(id)) continue;
				if (owner.kind !== "ok") {
					warnings.push({
						path: artifactPath,
						message:
							owner.kind === "ambiguous"
								? `skipped artifact ${id}: ${owner.matches} nodes named ${name} in run ${run.runId} — ambiguous, not guessed`
								: `skipped artifact ${id}: no node named ${name} under run ${run.runId} — never resolved outside its own run`,
					});
					continue;
				}
				let stats: fs.Stats;
				try {
					stats = fs.statSync(artifactPath);
				} catch (error) {
					warnings.push({ path: artifactPath, message: `skipped artifact ${id}: ${messageOf(error)}` });
					continue;
				}
				if (!stats.isFile()) continue;
				if (stats.size === 0) {
					warnings.push({ path: artifactPath, message: `skipped artifact ${id}: empty file is not an artifact (A1)` });
					continue;
				}
				try {
					recordArtifact(db, {
						id,
						parentId: owner.parentId,
						nodeId: owner.id,
						name,
						round,
						path: path.resolve(artifactPath),
						bytes: stats.size,
						createdAt: Math.round(stats.mtimeMs),
					});
				} catch (error) {
					warnings.push({ path: artifactPath, message: `could not rebuild artifact ${id}: ${messageOf(error)}` });
					continue;
				}
				seen.add(id);
				rebuilt += 1;
			}
		}
	}
	return rebuilt;
}

/** Result of {@link resolveArtifactOwner}: resolved, absent, or not unique. */
export type ArtifactOwnerResolution =
	| { kind: "ok"; id: string; parentId: string }
	| { kind: "missing" }
	| { kind: "ambiguous"; matches: number };

/**
 * The node that produced `<runDir>/artifacts/<name>/…`, resolved **inside the
 * run's own scope only**.
 *
 * A run directory belongs to one node (`nodes.run_id`), so the artifact's parent
 * is that node and its producer is the child named `<name>` underneath it. There
 * is deliberately **no tree-wide fallback**: a name that does not resolve inside
 * this run is skipped, because the only thing a global name lookup can produce is
 * a pointer into a *different* run's subtree — i.e. a notice addressed to the
 * wrong parent. Zero matches and multiple matches both answer
 * `missing`/`ambiguous` so the caller can warn instead of guessing.
 *
 * Exported for the rebuild tests: the ambiguity branch cannot be reached from a
 * well-formed on-disk tree (a run has exactly one owning node, and node names are
 * unique under a parent), so it is exercised against a hand-seeded `nodes` table.
 */
export function resolveArtifactOwner(
	db: DatabaseSync,
	runId: string,
	name: string,
): ArtifactOwnerResolution {
	const matches = db
		.prepare(
			`SELECT id, parent_id FROM nodes
			 WHERE name = ? AND parent_id IN (SELECT id FROM nodes WHERE run_id = ?)
			 ORDER BY id LIMIT 2`,
		)
		.all(sanitizeNodeSlug(name), runId);
	if (matches.length === 0) return { kind: "missing" };
	if (matches.length > 1) return { kind: "ambiguous", matches: matches.length };
	const row = matches[0];
	if (row === undefined || row.parent_id === null || row.parent_id === undefined) {
		return { kind: "missing" };
	}
	return { kind: "ok", id: String(row.id), parentId: String(row.parent_id) };
}

function readDirectoryEntries(directory: string, warnings: RebuildWarning[]): string[] {
	try {
		return fs.readdirSync(directory).sort();
	} catch (error) {
		warnings.push({ path: directory, message: `skipped unreadable directory: ${messageOf(error)}` });
		return [];
	}
}

function listDirectories(directory: string): string[] {
	try {
		return fs.readdirSync(directory).filter((entry) => {
			try {
				return fs.statSync(path.join(directory, entry)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		return [];
	}
}

function isRunRecord(value: unknown): value is RunRecord {
	if (value === null || typeof value !== "object") return false;
	const run = value as Record<string, unknown>;
	return typeof run.runId === "string" && typeof run.task === "string" &&
		typeof run.cwd === "string" && Array.isArray(run.path) &&
		Array.isArray(run.children) && typeof run.createdAt === "string" &&
		typeof run.updatedAt === "string";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
