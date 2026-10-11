import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	RunStore,
	sanitizeNameForFs,
	pickChildByName,
} from "../../src/runs/store.ts";
import { SubagentError, type RunRecord, type ChildRecord } from "../../src/shared/types.ts";

// ── helpers ───────────────────────────────────────────────────────────────

let tmpDir: string;

function newStore(now?: () => number): RunStore {
	return new RunStore({ rootDir: tmpDir, ...(now ? { now } : {}) });
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "w2-store-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeChild(name: string, overrides: Partial<ChildRecord> = {}): ChildRecord {
	return {
		name,
		sessionFile: path.join(tmpDir, "runs", "r-x", `${name}.jsonl`),
		ownerToken: "tok-abc",
		state: "launching",
		spawnedAt: new Date().toISOString(),
		...overrides,
	};
}

// ── create / read / write round-trip ──────────────────────────────────────

test("createRun generates r- prefixed runId and persists run.json", () => {
	const store = newStore();
	const run = store.createRun({ task: "do things", cwd: "/proj" });
	assert.match(run.runId, /^r-[0-9a-f]{8}$/);
	assert.equal(run.schemaVersion, 1);
	assert.equal(run.task, "do things");
	assert.equal(run.depth, 0);
	assert.deepEqual(run.children, []);
	assert.equal(run.budget.spawned, 0);
	assert.equal(run.budget.limit, null);
	assert.ok(fs.existsSync(store.runDir(run.runId) + "/run.json"));
});

test("createRun rejects empty task / cwd", () => {
	const store = newStore();
	assert.throws(() => store.createRun({ task: "", cwd: "/p" }), SubagentError);
	assert.throws(() => store.createRun({ task: "t", cwd: "" }), SubagentError);
});

test("createRun accepts nested path and derives depth", () => {
	const store = newStore();
	const pathEntries = [
		{ runId: "r-root", agent: "orchestrator" },
		{ runId: "r-mid", stepIndex: 0, agent: "planner" },
	];
	const run = store.createRun({ task: "t", cwd: "/p", path: pathEntries });
	assert.equal(run.depth, 2);
	assert.deepEqual(run.path, pathEntries);
});

test("createRun truncates nested path to 4 entries", () => {
	const store = newStore();
	const run = store.createRun({
		task: "t",
		cwd: "/p",
		path: Array.from({ length: 9 }, (_, i) => ({ runId: `r-${i}` })),
	});
	assert.equal(run.path.length, 4);
});

test("create/read round-trip preserves RPC run identity", () => {
	const store = newStore();
	const created = store.createRun({
		task: "refactor",
		cwd: "/proj",
		maxDepth: 4,
		herdr: { supervisor: "rpc", node_id: "root" },
	});
	const read = store.readRun(created.runId);
	assert.ok(read);
	assert.equal(read.runId, created.runId);
	assert.equal(read.maxDepth, 4);
	assert.deepEqual(read.herdr, { supervisor: "rpc", node_id: "root" });
});

test("readRun returns null for a missing run", () => {
	const store = newStore();
	assert.equal(store.readRun("r-doesnotexist"), null);
});

test("readRun throws for traversal runIds", () => {
	const store = newStore();
	assert.throws(() => store.readRun("../escape"), SubagentError);
	assert.throws(() => store.readRun("a/b"), SubagentError);
});

test("writeRun updates updatedAt and round-trips", () => {
	let tick = 1_000_000;
	const store = newStore(() => tick);
	const run = store.createRun({ task: "t", cwd: "/p" });
	tick += 5_000;
	store.writeRun(run);
	const again = store.readRun(run.runId);
	assert.ok(again);
	assert.notEqual(again.updatedAt, run.createdAt);
});

test("writeRun rejects a non-RunRecord shape", () => {
	const store = newStore();
	assert.throws(
		() => store.writeRun({ nope: true } as unknown as RunRecord),
		SubagentError,
	);
});

// ── atomic writes ─────────────────────────────────────────────────────────

test("atomic write leaves no .tmp behind", () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	store.writeRun(run);
	const files = fs.readdirSync(store.runDir(run.runId));
	assert.ok(files.includes("run.json"));
	assert.equal(files.filter((f) => f.endsWith(".tmp")).length, 0);
});

test("run.json still parses after many rapid writes (no partial state)", () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	for (let i = 0; i < 25; i++) {
		store.writeRun(run);
	}
	const parsed: unknown = JSON.parse(
		fs.readFileSync(path.join(store.runDir(run.runId), "run.json"), "utf8"),
	);
	assert.equal((parsed as RunRecord).runId, run.runId);
});

test("run.json is created with restrictive file mode", () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	const mode = fs.statSync(path.join(store.runDir(run.runId), "run.json")).mode & 0o777;
	assert.ok((mode & 0o077) === 0, `expected no group/other bits, got ${mode.toString(8)}`);
});

// ── corrupt run.json recovery ─────────────────────────────────────────────

test("corrupt run.json: readRun returns null and quarantines as .corrupt", () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	const runFile = path.join(store.runDir(run.runId), "run.json");
	fs.writeFileSync(runFile, '{"runId": "r-', "utf8"); // torn JSON
	assert.equal(store.readRun(run.runId), null);
	assert.ok(fs.existsSync(`${runFile}.corrupt`));
	assert.ok(!fs.existsSync(runFile));
});

test("corrupt run.json with valid JSON but wrong shape is quarantined", () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	const runFile = path.join(store.runDir(run.runId), "run.json");
	fs.writeFileSync(runFile, JSON.stringify({ hello: "world" }), "utf8");
	assert.equal(store.readRun(run.runId), null);
	assert.ok(fs.existsSync(`${runFile}.corrupt`));
});

test("after corruption the run can be recreated cleanly", () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	fs.writeFileSync(path.join(store.runDir(run.runId), "run.json"), "garbage", "utf8");
	assert.equal(store.readRun(run.runId), null);
	const fresh = store.createRun({ task: "t2", cwd: "/p" });
	assert.ok(store.readRun(fresh.runId));
});

test("listRuns skips corrupt runs without throwing", () => {
	const store = newStore();
	store.createRun({ task: "good", cwd: "/p" });
	const bad = store.createRun({ task: "bad", cwd: "/p" });
	fs.writeFileSync(path.join(store.runDir(bad.runId), "run.json"), "{oops", "utf8");
	const runs = store.listRuns();
	assert.equal(runs.length, 1);
	assert.equal(runs[0]?.task, "good");
});

// ── session pre-creation (design F4) ──────────────────────────────────────

test("sessionFileFor pre-creates an empty file at mode 0600 and returns the path", () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	const file = store.sessionFileFor(run.runId, "reviewer-1");
	assert.ok(fs.existsSync(file), "session file must exist immediately (F4)");
	assert.equal(fs.statSync(file).size, 0, "pre-created file must be empty");
	const mode = fs.statSync(file).mode & 0o777;
	assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
	assert.ok(file.endsWith("reviewer-1.jsonl"));
	assert.ok(file.startsWith(store.runDir(run.runId)));
});

test("sessionFileFor is idempotent — no data loss on repeat calls", () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	const file = store.sessionFileFor(run.runId, "worker-1");
	fs.writeFileSync(file, '{"some":"session data"}\n', "utf8");
	const again = store.sessionFileFor(run.runId, "worker-1");
	assert.equal(again, file);
	assert.equal(fs.readFileSync(file, "utf8"), '{"some":"session data"}\n');
});

test("sessionFileFor creates the run dir on demand", () => {
	const store = newStore();
	const file = store.sessionFileFor("r-manual", "agent");
	assert.ok(fs.existsSync(file));
	assert.ok(fs.statSync(path.dirname(file)).isDirectory());
});

// ── name sanitization ─────────────────────────────────────────────────────

test("sanitizeNameForFs neutralizes path traversal", () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	const file = store.sessionFileFor(run.runId, "../../etc/passwd");
	// must land inside the run dir, basename-only
	assert.ok(file.startsWith(store.runDir(run.runId) + path.sep));
	assert.ok(!file.includes(".."));
	assert.equal(path.dirname(file), store.runDir(run.runId));
	assert.ok(fs.existsSync(file));
});

test("sanitizeNameForFs: ../../etc/passwd becomes passwd", () => {
	assert.equal(sanitizeNameForFs("../../etc/passwd"), "passwd");
});

test("sanitizeNameForFs replaces spaces and unicode", () => {
	assert.equal(sanitizeNameForFs("Review Agent"), "Review-Agent");
	const uni = sanitizeNameForFs("réviséur 中文");
	assert.match(uni, /^[A-Za-z0-9._-]+$/);
	assert.ok(!uni.includes("中"));
});

test("sanitizeNameForFs rejects names that sanitize to nothing", () => {
	assert.throws(() => sanitizeNameForFs("中文"), SubagentError);
	assert.throws(() => sanitizeNameForFs(".."), SubagentError);
	assert.throws(() => sanitizeNameForFs("///"), SubagentError);
});

test("sessionFileFor with a hostile name still creates a file inside the run dir", () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	const file = store.sessionFileFor(run.runId, "..\\..\\win32");
	assert.ok(file.startsWith(store.runDir(run.runId) + path.sep));
	assert.ok(fs.existsSync(file));
});

// ── children ──────────────────────────────────────────────────────────────

test("addChild appends, bumps budget, and generates ownerToken when missing", async () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	const updated = await store.addChild(run.runId, makeChild("reviewer-1", { ownerToken: "" }));
	assert.equal(updated.children.length, 1);
	assert.equal(updated.budget.spawned, 1);
	const child = updated.children[0];
	assert.ok(child);
	assert.match(child.ownerToken, /^[0-9a-f]{16}$/);
	// persisted
	assert.equal(store.findChild(run.runId, "reviewer-1")?.ownerToken, child.ownerToken);
});

test("addChild rejects duplicate child names", async () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	await store.addChild(run.runId, makeChild("dup"));
	await assert.rejects(
		() => store.addChild(run.runId, makeChild("dup")),
		(e: unknown) => e instanceof SubagentError && e.code === "NAME_TAKEN",
	);
});

test("findChild returns null for unknown child", () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	assert.equal(store.findChild(run.runId, "nobody"), null);
	assert.equal(store.findChild("r-missing", "nobody"), null);
});

test("updateChild mutates only the named child and persists", async () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	await store.addChild(run.runId, makeChild("a"));
	await store.addChild(run.runId, makeChild("b"));
	const updated = await store.updateChild(run.runId, "a", (c) => {
		c.state = "retired";
		c.retiredAt = new Date().toISOString();
	});
	assert.equal(updated.children[0]?.state, "retired");
	assert.equal(updated.children[1]?.state, "launching");
	assert.equal(store.findChild(run.runId, "a")?.state, "retired");
});

test("updateChild throws NOT_FOUND for unknown child", async () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	await assert.rejects(
		() => store.updateChild(run.runId, "ghost", () => {}),
		(e: unknown) => e instanceof SubagentError && e.code === "NOT_FOUND",
	);
});

test("removeChild atomically releases a failed launch reservation", async () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	await store.addChild(run.runId, { ...makeChild("worker-0"), nodeId: "root.worker-0", state: "launching" });
	const removed = await store.removeChild(run.runId, "worker-0", "root.worker-0");
	assert.equal(removed.children.length, 0);
	assert.equal(removed.budget.spawned, 0);
	assert.equal(store.findChild(run.runId, "worker-0"), null);
	await store.addChild(run.runId, makeChild("worker-0"));
	assert.equal(store.findChild(run.runId, "worker-0")?.state, "launching");
});

// ── updateRun + concurrency ───────────────────────────────────────────────

test("updateRun read-modify-write round trip", async () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	const updated = await store.updateRun(run.runId, (r) => {
		r.task = "changed";
		r.budget.granted = 3;
	});
	assert.equal(updated.task, "changed");
	assert.equal(store.readRun(run.runId)?.budget.granted, 3);
});

test("updateRun throws NOT_FOUND for a missing run", async () => {
	const store = newStore();
	await assert.rejects(
		() => store.updateRun("r-nope", () => {}),
		(e: unknown) => e instanceof SubagentError && e.code === "NOT_FOUND",
	);
});

test("concurrent updateRun calls on the same run serialize (no lost update)", async () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	const N = 30;
	// fire 30 concurrent updates, each bumping spawned by 1
	await Promise.all(
		Array.from({ length: N }, () =>
			store.updateRun(run.runId, (r) => {
				r.budget.spawned += 1;
			}),
		),
	);
	const final = store.readRun(run.runId);
	assert.equal(final?.budget.spawned, N, "mutex must prevent lost updates");
});

test("concurrent addChild calls all land (mutex under contention)", async () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	await Promise.all(
		Array.from({ length: 10 }, (_, i) =>
			store.addChild(run.runId, makeChild(`child-${i}`)),
		),
	);
	const final = store.readRun(run.runId);
	assert.equal(final?.children.length, 10);
	assert.equal(final?.budget.spawned, 10);
});

test("a failing mutator does not poison the lock for later callers", async () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	await assert.rejects(() =>
		store.updateRun(run.runId, () => {
			throw new Error("boom");
		}),
	);
	const ok = await store.updateRun(run.runId, (r) => {
		r.task = "still-works";
	});
	assert.equal(ok.task, "still-works");
});

// ── artifact dir ──────────────────────────────────────────────────────────

test("artifactDirFor creates <runDir>/out", () => {
	const store = newStore();
	const run = store.createRun({ task: "t", cwd: "/p" });
	const dir = store.artifactDirFor(run.runId);
	assert.equal(dir, path.join(store.runDir(run.runId), "out"));
	assert.ok(fs.statSync(dir).isDirectory());
});

// ── prune ─────────────────────────────────────────────────────────────────

test("prune deletes only sessions older than retentionDays", () => {
	const now = Date.now();
	const store = newStore(() => now);
	const run = store.createRun({ task: "t", cwd: "/p" });
	const oldFile = store.sessionFileFor(run.runId, "old-child");
	const newFile = store.sessionFileFor(run.runId, "new-child");
	// backdate old-child by 10 days
	const old = new Date(now - 10 * 24 * 3600 * 1000);
	fs.utimesSync(oldFile, old, old);

	const res = store.prune({ retentionDays: 7 });
	assert.equal(res.removedSessions.length, 1);
	assert.ok(res.removedSessions[0]?.endsWith("old-child.jsonl"));
	assert.ok(!fs.existsSync(oldFile));
	assert.ok(fs.existsSync(newFile), "fresh session must survive");
	assert.ok(fs.existsSync(path.join(store.runDir(run.runId), "run.json")), "run.json must survive");
	assert.equal(res.removedRuns.length, 0);
});

test("prune removes whole run dirs whose run.json is older than retention", () => {
	const now = Date.now();
	const store = newStore(() => now);
	const run = store.createRun({ task: "ancient", cwd: "/p" });
	const dir = store.runDir(run.runId);
	store.sessionFileFor(run.runId, "child");
	// backdate run.json itself
	const old = new Date(now - 30 * 24 * 3600 * 1000);
	fs.utimesSync(path.join(dir, "run.json"), old, old);
	fs.utimesSync(path.join(dir, "child.jsonl"), old, old);

	const res = store.prune({ retentionDays: 7 });
	assert.deepEqual(res.removedRuns, [dir]);
	assert.ok(!fs.existsSync(dir), "stale run dir must be gone");
});

test("prune never deletes run.json of a run newer than retention", () => {
	const now = Date.now();
	const store = newStore(() => now);
	const run = store.createRun({ task: "fresh", cwd: "/p" });
	// sessions old, run.json fresh
	const old = new Date(now - 20 * 24 * 3600 * 1000);
	const s1 = store.sessionFileFor(run.runId, "a");
	fs.utimesSync(s1, old, old);
	const res = store.prune({ retentionDays: 7 });
	assert.equal(res.removedRuns.length, 0);
	assert.ok(fs.existsSync(path.join(store.runDir(run.runId), "run.json")));
	assert.equal(res.removedSessions.length, 1);
});

test("prune enforces maxBytesPerRun by dropping oldest sessions first", () => {
	const now = Date.now();
	const store = newStore(() => now);
	const run = store.createRun({ task: "t", cwd: "/p" });
	const a = store.sessionFileFor(run.runId, "a");
	const b = store.sessionFileFor(run.runId, "b");
	const c = store.sessionFileFor(run.runId, "c");
	fs.writeFileSync(a, "x".repeat(1000));
	fs.writeFileSync(b, "x".repeat(1000));
	fs.writeFileSync(c, "x".repeat(1000));
	// make 'a' the oldest
	const earlier = new Date(now - 60_000);
	fs.utimesSync(a, earlier, earlier);

	const res = store.prune({ retentionDays: 7, maxBytesPerRun: 2500 });
	assert.deepEqual(res.removedSessions, [a]); // only the oldest exceeds the 2500 budget
	assert.ok(fs.existsSync(b));
	assert.ok(fs.existsSync(c));
});

test("prune is a no-op when there is nothing to do", () => {
	const store = newStore();
	const res = store.prune({ retentionDays: 7 });
	assert.deepEqual(res, { removedSessions: [], removedRuns: [] });
});

test("prune ignores dirs without run.json", () => {
	const store = newStore();
	fs.mkdirSync(path.join(tmpDir, "runs", "r-stray"), { recursive: true });
	fs.writeFileSync(path.join(tmpDir, "runs", "r-stray", "notes.txt"), "hi");
	const res = store.prune({ retentionDays: 7 });
	assert.deepEqual(res, { removedSessions: [], removedRuns: [] });
	assert.ok(fs.existsSync(path.join(tmpDir, "runs", "r-stray")));
});

test("prune rejects non-positive retentionDays", () => {
	const store = newStore();
	assert.throws(() => store.prune({ retentionDays: 0 }), SubagentError);
	assert.throws(() => store.prune({ retentionDays: -1 }), SubagentError);
});

// ── misc ──────────────────────────────────────────────────────────────────

test("listRuns returns runs ordered oldest-first", () => {
	let tick = 1_000_000;
	const store = newStore(() => tick);
	store.createRun({ task: "first", cwd: "/p" });
	tick += 10_000;
	store.createRun({ task: "second", cwd: "/p" });
	tick += 10_000;
	store.createRun({ task: "third", cwd: "/p" });
	const runs = store.listRuns();
	assert.deepEqual(
		runs.map((r) => r.task),
		["first", "second", "third"],
	);
});

test("store works without a runs dir present", () => {
	const store = newStore();
	assert.deepEqual(store.listRuns(), []);
	const run = store.createRun({ task: "t", cwd: "/p" });
	assert.ok(store.readRun(run.runId));
});

test("RunStore requires rootDir", () => {
	assert.throws(() => new RunStore({ rootDir: "" }), SubagentError);
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 16: session pre-creation used a manual open/close with no guard. When
// `closeSync` throws (EIO/ENOSPC on flush) the descriptor leaked, and the
// launcher creates one session file per child — so a leak compounds across a
// fan-out. `fs.writeFileSync(..., { flag: "wx" })` manages the fd internally and
// also removes the TOCTOU window an `existsSync` check leaves open.
// ─────────────────────────────────────────────────────────────────────────────

test("sessionFileFor does not leak file descriptors across repeated calls", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-fd-"));
	try {
		const store = new RunStore({ rootDir: dir });
		const run = store.createRun({ task: "t", cwd: "/tmp" });
		const fdDir = "/proc/self/fd";
		const canCount = fs.existsSync(fdDir);
		const before = canCount ? fs.readdirSync(fdDir).length : 0;

		// Repeat names exercise the EEXIST path; distinct names exercise creation.
		for (let i = 0; i < 300; i += 1) {
			store.sessionFileFor(run.runId, `worker-${i % 25}`);
		}

		if (canCount) {
			const after = fs.readdirSync(fdDir).length;
			assert.ok(
				after - before <= 2,
				`descriptors must not accumulate (before=${before} after=${after})`,
			);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("sessionFileFor keeps the pre-creation contract", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-precreate-"));
	try {
		const store = new RunStore({ rootDir: dir });
		const run = store.createRun({ task: "t", cwd: "/tmp" });
		const file = store.sessionFileFor(run.runId, "probe");

		assert.equal(fs.existsSync(file), true, "the file must exist before the child starts (F4)");
		assert.equal(fs.statSync(file).size, 0, "it must be empty");
		assert.equal(
			fs.statSync(file).mode & 0o777,
			0o600,
			"it must be owner-only",
		);

		// Calling again must be idempotent and must NOT truncate existing data.
		fs.writeFileSync(file, "existing session data");
		store.sessionFileFor(run.runId, "probe");
		assert.equal(
			fs.readFileSync(file, "utf-8"),
			"existing session data",
			"a repeat call must never clobber a session in progress",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("pickChildByName prefers a live child when names are reused across run records", async () => {
	const store = newStore();
	const old = store.createRun({ task: "old", cwd: "/p" });
	await store.addChild(old.runId, makeChild("scout-0", { state: "retired" }));
	const current = store.createRun({ task: "current", cwd: "/p" });
	await store.addChild(current.runId, makeChild("scout-0", { state: "working" }));
	const picked = pickChildByName(store.listRuns(), "scout-0");
	assert.equal(picked?.run.runId, current.runId);
	assert.equal(picked?.child.state, "working");
});

test("pickChildByName falls back to the newest retired record when no live child exists", async () => {
	let tick = 1_000_000;
	const store = newStore(() => tick++);
	const old = store.createRun({ task: "old", cwd: "/p" });
	await store.addChild(old.runId, makeChild("scout-0", { state: "retired" }));
	const next = store.createRun({ task: "next", cwd: "/p" });
	await store.addChild(next.runId, makeChild("scout-0", { state: "retired" }));
	assert.equal(pickChildByName(store.listRuns(), "scout-0")?.run.runId, next.runId);
});
