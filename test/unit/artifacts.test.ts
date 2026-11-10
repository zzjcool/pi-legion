import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { openLegionDb } from "../../src/legion/db.ts";
import type { DatabaseSync } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { recordArtifact } from "../../src/legion/ledger.ts";
import { rebuildLegionDb } from "../../src/legion/rebuild.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import {
	artifactContentMatches,
	artifactNameSegment,
	artifactPathFor,
	nextArtifactRound,
	readLatestArtifact,
	writeArtifactAtomic,
} from "../../src/runs/artifacts.ts";
import { ErrorCodes, SubagentError, type AgentConfig, type RunRecord } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

/**
 * The artifact store (contract `result-ledger-v1.md` §3 D1/D1a/D1b/D1d/A1).
 *
 * The three rules these tests pin are the ones that cannot be checked by reading
 * the code: the round source (`MAX(round)+1`, never the runtime's report round),
 * byte-identical bodies adding no round, and the write side producing exactly the
 * same `(id, bytes, parent_id)` a `rebuild` from disk derives — the two paths must
 * not drift, or "has the parent read it" starts answering differently after a
 * recovery.
 */

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "test agent",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test agent.",
		source: "user",
		filePath: "/fake/worker.md",
		...overrides,
	};
}

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withDb(run: (db: DatabaseSync) => void): void {
	const db = openLegionDb(":memory:");
	try {
		run(db);
	} finally {
		db.close();
	}
}

function ledgerArtifact(overrides: Partial<Parameters<typeof recordArtifact>[1]> = {}) {
	return {
		id: "r-1/scout-a/r1",
		parentId: "root",
		nodeId: "root.scout-a",
		name: "scout-a",
		round: 1,
		path: "/tmp/runs/r-1/artifacts/scout-a/r1.md",
		bytes: 10,
		createdAt: 1_000,
		...overrides,
	};
}

test("nextArtifactRound without a DB scans the directory and is 1-based (D1a)", () => {
	const runDir = tempDir("legion-artifacts-round-");
	try {
		const scope = { runDir, name: "scout-a", runId: "r-1" };
		assert.equal(nextArtifactRound(scope), 1, "nothing written yet ⇒ round 1");

		const directory = path.join(runDir, "artifacts", "scout-a");
		fs.mkdirSync(directory, { recursive: true });
		for (const file of ["r1.md", "r3.md"]) fs.writeFileSync(path.join(directory, file), "body\n");
		assert.equal(nextArtifactRound(scope), 4, "MAX(r<digits>) + 1");

		// Anything that is not `r<digits>.md` is not a round: a leftover temp file,
		// a non-numeric suffix and `r0` (rounds start at 1) must all be ignored.
		for (const file of ["r9.md.tmp", "rX.md", "r0.md", "notes.md"]) {
			fs.writeFileSync(path.join(directory, file), "body\n");
		}
		assert.equal(nextArtifactRound(scope), 4, "only r<digits>.md counts, and r0 does not");
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

test("nextArtifactRound with a DB answers MAX(round)+1 for its own (runId, name) only (D1a)", () => {
	const runDir = tempDir("legion-artifacts-db-round-");
	try {
		withDb((db) => {
			recordArtifact(db, ledgerArtifact({ round: 1, id: "r-1/scout-a/r1" }));
			recordArtifact(db, ledgerArtifact({ round: 2, id: "r-1/scout-a/r2" }));
			// Decoys: same name in another run, another name in this run, and a name that
			// is a prefix of the queried one. A prefix that dropped the trailing `/r`
			// separator would count any of these and skip a round.
			recordArtifact(db, ledgerArtifact({ round: 7, id: "r-2/scout-a/r7" }));
			recordArtifact(db, ledgerArtifact({ name: "scout-b", round: 5, id: "r-1/scout-b/r5" }));
			recordArtifact(db, ledgerArtifact({ name: "scout-ab", round: 6, id: "r-1/scout-ab/r6" }));

			assert.equal(nextArtifactRound({ db, runDir, name: "scout-a", runId: "r-1" }), 3);
			assert.equal(nextArtifactRound({ db, runDir, name: "scout-b", runId: "r-1" }), 6);
			assert.equal(nextArtifactRound({ db, runDir, name: "scout-a", runId: "r-2" }), 8);
			assert.equal(nextArtifactRound({ db, runDir, name: "unknown", runId: "r-1" }), 1);
		});
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

test("nextArtifactRound takes max(ledger, disk)+1, so an existing file is never overwritten (A1, D1a v1.5)", () => {
	const runDir = tempDir("legion-artifacts-max-");
	try {
		// The failure this pins: `legion.db` was deleted or replaced and `rebuild` was
		// never run, so the ledger knows nothing while the disk holds r1. A ledger-only
		// round would answer 1 here and overwrite that body — A1 says paths are never
		// reused, so the disk has to win.
		const file = artifactPathFor(runDir, "scout-a", 1);
		writeArtifactAtomic(file, "old round\n");
		withDb((db) => {
			assert.equal(
				nextArtifactRound({ db, runDir, name: "scout-a", runId: "r-1" }),
				2,
				"an empty ledger must not hand out a round the disk already used",
			);
			assert.equal(fs.readFileSync(file, "utf8"), "old round\n");

			// The symmetric case: the ledger is AHEAD (rows whose files were pruned).
			// Neither source may ever lower the answer.
			recordArtifact(db, ledgerArtifact({ round: 3, id: "r-1/scout-a/r3" }));
			assert.equal(nextArtifactRound({ db, runDir, name: "scout-a", runId: "r-1" }), 4);
		});
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

test("readLatestArtifact reports the newest round with its on-disk byte count", () => {
	const runDir = tempDir("legion-artifacts-latest-");
	try {
		const scope = { runDir, name: "scout-a", runId: "r-1" };
		assert.equal(readLatestArtifact(scope), null, "no artifact yet");

		writeArtifactAtomic(artifactPathFor(runDir, "scout-a", 1), "one\n");
		writeArtifactAtomic(artifactPathFor(runDir, "scout-a", 2), "两个\n");
		assert.deepEqual(readLatestArtifact(scope), {
			path: path.join(runDir, "artifacts", "scout-a", "r2.md"),
			round: 2,
			bytes: Buffer.byteLength("两个\n", "utf8"),
		});
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

test("writeArtifactAtomic writes the exact bytes, atomically, private and with no temp file left (A1)", () => {
	const runDir = tempDir("legion-artifacts-write-");
	try {
		const file = path.join(runDir, "artifacts", "scout-a", "r1.md");
		const body = "héllo 结果\n";
		const bytes = writeArtifactAtomic(file, body);

		assert.equal(bytes, Buffer.byteLength(body, "utf8"), "bytes are UTF-8 bytes, not characters");
		assert.notEqual(bytes, body.length, "the fixture is multi-byte, so a char count would differ");
		const stats = fs.statSync(file);
		assert.equal(stats.size, bytes, "the ledger's `bytes` must equal `stat.size` (rebuild measures stat)");
		assert.equal(fs.readFileSync(file, "utf8"), body, "the body is written verbatim, trailing newline included");
		assert.equal(stats.mode & 0o777, 0o600, "artifacts are as private as session files");
		assert.deepEqual(fs.readdirSync(path.dirname(file)), ["r1.md"], "the .tmp file is renamed away, never left behind");
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

test("artifactPathFor rejects an unusable name and keeps a hostile one inside artifacts/ (D1d)", () => {
	const runDir = "/tmp/runs/r-1";
	const artifactsRoot = path.join(runDir, "artifacts");

	// Names that sanitize to nothing must throw, not silently become the artifacts
	// directory itself (which is what a swallowed `sanitizeNameForFs` error would do).
	for (const name of ["..", "", ".", "../", "///"]) {
		assert.throws(
			() => artifactPathFor(runDir, name, 1),
			(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.INVALID_PARAMS,
			`${JSON.stringify(name)} must be refused, not mapped onto artifacts/`,
		);
	}

	// Escape attempts and control characters are reduced to a single safe segment:
	// the RESULT is what has to stay inside, so it is asserted rather than skipped.
	for (const name of ["../evil", "../../etc/passwd", "/etc/passwd", "a\0b", "a/b"]) {
		const file = artifactPathFor(runDir, name, 1);
		const relative = path.relative(artifactsRoot, file);
		assert.equal(relative.startsWith(".."), false, `${JSON.stringify(name)} must not escape ${artifactsRoot}`);
		assert.equal(path.isAbsolute(relative), false);
		assert.deepEqual(relative.split(path.sep).length, 2, `${JSON.stringify(name)} ⇒ <segment>/r1.md`);
		assert.equal(path.basename(file), "r1.md");
	}

	// Round 0 is not an artifact: it would collide with the 1-based round meaning.
	assert.throws(() => artifactPathFor(runDir, "scout-a", 0), TypeError);
});

test("artifactContentMatches compares bytes, not text (D1b)", () => {
	const runDir = tempDir("legion-artifacts-match-");
	try {
		const scope = { runDir, name: "scout-a", runId: "r-1" };
		assert.equal(artifactContentMatches(null, "body\n"), false, "no artifact is never 'the same'");

		const file = artifactPathFor(runDir, "scout-a", 1);
		writeArtifactAtomic(file, "body\n");
		const latest = readLatestArtifact(scope);
		assert.ok(latest);
		assert.equal(artifactContentMatches(latest, "body\n"), true);
		assert.equal(artifactContentMatches(latest, "body"), false, "the trailing newline is part of the bytes");
		assert.equal(artifactContentMatches(latest, "bodY\n"), false, "same size, different bytes");
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

test("D1b: an identical second turn reuses the artifact; a different body allocates a new round", async () => {
	const runDir = tempDir("legion-artifacts-idempotent-");
	const supervisor = new FakeSupervisor();
	let clock = 0;
	const orchestrator = new Orchestrator({
		supervisor,
		runDir,
		cwd: "/tmp/project",
		now: () => clock,
		sleep: async (ms) => { clock += ms; },
	});
	const directory = path.join(runDir, "artifacts", "scout-a");
	try {
		const handle = await orchestrator.launch({ agent: agent(), task: "first", name: "scout-a", worktree: false });
		supervisor.settle(handle.name, { text: "same body" });
		const first = await orchestrator.collect(handle.name);
		assert.equal(first.outputFile, path.join(directory, "r1.md"));
		assert.equal(fs.readFileSync(first.outputFile, "utf8"), "same body\n");

		// Same bytes on the next turn: no r2, and `outputFile` still points at a body
		// that really holds this turn's text.
		await orchestrator.steer(handle.name, "say it again");
		supervisor.settle(handle.name, { text: "same body" });
		const second = await orchestrator.collect(handle.name);
		assert.equal(second.output, "same body");
		assert.equal(second.outputFile, first.outputFile, "identical bytes reuse the existing artifact");
		assert.deepEqual(fs.readdirSync(directory), ["r1.md"], "a duplicate round was not written");

		// Different bytes: a new immutable round, the old one untouched.
		await orchestrator.steer(handle.name, "say something else");
		supervisor.settle(handle.name, { text: "other body" });
		const third = await orchestrator.collect(handle.name);
		assert.equal(third.outputFile, path.join(directory, "r2.md"));
		assert.deepEqual(fs.readdirSync(directory).sort(), ["r1.md", "r2.md"]);
		assert.equal(fs.readFileSync(path.join(directory, "r1.md"), "utf8"), "same body\n", "round 1 is immutable");
		assert.equal(fs.readFileSync(path.join(directory, "r2.md"), "utf8"), "other body\n");
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

/**
 * The convergence test: what the writer records and what `rebuild` derives
 * from disk must be the SAME row.
 *
 * `rebuild` is the only recovery path for the ledger (D10), so the pair
 * `(id, bytes, parent_id)` has to be reachable from `<runId>/<name>/r<round>.md`
 * alone: the id from the path, `bytes` from `stat`, the consumer from the tree.
 * If the writer used the runtime's report round, `content.length` instead of
 * `Buffer.byteLength`, or `child.nodeId` as the consumer, a recovered database
 * would rank and suppress artifacts differently from the live one.
 */
test("artifact written by the orchestrator and the one rebuilt from disk are the same row (D10)", async () => {
	const sandbox = tempDir("legion-artifacts-rebuild-");
	const runs = path.join(sandbox, "runs");
	const runId = "r-root";
	const runDir = path.join(runs, runId);
	fs.mkdirSync(runDir, { recursive: true });
	const dbPath = path.join(sandbox, "legion.db");
	const db = openLegionDb(dbPath);
	const supervisor = new FakeSupervisor();
	let clock = 0;
	try {
		// The consumer this orchestrator runs for. `reserveNode` needs it to exist.
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId, status: "running" });
		const orchestrator = new Orchestrator({
			supervisor,
			runDir,
			cwd: "/tmp/project",
			now: () => clock,
			sleep: async (ms) => { clock += ms; },
			legion: { db, dbPath, nodeId: "root", runId },
		});
		const handle = await orchestrator.launch({ agent: agent(), task: "go", name: "scout-a", worktree: false });
		supervisor.settle(handle.name, { text: "结果 ✓" });
		const collected = await orchestrator.collect(handle.name);
		assert.equal(collected.outputFile, path.join(runDir, "artifacts", "scout-a", "r1.md"));

		const written = readArtifactRow(db);
		assert.deepEqual(written, {
			id: "r-root/scout-a/r1",
			parentId: "root",
			nodeId: "root.scout-a",
			name: "scout-a",
			round: 1,
			path: path.resolve(path.join(runDir, "artifacts", "scout-a", "r1.md")),
			bytes: Buffer.byteLength("结果 ✓\n", "utf8"),
		});

		// `rebuild` clears `nodes`/`artifacts` and re-derives both, so this is the
		// recovered database — not a second insert on top of the live one.
		writeRun(runDir, runRecord(runId, "scout-a"));
		const rebuilt = rebuildLegionDb({ rootRunDir: runDir, db });
		assert.equal(rebuilt.artifactsRebuilt, 1);
		assert.deepEqual(readArtifactRow(db), written, "write side and rebuild converge on the same row");
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

/**
 * Ruling 1 (D1a v1.5): a body that is already on disk must survive a lost ledger.
 *
 * The live writer path is what matters here — a store-level assertion cannot see
 * that `writeOutputFile` allocates its round from the same two sources.
 */
test("a round already on disk is never reused when the ledger has no row (A1, D1a v1.5)", async () => {
	const sandbox = tempDir("legion-artifacts-no-reuse-");
	const runs = path.join(sandbox, "runs");
	const runId = "r-root";
	const runDir = path.join(runs, runId);
	fs.mkdirSync(runDir, { recursive: true });
	const dbPath = path.join(sandbox, "legion.db");
	const db = openLegionDb(dbPath);
	const supervisor = new FakeSupervisor();
	let clock = 0;
	try {
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId, status: "running" });
		// A body from a previous database generation: the file exists, no artifact row does.
		const previous = artifactPathFor(runDir, "scout-a", 1);
		writeArtifactAtomic(previous, "from a run whose ledger was lost\n");

		const orchestrator = new Orchestrator({
			supervisor,
			runDir,
			cwd: "/tmp/project",
			now: () => clock,
			sleep: async (ms) => { clock += ms; },
			legion: { db, dbPath, nodeId: "root", runId },
		});
		const handle = await orchestrator.launch({ agent: agent(), task: "go", name: "scout-a", worktree: false });
		supervisor.settle(handle.name, { text: "the new answer" });
		const collected = await orchestrator.collect(handle.name);

		assert.equal(
			collected.outputFile,
			path.join(runDir, "artifacts", "scout-a", "r2.md"),
			"the disk round outranks an empty ledger",
		);
		assert.equal(
			fs.readFileSync(previous, "utf8"),
			"from a run whose ledger was lost\n",
			"A1: the existing artifact body is never overwritten",
		);
		const row = readArtifactRow(db);
		assert.equal(row.id, "r-root/scout-a/r2");
		assert.equal(row.round, 2);
		assert.equal(row.bytes, Buffer.byteLength("the new answer\n", "utf8"));
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

/**
 * Ruling 2 (D1d v1.5): the id's name segment is the SANITIZED one, the `name`
 * column keeps the raw value.
 *
 * `rebuild` can only read the directory (`rebuild.ts:562-570`), so a raw-name id
 * would mean the writer and the recovery path disagree about the same body: after
 * a rebuild the `consumptions` rows would be orphans and `maxRoundFor` — which
 * prefixes on the id — would stop seeing the recovered rows.
 *
 * Driven at the store boundary rather than through `launch`, because a launch
 * with a Legion identity normalizes the child name with `sanitizeNodeSlug` first
 * (`orchestrator.ts:1082`), which already maps `"A B"` to `"a-b"`; the raw name
 * reaching `recordArtifactRow` is therefore reproduced here directly.
 */
test("a name that sanitizes to a different segment still converges with rebuild (D1d v1.5)", () => {
	const sandbox = tempDir("legion-artifacts-raw-name-");
	const runs = path.join(sandbox, "runs");
	const runId = "r-root";
	const runDir = path.join(runs, runId);
	fs.mkdirSync(runDir, { recursive: true });
	const db = openLegionDb(path.join(sandbox, "legion.db"));
	try {
		const rawName = "A B";
		const segment = artifactNameSegment(rawName);
		assert.equal(segment, "A-B", "the fixture is only meaningful when the segment differs from the raw name");

		// The write side exactly as `recordArtifactRow` builds it: path and id use the
		// sanitized segment, the `name` column keeps the raw name.
		const file = artifactPathFor(runDir, rawName, 1);
		assert.deepEqual(path.relative(path.join(runDir, "artifacts"), file), path.join("A-B", "r1.md"));
		const bytes = writeArtifactAtomic(file, "多字节 body\n");
		recordArtifact(db, {
			id: `${runId}/${segment}/r1`,
			parentId: "root",
			nodeId: "root.a-b",
			name: rawName,
			round: 1,
			path: path.resolve(file),
			bytes,
			createdAt: 1_000,
		});
		const written = readArtifactRow(db);
		assert.equal(written.name, "A B", "the column stores what the caller passed, not the segment");

		writeRun(runDir, runRecord(runId, rawName));
		const rebuilt = rebuildLegionDb({ rootRunDir: runDir, db });
		assert.equal(rebuilt.artifactsRebuilt, 1, "the artifact resolves through the sanitized node name");

		const recovered = readArtifactRow(db);
		for (const field of ["id", "parentId", "nodeId", "round", "bytes", "path"] as const) {
			assert.equal(recovered[field], written[field], `${field} must survive a rebuild unchanged`);
		}
		// Known and accepted asymmetry: `rebuild` only has the DIRECTORY to read, so the
		// `name` column comes back as the segment. Nothing keys on that column — the
		// suppression predicate and the round query both go through the id — and the
		// moment before the rebuild still holds the raw value.
		assert.equal(recovered.name, segment);
		// Because the ids agree, the round query still sees the recovered row: after a
		// rebuild a reset ledger can never hand out round 1 again.
		assert.equal(nextArtifactRound({ db, runDir, name: rawName, runId }), 2);
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

/**
 * A non-canonical round file (`r01.md`) is round 1, and the reader must hand back
 * the path that really exists — rebuilding `r1.md` from the number would answer
 * "no artifact to compare against" and silently switch D1b off.
 */
test("readLatestArtifact returns the real file name, so r01.md still dedupes (D1b)", () => {
	const runDir = tempDir("legion-artifacts-r01-");
	try {
		const directory = path.join(runDir, "artifacts", "scout-a");
		fs.mkdirSync(directory, { recursive: true });
		const odd = path.join(directory, "r01.md");
		fs.writeFileSync(odd, "body\n");

		const latest = readLatestArtifact({ runDir, name: "scout-a", runId: "r-1" });
		assert.deepEqual(latest, { path: odd, round: 1, bytes: Buffer.byteLength("body\n", "utf8") });
		assert.equal(artifactContentMatches(latest, "body\n"), true, "the dedupe still sees the body");
		assert.equal(nextArtifactRound({ runDir, name: "scout-a", runId: "r-1" }), 2, "round 1 is taken");

		// The canonical spelling wins when both exist, so a normal tree is unaffected.
		const canonical = path.join(directory, "r1.md");
		fs.writeFileSync(canonical, "body\n");
		assert.equal(readLatestArtifact({ runDir, name: "scout-a", runId: "r-1" })?.path, canonical);
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

test("writeArtifactAtomic removes its temp file when the rename fails (A1)", () => {
	const runDir = tempDir("legion-artifacts-rename-");
	try {
		const file = path.join(runDir, "artifacts", "scout-a", "r1.md");
		// An existing DIRECTORY at the target makes the rename fail on every platform
		// (EISDIR / EEXIST / EPERM) without touching permissions, which root ignores.
		fs.mkdirSync(file, { recursive: true });

		assert.throws(() => writeArtifactAtomic(file, "half written\n"));

		assert.deepEqual(
			fs.readdirSync(path.dirname(file)),
			["r1.md"],
			"the full-size temp body is cleaned up: a `.tmp` is nobody's artifact",
		);
		assert.equal(fs.statSync(file).isDirectory(), true, "the target was not partially written");
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

test("an unreadable artifact directory refuses to answer instead of reusing round 1 (A1)", () => {
	const runDir = tempDir("legion-artifacts-unreadable-");
	try {
		const artifactsRoot = path.join(runDir, "artifacts");
		fs.mkdirSync(artifactsRoot, { recursive: true });
		// A self-referential symlink makes `readdir` fail with ELOOP — not a
		// permission bit, so it holds even when the suite runs as root. Folding that
		// into "no rounds yet" is exactly how the A1 hole reopened: the writer would
		// take round 1 over a directory it merely could not read.
		fs.symlinkSync("scout-a", path.join(artifactsRoot, "scout-a"));
		const scope = { runDir, name: "scout-a", runId: "r-1" };
		assert.throws(
			() => nextArtifactRound(scope),
			(error: unknown) => (error as NodeJS.ErrnoException).code === "ELOOP",
			"an unreadable directory must not answer 0",
		);
		assert.throws(() => readLatestArtifact(scope), (error: unknown) => (error as NodeJS.ErrnoException).code === "ELOOP");

		// The genuinely absent cases still answer 0/1 instead of throwing.
		assert.equal(nextArtifactRound({ runDir, name: "absent", runId: "r-1" }), 1, "ENOENT ⇒ no rounds yet");
		fs.writeFileSync(path.join(artifactsRoot, "not-a-directory"), "x");
		assert.equal(
			nextArtifactRound({ runDir, name: "not-a-directory", runId: "r-1" }),
			1,
			"ENOTDIR ⇒ no rounds yet",
		);
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

function readArtifactRow(db: DatabaseSync) {
	const row = db
		.prepare("SELECT id, parent_id, node_id, name, round, path, bytes FROM artifacts ORDER BY id LIMIT 1")
		.get();
	assert.ok(row, "expected exactly one artifact row");
	return {
		id: String(row.id),
		parentId: String(row.parent_id),
		nodeId: String(row.node_id),
		name: String(row.name),
		round: Number(row.round),
		path: String(row.path),
		bytes: Number(row.bytes),
	};
}

function writeRun(directory: string, run: RunRecord): void {
	fs.writeFileSync(path.join(directory, "run.json"), JSON.stringify(run));
}

function runRecord(runId: string, childName: string): RunRecord {
	return {
		schemaVersion: 1,
		runId,
		task: "artifacts convergence",
		cwd: "/tmp",
		herdr: {},
		path: [],
		depth: 0,
		maxDepth: 4,
		children: [{
			name: childName,
			sessionFile: path.join(runId, `${childName}.jsonl`),
			ownerToken: "owner",
			state: "exited",
			execution: { status: "success", turns: 1 },
			spawnedAt: new Date(1_000).toISOString(),
			agent: childName,
			kind: "pi",
		}],
		budget: { spawned: 1, limit: null, granted: 0 },
		createdAt: new Date(500).toISOString(),
		updatedAt: new Date(2_000).toISOString(),
	};
}
