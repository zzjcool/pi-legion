/**
 * In-process child identity channel (#197 / spawn-default-inprocess-v3 D5/D6).
 *
 * The store is global, so these tests must never assert "no context anywhere
 * in the process" — only "not in *this* async chain". Each test therefore
 * observes from the root chain, which never enters a context scope.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	type ChildLaunchContext,
	currentChildContext,
	runInChildContext,
} from "../../src/supervisor/child-context.ts";
import {
	inProcessDepth,
	runAtInProcessChildDepthAsync,
} from "../../src/supervisor/inprocess-depth.ts";

function ctx(nodeId: string, overrides: Partial<ChildLaunchContext> = {}): ChildLaunchContext {
	return {
		nodeId,
		allowNested: false,
		utility: false,
		spawnMode: "inprocess",
		...overrides,
	};
}

test("child-context: visible inside runInChildContext, undefined after it returns", async () => {
	assert.equal(currentChildContext(), undefined);
	const seen = await runInChildContext(ctx("n1"), async () => {
		const inside = currentChildContext();
		await Promise.resolve();
		// Identity must survive an await gap (tool execution sits behind one).
		assert.deepEqual(currentChildContext(), inside);
		return inside;
	});
	assert.equal(seen?.nodeId, "n1");
	assert.equal(seen?.spawnMode, "inprocess");
	assert.equal(currentChildContext(), undefined);
});

test("child-context: two nesting levels each read their own context", async () => {
	await runInChildContext(ctx("outer", { allowNested: true }), async () => {
		assert.equal(currentChildContext()?.nodeId, "outer");
		await runInChildContext(ctx("inner", { parentNodeId: "outer" }), async () => {
			assert.equal(currentChildContext()?.nodeId, "inner");
			assert.equal(currentChildContext()?.parentNodeId, "outer");
			assert.equal(currentChildContext()?.allowNested, false);
		});
		// Inner scope must not leak outward.
		assert.equal(currentChildContext()?.nodeId, "outer");
		assert.equal(currentChildContext()?.parentNodeId, undefined);
	});
	assert.equal(currentChildContext(), undefined);
});

test("child-context: concurrent contexts stay isolated across interleaved awaits", async () => {
	const trace: string[] = [];
	const run = (nodeId: string, ticks: number) =>
		runInChildContext(ctx(nodeId), async () => {
			for (let i = 0; i < ticks; i += 1) {
				// Interleave the two chains at every step.
				await new Promise((resolve) => setImmediate(resolve));
				trace.push(`${nodeId}:${currentChildContext()?.nodeId}`);
			}
		});

	// Deliberately different tick counts so the chains finish out of order.
	await Promise.all([run("a", 3), run("b", 2)]);
	assert.deepEqual(trace.filter((entry) => entry.startsWith("a:")), [
		"a:a",
		"a:a",
		"a:a",
	]);
	assert.deepEqual(trace.filter((entry) => entry.startsWith("b:")), ["b:b", "b:b"]);
	assert.equal(currentChildContext(), undefined);
});

test("inprocess-depth: accumulates across nesting and resets on exit", async () => {
	assert.equal(inProcessDepth(), 0);
	await runAtInProcessChildDepthAsync(async () => {
		assert.equal(inProcessDepth(), 1);
		await runAtInProcessChildDepthAsync(async () => {
			await Promise.resolve();
			assert.equal(inProcessDepth(), 2);
		});
		assert.equal(inProcessDepth(), 1);
	});
	assert.equal(inProcessDepth(), 0);
});

test("inprocess-depth: concurrent branches do not share depth", async () => {
	const seen: number[] = [];
	// Each branch nests *inside* its own scope and parks there; the branches then
	// interleave. Depth is per async chain, so a shallower branch must never see
	// the deeper branch's number.
	const nest = async (remaining: number): Promise<void> => {
		if (remaining === 0) {
			await new Promise((resolve) => setImmediate(resolve));
			seen.push(inProcessDepth());
			return;
		}
		await runAtInProcessChildDepthAsync(async () => {
			await new Promise((resolve) => setImmediate(resolve));
			await nest(remaining - 1);
		});
	};
	await Promise.all([nest(1), nest(2)]);
	assert.deepEqual([...seen].sort(), [1, 2]);
	assert.equal(inProcessDepth(), 0);
});

test("ALS stores are registered on globalThis so module re-evaluation cannot reset them", () => {
	// jiti may re-evaluate these modules with `moduleCache: false`. A module-level
	// `const store = new AsyncLocalStorage()` would then be a fresh, empty store.
	// Guard the globalThis registration that makes identity survive that reload.
	const childKey = Symbol.for("pi-legion.child-context.als");
	const depthKey = Symbol.for("pi-legion.inprocess-depth.als");
	const holder = globalThis as unknown as Record<symbol, unknown>;
	assert.equal(typeof holder[childKey], "object");
	assert.equal(typeof holder[depthKey], "object");
	assert.ok(holder[childKey] && holder[depthKey]);
});
