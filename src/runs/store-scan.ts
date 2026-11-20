/**
 * #450 — the run store is per-cwd, so a leftover launched from `~/code/anotify`
 * is invisible to a session started in `~/agents`: `status` lists nothing,
 * `recover` answers `No cross-machine child named …`, and the automatic re-attach
 * #445 added only ever looks at ONE store (`<cwd>/.pi-subagents`).
 *
 * #445's scan surface was correct for "the same cwd, a replaced session"; real
 * sessions launch across several repositories in one day, so the surface has to
 * be "every store this machine plausibly knows about" — while staying bounded and
 * without ever turning `status` into a `find /` walk.
 *
 * This module is discovery only. It answers "which store roots are worth looking
 * at, and in what order", plus the two label helpers the output needs
 * (`store=~/code/anotify`). It never reads a run, never writes anything, and it
 * never decides whether a child is live — those rules live in `reattach.ts`
 * (#445 §2/§3) and are quoted, not re-derived, by the callers.
 *
 * The surface, in priority order (a session store first, because that is the one
 * the caller already loaded):
 *
 *   1. the session's own cwd store — `<cwd>/.pi-subagents`;
 *   2. the caller's cwd store, when a tool call passed an explicit `cwd` (#270);
 *   3. when `cwd` is INSIDE `$HOME`: the cwd's ancestors within `$HOME` and
 *      `$HOME` itself, each walked to depth 2. That is exactly "sibling repos of
 *      the cwd" (`~/agents` finds `~/code/anotify`) and "`$HOME` one level of
 *      `<repo>/.pi-subagents`" (two levels below `$HOME` covers `~/code/anotify`,
 *      which is what the issue measured), without a filesystem walk;
 *   4. hidden directories, `node_modules` and `.pi-subagents` itself are never
 *      descended into, so this cannot wander into another worktree's internals.
 *
 * WHY the `$HOME` gate (rule 3 states what is scanned, this states what is not):
 * a session in `/tmp/scratch` does not scan `$HOME`, because a temp cwd is not
 * evidence that the user works in the home tree — and, more practically, every
 * test and every throwaway session would otherwise inherit the live children of
 * whatever repo happens to be checked out at home. The scan surface is "the tree
 * this session belongs to", not "the whole machine" (`$HOME` is the largest thing
 * we are willing to call that tree). A cwd outside `$HOME` still gets its own
 * store and an explicit `callerCwd`; it just does not reach across `$HOME`.
 *
 * Bounded on purpose (#445 §4 survives):
 *  - {@link MAX_LOCAL_STORES} stores at most, {@link MAX_SCAN_DIRS} directories
 *    read at most, depth capped at {@link SCAN_DEPTH};
 *  - hitting either cap is REPORTED (`stats.truncated` + one actionable
 *    `stats.skipped` sentence), never silently swallowed: the reattach log must be
 *    able to say why a store was not looked at;
 *  - deduped by resolved path, so the same store reached through a symlink or via
 *    two spelling (`cwd` and an ancestor's sibling walk) is looked at once.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Directory name every run store uses (`<cwd>/.pi-subagents`). */
export const STORE_DIR = ".pi-subagents";

/** Hard cap on stores one discovery pass returns. */
export const MAX_LOCAL_STORES = 32;
/** Hard cap on directories one discovery pass reads (a readdir each). */
export const MAX_SCAN_DIRS = 240;
/** How deep below a base directory the walk goes (`~/group/repo` is depth 2). */
export const SCAN_DEPTH = 2;
/** One readdir's names are cut here; a pathological directory must not decide the cost. */
export const MAX_DIR_ENTRIES = 400;

/** Why a store is in the surface. Kept in the output so a log can say where it came from. */
export type StoreScanReason =
	| "cwd"
	| "caller-cwd"
	| "ancestor"
	| "ancestor-nested"
	| "home"
	| "home-nested"
	| "sibling"
	| "sibling-nested"
	| "scan";

/** One store root worth reading, and the launch cwd it belongs to. */
export interface StoreLocation {
	/** `<cwd>/.pi-subagents`. */
	rootDir: string;
	/** The directory the store sits in: the launch cwd every record in it shares. */
	cwd: string;
	reason: StoreScanReason;
}

/**
 * What one discovery pass did. `stores` is the number RETURNED, `candidates` the
 * number of directories that looked like a store root (including ones over a cap),
 * `scannedDirs` the readdir count — the numbers the reattach log quotes.
 */
export interface StoreScanStats {
	scannedDirs: number;
	candidates: number;
	stores: number;
	truncated: boolean;
	/** True when the `$HOME` tree was part of the surface (cwd inside it). */
	homeScanned: boolean;
	/** One sentence per store/dir the pass refused to look at, with the reason. */
	skipped: Array<{ dir: string; reason: string }>;
}

export interface StoreScanInput {
	/** This session's cwd (the store it already loaded). */
	cwd: string;
	/** The directory a tool call passed as `cwd`, when it differs (#270). */
	callerCwd?: string | undefined;
	/** `$HOME` override (tests, and a host where `os.homedir()` is not the tree). */
	home?: string | undefined;
	env?: NodeJS.ProcessEnv | undefined;
	maxStores?: number | undefined;
	maxDirs?: number | undefined;
	/** Depth below a base directory. Defaults to {@link SCAN_DEPTH}. */
	depth?: number | undefined;
	/** Test seam: one `readdir` of names (never throws, `[]` on failure). */
	readdir?: (dir: string) => string[];
	/** Test seam: is this path a directory? */
	isDir?: (dir: string) => boolean;
	/** Test seam: the resolved spelling used for dedupe. */
	realpath?: (target: string) => string | undefined;
}

export interface StoreScanResult {
	stores: StoreLocation[];
	stats: StoreScanStats;
}

function homeOf(input: { home?: string | undefined; env?: NodeJS.ProcessEnv | undefined }): string | undefined {
	const raw = input.home ?? input.env?.HOME ?? input.env?.USERPROFILE ?? os.homedir();
	if (typeof raw !== "string" || raw.length === 0) return undefined;
	return path.resolve(raw);
}

/** `cwd` is `home` or lives under it. */
export function insideHome(cwd: string, home: string | undefined): boolean {
	if (home === undefined) return false;
	const resolvedCwd = path.resolve(cwd);
	const relative = path.relative(home, resolvedCwd);
	return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function defaultReaddir(dir: string): string[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return [];
	}
}

function defaultIsDir(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function defaultRealpath(target: string): string | undefined {
	try {
		return fs.realpathSync(target);
	} catch {
		// The store dir may not exist yet (the cwd root is unconditional); resolve
		// the parent, which is what two spellings of one cwd share.
		try {
			return path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
		} catch {
			return undefined;
		}
	}
}

/** Directories never worth descending into: dot dirs, `node_modules`, the store itself. */
function skipEntry(name: string): boolean {
	if (name.length === 0 || name.startsWith(".")) return true;
	if (name === "node_modules") return true;
	// A vendored dependency tree and the usual build outputs: thousands of
	// directories that cannot hold a session store (they are not launch cwds).
	return name === "dist" || name === "build" || name === "target" || name === "__pycache__";
}

/** The directory a store root belongs to (`dirname` of `<cwd>/.pi-subagents`). */
export function storeCwdOf(rootDir: string): string {
	return path.dirname(path.resolve(rootDir));
}

/** Is this rootDir the store of the same cwd as `other` (resolved spelling)? */
export function sameStore(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b);
}

/**
 * `~/code/anotify` for a store under `$HOME`, the absolute cwd otherwise.
 *
 * The label is what `status`/the reattach summary print (`store=…`), so it must
 * be the shortest spelling a human can still type: the store's own cwd, with
 * `$HOME` folded to `~` when it is inside it.
 */
export function formatStoreLabel(rootDir: string, opts: { home?: string | undefined; env?: NodeJS.ProcessEnv } = {}): string {
	const cwd = storeCwdOf(rootDir);
	const home = homeOf(opts);
	if (home === undefined) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}${path.sep}`)) return `~/${path.relative(home, cwd).split(path.sep).join("/")}`;
	return cwd;
}

/**
 * Every store root this session may legitimately look at, deduped, session store
 * first. Pure read-only discovery: no `RunStore`, no ledger, no wire.
 */
export function discoverLocalStores(input: StoreScanInput): StoreScanResult {
	const readdir = input.readdir ?? defaultReaddir;
	const isDir = input.isDir ?? defaultIsDir;
	const realpath = input.realpath ?? defaultRealpath;
	const maxStores = Math.max(1, input.maxStores ?? MAX_LOCAL_STORES);
	const maxDirs = Math.max(1, input.maxDirs ?? MAX_SCAN_DIRS);
	const depth = Math.max(0, input.depth ?? SCAN_DEPTH);
	const home = homeOf(input);
	const stats: StoreScanStats = {
		scannedDirs: 0,
		candidates: 0,
		stores: 0,
		truncated: false,
		homeScanned: false,
		skipped: [],
	};
	const stores: StoreLocation[] = [];
	const seen = new Set<string>();

	const canonical = (dir: string): string => {
		const resolved = path.resolve(dir);
		return realpath(resolved) ?? resolved;
	};
	/**
	 * Record one candidate directory. `mustExist` is false for the two roots the
	 * caller already knows (`cwd`/`callerCwd`): their store may be materialised by
	 * this very session, and "the session's own store" is never a guess.
	 */
	const push = (dir: string, reason: StoreScanReason, mustExist: boolean): void => {
		const cwd = path.resolve(dir);
		const rootDir = path.join(cwd, STORE_DIR);
		const key = canonical(rootDir);
		if (seen.has(key)) return;
		if (mustExist && !isDir(rootDir)) return;
		stats.candidates += 1;
		if (stores.length >= maxStores) {
			stats.truncated = true;
			if (stats.skipped.length < 8) {
				stats.skipped.push({ dir: cwd, reason: `over the ${maxStores}-store cap (${reason}); a later session with fewer stores looks again` });
			}
			return;
		}
		seen.add(key);
		stores.push({ rootDir, cwd, reason });
	};

	push(input.cwd, "cwd", false);
	if (input.callerCwd !== undefined && path.resolve(input.callerCwd) !== path.resolve(input.cwd)) {
		push(input.callerCwd, "caller-cwd", false);
	}

	const bases: Array<{ dir: string; reason: StoreScanReason; nested: StoreScanReason }> = [];
	if (insideHome(input.cwd, home) && home !== undefined) {
		stats.homeScanned = true;
		// Ancestors from the cwd's parent up to `$HOME`: the closest one is the
		// strongest "sibling repo" signal, `$HOME` the broadest. A session started IN
		// `$HOME` has no ancestors above it inside the tree, so `$HOME` itself is the base
		// (its "sibling repos" are one level BELOW it, not beside it).
		const cwdResolved = path.resolve(input.cwd);
		let cursor = cwdResolved === home ? home : path.dirname(cwdResolved);
		const ancestors: string[] = [];
		while (insideHome(cursor, home)) {
			ancestors.push(cursor);
			if (cursor === home) break;
			const next = path.dirname(cursor);
			if (next === cursor) break;
			cursor = next;
		}
		for (const ancestor of ancestors) {
			const isHome = ancestor === home;
			bases.push({
				dir: ancestor,
				reason: isHome ? "home" : "sibling",
				nested: isHome ? "home-nested" : "ancestor-nested",
			});
		}
	}

	const walk = (base: string, reason: StoreScanReason, nested: StoreScanReason, remaining: number): void => {
		if (remaining <= 0 || stats.scannedDirs >= maxDirs) {
			if (stats.scannedDirs >= maxDirs) stats.truncated = true;
			return;
		}
		stats.scannedDirs += 1;
		const names = readdir(base).slice().sort();
		let entries = 0;
		for (const name of names) {
			if (skipEntry(name)) continue;
			if (entries >= MAX_DIR_ENTRIES) {
				stats.truncated = true;
				stats.skipped.push({ dir: base, reason: `more than ${MAX_DIR_ENTRIES} entries under ${base}; the rest of this directory is not scanned` });
				break;
			}
			entries += 1;
			const dir = path.join(base, name);
			if (!isDir(dir)) continue;
			push(dir, reason, true);
			if (remaining > 1) walk(dir, nested, nested, remaining - 1);
		}
	};

	for (const base of bases) {
		walk(base.dir, base.reason, base.nested, depth);
	}

	stats.stores = stores.length;
	return { stores, stats };
}

/**
 * {@link discoverLocalStores} plus each store's runs — the shape the `status` /
 * `list` / `recover` call sites need.
 *
 * `listRuns` is injectable so a test can drive the surface without constructing a
 * `RunStore`; production passes `RunStore`'s own reader. A store that cannot be
 * read contributes `runs: []` and a `skipped` sentence rather than failing the
 * whole scan: one unreadable store must not cost the session the others.
 */
export function scanLocalStoreRuns<T>(
	input: StoreScanInput & { listRuns?: (rootDir: string) => T[] },
): { stores: Array<StoreLocation & { runs: T[] }>; stats: StoreScanStats } {
	const discovered = discoverLocalStores(input);
	const read = input.listRuns;
	if (read === undefined) return { stores: discovered.stores.map((store) => ({ ...store, runs: [] })), stats: discovered.stats };
	const stores = discovered.stores.map((store) => {
		try {
			return { ...store, runs: read(store.rootDir) };
		} catch (error) {
			discovered.stats.skipped.push({
				dir: store.cwd,
				reason: `its runs could not be listed (${error instanceof Error ? error.message : String(error)})`,
			});
			return { ...store, runs: [] };
		}
	});
	return { stores, stats: discovered.stats };
}
