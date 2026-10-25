/**
 * #72: pi --print ends the parent turn and session_shutdown was retiring
 * just-spawned async RPC children before they wrote an assistant message.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import piLegion from "../../index.ts";
import { RunStore } from "../../src/runs/store.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
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
		piLegion(pi as never, { supervisor });
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

test("#283: re-entering the extension factory must reuse the legion.db handle", async () => {
	// `pi` re-runs the extension factory for every `DefaultResourceLoader.reload()`,
	// and an in-process child session builds its OWN loader per
	// `createAgentSession`. One process therefore enters `piLegion` many times.
	//
	// The runtime handle used to be a closure-local `let`, reset to undefined on
	// every entry. That defeated the `cached` short-circuit in
	// `resolveLegionIdentity`, so each re-entry opened a fresh `legion.db` and
	// never closed it: measured on a centurion dispatching one in-process scout,
	// ~2.5k leaked descriptors per 20 s while RSS climbed to 6 GB until V8 aborted
	// with `JavaScript heap out of memory`.
	//
	// This case drives the real open path (PI_LEGION_DB + PI_LEGION_NODE_ID set,
	// with a real ledger on disk) and counts descriptors pointing at that file.
	const sandbox = mkdtempSync(path.join(tmpdir(), "legion-283-"));
	const cwd = path.join(sandbox, "project");
	const agentDir = path.join(sandbox, "agent");
	const extraAgentsDir = path.join(sandbox, "extra-agents");
	const storeRoot = path.join(cwd, ".pi-subagents");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });

	const store = new RunStore({ rootDir: storeRoot });
	const run = store.createRun({ task: "re-entry", cwd, maxDepth: 4, nodeId: "root" });
	const dbPath = legionDbPath(store.runDir(run.runId));
	const seed = openLegionDb(dbPath);
	insertNode(seed, { id: "root", parentId: null, name: "root", role: "root", runId: run.runId, status: "running" });
	seed.close();

	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	// `piLegion` installs timers and an event bus; without capturing its handlers
	// the test leaves work pending after the assertions and the runner hangs
	// ("Promise resolution is still pending"). Keep the latest handler map so the
	// finally block can shut the runtime down.
	let handlers = new Map<string, (...args: unknown[]) => unknown>();
	const fakePi = () => {
		const own = new Map<string, (...args: unknown[]) => unknown>();
		handlers = own;
		return {
			registerTool() {},
			registerCommand() {},
			registerMessageRenderer() {},
			sendMessage() {},
			events: { emit() {} },
			on(name: string, handler: (...args: unknown[]) => unknown) {
				own.set(name, handler);
			},
		};
	};
	const countDbFds = (): number => {
		try {
			const target = `legion.db`;
			return readdirSync("/proc/self/fd").filter((fd) => {
				try {
					return readlinkSync(`/proc/self/fd/${fd}`).endsWith(target);
				} catch {
					return false;
				}
			}).length;
		} catch {
			return -1; // not Linux
		}
	};

	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
		for (const name of ENV_KEYS.slice(2)) delete process.env[name];
		// Drive the boot-time attach path (`isChild` + LEGION_DB/NODE_ID present).
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_ALLOW_NESTED = "1";
		process.env.PI_LEGION_DB = dbPath;
		process.env.PI_LEGION_NODE_ID = "root";

		piLegion(fakePi() as never, { supervisor });
		const before = countDbFds();
		for (let i = 0; i < 4; i += 1) piLegion(fakePi() as never, { supervisor });
		const after = countDbFds();

		if (before >= 0) {
			assert.ok(
				after <= before,
				`re-entering the factory must reuse the ledger handle, not open another: ${before} -> ${after} across 4 re-entries`,
			);
		}
	} finally {
		await handlers.get("session_shutdown")?.();
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(sandbox, { recursive: true, force: true });
	}
});
