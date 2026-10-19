import { test } from "node:test";
import assert from "node:assert/strict";

test("public API exposes the RPC orchestration surface", async () => {
	const api = await import("../../src/api.ts");
	assert.equal(typeof api.Orchestrator, "function");
	assert.equal(typeof api.RpcSupervisor, "function");
	assert.equal(typeof api.InMemoryUIProxy, "function");
	assert.equal("Placement" in api, false, "pane Placement is no longer part of the public API");
});

test("public API keeps SubagentError after the legacy backend removal", async () => {
	// `SubagentError` used to reach `pi-legion/api` only as a side effect of the
	// legacy client re-exporting it. Removing that re-export silently dropped a
	// type downstream callers catch, so the export is now explicit and pinned.
	const api = await import("../../src/api.ts");
	assert.equal(typeof api.SubagentError, "function");
	const error = new api.SubagentError("boom", "SOME_CODE");
	assert.ok(error instanceof Error);
	assert.equal(error.code, "SOME_CODE");
});
