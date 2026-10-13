import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { appendEvent } from "../../src/legion/events.ts";
import { RunStore } from "../../src/runs/store.ts";
import { RUN_OWNER_FILE, TEMP_OWNER_FILE, isPidAlive, ownerState, readOwnerFile, writeOwnerFile } from "../../src/runs/owner.ts";
import { HYGIENE_DEFAULTS, applyEventRetention, formatHygieneReport, hygieneEnabled, resolveHygieneConfig, runStartupHygiene } from "../../src/runs/hygiene.ts";

const DAY = 24 * 60 * 60 * 1000;
const DEAD = 2 ** 22 + 12345; // beyond default pid_max on most hosts
const alive = (pid: number) => pid === process.pid;

function store(): { root: string; store: RunStore } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyg-"));
	return { root, store: new RunStore({ rootDir: root }) };
}

function age(p: string, ms: number): void {
	const t = new Date(Date.now() - ms);
	fs.utimesSync(p, t, t);
	if (fs.statSync(p).isDirectory()) for (const n of fs.readdirSync(p)) fs.utimesSync(path.join(p, n), t, t);
}

function makeRun(s: RunStore, owner: number | undefined, ageMs = 0): string {
	const run = s.createRun({ task: "t", cwd: "/x" });
	const dir = s.runDir(run.runId);
	if (owner === undefined) fs.rmSync(path.join(dir, RUN_OWNER_FILE));
	else writeOwnerFile(path.join(dir, RUN_OWNER_FILE), owner);
	if (ageMs) age(dir, ageMs);
	return dir;
}

test("owner markers: createRun records this pid; liveness verdicts", () => {
	const { store: s } = store();
	const run = s.createRun({ task: "t", cwd: "/x" });
	assert.equal(readOwnerFile(path.join(s.runDir(run.runId), RUN_OWNER_FILE))?.pid, process.pid);
	assert.equal(isPidAlive(process.pid), true);
	assert.equal(isPidAlive(DEAD), false);
	const f = path.join(s.runDir(run.runId), "x.owner");
	assert.equal(ownerState(f), "unknown");
	writeOwnerFile(f, DEAD);
	assert.equal(ownerState(f), "dead");
	writeOwnerFile(f, process.pid);
	assert.equal(ownerState(f), "live");
});

test("#38 sweep removes rpc-child dirs of dead owners and stale legacy dirs only", () => {
	const { root, store: s } = store();
	const dir = makeRun(s, process.pid);
	const mk = (name: string, owner?: number) => {
		const d = path.join(dir, name);
		fs.mkdirSync(d);
		fs.writeFileSync(path.join(d, "task.md"), "x".repeat(1000));
		if (owner !== undefined) writeOwnerFile(path.join(d, TEMP_OWNER_FILE), owner);
		return d;
	};
	const dead = mk("rpc-child-dead", DEAD);
	const live = mk("rpc-child-live", process.pid);
	const legacyOld = mk("rpc-child-legacyold");
	age(legacyOld, 2 * DAY);
	const legacyNew = mk("rpc-child-legacynew");
	const r = runStartupHygiene({ storeRoot: root, isAlive: alive });
	assert.deepEqual(r.removedTempDirs.sort(), [dead, legacyOld].sort());
	assert.ok(fs.existsSync(live) && fs.existsSync(legacyNew));
	assert.ok(r.freedBytes >= 2000);
});

test("#37 prune: idle dead-owner runs go; live owner, worktrees, fresh, protected stay", () => {
	const { root, store: s } = store();
	const old = makeRun(s, DEAD, 20 * DAY);
	const legacyOld = makeRun(s, undefined, 20 * DAY);
	const liveOld = makeRun(s, process.pid, 20 * DAY);
	const fresh = makeRun(s, DEAD, 1 * DAY);
	const withWt = makeRun(s, DEAD);
	fs.mkdirSync(path.join(withWt, "worktrees", "worker-0"), { recursive: true });
	age(withWt, 20 * DAY);
	const prot = makeRun(s, DEAD, 20 * DAY);
	const r = runStartupHygiene({ storeRoot: root, isAlive: alive, protectRunIds: [path.basename(prot)] });
	assert.deepEqual(r.prunedRuns.sort(), [old, legacyOld].sort());
	for (const d of [liveOld, fresh, withWt, prot]) assert.ok(fs.existsSync(d), d);
	assert.match(formatHygieneReport(r) ?? "", /pruned 2 idle run dir/);
});

test("#37 prune disabled by retentionDays=0", () => {
	const { root, store: s } = store();
	const old = makeRun(s, DEAD, 400 * DAY);
	const r = runStartupHygiene({ storeRoot: root, isAlive: alive, config: { ...HYGIENE_DEFAULTS, retentionDays: 0 } });
	assert.equal(r.prunedRuns.length, 0);
	assert.ok(fs.existsSync(old));
});

function seedDb(dir: string, nodes: Array<{ id: string; status: string; updatedAt: number; parent?: string | null }>): string {
	const dbPath = path.join(dir, "legion.db");
	const db = openLegionDb(dbPath);
	for (const n of nodes) {
		insertNode(db, { id: n.id === "root" ? "root" : `root.${n.id}`, parentId: n.parent === undefined ? "root" : n.parent, name: n.id, role: n.id === "root" ? "root" : "worker", kind: "pi", depth: n.id === "root" ? 0 : 1, status: n.status as never, createdAt: n.updatedAt, updatedAt: n.updatedAt } as never, () => n.updatedAt);
	}
	db.close();
	return dbPath;
}

test("#38 stale working records in dead-owner runs are marked failed + node_abandoned; fresh/root untouched", () => {
	const { root, store: s } = store();
	const dir = makeRun(s, DEAD);
	const now = Date.now();
	const dbPath = seedDb(dir, [
		{ id: "root", status: "running", updatedAt: now - 10 * DAY, parent: null },
		{ id: "stale", status: "running", updatedAt: now - 5 * DAY },
		{ id: "fresh", status: "running", updatedAt: now - 60_000 },
		{ id: "done", status: "settled", updatedAt: now - 5 * DAY },
	]);
	const liveDir = makeRun(s, process.pid);
	const liveDb = seedDb(liveDir, [
		{ id: "root", status: "running", updatedAt: now - 10 * DAY, parent: null },
		{ id: "stale", status: "running", updatedAt: now - 5 * DAY },
	]);
	const r = runStartupHygiene({ storeRoot: root, isAlive: alive });
	assert.deepEqual(r.abandonedNodes, [`${path.basename(dir)}/root.stale`]);
	const db = openLegionDb(dbPath);
	const st = Object.fromEntries(db.prepare("SELECT id, status FROM nodes").all().map((x) => [x.id, x.status]));
	assert.deepEqual(st, { root: "running", "root.stale": "failed", "root.fresh": "running", "root.done": "settled" });
	assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='node_abandoned'").get()?.n, 1);
	db.close();
	const ldb = openLegionDb(liveDb);
	assert.equal(ldb.prepare("SELECT status FROM nodes WHERE id='root.stale'").get()?.status, "running");
	ldb.close();
	assert.ok(!fs.existsSync(`${dbPath}-wal`) || fs.statSync(`${dbPath}-wal`).size === 0);
});

test("#40 event retention: old terminal-node events go, live-node + retained types stay, row cap, WAL truncated", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ret-"));
	const now = Date.now();
	const dbPath = seedDb(dir, [
		{ id: "root", status: "running", updatedAt: now, parent: null },
		{ id: "done", status: "settled", updatedAt: now },
		{ id: "live", status: "running", updatedAt: now },
	]);
	const db = openLegionDb(dbPath);
	for (let i = 0; i < 1500; i++) appendEvent(db, "root.done", "phase_change", { i }, { now: () => now - 40 * DAY });
	appendEvent(db, "root.done", "orphan_detected", {}, { now: () => now - 40 * DAY });
	for (let i = 0; i < 10; i++) appendEvent(db, "root.live", "phase_change", { i }, { now: () => now - 40 * DAY });
	for (let i = 0; i < 20; i++) appendEvent(db, "root.done", "phase_change", { i }, { now: () => now });
	const r = applyEventRetention(db, { ...HYGIENE_DEFAULTS, eventMaxRows: 25 }, now);
	assert.equal(r.deleted, 1500 + 6);
	assert.equal(r.vacuumed, true);
	const left = db.prepare("SELECT node_id, type, COUNT(*) n FROM events GROUP BY node_id, type ORDER BY node_id, type").all().map((x) => `${x.node_id}:${x.type}:${x.n}`);
	assert.deepEqual(left, ["root.done:orphan_detected:1", "root.done:phase_change:14", "root.live:phase_change:10"]);
	db.close();
	assert.ok(!fs.existsSync(`${dbPath}-wal`) || fs.statSync(`${dbPath}-wal`).size === 0);
});

test("env config", () => {
	assert.deepEqual(resolveHygieneConfig({}), HYGIENE_DEFAULTS);
	const c = resolveHygieneConfig({ PI_LEGION_RUN_RETENTION_DAYS: "3", PI_LEGION_STALE_NODE_HOURS: "0", PI_LEGION_EVENT_MAX_ROWS: "x" });
	assert.equal(c.retentionDays, 3);
	assert.equal(c.staleNodeHours, 0);
	assert.equal(c.eventMaxRows, HYGIENE_DEFAULTS.eventMaxRows);
	assert.equal(hygieneEnabled({}), true);
	assert.equal(hygieneEnabled({ PI_LEGION_HYGIENE: "0" }), false);
	assert.equal(hygieneEnabled({ PI_LEGION_HYGIENE: "off" }), false);
});
