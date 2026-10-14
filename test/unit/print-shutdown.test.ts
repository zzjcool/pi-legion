/**
 * #72: pi --print ends the parent turn and session_shutdown was retiring
 * just-spawned async RPC children before they wrote an assistant message.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import herdrSubagents from "../../index.ts";
import { RunStore } from "../../src/runs/store.ts";
import {
	NO_ASSISTANT_ABORT_REASON,
	PARENT_SESSION_SHUTDOWN_ABORT_REASON,
} from "../../src/shared/session.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

initTheme("dark");

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
	"PI_SUBAGENTS_TEAM",
];

function restoreEnv(previous: Map<string, string | undefined>): void {
	for (const [name, value] of previous) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

async function withExtension(
	run: (harness: {
		cwd: string;
		supervisor: FakeSupervisor;
		tool: { execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }> }> };
		shutdown: (mode?: string) => Promise<void>;
	}) => Promise<void>,
): Promise<void> {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-print-shutdown-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { disableBuiltins: true } }));
	writeFileSync(
		path.join(extraAgentsDir, "worker.md"),
		"---\nname: worker\ndescription: unit worker\ntimeoutMs: 10000\n---\nworker prompt\n",
	);
	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }> }> }>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const pi = {
		registerTool(value: unknown) {
			const typed = value as { name: string; execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }> }> };
			tools.set(typed.name, typed);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	};
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
		for (const name of ENV_KEYS.slice(2)) delete process.env[name];
		herdrSubagents(pi as never, { supervisor });
		const tool = tools.get("subagent");
		assert.ok(tool);
		await run({
			cwd,
			supervisor,
			tool,
			shutdown: async (mode) => {
				const ctx = mode === undefined
					? undefined
					: { mode, cwd, hasUI: false, ui: { notify() {}, setStatus() {} } };
				await handlers.get("session_shutdown")?.(
					{ type: "session_shutdown", reason: "quit" },
					ctx,
				);
			},
		});
	} finally {
		await handlers.get("session_shutdown")?.();
		restoreEnv(previous);
		rmSync(cwd, { recursive: true, force: true });
	}
}

function childExecution(cwd: string, name: string): { status?: string; reason?: string; acceptance?: string } {
	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	const child = store.listRuns().flatMap((run) => run.children).find((entry) => entry.name === name);
	return {
		status: child?.execution?.status,
		reason: child?.execution?.reason,
		acceptance: child?.acceptance?.status,
	};
}

const ctxFor = (cwd: string) => ({ cwd, hasUI: false, ui: { notify() {}, setStatus() {} } });

test("print-mode session_shutdown waits for an async child instead of aborting it before the first assistant message", async () => {
	await withExtension(async ({ cwd, supervisor, tool, shutdown }) => {
		const launch = await tool.execute(
			"print-async",
			{ agent: "worker", task: "report SCOUT_OK", async: true, worktree: false },
			undefined,
			undefined,
			ctxFor(cwd),
		);
		assert.match((launch.content ?? []).map((part) => part.text ?? "").join("\n"), /worker-0/);
		const name = supervisor.spawns[0]?.input.name;
		assert.equal(name, "worker-0");
		assert.equal(supervisor.isAlive(name), true);

		let finished = false;
		const pending = shutdown("print").then(() => {
			finished = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(finished, false, "print shutdown must not retire the child before it settles");
		assert.equal(supervisor.isAlive(name), true);
		assert.equal(supervisor.calls.filter((call) => call.method === "retire").length, 0);

		supervisor.settle(name, { text: '{"ok":true,"reason":"SCOUT_OK"}' });
		await Promise.race([
			pending,
			new Promise((_, reject) => setTimeout(() => reject(new Error("print shutdown did not finish after the child settled")), 8_000)),
		]);

		const execution = childExecution(cwd, name);
		assert.equal(execution.status, "success");
		assert.equal(execution.acceptance, "accepted");
		assert.notEqual(execution.reason, NO_ASSISTANT_ABORT_REASON);
		assert.notEqual(execution.reason, PARENT_SESSION_SHUTDOWN_ABORT_REASON);
	});
});

test("json-mode session_shutdown also waits for a live async child", async () => {
	await withExtension(async ({ cwd, supervisor, tool, shutdown }) => {
		await tool.execute(
			"json-async",
			{ agent: "worker", task: "report SCOUT_OK", async: true, worktree: false },
			undefined,
			undefined,
			ctxFor(cwd),
		);
		const name = supervisor.spawns[0]?.input.name ?? "worker-0";
		const pending = shutdown("json");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(supervisor.calls.filter((call) => call.method === "retire").length, 0);
		supervisor.settle(name, { text: '{"ok":true,"reason":"SCOUT_OK"}' });
		await pending;
		assert.equal(childExecution(cwd, name).status, "success");
	});
});

test("interactive session_shutdown still retires immediately and attributes the abort to parent shutdown", async () => {
	for (const mode of ["tui", undefined] as const) {
		await withExtension(async ({ cwd, supervisor, tool, shutdown }) => {
			await tool.execute(
				"tui-async",
				{ agent: "worker", task: "still starting", async: true, worktree: false },
				undefined,
				undefined,
				ctxFor(cwd),
			);
			const name = supervisor.spawns[0]?.input.name ?? "worker-0";
			await shutdown(mode);
			assert.equal(supervisor.isAlive(name), false);
			const execution = childExecution(cwd, name);
			assert.equal(execution.status, "aborted");
			assert.equal(execution.reason, PARENT_SESSION_SHUTDOWN_ABORT_REASON);
			assert.notEqual(execution.reason, NO_ASSISTANT_ABORT_REASON);
		});
	}
});
