import test from "node:test";
import assert from "node:assert/strict";
import { createCappedOutput, resolveMaxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES } from "../../src/shared/output-cap.ts";
import { defaultVerifyRunner } from "../../src/runs/acceptance.ts";
import { runLegionCommand } from "../../src/extension/legion-tools.ts";

test("capped output keeps head, marks truncation, fires overflow once", () => {
	let fired = 0;
	const c = createCappedOutput(10, () => fired++);
	c.push("12345");
	c.push(Buffer.from("67890abc"));
	c.push("more");
	assert.equal(fired, 1);
	assert.equal(c.truncated, true);
	assert.equal(c.bytesSeen, 17);
	assert.match(c.text(), /^1234567890\n\[output truncated: exceeded 10 bytes/);
});

test("under cap is untouched", () => {
	const c = createCappedOutput(10);
	c.push("hi");
	assert.equal(c.text(), "hi");
	assert.equal(c.truncated, false);
});

test("env resolution", () => {
	assert.equal(resolveMaxOutputBytes({}), DEFAULT_MAX_OUTPUT_BYTES);
	assert.equal(resolveMaxOutputBytes({ PI_LEGION_MAX_OUTPUT_BYTES: "4096" }), 4096);
	assert.equal(resolveMaxOutputBytes({ PI_LEGION_MAX_OUTPUT_BYTES: "-1" }), DEFAULT_MAX_OUTPUT_BYTES);
	assert.equal(resolveMaxOutputBytes({ PI_LEGION_MAX_OUTPUT_BYTES: "abc" }), DEFAULT_MAX_OUTPUT_BYTES);
});

async function withCap<T>(cap: string, fn: () => Promise<T>): Promise<T> {
	const prev = process.env.PI_LEGION_MAX_OUTPUT_BYTES;
	process.env.PI_LEGION_MAX_OUTPUT_BYTES = cap;
	try { return await fn(); } finally {
		if (prev === undefined) delete process.env.PI_LEGION_MAX_OUTPUT_BYTES; else process.env.PI_LEGION_MAX_OUTPUT_BYTES = prev;
	}
}

test("verify runner kills an infinite `yes` at the cap", async () => {
	const r = await withCap("65536", () => defaultVerifyRunner("yes", process.cwd(), 20_000));
	assert.equal(r.code, 1);
	assert.ok(r.stdout.length < 70_000);
	assert.match(r.stdout, /output truncated/);
});

test("runLegionCommand kills an infinite `yes` at the cap", async () => {
	const r = await withCap("65536", () => runLegionCommand("yes", process.cwd(), 20_000));
	assert.equal(r.code, 1);
	assert.ok(r.stdout.length < 70_000);
	assert.match(r.stdout, /output truncated/);
	assert.equal(r.timedOut, undefined);
});

test("normal small output still exact", async () => {
	const r = await defaultVerifyRunner("printf ok", process.cwd(), 10_000);
	assert.deepEqual([r.code, r.stdout], [0, "ok"]);
});

test("env resolution: floored value below 1 falls back to default (#174)", () => {
	assert.equal(resolveMaxOutputBytes({ PI_LEGION_MAX_OUTPUT_BYTES: "0.5" }), DEFAULT_MAX_OUTPUT_BYTES);
	assert.equal(resolveMaxOutputBytes({ PI_LEGION_MAX_OUTPUT_BYTES: "0.9" }), DEFAULT_MAX_OUTPUT_BYTES);
	assert.equal(resolveMaxOutputBytes({ PI_LEGION_MAX_OUTPUT_BYTES: "0" }), DEFAULT_MAX_OUTPUT_BYTES);
	assert.equal(resolveMaxOutputBytes({ PI_LEGION_MAX_OUTPUT_BYTES: "1" }), 1);
	assert.equal(resolveMaxOutputBytes({ PI_LEGION_MAX_OUTPUT_BYTES: "1.5" }), 1);
	assert.equal(resolveMaxOutputBytes({ PI_LEGION_MAX_OUTPUT_BYTES: "4096.9" }), 4096);
});

