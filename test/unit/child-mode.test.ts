import { test } from "node:test";
import assert from "node:assert/strict";
import piLegion from "../../index.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

function fakePi() {
	const tools: unknown[] = [];
	const events = new Map<string, unknown>();
	return {
		tools,
		registeredEvents: events,
		events: { emit() {} },
		registerTool(tool: unknown) { tools.push(tool); },
		registerMessageRenderer() {},
		on(name: string, handler: unknown) { events.set(name, handler); },
		registerCommand() {},
		sendMessage() {},
	};
}

test("child process without nested dispatch registers only vexillatio", () => {
	const previous = process.env.PI_SUBAGENT_CHILD;
	const previousNested = process.env.PI_SUBAGENT_ALLOW_NESTED;
	const previousUtility = process.env.PI_SUBAGENT_UTILITY_CHILD;
	delete process.env.PI_SUBAGENT_ALLOW_NESTED;
	delete process.env.PI_SUBAGENT_UTILITY_CHILD;
	process.env.PI_SUBAGENT_CHILD = "1";
	try {
		const pi = fakePi();
		piLegion(pi as never, { supervisor: new FakeSupervisor() });
		// REV-17.6: a non-nested child gets only the utility dispatch tool (§2.2).
		assert.equal(pi.tools.length, 1);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
		if (previousNested === undefined) delete process.env.PI_SUBAGENT_ALLOW_NESTED;
		else process.env.PI_SUBAGENT_ALLOW_NESTED = previousNested;
		if (previousUtility === undefined) delete process.env.PI_SUBAGENT_UTILITY_CHILD;
		else process.env.PI_SUBAGENT_UTILITY_CHILD = previousUtility;
	}
});

test("nested-allowed RPC child registers vexillatio and subagent", () => {
	const previousChild = process.env.PI_SUBAGENT_CHILD;
	const previousNested = process.env.PI_SUBAGENT_ALLOW_NESTED;
	const previousUtility = process.env.PI_SUBAGENT_UTILITY_CHILD;
	delete process.env.PI_SUBAGENT_UTILITY_CHILD;
	process.env.PI_SUBAGENT_CHILD = "1";
	process.env.PI_SUBAGENT_ALLOW_NESTED = "1";
	try {
		const pi = fakePi();
		piLegion(pi as never, { supervisor: new FakeSupervisor() });
		// REV-17.6: nested-enabled roles register vexillatio in addition to subagent (§2.2).
		assert.equal(pi.tools.length, 2);
	} finally {
		if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previousChild;
		if (previousNested === undefined) delete process.env.PI_SUBAGENT_ALLOW_NESTED;
		else process.env.PI_SUBAGENT_ALLOW_NESTED = previousNested;
		if (previousUtility === undefined) delete process.env.PI_SUBAGENT_UTILITY_CHILD;
		else process.env.PI_SUBAGENT_UTILITY_CHILD = previousUtility;
	}
});
