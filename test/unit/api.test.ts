import { test } from "node:test";
import assert from "node:assert/strict";

test("public API exposes the RPC orchestration surface", async () => {
	const api = await import("../../src/api.ts");
	assert.equal(typeof api.Orchestrator, "function");
	assert.equal(typeof api.RpcSupervisor, "function");
	assert.equal(typeof api.InMemoryUIProxy, "function");
	assert.equal("Placement" in api, false, "pane Placement is no longer part of the public API");
});
