/**
 * Broader mock-llm e2e for legion behaviours that previously needed a live model:
 * multi-child railway (connectors / vanish / lockstep), stop one+all,
 * idle strip hint vs main busy, auto-doctor on model-miss / memory refuse,
 * verify concurrency ≤2.
 *
 * Always uses dummy apiKey "mock" — never copies host auth.json or real keys.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	MOCK_API_KEY,
	startMockLlm,
	writeMockPiHome,
	type MockScript,
} from "../mock-llm/index.ts";
import { enrichFailureWithAutoDoctor } from "../../src/extension/auto-doctor.ts";
import { clearSpawnFailures } from "../../src/extension/spawn-hints.ts";
import {
	IDLE_STOP_HINT,
	runLegionStop,
	type StopJob,
	type StopNode,
} from "../../src/extension/legion-stop.ts";
import { acquireVerifySlot } from "../../src/runs/verify-queue.ts";
import { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";
import { ErrorCodes } from "../../src/shared/types.ts";
import { nodesFromEntries } from "../../src/tui/viz/model.ts";
import { renderRailway } from "../../src/tui/viz/railway.ts";
import {
	createStatusBoard,
	type StatusEntry,
	type StatusUi,
	type WidgetFactory,
} from "../../src/tui/status.ts";

const T0 = 1_700_000_000_000;
const sec = (s: number) => T0 + s * 1000;
const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

async function chat(baseUrl: string, messages: unknown[]) {
	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${MOCK_API_KEY}`,
		},
		body: JSON.stringify({ model: "flash", stream: false, messages }),
	});
	const raw = await res.text();
	assert.equal(res.ok, true, raw);
	return JSON.parse(raw) as {
		choices: Array<{
			finish_reason: string;
			message: {
				content?: string | null;
				tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
			};
		}>;
	};
}

const multiChildScript: MockScript = {
	models: [{ id: "flash", name: "Mock Flash" }],
	rules: [
		{
			name: "after",
			when: { hasToolResult: true },
			then: { type: "text", content: '{"ok": true, "reason": "MULTI_SPAWN_OK"}' },
		},
		{
			name: "spawn",
			when: { promptIncludes: "spawn" },
			then: {
				type: "tool_call",
				name: "subagent",
				arguments: { agent: "scout", task: "SCOUT_OK" },
			},
		},
		{ name: "default", then: { type: "text", content: "MOCK_OK" } },
	],
};

test("e2e: mock-llm multi-spawn + railway connectors, vanish, lockstep scroll", async () => {
	const homeDir = mkdtempSync(path.join(tmpdir(), "mle2e-rail-"));
	const mock = await startMockLlm({ scenario: "script", script: multiChildScript, port: 0 });
	try {
		writeMockPiHome({ dir: homeDir, baseUrl: mock.baseUrl });
		const first = await chat(mock.baseUrl, [{ role: "user", content: "spawn three scouts" }]);
		assert.equal(first.choices[0]?.message.tool_calls?.[0]?.function.name, "subagent");
		const call = first.choices[0]?.message.tool_calls?.[0];
		const settled = await chat(mock.baseUrl, [
			{ role: "user", content: "spawn three scouts" },
			{ role: "assistant", content: null, tool_calls: first.choices[0]?.message.tool_calls },
			{ role: "tool", tool_call_id: call?.id ?? "c1", content: "scout-0 ok" },
		]);
		assert.match(settled.choices[0]?.message.content ?? "", /MULTI_SPAWN_OK/);

		const entries: StatusEntry[] = [
			{ name: "centurion-0", agent: "centurion", state: "running", startedAt: sec(0), nodeId: "root", parentId: null, depth: 0 },
			{ name: "scout-0", agent: "scout", state: "running", startedAt: sec(100), nodeId: "root.0", parentId: "root", depth: 1 },
			{ name: "scout-1", agent: "scout", state: "running", startedAt: sec(100), nodeId: "root.1", parentId: "root", depth: 1 },
			{ name: "scout-2", agent: "scout", state: "running", startedAt: sec(160), nodeId: "root.2", parentId: "root", depth: 1 },
			{ name: "scout-done", agent: "scout", state: "settled", startedAt: sec(40), finishedAt: sec(180), nodeId: "root.x", parentId: "root", depth: 1 },
		];
		const nodes = nodesFromEntries(entries);
		const frame = (t: number) => {
			const out = renderRailway({ nodes, now: sec(t), width: 120, rate: 0 })!;
			const lines = out.canvas.toLines(plain).map((l) => Array.from(l));
			return { out, lines };
		};
		const a = frame(200);
		assert.deepEqual(a.out.shown.map((n) => n.name), ["scout-0", "scout-1", "scout-2"]);
		assert.ok(!a.lines.flat().join("").includes("scout-done"), "ended lane vanished");
		const ticks = a.lines[0]!.flatMap((ch, x) => (ch === "┬" ? [x] : []));
		assert.equal(ticks.length, 2, "pair at t=100 + late scout-2");
		const [sxPair, sxLate] = ticks as [number, number];
		assert.deepEqual([a.lines[1]![sxPair], a.lines[2]![sxPair], a.lines[3]![sxLate]], ["├", "╰", "╰"]);
		const startsA = a.lines.slice(1).map((l) => l.findIndex((ch) => "╺╰╭┄├".includes(ch)));
		const b = frame(260);
		const startsB = b.lines.slice(1).map((l) => l.findIndex((ch) => "╺╰╭┄├".includes(ch)));
		const shifts = startsA.map((s, i) => s - startsB[i]!);
		assert.ok(shifts.every((s) => s === shifts[0]) && shifts[0]! > 0, `lockstep ${JSON.stringify(shifts)}`);
		assert.ok(mock.requestCount() >= 2);
	} finally {
		await mock.close();
		rmSync(homeDir, { recursive: true, force: true });
	}
});

test("e2e: mock stop-all scenario + /legion stop one/all", async () => {
	const mock = await startMockLlm({ scenario: "stop-all", port: 0 });
	try {
		const first = await chat(mock.baseUrl, [{ role: "user", content: "stop everything" }]);
		assert.equal(first.choices[0]?.message.tool_calls?.[0]?.function.name, "subagent");
		assert.match(first.choices[0]?.message.tool_calls?.[0]?.function.arguments ?? "", /"action"\s*:\s*"stop"/);
		assert.match(first.choices[0]?.message.tool_calls?.[0]?.function.arguments ?? "", /"all"\s*:\s*true/);

		const nodes: StopNode[] = [
			{ id: "root", name: "centurion-0", parentId: null, depth: 0, status: "running" },
			{ id: "root.a", name: "scout-0", parentId: "root", depth: 1, status: "running" },
			{ id: "root.b", name: "scout-1", parentId: "root", depth: 1, status: "running" },
			{ id: "root.c", name: "worker-0", parentId: "root", depth: 1, status: "running" },
		];
		const jobs: StopJob[] = [
			{ name: "scout-0", nodeId: "root.a", state: "running" },
			{ name: "scout-1", nodeId: "root.b", state: "running" },
			{ name: "worker-0", nodeId: "root.c", state: "running" },
		];
		const calls: Array<{ name?: string; all?: boolean }> = [];
		const deps = {
			jobs: () => jobs,
			nodes: () => nodes,
			stop: async (params: { name?: string; all?: boolean }) => {
				calls.push(params);
				return {
					ok: true,
					text: params.all
						? "Stopped 3 children: scout-0, scout-1, worker-0."
						: `Stopped 1 child: ${params.name}.`,
				};
			},
			notify: () => {},
		};
		assert.equal(await runLegionStop("scout-1", deps), "Stopped 1 child: scout-1.");
		assert.deepEqual(calls, [{ name: "scout-1" }]);
		calls.length = 0;
		assert.match(await runLegionStop("all", deps), /Stopped 3 children/);
		assert.deepEqual(calls, [{ all: true }]);

	} finally {
		await mock.close();
	}
});

test("e2e: idle hint shows only when setIdleHint(true); hidden while main busy", async () => {
	const mock = await startMockLlm({ scenario: "echo", port: 0 });
	const homeDir = mkdtempSync(path.join(tmpdir(), "mle2e-hint-"));
	try {
		writeMockPiHome({ dir: homeDir, baseUrl: mock.baseUrl });
		// Touch the mock so the offline provider path is exercised.
		await chat(mock.baseUrl, [{ role: "user", content: "MOCK_SAY: hint-ok" }]);

		let factory: WidgetFactory | undefined;
		const board = createStatusBoard({ strip: "railway", tickMs: 60_000 });
		const ctx: StatusUi = {
			hasUI: true,
			ui: {
				theme: plain,
				setStatus() {},
				setWidget(_k, c) {
					factory = typeof c === "function" ? c : undefined;
				},
			},
		};
		board.bind(ctx);
		const now = Date.now();
		board.paint(
			[
				{ name: "centurion-0", agent: "centurion", state: "running", startedAt: now - 60_000, nodeId: "root", parentId: null, depth: 0 },
				{ name: "scout-1", agent: "scout", state: "running", startedAt: now - 30_000, nodeId: "root.s", parentId: "root", depth: 1 },
			],
			now,
		);
		const comp = factory!({ requestRender() {} }, plain);
		assert.doesNotMatch(comp.render(120)[0]!, /legion stop/, "default: main busy / no idle hint");
		board.setIdleHint!(true);
		assert.match(comp.render(120)[0]!, new RegExp(IDLE_STOP_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		board.setIdleHint!(false);
		assert.doesNotMatch(comp.render(120)[0]!, /legion stop/, "cleared when main streams again");
		board.clear();
	} finally {
		await mock.close();
		rmSync(homeDir, { recursive: true, force: true });
	}
});

test("e2e: model-missing spawn failure auto-attaches doctor (mock home, no real keys)", async () => {
	const homeDir = mkdtempSync(path.join(tmpdir(), "mle2e-doc-"));
	const mock = await startMockLlm({ scenario: "echo", port: 0 });
	const prev = process.env.PI_CODING_AGENT_DIR;
	clearSpawnFailures();
	try {
		writeMockPiHome({ dir: homeDir, baseUrl: mock.baseUrl });
		mkdirSync(path.join(homeDir, "npm/node_modules/pi-any-endpoint/extensions"), { recursive: true });
		writeFileSync(
			path.join(homeDir, "npm/node_modules/pi-any-endpoint/package.json"),
			JSON.stringify({
				name: "pi-any-endpoint",
				keywords: ["provider"],
				description: "Pi provider",
				pi: { extensions: ["./extensions/index.ts"] },
			}),
		);
		writeFileSync(path.join(homeDir, "npm/node_modules/pi-any-endpoint/extensions/index.ts"), "export default {};\n");
		const settings = JSON.parse(readFileSync(path.join(homeDir, "settings.json"), "utf8")) as Record<string, unknown>;
		settings.packages = ["npm:pi-any-endpoint@0.1.2"];
		writeFileSync(path.join(homeDir, "settings.json"), JSON.stringify(settings));
		process.env.PI_CODING_AGENT_DIR = homeDir;

		const msg =
			'Pi RPC process exited during startup: Error: Model "workbuddy/ghost:high" not found. Use --list-models';
		const enriched = enrichFailureWithAutoDoctor(msg, {
			name: "scout-0",
			stderr: 'Error: Model "workbuddy/ghost:high" not found. Use --list-models',
			args: ["--no-extensions", "--model", "workbuddy/ghost:high"],
			code: "START_FAILED",
			cwd: homeDir,
		});
		assert.match(enriched, /Legion auto-doctor \(model/);
		assert.match(enriched, /## Models|## Extensions|## Next steps/);
		assert.match(enriched, /PI_LEGION_CHILD_EXTENSIONS|pi-any-endpoint|Hint:/);
		// Models.json still only has the dummy mock key.
		const models = JSON.parse(readFileSync(path.join(homeDir, "models.json"), "utf8")) as {
			providers: { mock: { apiKey: string } };
		};
		assert.equal(models.providers.mock.apiKey, "mock");
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		clearSpawnFailures();
		await mock.close();
		rmSync(homeDir, { recursive: true, force: true });
	}
});

test("e2e: memory gate refuse attaches auto-doctor and starts no child", async () => {
	const homeDir = mkdtempSync(path.join(tmpdir(), "mle2e-mem-"));
	const mock = await startMockLlm({ scenario: "echo", port: 0 });
	const prevMin = process.env.PI_LEGION_MIN_FREE_MEM_MB;
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	clearSpawnFailures();
	try {
		writeMockPiHome({ dir: homeDir, baseUrl: mock.baseUrl });
		process.env.PI_CODING_AGENT_DIR = homeDir;
		process.env.PI_LEGION_MIN_FREE_MEM_MB = "4096";
		let created = 0;
		const refused: string[] = [];
		const sup = new RpcSupervisor({
			clientFactory: (() => {
				created++;
				throw new Error("must not start");
			}) as never,
			memoryAvailable: () => 100,
			onSpawnRefused: (m) => refused.push(m),
		});
		await assert.rejects(
			sup.spawnChild({
				name: "scout-0",
				task: "x",
				agent: { name: "scout", kind: "pi", description: "", source: "user", filePath: "<t>", systemPrompt: "", systemPromptMode: "append", inheritProjectContext: true, inheritSkills: false, tools: [] },
				sessionFile: path.join(homeDir, "s.jsonl"),
				tempDir: homeDir,
				cwd: homeDir,
			} as never),
			(e: { code?: string; message: string }) =>
				e.code === ErrorCodes.INSUFFICIENT_MEMORY &&
				/insufficient memory/.test(e.message) &&
				/Legion auto-doctor \(memory/.test(e.message),
		);
		assert.equal(created, 0);
		assert.equal(refused.length, 1);
		assert.match(refused[0]!, /auto-doctor \(memory/);
		assert.equal(sup.isAlive("scout-0"), false);
	} finally {
		if (prevMin === undefined) delete process.env.PI_LEGION_MIN_FREE_MEM_MB;
		else process.env.PI_LEGION_MIN_FREE_MEM_MB = prevMin;
		if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		clearSpawnFailures();
		await mock.close();
		rmSync(homeDir, { recursive: true, force: true });
	}
});

test("e2e: verify concurrency ≤2 while mock LLM is up", async () => {
	const mock = await startMockLlm({ scenario: "declare-verify", port: 0 });
	const lockDir = mkdtempSync(path.join(tmpdir(), "mle2e-vq-"));
	try {
		const declare = await chat(mock.baseUrl, [{ role: "user", content: "declare verify" }]);
		assert.match(declare.choices[0]?.message.content ?? "", /VERIFY_DECLARED|ok/i);

		const cfg = { limit: 2, maxWaitMs: 10_000, lockDir };
		const a = await acquireVerifySlot("a", cfg);
		const b = await acquireVerifySlot("b", cfg);
		let cReady = false;
		const cP = acquireVerifySlot("c", cfg).then((s) => {
			cReady = true;
			return s;
		});
		await new Promise((r) => setTimeout(r, 400));
		assert.equal(cReady, false, "third waiter blocked while 2 slots held");
		a.release();
		const c = await cP;
		assert.equal(cReady, true);
		assert.ok(c.waitedMs >= 300);
		b.release();
		c.release();
	} finally {
		await mock.close();
		rmSync(lockDir, { recursive: true, force: true });
	}
});
