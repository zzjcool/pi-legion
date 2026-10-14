/**
 * E2E: mock-llm + railway strip shared time axis / spawn connectors.
 *
 * 1. Scripted OpenAI mock issues `subagent` spawns (no real API keys).
 * 2. Railway render uses those spawn times: live lanes share one axis, scroll
 *    left in lockstep, root-spawned siblings share ┬/├/╰ connectors, ended
 *    lanes vanish and compact.
 * 3. Status-board widget path smoke-checks the same connector glyphs.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	MOCK_API_KEY,
	startMockLlm,
	writeMockPiHome,
	type MockScript,
} from "../mock-llm/index.ts";
import { nodesFromEntries } from "../../src/tui/viz/model.ts";
import { renderRailway } from "../../src/tui/viz/railway.ts";
import {
	createStatusBoard,
	type StatusEntry,
	type StatusUi,
	type WidgetFactory,
} from "../../src/tui/status.ts";

const T0 = 1_700_000_000_000;
const sec = (s: number): number => T0 + s * 1000;
const plainTheme = {
	fg: (_c: string, text: string) => text,
	bold: (text: string) => text,
};

const multiSpawnScript: MockScript = {
	models: [{ id: "flash", name: "Mock Flash" }],
	rules: [
		{
			name: "after-tools",
			when: { hasToolResult: true },
			then: {
				type: "text",
				content: 'All scouts spawned.\n{"ok": true, "reason": "SPAWN_OK"}\n',
			},
		},
		{
			name: "spawn",
			then: {
				type: "tool_call",
				name: "subagent",
				arguments: {
					agent: "scout",
					task: 'Reply SCOUT_OK. End with {"ok": true, "reason": "SCOUT_OK"}.',
				},
			},
		},
	],
};

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
			message: {
				content?: string | null;
				tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
			};
			finish_reason: string;
		}>;
	};
}

function entriesAt(children: Array<{ name: string; startedAt: number; ended?: number }>): StatusEntry[] {
	return [
		{ name: "centurion-0", agent: "centurion", state: "running", startedAt: sec(0), nodeId: "root", parentId: null, depth: 0 },
		...children.map((child, index) => ({
			name: child.name,
			agent: "scout",
			state: child.ended !== undefined ? "settled" : "running",
			startedAt: child.startedAt,
			...(child.ended !== undefined ? { finishedAt: child.ended } : {}),
			nodeId: `root.${index}`,
			parentId: "root" as string | null,
			depth: 1,
		})),
	];
}

test("e2e mock-llm: spawn tool call + railway lockstep scroll + shared spawn connectors", async () => {
	const homeDir = mkdtempSync(path.join(tmpdir(), "railway-mock-home-"));
	const mock = await startMockLlm({ scenario: "script", script: multiSpawnScript, port: 0 });
	try {
		const home = writeMockPiHome({ dir: homeDir, baseUrl: mock.baseUrl });
		const models = JSON.parse(readFileSync(path.join(home.agentDir, "models.json"), "utf8")) as {
			providers: { mock: { apiKey: string; baseUrl: string } };
		};
		assert.equal(models.providers.mock.apiKey, "mock");
		assert.equal(models.providers.mock.baseUrl, mock.baseUrl);

		// --- mock LLM: parent turn issues subagent, then settles after tool result ---
		const first = await chat(mock.baseUrl, [
			{ role: "user", content: "Spawn scouts in parallel to survey the repo." },
		]);
		assert.equal(first.choices[0]?.finish_reason, "tool_calls");
		const tool = first.choices[0]?.message.tool_calls?.[0];
		assert.equal(tool?.function.name, "subagent");
		assert.match(tool?.function.arguments ?? "", /"agent"\s*:\s*"scout"/);

		const second = await chat(mock.baseUrl, [
			{ role: "user", content: "Spawn scouts in parallel to survey the repo." },
			{ role: "assistant", content: null, tool_calls: first.choices[0]?.message.tool_calls },
			{ role: "tool", tool_call_id: tool?.id ?? "call_1", content: '{"ok":true,"name":"scout-0"}' },
		]);
		assert.match(second.choices[0]?.message.content ?? "", /SPAWN_OK/);

		// --- viz: spawn times as if three root children were launched (two at once) ---
		const children = [
			{ name: "scout-0", startedAt: sec(100) },
			{ name: "scout-1", startedAt: sec(100) },
			{ name: "scout-2", startedAt: sec(160) },
			{ name: "scout-done", startedAt: sec(40), ended: sec(180) },
		];
		const nodes = nodesFromEntries(entriesAt(children));

		const frame = (t: number) => {
			const out = renderRailway({ nodes, now: sec(t), width: 120, rate: 0 })!;
			const lines = out.canvas.toLines(plainTheme).map((line) => Array.from(line));
			return { out, lines };
		};

		const a = frame(200);
		assert.deepEqual(a.out.shown.map((n) => n.name), ["scout-0", "scout-1", "scout-2"]);
		assert.ok(!a.lines.flat().join("").includes("scout-done"));
		const ticks = a.lines[0]!.flatMap((ch, x) => (ch === "┬" ? [x] : []));
		assert.equal(ticks.length, 2, "one tick for the t=100 pair, one for scout-2");
		const [sxPair, sxLate] = ticks as [number, number];
		assert.deepEqual(
			[a.lines[1]![sxPair], a.lines[2]![sxPair], a.lines[3]![sxLate]],
			["├", "╰", "╰"],
			"siblings share one vertical; late spawn has its own",
		);
		assert.equal(a.out.hit[0]![sxPair], "root.0");
		const headsA = a.lines.slice(1).map((line) => line.lastIndexOf("━"));
		assert.ok(headsA.every((h) => h === headsA[0]), `shared now-column ${JSON.stringify(headsA)}`);
		const startsA = a.lines.slice(1).map((line) => line.findIndex((ch) => "╺╰╭┄├".includes(ch)));

		const b = frame(260);
		const startsB = b.lines.slice(1).map((line) => line.findIndex((ch) => "╺╰╭┄├".includes(ch)));
		const shifts = startsA.map((s, i) => s - startsB[i]!);
		assert.ok(shifts.every((s) => s === shifts[0]), `lockstep ${JSON.stringify(shifts)}`);
		assert.ok(shifts[0]! > 0, "lanes move left together");
		assert.deepEqual(b.out.shown.map((n) => n.name), ["scout-0", "scout-1", "scout-2"]);

		// --- status board widget path (Date.now()-relative) still draws connectors ---
		let factory: WidgetFactory | undefined;
		const ctx: StatusUi = {
			hasUI: true,
			ui: {
				theme: plainTheme,
				setStatus() {},
				setWidget(_k, c) {
					factory = typeof c === "function" ? c : undefined;
				},
			},
		};
		const board = createStatusBoard({ strip: "railway", tickMs: 60_000 });
		board.bind(ctx);
		const wall = Date.now();
		board.paint(
			[
				{ name: "centurion-0", agent: "centurion", state: "running", startedAt: wall - 300_000, nodeId: "root", parentId: null, depth: 0 },
				{ name: "scout-0", agent: "scout", state: "running", startedAt: wall - 120_000, nodeId: "root.0", parentId: "root", depth: 1 },
				{ name: "scout-1", agent: "scout", state: "running", startedAt: wall - 120_000, nodeId: "root.1", parentId: "root", depth: 1 },
				{ name: "scout-2", agent: "scout", state: "running", startedAt: wall - 60_000, nodeId: "root.2", parentId: "root", depth: 1 },
			],
			wall,
		);
		const widgetLines = factory!({ requestRender() {} }, plainTheme)
			.render(120)
			.map((line) => stripTerminalSequences(line));
		assert.match(widgetLines.join("\n"), /3 live/);
		assert.ok(widgetLines[0]!.includes("┬"), "header spawn ticks through the widget");
		assert.ok(widgetLines.some((line) => line.includes("╰") || line.includes("├")), "fork connectors through the widget");
		for (const line of widgetLines) assert.equal(visibleWidth(line), 120);

		assert.ok(mock.requestCount() >= 2);
	} finally {
		await mock.close();
		rmSync(homeDir, { recursive: true, force: true });
	}
});

test("e2e mock-llm: built-in spawn-scout scenario then settle", async () => {
	const mock = await startMockLlm({ scenario: "spawn-scout", port: 0 });
	try {
		const first = await chat(mock.baseUrl, [{ role: "user", content: "please spawn a scout" }]);
		assert.equal(first.choices[0]?.message.tool_calls?.[0]?.function.name, "subagent");
		const second = await chat(mock.baseUrl, [
			{ role: "user", content: "please spawn a scout" },
			{ role: "assistant", content: null, tool_calls: first.choices[0]?.message.tool_calls },
			{ role: "tool", content: "scout settled" },
		]);
		assert.match(second.choices[0]?.message.content ?? "", /ok|Spawned/i);
	} finally {
		await mock.close();
	}
});
