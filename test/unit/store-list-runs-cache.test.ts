/**
 * #344: `RunStore.listRuns()` keeps a process-wide snapshot instead of re-parsing
 * every `run.json` on every call.
 *
 * The scan is `readdir` + one `readFileSync` + `JSON.parse` per run — 26ms at the
 * 352 runs this machine has, 110ms at 1000 synthetic ones — and every control
 * call paid it. Caching a registry is only safe if the cache cannot hand back a
 * registry the filesystem no longer agrees with, so these tests are mostly about
 * the invalidation edges: a write through THIS instance, a write through ANOTHER
 * instance on the same root (the tool surface builds a `RunStore` per call), a
 * run dir created out of band, and the TTL that bounds what a foreign process can
 * change in place.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { ChildRecord } from "../../src/shared/types.ts";
import { RunStore } from "../../src/runs/store.ts";

function tempRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "legion-list-runs-cache-"));
}

function child(name: string): ChildRecord {
	return {
		sessionFile: `/tmp/${name}.jsonl`,
		ownerToken: `tok-${name}`,
		state: "working",
		spawnedAt: "2026-01-01T00:00:00.000Z",
		agent: "worker",
		kind: "pi",
		name,
	};
}

/** A `run.json` written straight to disk, like a fixture or another process would. */
function writeRunOutOfBand(rootDir: string, runId: string, names: string[]): void {
	const dir = path.join(rootDir, "runs", runId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "run.json"),
		JSON.stringify(
			{
				schemaVersion: 1,
				runId,
				task: `out of band ${runId}`,
				cwd: "/p",
				herdr: {},
				path: [],
				depth: 0,
				maxDepth: 3,
				budget: { spawned: names.length, limit: null, granted: 0 },
				children: names.map((name) => child(name)),
				createdAt: "2030-01-01T00:00:00.000Z",
				updatedAt: "2030-01-01T00:00:00.000Z",
			},
			null,
			2,
		),
	);
	// Force a distinct directory mtime: the cache keys on it, and a fixture that
	// lands in the same filesystem timestamp tick must still be visible.
	const future = new Date(Date.now() + 5_000);
	fs.utimesSync(path.join(rootDir, "runs"), future, future);
}

/** Count `readRun` calls — one per run.json the scan re-parses. */
function countReadRun(store: RunStore) {
	const spy = mock.method(store, "readRun");
	return spy.mock;
}

test("#344 listRuns: a repeated call is served from the snapshot, not from disk", async () => {
	const root = tempRoot();
	try {
		const store = new RunStore({ rootDir: root });
		store.createRun({ task: "a", cwd: "/p" });
		const second = store.createRun({ task: "b", cwd: "/p" });
		await store.addChild(second.runId, child("worker-0"));

		const reads = countReadRun(store);
		const first = store.listRuns();
		assert.equal(first.length, 2);
		assert.equal(reads.callCount(), 2, "the cold call parses every run.json once");

		store.listRuns();
		store.listRuns();
		assert.equal(reads.callCount(), 2, "a warm call must not re-parse the registry");
	} finally {
		mock.restoreAll();
		rmSync(root, { recursive: true, force: true });
	}
});

test("#344 listRuns: createRun is visible on the very next call (and to other stores on the root)", () => {
	const root = tempRoot();
	try {
		const store = new RunStore({ rootDir: root });
		store.createRun({ task: "a", cwd: "/p" });
		assert.equal(store.listRuns().length, 1);

		const created = store.createRun({ task: "b", cwd: "/p" });
		const afterCreate = store.listRuns();
		assert.equal(afterCreate.length, 2, "an in-process create must invalidate the snapshot");
		assert.ok(afterCreate.some((record) => record.runId === created.runId));

		// The tool surface builds a RunStore per call, so a second instance on the
		// same root is the normal case — it must not be served the first one's view.
		const other = new RunStore({ rootDir: root });
		assert.equal(other.listRuns().length, 2);
		const third = store.createRun({ task: "c", cwd: "/p" });
		assert.equal(other.listRuns().length, 3, "a write through ANY instance on the root invalidates");
		assert.ok(other.listRuns().some((record) => record.runId === third.runId));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#344 listRuns: updateChild made through another store instance is visible immediately", async () => {
	const root = tempRoot();
	try {
		const store = new RunStore({ rootDir: root });
		const run = store.createRun({ task: "a", cwd: "/p" });
		await store.addChild(run.runId, child("worker-0"));
		assert.equal(store.listRuns()[0]?.children[0]?.state, "working");

		const writer = new RunStore({ rootDir: root });
		await writer.updateChild(run.runId, "worker-0", (record) => {
			record.state = "exited";
		});

		const updated = store.listRuns()[0]?.children[0];
		assert.equal(updated?.state, "exited", "a stale child record is exactly the bug a cache must not introduce");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#344 listRuns: a run dir created out of band is visible (directory mtime invalidates)", () => {
	const root = tempRoot();
	try {
		const store = new RunStore({ rootDir: root });
		store.createRun({ task: "a", cwd: "/p" });
		assert.equal(store.listRuns().length, 1);

		writeRunOutOfBand(root, "r-out0band", ["worker-9"]);

		const runs = store.listRuns();
		assert.equal(runs.length, 2, "a registry snapshot must not hide a run written by hand");
		assert.ok(runs.some((record) => record.runId === "r-out0band"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#344 listRuns: the injected clock bounds how long a snapshot is reused", () => {
	const root = tempRoot();
	try {
		let now = 1_000_000;
		const store = new RunStore({ rootDir: root, now: () => now });
		store.createRun({ task: "a", cwd: "/p" });

		const reads = countReadRun(store);
		store.listRuns();
		assert.equal(reads.callCount(), 1);
		store.listRuns();
		assert.equal(reads.callCount(), 1, "inside the TTL the snapshot is reused");

		// Nothing was written and no directory changed — only the clock moved. The
		// TTL is the one bound on a record another process rewrote in place.
		now += 5_000;
		store.listRuns();
		assert.equal(reads.callCount(), 2, "past the TTL the registry is re-read");
	} finally {
		mock.restoreAll();
		rmSync(root, { recursive: true, force: true });
	}
});

test("#344 listRuns: callers get their own array, so sorting one cannot corrupt the next", () => {
	const root = tempRoot();
	try {
		// Distinct createdAt per run: the scan sorts by it, and "oldest first" is
		// part of the contract this cache must not change.
		let tick = 1_700_000_000_000;
		const store = new RunStore({ rootDir: root, now: () => (tick += 1_000) });
		store.createRun({ task: "a", cwd: "/p" });
		store.createRun({ task: "b", cwd: "/p" });

		const first = store.listRuns();
		first.reverse();
		first.pop();
		const second = store.listRuns();
		assert.equal(second.length, 2);
		assert.notEqual(first, second);
		assert.deepEqual(
			second.map((record) => record.task),
			["a", "b"],
			"oldest first, exactly as an uncached scan returns it",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
