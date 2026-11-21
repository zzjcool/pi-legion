/**
 * #450 — the scan surface is every store this machine plausibly knows about, not
 * just the session's cwd store.
 *
 * The unit half pins the DISCOVERY decisions (`src/runs/store-scan.ts`); the
 * reattach pass and the tool surface consume them, and
 * `test/integration/reattach-cross-store.test.ts` proves the same surface end to
 * end through the real `hc` client.
 *
 * Each case names the #450 clause it holds:
 *
 *   1. launch-cwd per store: every store location carries the cwd its records
 *      were launched from (the store's own directory), so output can say
 *      `store=~/code/anotify` without a new run.json field;
 *   2. the surface: cwd, caller cwd, the cwd's ancestors inside `$HOME` and the
 *      `$HOME` tree to depth 2 — which is how `~/agents` finds a child launched
 *      from `~/code/anotify`;
 *   3. bounded: `MAX_LOCAL_STORES` / `MAX_SCAN_DIRS` / depth, deduped, and every
 *      refusal carries a sentence a human can act on;
 *   4. hermetic: a cwd OUTSIDE `$HOME` does not scan `$HOME` at all (a throwaway
 *      session must not inherit somebody else's live children).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
	discoverLocalStores,
	formatStoreLabel,
	insideHome,
	MAX_SCAN_DIRS,
	sameStore,
	SCAN_DEPTH,
	scanLocalStoreRuns,
	STORE_DIR,
	storeCwdOf,
} from "../../src/runs/store-scan.ts";

// ── a fake filesystem ───────────────────────────────────────────────────────

/**
 * The real shape the issue measured: `$HOME/agents` is where the new session
 * starts, `$HOME/code/anotify` is where the leftover was launched from. A fake
 * tree keeps the case exact (no dependency on this machine's real `$HOME`).
 */
interface FakeTree {
	home: string;
	dirs: Set<string>;
}

function fakeTree(paths: string[], home: string): FakeTree {
	return { home, dirs: new Set(paths.map((entry) => path.resolve(entry))) };
}

function scanFake(tree: FakeTree, input: { cwd: string; callerCwd?: string; maxStores?: number; maxDirs?: number; depth?: number }) {
	return discoverLocalStores({
		cwd: input.cwd,
		...(input.callerCwd !== undefined ? { callerCwd: input.callerCwd } : {}),
		home: tree.home,
		...(input.maxStores !== undefined ? { maxStores: input.maxStores } : {}),
		...(input.maxDirs !== undefined ? { maxDirs: input.maxDirs } : {}),
		...(input.depth !== undefined ? { depth: input.depth } : {}),
		// The seams read the fake tree: a directory whose `<dir>/.pi-subagents`
		// exists is a store unless the fake tree lists it as a plain directory.
		readdir: (dir) => {
			const base = path.resolve(dir);
			const names = new Set<string>();
			for (const entry of tree.dirs) {
				const rel = path.relative(base, entry);
				if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
				const [first] = rel.split(path.sep);
				if (first !== undefined && first.length > 0) names.add(first);
			}
			return [...names];
		},
		isDir: (dir) => tree.dirs.has(path.resolve(dir)),
		realpath: (target) => path.resolve(target),
	});
}

const HOME = "/home/u";

/** `$HOME/code/anotify` etc., with the store dirs the scan looks for. */
function homeTree(): FakeTree {
	const dirs = [
		HOME,
		`${HOME}/agents`,
		`${HOME}/agents/${STORE_DIR}`,
		`${HOME}/code`,
		`${HOME}/code/anotify`,
		`${HOME}/code/anotify/${STORE_DIR}`,
		`${HOME}/code/pi-legion`,
		`${HOME}/code/pi-legion/${STORE_DIR}`,
		`${HOME}/code/pi-async`,
		`${HOME}/code/pi-async/${STORE_DIR}`,
		// Noise the walk must not mistake for a store or descend into.
		`${HOME}/.cache`,
		`${HOME}/.cache/${STORE_DIR}`,
		`${HOME}/code/anotify/node_modules`,
		`${HOME}/code/anotify/node_modules/${STORE_DIR}`,
		`${HOME}/code/anotify/.git`,
		`${HOME}/code/anotify/deep`,
		`${HOME}/code/anotify/deep/er`,
		`${HOME}/code/anotify/deep/er/${STORE_DIR}`,
	];
	return fakeTree(dirs, HOME);
}

// ── §2 the surface ──────────────────────────────────────────────────────────

test("#450 A1: a session in ~/agents discovers the store a launch from ~/code/anotify left", () => {
	const tree = homeTree();
	const { stores, stats } = scanFake(tree, { cwd: `${HOME}/agents` });
	const labels = stores.map((store) => formatStoreLabel(store.rootDir, { home: HOME }));
	assert.ok(labels.includes("~/code/anotify"), `expected ~/code/anotify in ${labels.join(", ")}`);
	// The session store is first, so a caller that already loaded it reads it first.
	assert.equal(stores[0]!.cwd, `${HOME}/agents`);
	assert.equal(stores[0]!.reason, "cwd");
	// The store is returned with the launch cwd it belongs to — no new run.json field.
	const anotify = stores.find((store) => store.cwd === `${HOME}/code/anotify`)!;
	assert.equal(anotify.rootDir, `${HOME}/code/anotify/.pi-subagents`);
	assert.equal(storeCwdOf(anotify.rootDir), `${HOME}/code/anotify`);
	assert.equal(stats.homeScanned, true);
	assert.equal(stats.truncated, false);
});

test("#450: a session started IN $HOME still finds the repos below it (depth 2 from home)", () => {
	// The real-machine case that exposed this: `~/agents` is inside home, but so is a
	// session started at `~` itself — and its "sibling repos" are one level BELOW it.
	const tree = homeTree();
	const { stores } = scanFake(tree, { cwd: HOME });
	const cwds = stores.map((store) => store.cwd);
	assert.equal(cwds[0], HOME);
	assert.ok(cwds.includes(`${HOME}/code/anotify`), `expected ~/code/anotify in ${cwds.join(", ")}`);
	assert.ok(cwds.includes(`${HOME}/code/pi-legion`));
});

test("#450: the cwd's own store is returned even before it exists (this session may create it)", () => {
	const tree = fakeTree([`${HOME}/agents`, `${HOME}/code/anotify`, `${HOME}/code/anotify/${STORE_DIR}`], HOME);
	const { stores } = scanFake(tree, { cwd: `${HOME}/agents` });
	assert.equal(stores[0]!.rootDir, `${HOME}/agents/.pi-subagents`);
	assert.equal(existsSync(stores[0]!.rootDir), false);
});

test("#450: a caller cwd store is part of the surface exactly once", () => {
	const tree = homeTree();
	const { stores } = scanFake(tree, { cwd: `${HOME}/agents`, callerCwd: `${HOME}/code/pi-legion` });
	const piLegion = stores.filter((store) => store.cwd === `${HOME}/code/pi-legion`);
	assert.equal(piLegion.length, 1, "the ancestor walk reaches the same store; it must not be listed twice");
	const same = scanFake(tree, { cwd: `${HOME}/code/pi-legion`, callerCwd: `${HOME}/code/pi-legion` });
	assert.equal(same.stores.filter((store) => store.cwd === `${HOME}/code/pi-legion`).length, 1);
});

test("#450: hidden dirs, node_modules and .pi-subagents are never descended into", () => {
	const tree = homeTree();
	const { stores } = scanFake(tree, { cwd: `${HOME}/agents` });
	const cwds = stores.map((store) => store.cwd);
	assert.ok(!cwds.some((cwd) => cwd.includes("/.cache")), "a dot directory is not a launch cwd");
	assert.ok(!cwds.some((cwd) => cwd.includes("/node_modules")), "a dependency tree is not a launch cwd");
	assert.ok(!cwds.some((cwd) => cwd.endsWith(STORE_DIR)), "a store inside a store is not scanned");
	// Depth: `~/code/anotify/deep/er` is depth 4 below home, outside SCAN_DEPTH.
	assert.ok(!cwds.some((cwd) => cwd.endsWith("/deep/er")), "deeper than SCAN_DEPTH is not scanned");
});

test("#450 A1 (hermetic): a cwd OUTSIDE $HOME does not scan $HOME at all", () => {
	const tree = homeTree();
	tree.dirs.add("/tmp/scratch");
	tree.dirs.add("/tmp/scratch/app");
	tree.dirs.add("/tmp/scratch/app/.pi-subagents");
	const { stores, stats } = scanFake(tree, { cwd: "/tmp/scratch/app" });
	assert.deepEqual(stores.map((store) => store.cwd), ["/tmp/scratch/app"]);
	assert.equal(stats.homeScanned, false);
	// And the caller's cwd still reaches its own store.
	const withCaller = scanFake(tree, { cwd: "/tmp/scratch/app", callerCwd: `${HOME}/code/anotify` });
	assert.deepEqual(withCaller.stores.map((store) => store.cwd), ["/tmp/scratch/app", `${HOME}/code/anotify`]);
});

test("#450: insideHome is a path-prefix test, not a string prefix one", () => {
	assert.equal(insideHome("/home/u", "/home/u"), true);
	assert.equal(insideHome("/home/u/code/x", "/home/u"), true);
	assert.equal(insideHome("/home/u2/code", "/home/u"), false);
	assert.equal(insideHome("/tmp/x", undefined), false);
});

// ── §3 bounded ──────────────────────────────────────────────────────────────

test("#450 A5: the store cap is reported, with a reason, instead of silently shrinking the surface", () => {
	const dirs = [HOME];
	for (let index = 0; index < 6; index += 1) {
		dirs.push(`${HOME}/repo${index}`, `${HOME}/repo${index}/${STORE_DIR}`);
	}
	const tree = fakeTree(dirs, HOME);
	const { stores, stats } = scanFake(tree, { cwd: `${HOME}/repo0`, maxStores: 3 });
	assert.equal(stores.length, 3);
	assert.equal(stats.truncated, true);
	assert.ok(stats.skipped.some((entry) => /over the 3-store cap/.test(entry.reason)), JSON.stringify(stats.skipped));
	assert.ok(stats.candidates > stores.length, "the pass knows how many store roots it refused");
});

test("#450 A5: the readdir budget stops the walk and says so", () => {
	const dirs = [HOME];
	for (let index = 0; index < 12; index += 1) {
		dirs.push(`${HOME}/g${index}`, `${HOME}/g${index}/repo`, `${HOME}/g${index}/repo/${STORE_DIR}`);
	}
	const tree = fakeTree(dirs, HOME);
	const { stores, stats } = scanFake(tree, { cwd: `${HOME}/g0/repo`, maxDirs: 5 });
	assert.ok(stats.scannedDirs <= 5, `scanned ${stats.scannedDirs}`);
	assert.equal(stats.truncated, true);
	assert.ok(stores.length < 13);
});

test("#450: MAX_SCAN_DIRS and SCAN_DEPTH are the frozen defaults", () => {
	assert.equal(MAX_SCAN_DIRS, 240);
	assert.equal(SCAN_DEPTH, 2);
});

test("#450: two spellings of one store (a symlink) are one candidate", () => {
	const root = mkdtempSync(path.join(tmpdir(), "store-scan-"));
	try {
		const real = path.join(root, "real");
		const link = path.join(root, "link");
		mkdirSync(path.join(real, STORE_DIR), { recursive: true });
		symlinkSync(real, link);
		const { stores } = discoverLocalStores({
			cwd: real,
			callerCwd: link,
			home: root,
			readdir: (dir) => {
				try {
					return [path.basename(dir)] as string[];
				} catch {
					return [];
				}
			},
			// Real fs defaults except readdir: the dedupe must use the resolved path.
			isDir: (dir) => {
				try {
					return existsSync(dir) && path.basename(dir) !== "";
				} catch {
					return false;
				}
			},
		});
		// `cwd` and `callerCwd` are two spellings of the same store: one entry.
		assert.equal(stores.filter((store) => sameStore(store.rootDir, path.join(real, STORE_DIR))).length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── §1 launch-cwd + labels ──────────────────────────────────────────────────

test("#450 A4: formatStoreLabel folds $HOME to ~ and leaves anything else absolute", () => {
	assert.equal(formatStoreLabel(`${HOME}/code/anotify/.pi-subagents`, { home: HOME }), "~/code/anotify");
	assert.equal(formatStoreLabel(`${HOME}/.pi-subagents`, { home: HOME }), "~");
	assert.equal(formatStoreLabel("/srv/repo/.pi-subagents", { home: HOME }), "/srv/repo");
	assert.equal(formatStoreLabel("/srv/repo/.pi-subagents", { home: undefined, env: {} }), "/srv/repo");
});

test("#450: storeCwdOf/sameStore are the identity helpers callers key on", () => {
	assert.equal(storeCwdOf("/a/b/.pi-subagents"), "/a/b");
	assert.equal(sameStore("/a/b/.pi-subagents", "/a/b/../b/.pi-subagents"), true);
	assert.equal(sameStore("/a/b/.pi-subagents", "/a/c/.pi-subagents"), false);
});

// ── scanLocalStoreRuns ──────────────────────────────────────────────────────

test("#450: scanLocalStoreRuns attaches each store's runs and survives one unreadable store", () => {
	const tree = homeTree();
	const input = {
		cwd: `${HOME}/agents`,
		home: HOME,
		readdir: (dir: string) => {
			const base = path.resolve(dir);
			const names = new Set<string>();
			for (const entry of tree.dirs) {
				const rel = path.relative(base, entry);
				if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
				const first = rel.split(path.sep)[0];
				if (first !== undefined) names.add(first);
			}
			return [...names];
		},
		isDir: (dir: string) => tree.dirs.has(path.resolve(dir)),
		realpath: (target: string) => path.resolve(target),
		listRuns: (rootDir: string) => {
			if (rootDir === `${HOME}/code/pi-legion/.pi-subagents`) throw new Error("EACCES");
			return [{ runId: `r-${path.basename(storeCwdOf(rootDir))}`, cwd: storeCwdOf(rootDir), createdAt: "2026-01-01T00:00:00.000Z", children: [] }];
		},
	};
	const { stores, stats } = scanLocalStoreRuns(input as never);
	const anotify = stores.find((store) => store.cwd === `${HOME}/code/anotify`)!;
	assert.equal(anotify.runs.length, 1);
	assert.equal((anotify.runs[0] as { cwd: string }).cwd, `${HOME}/code/anotify`);
	const piLegion = stores.find((store) => store.cwd === `${HOME}/code/pi-legion`)!;
	assert.deepEqual(piLegion.runs, []);
	assert.ok(stats.skipped.some((entry) => entry.dir === `${HOME}/code/pi-legion` && /could not be listed/.test(entry.reason)));
});
