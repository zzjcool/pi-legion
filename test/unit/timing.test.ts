import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	aggregateSubagentRuns,
} from "../../src/extension/summary.ts";
import {
	buildTimingReport,
	createTimingCommand,
	formatTimingDetail,
	formatTimingJson,
	formatTimingTable,
	timingChildFromSummary,
} from "../../src/extension/timing.ts";
import { parseSessionFile } from "../../src/shared/session.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { ChildRecord } from "../../src/shared/types.ts";
import {
	assistantMsg,
	modelChange,
	sessionHeader,
	toolResult,
	userMsg,
} from "../helpers/fixtures.ts";

function tempRoot(): string {
	return mkdtempSync(path.join(os.tmpdir(), "timing-"));
}

function child(
	rootDir: string,
	name: string,
	spawnedAt: string,
	overrides: Partial<ChildRecord> = {},
): ChildRecord {
	return {
		name,
		sessionFile: path.join(rootDir, `${name}.jsonl`),
		ownerToken: `token-${name}`,
		state: "retired",
		spawnedAt,
		...overrides,
	};
}

function sessionWithGeneration(
	genIntervals: Array<{ userAt: number; assistantAt: number; toolGap?: number }>,
): string {
	const lines = [sessionHeader(), modelChange("cb/test-model")];
	for (const interval of genIntervals) {
		lines.push(userMsg("go", { timestamp: interval.userAt }));
		if (interval.toolGap !== undefined) {
			lines.push(
				assistantMsg({
					stopReason: "toolUse",
					tools: ["bash"],
					timestamp: interval.assistantAt,
					usage: { input: 10, output: 50 },
				}),
			);
			lines.push(toolResult({ timestamp: interval.assistantAt + interval.toolGap }));
			lines.push(
				assistantMsg({
					stopReason: "stop",
					text: "done",
					timestamp: interval.assistantAt + interval.toolGap + 2_000,
					usage: { input: 10, output: 50 },
				}),
			);
		} else {
			lines.push(
				assistantMsg({
					stopReason: "stop",
					text: "done",
					timestamp: interval.assistantAt,
					usage: { input: 10, output: 100 },
				}),
			);
		}
	}
	return lines.join("\n");
}

test("timing: no-name multi-child table marks live wall with + and fills gen/other", async () => {
	const root = tempRoot();
	try {
		const cwd = path.join(root, "project");
		const now = Date.parse("2026-01-01T04:20:00.000Z");
		const store = new RunStore({
			rootDir: path.join(cwd, ".pi-subagents"),
			now: () => now,
		});
		const run = store.createRun({
			task: "timing fixture",
			cwd,
			herdr: { supervisor: "rpc" },
		});
		const done = child(root, "reviewer-0", "2026-01-01T04:00:00.000Z", {
			agent: "reviewer",
			retiredAt: "2026-01-01T04:10:00.000Z",
			execution: { status: "success", turns: 2 },
		});
		const live = child(root, "worker-0", "2026-01-01T04:15:00.000Z", {
			agent: "worker",
			state: "working",
		});
		// reviewer: user 04:00:00 → assistant 04:05:00 = 5m generation
		writeFileSync(
			done.sessionFile,
			sessionWithGeneration([
				{
					userAt: Date.parse("2026-01-01T04:00:00.000Z"),
					assistantAt: Date.parse("2026-01-01T04:05:00.000Z"),
				},
			]),
		);
		// live: one turn so far, 2m generation; wall is 5m live
		writeFileSync(
			live.sessionFile,
			sessionWithGeneration([
				{
					userAt: Date.parse("2026-01-01T04:15:00.000Z"),
					assistantAt: Date.parse("2026-01-01T04:17:00.000Z"),
				},
			]),
		);
		await store.addChild(run.runId, done);
		await store.addChild(run.runId, live);

		const runs = store.listRuns();
		const sessions = new Map(
			runs.flatMap((record) =>
				record.children.map(
					(entry) =>
						[entry.sessionFile, parseSessionFile(entry.sessionFile)] as const,
				),
			),
		);
		const summary = aggregateSubagentRuns(runs, { now, sessions });
		const report = buildTimingReport(summary, { cwd });

		assert.equal(report.children.length, 2);
		const reviewer = report.children.find((c) => c.name === "reviewer-0");
		const worker = report.children.find((c) => c.name === "worker-0");
		assert.ok(reviewer);
		assert.ok(worker);

		assert.equal(reviewer.wall_ms, 10 * 60_000);
		assert.equal(reviewer.generation_ms, 5 * 60_000);
		assert.equal(reviewer.other_ms, 5 * 60_000);
		assert.equal(reviewer.turns, 2);
		assert.equal(reviewer.live, false);
		assert.equal(reviewer.liveWall, false);

		assert.equal(worker.wall_ms, 5 * 60_000);
		assert.equal(worker.generation_ms, 2 * 60_000);
		assert.equal(worker.other_ms, 3 * 60_000);
		assert.equal(worker.live, true);
		assert.equal(worker.liveWall, true);

		const table = formatTimingTable(report, { cwd });
		assert.match(table, /Subagent timing — 2 children/);
		assert.match(table, /\| reviewer-0 \| retired \| 10m \| 5m \| 5m \| 2 \|/);
		assert.match(table, /\| worker-0 \| working \| 5m\+ \| 2m \| 3m \|/);
		assert.match(table, /span 20m · sum wall 15m · concurrency ~/);

		const json = JSON.parse(formatTimingJson(report));
		assert.equal(json.children.length, 2);
		assert.equal(json.sum_wall_ms, 15 * 60_000);
		assert.equal(json.span_ms, 20 * 60_000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("timing: with name returns single-child detail; unknown notifies", async () => {
	const root = tempRoot();
	try {
		const cwd = path.join(root, "project");
		const now = Date.parse("2026-01-01T04:20:00.000Z");
		const store = new RunStore({
			rootDir: path.join(cwd, ".pi-subagents"),
			now: () => now,
		});
		const run = store.createRun({ task: "detail", cwd, herdr: { supervisor: "rpc" } });
		const entry = child(root, "reviewer-0", "2026-01-01T04:00:00.000Z", {
			agent: "reviewer",
			retiredAt: "2026-01-01T04:04:00.000Z",
			execution: { status: "success", turns: 1 },
		});
		writeFileSync(
			entry.sessionFile,
			sessionWithGeneration([
				{
					userAt: Date.parse("2026-01-01T04:00:00.000Z"),
					assistantAt: Date.parse("2026-01-01T04:03:00.000Z"),
				},
			]),
		);
		await store.addChild(run.runId, entry);

		const messages: string[] = [];
		const errors: string[] = [];
		const fakePi = {
			sendMessage(message: { content: string }) {
				messages.push(message.content);
			},
		} as any;
		const command = createTimingCommand(fakePi);
		await command.handler("reviewer-0", {
			cwd,
			ui: { notify(msg: string) { errors.push(msg); } },
		} as never);
		assert.equal(messages.length, 1);
		assert.match(messages[0] ?? "", /^reviewer-0 — reviewer/);
		assert.match(messages[0] ?? "", /wall: 4m/);
		assert.match(messages[0] ?? "", /generation: 3m/);
		assert.match(messages[0] ?? "", /other: 1m/);

		await command.handler("--json reviewer-0", {
			cwd,
			ui: { notify() {} },
		} as never);
		const detail = JSON.parse(messages[1] ?? "{}");
		assert.equal(detail.name, "reviewer-0");
		assert.equal(detail.wall_ms, 4 * 60_000);
		assert.equal(detail.generation_ms, 3 * 60_000);
		assert.equal(detail.other_ms, 1 * 60_000);

		await command.handler("nope", {
			cwd,
			ui: { notify(msg: string) { errors.push(msg); } },
		} as never);
		assert.match(errors[0] ?? "", /^unknown child: nope/);
		assert.equal(messages.length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("timing: missing spawnedAt yields wall 0 / — ; no session turns → gen/other —", async () => {
	const root = tempRoot();
	try {
		const cwd = path.join(root, "project");
		const now = Date.parse("2026-01-01T05:00:00.000Z");
		const store = new RunStore({
			rootDir: path.join(cwd, ".pi-subagents"),
			now: () => now,
		});
		const run = store.createRun({ task: "missing spawn", cwd });
		const noSpawn = child(root, "ghost-0", "", {
			agent: "ghost",
			state: "retired",
			retiredAt: "2026-01-01T04:55:00.000Z",
		});
		const noSession = child(root, "empty-0", "2026-01-01T04:50:00.000Z", {
			agent: "empty",
			retiredAt: "2026-01-01T04:55:00.000Z",
		});
		// empty session file → no turns
		writeFileSync(noSession.sessionFile, "");
		await store.addChild(run.runId, noSpawn);
		await store.addChild(run.runId, noSession);

		const runs = store.listRuns();
		const sessions = new Map(
			runs.flatMap((record) =>
				record.children.map(
					(entry) =>
						[entry.sessionFile, parseSessionFile(entry.sessionFile)] as const,
				),
			),
		);
		const summary = aggregateSubagentRuns(runs, { now, sessions });
		const report = buildTimingReport(summary);

		const ghost = report.children.find((c) => c.name === "ghost-0");
		const empty = report.children.find((c) => c.name === "empty-0");
		assert.ok(ghost);
		assert.ok(empty);

		assert.equal(ghost.wall_ms, 0);
		assert.equal(ghost.startedAtMs, null);
		assert.equal(ghost.generation_ms, null);
		assert.equal(ghost.other_ms, null);

		assert.equal(empty.wall_ms, 5 * 60_000);
		assert.equal(empty.generation_ms, null);
		assert.equal(empty.other_ms, null);
		assert.equal(empty.turns, null);

		const table = formatTimingTable(report);
		assert.match(table, /\| ghost-0 \| retired \| — \| — \| — \| — \|/);
		assert.match(table, /\| empty-0 \| retired \| 5m \| — \| — \| — \|/);

		// timingChildFromSummary mirrors aggregate path
		const summaryGhost = summary.groups
			.flatMap((g) => g.children)
			.find((c) => c.child.name === "ghost-0");
		assert.ok(summaryGhost);
		assert.deepEqual(timingChildFromSummary(summaryGhost).wall_ms, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("timing command: help-style usage, empty state, completions", async () => {
	const root = tempRoot();
	try {
		const cwd = path.join(root, "project");
		const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
		const run = store.createRun({ task: "cmd", cwd, herdr: { supervisor: "rpc" } });
		const entry = child(root, "reviewer-0", new Date(Date.now() - 1000).toISOString(), {
			agent: "reviewer",
		});
		writeFileSync(entry.sessionFile, "");
		await store.addChild(run.runId, entry);

		const messages: string[] = [];
		const errors: string[] = [];
		const fakePi = {
			sendMessage(message: { content: string }) {
				messages.push(message.content);
			},
		} as any;
		const command = createTimingCommand(fakePi);

		await command.handler("--bogus", {
			cwd,
			ui: { notify(msg: string) { errors.push(msg); } },
		} as never);
		assert.match(errors[0] ?? "", /^Usage: \/legion timing/);

		await command.handler("", {
			cwd,
			ui: { notify() {} },
		} as never);
		assert.match(messages[0] ?? "", /Subagent timing/);

		await command.handler("--json", {
			cwd,
			ui: { notify() {} },
		} as never);
		const parsed = JSON.parse(messages[1] ?? "{}");
		assert.ok(Array.isArray(parsed.children));

		const completions = await command.getArgumentCompletions?.("rev");
		assert.deepEqual(completions, [
			{ value: "reviewer-0", label: "reviewer-0" },
		]);
		const jsonFlag = await command.getArgumentCompletions?.("--j");
		assert.deepEqual(jsonFlag, [{ value: "--json", label: "--json" }]);

		const emptyCwd = path.join(root, "empty-project");
		await command.handler("", {
			cwd: emptyCwd,
			ui: { notify() {} },
		} as never);
		assert.match(messages[2] ?? "", /No subagent runs under/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("formatTimingDetail and empty table are stable", () => {
	const empty = formatTimingTable(
		{ children: [], span_ms: null, sum_wall_ms: 0 },
		{ cwd: "/tmp/project" },
	);
	assert.match(empty, /^No subagent runs under \/tmp\/project\./);

	const detail = formatTimingDetail(
		{
			name: "a-0",
			role: "a",
			state: "retired",
			live: false,
			wall_ms: 60_000,
			generation_ms: 40_000,
			other_ms: 20_000,
			turns: 1,
			startedAtMs: 1,
			endedAtMs: 2,
			liveWall: false,
		},
		{
			schemaVersion: 1,
			runId: "r1",
			task: "t",
			cwd: "/tmp",
			herdr: { supervisor: "rpc" },
			path: [],
			depth: 0,
			maxDepth: 1,
			children: [],
			budget: { spawned: 1, limit: null, granted: 0 },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:01:00.000Z",
		},
	);
	assert.match(detail, /^a-0 — a/);
	assert.match(detail, /wall: 1m/);
	assert.match(detail, /generation: 40s/);
	assert.match(detail, /other: 20s/);
});
