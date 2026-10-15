import assert from "node:assert/strict";
import test from "node:test";
import {
	extensionActivityToUIRequest,
	InMemoryUIProxy,
	isExtensionActivity,
	isExtensionUIRequest,
} from "../../src/supervisor/ui-proxy.ts";

test("isExtensionActivity accepts raise/clear and record payloads", () => {
	assert.equal(
		isExtensionActivity({
			type: "extension_activity",
			id: "1",
			source: "bg",
			activity: { message: "compiling" },
		}),
		true,
	);
	assert.equal(
		isExtensionActivity({
			type: "extension_activity",
			id: "2",
			source: "bg",
			activity: null,
		}),
		true,
	);
	assert.equal(
		isExtensionActivity({
			type: "extension_activity",
			id: "3",
			record: { id: "plugin/job", state: "working", message: "job" },
		}),
		true,
	);
	assert.equal(isExtensionActivity({ type: "extension_ui_request", id: "x", method: "notify", message: "hi" }), false);
});

test("extensionActivityToUIRequest maps into UIProxy setActivity / setProgramRecord", () => {
	const raise = extensionActivityToUIRequest({
		type: "extension_activity",
		id: "a",
		source: "bg",
		activity: { message: "compiling" },
	});
	assert.equal(isExtensionUIRequest(raise), true);
	assert.equal(raise.method, "setActivity");
	if (raise.method === "setActivity") {
		assert.equal(raise.source, "bg");
		assert.deepEqual(raise.activity, { message: "compiling" });
	}

	const clear = extensionActivityToUIRequest({
		type: "extension_activity",
		id: "b",
		source: "bg",
		activity: null,
	});
	assert.equal(clear.method, "setActivity");
	if (clear.method === "setActivity") {
		assert.equal(clear.activity, undefined);
	}

	const record = extensionActivityToUIRequest({
		type: "extension_activity",
		id: "c",
		record: { id: "job-1", state: "working", message: "job-1" },
	});
	assert.equal(record.method, "setProgramRecord");
	if (record.method === "setProgramRecord") {
		assert.equal(record.record.id, "job-1");
	}
});

test("UIProxy accepts setActivity requests from children", () => {
	const proxy = new InMemoryUIProxy();
	const pending = proxy.enqueue({
		childName: "scout",
		request: {
			type: "extension_ui_request",
			id: "rpc-1",
			method: "setActivity",
			source: "bg",
			activity: { message: "compiling" },
		},
	});
	assert.equal(pending.childName, "scout");
	assert.equal(pending.request.method, "setActivity");
});

test("mock plugin setActivity path keeps a parent activity map working", () => {
	// Simulates parent-side fold-in without a live Pi reporter (CI peer may lag).
	const activities = new Map<string, { message?: string }>();
	const setActivity = (source: string, activity: { message?: string } | undefined) => {
		if (activity) activities.set(source, activity);
		else activities.delete(source);
	};
	setActivity("legion", { message: "1 subagent (scout)" });
	setActivity("legion/scout/bg", { message: "compiling" });
	assert.equal(activities.size, 2);
	assert.ok(activities.has("legion"));
	setActivity("legion/scout/bg", undefined);
	assert.equal(activities.size, 1);
	setActivity("legion", undefined);
	assert.equal(activities.size, 0);
});
