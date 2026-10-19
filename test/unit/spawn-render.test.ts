import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	renderSpawnResult,
	spawnModeSummary,
} from "../../src/extension/spawn-render.ts";

// Unit tests run without the host Pi process that normally initializes theme.
initTheme("dark");

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function result(
	text: string,
	details: unknown = {},
): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

/** `Text` pads each row to the render width; trim so assertions read plainly. */
function render(
	res: AgentToolResult<unknown>,
	expanded = false,
): string[] {
	return renderSpawnResult(res, { expanded, isPartial: false }, identityTheme)
		.render(200)
		.map((line) => line.trimEnd());
}

// ---------------------------------------------------------------------------
// spawnModeSummary
// ---------------------------------------------------------------------------

test("spawnModeSummary: no details, wrong shapes and legacy handles yield undefined", () => {
	assert.equal(spawnModeSummary(undefined), undefined);
	assert.equal(spawnModeSummary(null), undefined);
	assert.equal(spawnModeSummary({}), undefined);
	assert.equal(spawnModeSummary("details"), undefined);
	assert.equal(spawnModeSummary({ runId: "r-1", handles: [], async: true }), undefined);
	// Launch-family details carry `handles` as plain names, not objects.
	assert.equal(spawnModeSummary({ runId: "r-1", handles: ["worker-0"] }), undefined);
	// Legacy vexillatio: a handle object with NO spawnMode renders as absent.
	assert.equal(
		spawnModeSummary({
			handles: [{ name: "scout-0", agent: "scout", sessionFile: "/tmp/s.jsonl" }],
		}),
		undefined,
	);
	// An out-of-vocabulary value is skipped, never printed as a guess.
	assert.equal(spawnModeSummary({ spawns: [{ name: "w", agent: "worker", spawnMode: "unknown" }] }), undefined);
	assert.equal(spawnModeSummary({ spawns: [{ name: "", agent: "worker", spawnMode: "rpc" }] }), undefined);
});

test("spawnModeSummary: launch-family details shape", () => {
	assert.equal(
		spawnModeSummary({
			runId: "r-1",
			handles: ["scout-0"],
			async: true,
			spawns: [{ name: "scout-0", agent: "scout", spawnMode: "inprocess" }],
		}),
		"spawn: scout-0=inprocess",
	);
	assert.equal(
		spawnModeSummary({
			spawns: [
				{ name: "worker-0", agent: "worker", spawnMode: "rpc" },
				{ name: "scout-1", agent: "scout", spawnMode: "inprocess" },
			],
		}),
		"spawn: worker-0=rpc, scout-1=inprocess",
	);
});

test("spawnModeSummary: vexillatio details shape reads handles[].spawnMode", () => {
	assert.equal(
		spawnModeSummary({
			runId: "r-1",
			handles: [
				{ name: "scout-0", agent: "scout", sessionFile: "/tmp/s0.jsonl", spawnMode: "rpc" },
				{ name: "scout-1", agent: "scout", sessionFile: "/tmp/s1.jsonl", spawnMode: "inprocess" },
			],
			async: false,
		}),
		"spawn: scout-0=rpc, scout-1=inprocess",
	);
});

test("spawnModeSummary: unknown modes are skipped, surviving entries still render", () => {
	assert.equal(
		spawnModeSummary({
			spawns: [
				{ name: "legacy-0", agent: "worker" },
				{ name: "worker-1", agent: "worker", spawnMode: "rpc" },
			],
		}),
		"spawn: worker-1=rpc",
	);
});

test("spawnModeSummary: a throwing getter is a missing fact, never a throw (#209/D4)", () => {
	// The host swallows a throwing renderer and paints its fallback card, so a
	// hostile `details` object would silently erase the whole result. Shape
	// checks are not enough: the read itself is what throws.
	const throwingProperty = {
		get spawns(): never {
			throw new Error("boom");
		},
	};
	assert.equal(spawnModeSummary(throwingProperty), undefined);
	assert.doesNotThrow(() => spawnModeSummary(throwingProperty));

	const throwingHandles = {
		get handles(): never {
			throw new Error("boom");
		},
	};
	assert.equal(spawnModeSummary(throwingHandles), undefined);

	// A Proxy that throws on ANY property read is the same class of hostile
	// input and must degrade identically.
	const hostile = new Proxy({}, {
		get(): never {
			throw new Error("trap");
		},
	});
	assert.equal(spawnModeSummary(hostile), undefined);

	// And the renderer as a whole still produces the model text.
	assert.doesNotThrow(() =>
		renderSpawnResult(result("body", throwingProperty), { expanded: false, isPartial: false }, identityTheme),
	);
	assert.doesNotThrow(() =>
		renderSpawnResult(
			{ content: [{ type: "text", text: "body" }], details: hostile } as unknown as AgentToolResult<unknown>,
			{ expanded: false, isPartial: false },
			identityTheme,
		),
	);
});

test("spawnModeSummary: one entry per child, first occurrence wins (#209/D4)", () => {
	// A result carrying the same handle in both detail shapes used to print
	// `spawn: w=rpc, w=rpc`.
	assert.equal(
		spawnModeSummary({
			spawns: [{ name: "w", agent: "worker", spawnMode: "rpc" }],
			handles: [{ name: "w", agent: "worker", sessionFile: "/tmp/w.jsonl", spawnMode: "rpc" }],
		}),
		"spawn: w=rpc",
	);
	// Distinct children are still all listed, in first-seen order.
	assert.equal(
		spawnModeSummary({
			spawns: [
				{ name: "w", agent: "worker", spawnMode: "rpc" },
				{ name: "s", agent: "scout", spawnMode: "inprocess" },
			],
			handles: [
				{ name: "s", agent: "scout", sessionFile: "/tmp/s.jsonl", spawnMode: "inprocess" },
				{ name: "q", agent: "scout", sessionFile: "/tmp/q.jsonl", spawnMode: "inprocess" },
			],
		}),
		"spawn: w=rpc, s=inprocess, q=inprocess",
	);
});

// ---------------------------------------------------------------------------
// renderSpawnResult
// ---------------------------------------------------------------------------

test("renderSpawnResult: a \\r-separated progress stream cannot bypass the cap (#209/D4)", () => {
	// `Text` treats `\r` as a line break, so 20 carriage-returned segments used
	// to paint 20 rows and never show the hint: the cap counted `\n` only.
	const segments = Array.from({ length: 20 }, (_, i) => `progress-${i + 1}`);
	const rendered = render(result(segments.join("\r")));
	assert.ok(rendered.length <= 11, `cap holds on a \\r stream (got ${rendered.length} rows)`);
	assert.match(rendered.join("\n"), /ctrl\+o to expand/, "the collapsed hint is reachable from a \\r stream");
	// The segments stay readable instead of being concatenated into one blob.
	assert.match(rendered[0] ?? "", /progress-1$/);
	assert.match(rendered[1] ?? "", /progress-2$/);
});

test("renderSpawnResult: binary control bytes never reach the terminal (#209/D4)", () => {
	// Same byte set the host fallback sanitizes (`sanitizeBinaryOutput`).
	const noisy = "a\u0000b\u0007c\u0008d\u000Be\u000Cf\u000Eg\u001Fh\uFFF9i\uFFFBj";
	const rendered = render(result(noisy));
	const painted = rendered.join("\n");
	assert.doesNotMatch(
		painted,
		/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/,
		"no raw control character may be painted",
	);
	assert.equal(painted.trimEnd(), "abcdefghij", "the visible text survives, only the control bytes are gone");
});

test("renderSpawnResult: a \\r\\n stream counts as line breaks, not twice (#209/D4)", () => {
	const lines = Array.from({ length: 14 }, (_, i) => `line-${i + 1}`);
	const rendered = render(result(lines.join("\r\n")));
	assert.equal(rendered.length, 11, "10 visible rows + 1 hint, no phantom blank rows");
	assert.match(rendered[10] ?? "", /ctrl\+o to expand/);
	assert.deepEqual(rendered.slice(0, 3), ["line-1", "line-2", "line-3"]);
});

test("renderSpawnResult: collapsed keeps the summary line and caps at 10 lines plus the hint", () => {
	const lines = Array.from({ length: 14 }, (_, i) => `line-${i + 1}`);
	const rendered = render(
		result(lines.join("\n"), {
			spawns: [{ name: "worker-0", agent: "worker", spawnMode: "rpc" }],
		}),
		false,
	);
	// The cap applies to the composed text (summary line included, as the
	// contract reads it): 10 visible rows + 1 hint.
	assert.equal(rendered.length, 11);
	assert.match(rendered[0] ?? "", /spawn: worker-0=rpc/);
	assert.match(rendered[1] ?? "", /line-1/);
	assert.match(rendered[9] ?? "", /line-9/);
	assert.match(rendered[10] ?? "", /\.\.\. \(5 more lines, ctrl\+o to expand\)/);
	assert.doesNotMatch(rendered.join("\n"), /line-10/);
});

test("renderSpawnResult: expanded prints every line and no hint", () => {
	const lines = Array.from({ length: 14 }, (_, i) => `line-${i + 1}`);
	const rendered = render(
		result(lines.join("\n"), {
			spawns: [{ name: "worker-0", agent: "worker", spawnMode: "rpc" }],
		}),
		true,
	);
	assert.equal(rendered.length, 15);
	assert.match(rendered[0] ?? "", /spawn: worker-0=rpc/);
	assert.match(rendered[14] ?? "", /line-14/);
	assert.doesNotMatch(rendered.join("\n"), /ctrl\+o to expand/);
});

test("renderSpawnResult: a short result is not truncated and adds no hint", () => {
	const rendered = render(result("▶ worker-0 started"));
	assert.deepEqual(rendered, ["▶ worker-0 started"]);
});

test("renderSpawnResult: no summary line when the mode is unknown (never a guessed rpc)", () => {
	const rendered = render(result("▶ legacy-0 started", { handles: ["legacy-0"] }));
	assert.deepEqual(rendered, ["▶ legacy-0 started"]);
	assert.doesNotMatch(rendered.join("\n"), /spawn:/);
});

test("renderSpawnResult: hostile/malformed details never throw", () => {
	const noisy = [
		undefined,
		null,
		42,
		"details",
		[],
		{ spawns: "not-an-array" },
		{ spawns: [null, 7, {}, { name: 1 }] },
		{ handles: [{ name: "a", spawnMode: 99 }] },
		{ handles: "nope" },
	];
	for (const details of noisy) {
		assert.doesNotThrow(() => spawnModeSummary(details));
		assert.doesNotThrow(() =>
			renderSpawnResult(result("body", details), { expanded: false, isPartial: false }, identityTheme),
		);
	}
	// A malformed result object itself must not take the card down either.
	assert.doesNotThrow(() =>
		renderSpawnResult(
			{ content: undefined, details: undefined } as unknown as AgentToolResult<unknown>,
			{ expanded: false, isPartial: false },
			identityTheme,
		),
	);
	// Nor may host-supplied options: absent options degrade to the collapsed view.
	assert.doesNotThrow(() =>
		renderSpawnResult(
			result("body"),
			undefined as unknown as { expanded: boolean; isPartial: boolean },
			identityTheme,
		),
	);
});

test("renderSpawnResult: terminal sequences are stripped from the model text", () => {
	const rendered = render(result("ok \u001b[31mred\u001b[0m done"));
	assert.doesNotMatch(rendered.join(""), /\[31m/);
	assert.match(rendered.join(""), /ok .*red.* done/);
});

test("renderSpawnResult: non-text content blocks are not printed as text", () => {
	const res = {
		content: [
			{ type: "text", text: "visible" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		],
		details: {},
	} as unknown as AgentToolResult<unknown>;
	const rendered = render(res);
	assert.deepEqual(rendered, ["visible"]);
});

test("renderSpawnResult: partial results render the same way (no special casing)", () => {
	const component = renderSpawnResult(
		result("streaming…", { spawns: [{ name: "s", agent: "scout", spawnMode: "inprocess" }] }),
		{ expanded: false, isPartial: true },
		identityTheme,
	);
	const rendered = component.render(200).map((line) => line.trimEnd());
	assert.match(rendered[0] ?? "", /spawn: s=inprocess/);
	assert.match(rendered[1] ?? "", /streaming/);
});
