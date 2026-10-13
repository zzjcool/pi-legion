import test from "node:test";
import assert from "node:assert/strict";
import { availableMemoryMb, checkMemoryGate, childMemoryEnv, childNodeOptions, resolveMemoryGateConfig, restoreHostNodeOptions, HOST_NODE_OPTIONS_ENV } from "../../src/supervisor/child-memory.ts";
import { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";

test("child NODE_OPTIONS adds semi-space + old-space caps, keeps host options, 0 disables", () => {
	assert.equal(childNodeOptions({}), "--max-semi-space-size=1 --max-old-space-size=1024");
	assert.equal(childNodeOptions({ NODE_OPTIONS: "--enable-source-maps" }), "--enable-source-maps --max-semi-space-size=1 --max-old-space-size=1024");
	assert.equal(childNodeOptions({ PI_LEGION_CHILD_MAX_OLD_SPACE_MB: "2048", PI_LEGION_CHILD_SEMI_SPACE_MB: "0" }), "--max-old-space-size=2048");
	assert.equal(childNodeOptions({ PI_LEGION_CHILD_MAX_OLD_SPACE_MB: "0", PI_LEGION_CHILD_SEMI_SPACE_MB: "0" }), undefined);
	assert.equal(childNodeOptions({ NODE_OPTIONS: "--max-old-space-size=4096" }), "--max-old-space-size=4096 --max-semi-space-size=1", "host cap wins");
});

test("childMemoryEnv carries the host NODE_OPTIONS for restoration; no-op when disabled", () => {
	assert.deepEqual(childMemoryEnv({ NODE_OPTIONS: "--x" }), { NODE_OPTIONS: "--x --max-semi-space-size=1 --max-old-space-size=1024", [HOST_NODE_OPTIONS_ENV]: "--x" });
	assert.deepEqual(childMemoryEnv({ PI_LEGION_CHILD_MAX_OLD_SPACE_MB: "0", PI_LEGION_CHILD_SEMI_SPACE_MB: "0" }), {});
});

test("restoreHostNodeOptions puts back host value or removes the var", () => {
	const a: NodeJS.ProcessEnv = { NODE_OPTIONS: "--x --max-semi-space-size=1", [HOST_NODE_OPTIONS_ENV]: "--x" };
	restoreHostNodeOptions(a);
	assert.deepEqual(a, { NODE_OPTIONS: "--x" });
	const b: NodeJS.ProcessEnv = { NODE_OPTIONS: "--max-semi-space-size=1", [HOST_NODE_OPTIONS_ENV]: "" };
	restoreHostNodeOptions(b);
	assert.deepEqual(b, {});
	const c: NodeJS.ProcessEnv = { NODE_OPTIONS: "--user" };
	restoreHostNodeOptions(c);
	assert.deepEqual(c, { NODE_OPTIONS: "--user" }, "untouched when not launched by legion");
});

test("memory gate: floor + per-starting-child reservation, 0 disables", () => {
	const config = { minFreeMb: 1000, reserveMb: 100 };
	assert.equal(checkMemoryGate({ name: "a", inFlight: 0, config, available: () => 1100 }).ok, true);
	const r = checkMemoryGate({ name: "scout-3", inFlight: 2, config, available: () => 1250 });
	assert.equal(r.ok, false);
	assert.equal(r.requiredMb, 1300);
	assert.match(r.message!, /insufficient memory to start subagent scout-3: 1250 MB available, 1300 MB required/);
	assert.match(r.message!, /PI_LEGION_MIN_FREE_MEM_MB=0/);
	assert.equal(checkMemoryGate({ name: "a", inFlight: 9, config: { minFreeMb: 0, reserveMb: 100 }, available: () => 0 }).ok, true);
	assert.deepEqual(resolveMemoryGateConfig({ PI_LEGION_MIN_FREE_MEM_MB: "64", PI_LEGION_CHILD_RESERVE_MB: "x" }), { minFreeMb: 64, reserveMb: 160 });
	assert.ok(availableMemoryMb() > 0);
});

test("supervisor refuses spawn with INSUFFICIENT_MEMORY, notifies, and starts nothing", async () => {
	let created = 0;
	const refused: string[] = [];
	const prev = process.env.PI_LEGION_MIN_FREE_MEM_MB;
	process.env.PI_LEGION_MIN_FREE_MEM_MB = "4096";
	try {
		const sup = new RpcSupervisor({
			clientFactory: (() => { created++; throw new Error("must not start"); }) as never,
			memoryAvailable: () => 100,
			onSpawnRefused: (m) => refused.push(m),
		});
		await assert.rejects(
			sup.spawnChild({ name: "scout-0", agent: { kind: "pi" } } as never),
			(e: { code?: string; message: string }) => e.code === "INSUFFICIENT_MEMORY" && /insufficient memory/.test(e.message),
		);
		assert.equal(created, 0);
		assert.equal(refused.length, 1);
		assert.equal(sup.isAlive("scout-0"), false);
	} finally {
		if (prev === undefined) delete process.env.PI_LEGION_MIN_FREE_MEM_MB; else process.env.PI_LEGION_MIN_FREE_MEM_MB = prev;
	}
});
