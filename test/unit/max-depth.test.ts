import test from "node:test";
import assert from "node:assert/strict";
import { effectiveMaxDepth } from "../../src/runs/orchestrator.ts";

const MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";

async function withMaxDepthEnv<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
	const prev = process.env[MAX_DEPTH_ENV];
	try {
		if (value === undefined) delete process.env[MAX_DEPTH_ENV];
		else process.env[MAX_DEPTH_ENV] = value;
		return await fn();
	} finally {
		if (prev === undefined) delete process.env[MAX_DEPTH_ENV];
		else process.env[MAX_DEPTH_ENV] = prev;
	}
}

test("effectiveMaxDepth: legal integers honour the ceiling (#173)", async () => {
	await withMaxDepthEnv("0", () => assert.equal(effectiveMaxDepth(), 0));
	await withMaxDepthEnv("1", () => assert.equal(effectiveMaxDepth(), 1));
	await withMaxDepthEnv("2", () => assert.equal(effectiveMaxDepth(), 2));
	await withMaxDepthEnv("4", () => assert.equal(effectiveMaxDepth(), 4));
	await withMaxDepthEnv("10", () => assert.equal(effectiveMaxDepth(), 4));
	await withMaxDepthEnv(undefined, () => assert.equal(effectiveMaxDepth(), 4));
	await withMaxDepthEnv("", () => assert.equal(effectiveMaxDepth(), 4));
});

test("effectiveMaxDepth: illegal values fail closed to 0, not hard-cap 4 (#173)", async () => {
	const illegal = ["-1", "-5", "3.0", "+2", "0x2", "abc", "  -1  "];
	for (const v of illegal) {
		await withMaxDepthEnv(v, () => {
			assert.equal(effectiveMaxDepth(), 0, `env=${JSON.stringify(v)} must be leaf-only`);
			assert.equal(effectiveMaxDepth(4), 0, `settings must not widen illegal env=${JSON.stringify(v)}`);
		});
	}
});
