/**
 * Cross-store child lookup (issue #270).
 *
 * Child records live under `<cwd>/.pi-subagents`, so a control call such as
 * `subagent({action:"status", name})` can only see children launched from the
 * exact same `cwd`. In practice that assumption breaks in two ordinary ways:
 *
 *  1. A user launches from one directory and later runs a control call from
 *     another. Nothing records "where you launched it", so the miss is
 *     indistinguishable from a typo.
 *  2. A `worktree: true` role (centurion) is spawned INTO a git worktree:
 *     `orchestrator.ts` passes `cwd: worktreePath ?? this.cwd` to the child, so
 *     the child's own run store lands in `<runDir>/worktrees/<name>/.pi-subagents`
 *     — a tree the parent's root store can never enumerate.
 *
 * The fix is a bounded, read-only search of the stores that can plausibly hold
 * the record, plus a message that names the directory instead of asking the
 * caller to remember it.
 *
 * Bounded on purpose:
 *  - only stores reachable from the two known roots (the current `cwd` and the
 *    caller's `cwd`), never a scan of `$HOME` or the filesystem;
 *  - at most `MAX_SEARCHED_STORES` candidates, each probed with a single
 *    `readdir` of `runs/`;
 *  - `readdir` only — never `createRun`/`ensureRootUsable`, because a lookup
 *    must not materialise directories in a tree the user cannot write.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { RunStore, pickChildByName } from "./store.ts";
import type { RunRecord } from "../shared/types.ts";

/** Directory name every run store uses. */
export const STORE_DIR_NAME = ".pi-subagents";

/**
 * Hard cap on candidate stores. A worktree-heavy run can nest a store per
 * centurion; the cap keeps a pathological tree from turning one status call
 * into a filesystem walk.
 */
export const MAX_SEARCHED_STORES = 24;

/** A store that actually contains run records (so a miss there is meaningful). */
export interface CandidateStore {
	rootDir: string;
	/** Why this directory is a candidate, for the error message. */
	reason: "cwd" | "caller-cwd" | "worktree";
	/** Run records found in it (empty when the directory is unreadable). */
	runs: readonly RunRecord[];
}

/** The store a lookup resolved to, when it did. */
export interface ResolvedChildLocation {
	storeRoot: string;
	runId: string;
	reason: CandidateStore["reason"];
	name: string;
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Cheap existence probe: does `<root>/runs` hold at least one run directory?
 *
 * Deliberately one `readdir`, not `run.json` parsing: a store that exists but
 * holds no runs must NOT be offered as "the place to look", because a miss
 * there would send the caller in a circle.
 */
function hasRuns(rootDir: string): boolean {
	try {
		return fs
			.readdirSync(path.join(rootDir, "runs"), { withFileTypes: true })
			.some((entry) => entry.isDirectory());
	} catch {
		return false;
	}
}

function storeRootOf(cwd: string): string {
	return path.join(cwd, STORE_DIR_NAME);
}

/**
 * The store roots worth probing for one lookup, most likely first.
 *
 * `cwd` is the store the call already resolved (so its runs are already loaded
 * by the caller and it is listed here only for completeness). `parentOf` climbs
 * the run's own `worktrees/` directory, which is where a worktree child's store
 * lives: `<runDir>/worktrees/<child>/.pi-subagents`.
 */
export function candidateStoreRoots(input: {
	cwd: string;
	/** The directory the caller's context runs in, when it differs from `cwd`. */
	callerCwd?: string | undefined;
	/** Run directory of the store already searched (`<root>/runs/<runId>`). */
	runDir?: string | undefined;
}): Array<{ rootDir: string; reason: CandidateStore["reason"] }> {
	const out: Array<{ rootDir: string; reason: CandidateStore["reason"] }> = [];
	const seen = new Set<string>();
	const push = (rootDir: string, reason: CandidateStore["reason"]): void => {
		const resolved = path.resolve(rootDir);
		if (seen.has(resolved) || out.length >= MAX_SEARCHED_STORES) return;
		seen.add(resolved);
		out.push({ rootDir: resolved, reason });
	};

	push(storeRootOf(input.cwd), "cwd");
	if (input.callerCwd !== undefined) push(storeRootOf(input.callerCwd), "caller-cwd");

	// Sibling stores: a session started in `<base>/legion-demo` leaves its records
	// there, and the reported case had the caller standing in `<base>` — one level
	// up, looking at an empty store. Probing the immediate children of both known
	// directories covers "I launched from a subdirectory" without a filesystem
	// walk.
	for (const base of [input.cwd, input.callerCwd]) {
		if (base === undefined) continue;
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(base, { withFileTypes: true });
		} catch {
			entries = [];
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === STORE_DIR_NAME) continue;
			push(path.join(base, entry.name, STORE_DIR_NAME), "caller-cwd");
		}
	}

	// Worktree stores: every `<runDir>/worktrees/<name>` is a spawn root whose
	// `.pi-subagents` belongs to that child. One level of `worktrees/` is the
	// real shape (`src/runs/worktree.ts`); deeper nesting is reached by the
	// recursive search below rather than by guessing path names here.
	if (input.runDir !== undefined) {
		const worktreesDir = path.join(input.runDir, "worktrees");
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
		} catch {
			entries = [];
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			push(path.join(worktreesDir, entry.name, STORE_DIR_NAME), "worktree");
		}
	}
	return out;
}

/**
 * Look for `name` in every candidate store.
 *
 * Returns the first hit plus every candidate that was actually examined, so the
 * caller can report "searched these directories" instead of a single guess.
 * Read-only: a store directory is only opened when `runs/` already has entries.
 */
export function resolveChildAcrossStores(input: {
	name: string;
	cwd: string;
	callerCwd?: string | undefined;
	runDir?: string | undefined;
	/** Injectable for tests. */
	roots?: ReturnType<typeof candidateStoreRoots>;
}): { found: ResolvedChildLocation | null; searched: CandidateStore[] } {
	const roots = input.roots ?? candidateStoreRoots(input);
	const searched: CandidateStore[] = [];
	for (const candidate of roots) {
		if (!hasRuns(candidate.rootDir)) continue;
		let runs: readonly RunRecord[];
		try {
			runs = new RunStore({ rootDir: candidate.rootDir }).listRuns();
		} catch {
			continue;
		}
		searched.push({ rootDir: candidate.rootDir, reason: candidate.reason, runs });
		const picked = pickChildByName([...runs], input.name);
		if (picked) {
			return {
				found: {
					storeRoot: candidate.rootDir,
					runId: picked.run.runId,
					reason: candidate.reason,
					name: picked.child.name,
				},
				searched,
			};
		}
	}
	return { found: null, searched };
}

/** Distinct child names visible across the searched stores, for a miss message. */
export function knownChildNames(
	searched: readonly CandidateStore[],
	limit = 12,
): { names: string[]; total: number; truncated: boolean } {
	const seen = new Set<string>();
	for (const store of searched) {
		for (const run of store.runs) {
			for (const child of run.children) seen.add(child.name);
		}
	}
	const all = [...seen].sort();
	return { names: all.slice(0, limit), total: all.length, truncated: all.length > limit };
}

/** Where a store sits relative to the cwd the caller used, for the message. */
function describeRoot(rootDir: string, cwd: string, reason: CandidateStore["reason"]): string {
	const relative = path.relative(cwd, rootDir);
	const label = reason === "worktree" ? " (a child's worktree)" : reason === "caller-cwd" ? " (the caller's cwd)" : "";
	if (relative === "" || relative === STORE_DIR_NAME) return `${rootDir}${label}`;
	return `${rootDir}${label}`;
}

/**
 * The miss message.
 *
 * Structure follows the house style used by `spawn-hints.ts`: what was searched,
 * why the miss is expected, then the exact next command. Three concrete
 * improvements over the old text:
 *
 *  - the absolute directory is printed (the old `${cwd}/.pi-subagents` was a
 *    path concatenation that only looked absolute);
 *  - names actually present are listed once each and capped, so the message
 *    stays readable on a busy store (measured 146 records / 61 unique names
 *    previously produced a 1717-character error);
 *  - it suggests `cwd:` with a real directory rather than "the same cwd you
 *    used for launch", which the caller cannot know.
 */
export function unknownChildMessage(input: {
	name: string;
	cwd: string;
	searched: readonly CandidateStore[];
}): string {
	const lines: string[] = [`unknown child: ${input.name}`];
	if (input.searched.length === 0) {
		lines.push(`  no child records found near ${input.cwd}: ${storeRootOf(input.cwd)} has no runs`);
		lines.push(
			`  Fix: pass \`cwd\` with the directory you launched from — records live in <cwd>/${STORE_DIR_NAME}.`,
		);
		return lines.join("\n");
	}
	lines.push("  searched:");
	for (const store of input.searched) {
		lines.push(`    - ${describeRoot(store.rootDir, input.cwd, store.reason)}`);
	}
	const known = knownChildNames(input.searched);
	if (known.names.length > 0) {
		lines.push(
			`  known here: ${known.names.join(", ")}${known.truncated ? `, … (${known.total} total)` : ""}`,
		);
	}
	lines.push(
		`  Fix: child records are scoped to a store — retry with \`cwd\` set to the directory listed above that owns the run.`,
	);
	return lines.join("\n");
}
