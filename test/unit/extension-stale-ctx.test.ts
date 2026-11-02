/**
 * #377 — the extension entry points must not throw on a ctx the host has already
 * invalidated.
 *
 * `AgentSession.dispose()` calls `ExtensionRunner.invalidate()`, and everything on
 * a ctx created by that runner then throws `This extension ctx is stale after
 * session replacement or reload`. But the run's `finally` block still emits
 * `turn_end` and `agent_settled`, both of which pi-legion handles by calling
 * `bindUi`. The status board already treats staleness as "no UI"
 * (`src/tui/status.ts`), so the board never printed anything — but the handler
 * entry threw, and the host printed
 *
 *   Extension error (/plugin/index.ts): This extension ctx is stale …
 *
 * at every session exit (observed in the container, end of a resumed session).
 * These tests pin the entry behaviour: staleness is "no UI", anything else still
 * propagates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";

import piLegion from "../../index.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

initTheme("dark");

const STALE = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx";

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_UTILITY_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_SUBAGENT_MAX_DEPTH",
	"PI_SUBAGENT_PARENT_PATH",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
	"PI_LEGION_PHASES",
] as const;

function harness() {
	const root = mkdtempSync(path.join(tmpdir(), "legion-stale-ctx-"));
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({}));
	const repo = path.join(root, "repo");
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);

	const previousEnv = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of ENV_KEYS.slice(1)) delete process.env[name];

	const supervisor = new FakeSupervisor({ immediateTimeout: false });
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
	piLegion(pi as never, { supervisor });

	const dispatch = async (name: string, ctx: unknown): Promise<void> => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
	};

	return {
		baseCtx: (overrides: Record<string, unknown> = {}) => ({
			cwd: repo,
			hasUI: false,
			ui: { notify() {}, setStatus() {} },
			sessionManager: { getSessionFile: () => path.join(root, "session.jsonl") },
			...overrides,
		}),
		/** A ctx whose every getter throws the host's staleness message. */
		staleCtx: () =>
			Object.defineProperties(
				{},
				{
					hasUI: { get: () => { throw new Error(STALE); } },
					cwd: { get: () => { throw new Error(STALE); } },
					ui: { get: () => { throw new Error(STALE); } },
					sessionManager: { get: () => { throw new Error(STALE); } },
				},
			),
		dispatch,
		cleanup: () => {
			for (const [name, value] of previousEnv) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("#377: a stale ctx at turn_end/agent_settled is treated as 'no UI', not as an error", async () => {
	const h = harness();
	try {
		// Both events the host dispatches after invalidate. Neither may throw: the
		// host would print an "Extension error (/plugin/index.ts)" line at every exit.
		await h.dispatch("turn_end", h.staleCtx());
		await h.dispatch("agent_settled", h.staleCtx());
		await h.dispatch("turn_start", h.staleCtx());

		// …and a live ctx still binds afterwards: the guard must not latch.
		await h.dispatch("turn_start", h.baseCtx());
	} finally {
		h.cleanup();
	}
});

test("#377: only staleness is swallowed — every other ctx failure still propagates", async () => {
	const h = harness();
	try {
		const broken = {
			get hasUI(): boolean {
				throw new Error("something else went wrong");
			},
		};
		await assert.rejects(() => h.dispatch("turn_start", broken), /something else went wrong/u);
	} finally {
		h.cleanup();
	}
});
