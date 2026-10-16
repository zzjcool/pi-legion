/**
 * #181: short pi --print exits before the deferred 1.5s hygiene timer.
 * session_shutdown must still flush the sweep so orphan rpc-child-* dirs go.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piLegion from "../../index.ts";
import { HYGIENE_LAST_FILE } from "../../src/runs/hygiene.ts";
import { RUN_OWNER_FILE, TEMP_OWNER_FILE, writeOwnerFile } from "../../src/runs/owner.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

initTheme("dark");

const DEAD = 2 ** 22 + 54321;

test("#181 short session_shutdown flushes deferred hygiene before the 1.5s timer", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hyg-shutdown-181-"));
	const agentDir = path.join(cwd, "agent-config");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { disableBuiltins: true } }));

	const storeRoot = path.join(cwd, ".pi-subagents");
	const runDir = path.join(storeRoot, "runs", "r-orphan");
	const orphan = path.join(runDir, "rpc-child-zzz");
	fs.mkdirSync(orphan, { recursive: true });
	fs.writeFileSync(
		path.join(runDir, "run.json"),
		JSON.stringify({ runId: "r-orphan", task: "x", cwd }),
	);
	writeOwnerFile(path.join(runDir, RUN_OWNER_FILE), DEAD);
	writeOwnerFile(path.join(orphan, TEMP_OWNER_FILE), DEAD);
	fs.writeFileSync(path.join(orphan, "task.md"), "leftover");

	const previous = new Map(
		["PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_ALLOW_NESTED", "PI_LEGION_DB", "PI_LEGION_NODE_ID", "PI_LEGION_HYGIENE"].map(
			(name) => [name, process.env[name]],
		),
	);
	// Accumulate handlers — index registers multiple session_start/shutdown listeners.
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	};
	const emit = async (name: string, ...args: unknown[]) => {
		for (const handler of handlers.get(name) ?? []) await handler(...args);
	};
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_SUBAGENT_CHILD;
		delete process.env.PI_SUBAGENT_ALLOW_NESTED;
		delete process.env.PI_LEGION_DB;
		delete process.env.PI_LEGION_NODE_ID;
		delete process.env.PI_LEGION_HYGIENE;
		piLegion(pi as never, { supervisor: new FakeSupervisor({ immediateTimeout: false }) });

		assert.ok(fs.existsSync(orphan), "orphan planted");
		await emit(
			"session_start",
			{ type: "session_start" },
			{ cwd, hasUI: false, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionFile: () => undefined } },
		);
		// Immediate shutdown — no wait for the 1.5s timer (the short --print path).
		await emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit" },
			{ mode: "print", cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
		);

		assert.equal(fs.existsSync(orphan), false, "orphan rpc-child must be swept on short shutdown");
		assert.ok(
			fs.existsSync(path.join(storeRoot, HYGIENE_LAST_FILE)),
			".hygiene-last.json marker proves hygiene ran",
		);
	} finally {
		await emit("session_shutdown");
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
