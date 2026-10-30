import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CHILD_TASK_APPENDIX,
	forbiddenChildReason,
	formatChildTask,
	isReadOnlyRole,
	registerChildGuard,
} from "../../src/extension/child-guard.ts";
import { BUILTIN_AGENTS_DIR, loadAgentsFromDir } from "../../src/agents/agents.ts";
import {
	MAX_TOOL_CALLS_ENV,
	MAX_TURNS_ENV,
	TOOL_TIMEOUT_MS_ENV,
} from "../../src/extension/budget.ts";

test("child blocks direct access to the legion database and allows ordinary inspection", () => {
	for (const command of [
		"sqlite3 legion.db 'select * from nodes'",
		"cat legion.db-wal",
		"cat \"$PI_LEGION_DB-wal\"",
		"sqlite3 \"$PI_LEGION_DB\" 'select * from nodes'",
		"grep -f legion.db '.*'",
		"git grep -e TODO -- .pi-subagents/legion.db",
		"cat < .pi-subagents/legion.db-shm",
		"printf '{}' > .pi-subagents/legion.db",
	]) assert.ok(forbiddenChildReason(command), `must block ${command}`);
	for (const command of [
		"rg TODO src",
		"rg legion.db src",
		"git grep legion.db",
		"grep -n 'PI_LEGION_DB' src/shared/types.ts",
		"grep 'legion.db' README.md",
		"echo legion.db",
		"echo $PI_LEGION_DB",
		"echo $PI_LEGION_DB-wal",
		"printf 'PI_LEGION_DB is configured'",
		"node -e \"console.log('legion.db')\"",
	]) assert.equal(forbiddenChildReason(command), undefined, `mention/pattern must be allowed: ${command}`);
	assert.equal(forbiddenChildReason("git log -1 --oneline"), undefined);
});

test("child constraints use RPC child language and only allow nested dispatch via tool", () => {
	const plain = formatChildTask("inspect this repo");
	assert.match(plain, /Do not spawn nested agents/);
	assert.doesNotMatch(plain, /pane|herdr agent|send keys/i);
	const nested = formatChildTask("inspect", { allowNested: true });
	assert.match(nested, /Nested subagents via `subagent` tool only/);
	assert.match(nested, /machine-readable JSON/);
});

test("formatChildTask appends the frozen constraints", () => {
	const text = formatChildTask("Review src/foo.ts");
	assert.match(text, /^Task: Review src\/foo\.ts/m);
	assert.match(text, /Frozen child constraints/);
	assert.match(text, /\{\"ok\":/);
	assert.ok(text.includes(CHILD_TASK_APPENDIX));
});

test("formatChildTask allowNested changes the nested-agents bullet", () => {
	const nested = formatChildTask("do it", { allowNested: true });
	assert.match(nested, /Nested subagents via `subagent` tool only/);
	assert.doesNotMatch(nested, /Do not spawn nested agents/);
	assert.match(formatChildTask("do it"), /Do not spawn nested agents/);
});

test("formatChildTask worktreeBranch tells the child to ship via MR", () => {
	const text = formatChildTask("implement it", {
		worktreeBranch: "pi-subagent/worker-0-deadbeef",
	});
	assert.match(text, /pi-subagent\/worker-0-deadbeef/);
	assert.match(text, /isolated git worktree/);
	assert.match(text, /merge request \/ pull request/);
	assert.doesNotMatch(formatChildTask("implement it"), /isolated git worktree/);
});

test("isReadOnlyRole is case-insensitive (#172)", () => {
	assert.equal(isReadOnlyRole("read-only"), true);
	assert.equal(isReadOnlyRole("READ-ONLY"), true);
	assert.equal(isReadOnlyRole("Read-Only"), true);
	assert.equal(isReadOnlyRole("  read-only  "), true);
	assert.equal(isReadOnlyRole("writer"), false);
	assert.equal(isReadOnlyRole("WRITER"), false);
	assert.equal(isReadOnlyRole(undefined), false);
});

test("read-only role: writes and herdr prompts are blocked, recon commands pass", () => {
	assert.equal(isReadOnlyRole("read-only"), true);
	assert.equal(isReadOnlyRole("writer"), false);

	const env = { acceptanceRole: "read-only" as const };
	assert.ok(forbiddenChildReason("rm -rf /tmp/x", env));
	assert.ok(forbiddenChildReason("rm -rf /tmp/x", { acceptanceRole: "READ-ONLY" }));
	assert.ok(forbiddenChildReason("git commit -am wip", env));
	assert.ok(forbiddenChildReason("echo hi > /tmp/out", env));
	assert.ok(forbiddenChildReason("npm install left-pad", env));
	assert.equal(forbiddenChildReason("rg TODO src", env), undefined);
	assert.equal(forbiddenChildReason("git log -1 --oneline", env), undefined);
	assert.equal(forbiddenChildReason("ls src", env), undefined);
});

test("writer role may run npm test", () => {
	assert.equal(
		forbiddenChildReason("npm test", { acceptanceRole: "writer" }),
		undefined,
	);
});

function guardPi() {
	const events = new Map<string, unknown>();
	return {
		events,
		on(name: string, handler: unknown) {
			events.set(name, handler);
		},
		registerTool() {},
		registerCommand() {},
		sendMessage() {},
		eventsBus: { emit() {} },
	};
}

test("child-guard counts every tool call against toolBudget", () => {
	const previous = process.env[MAX_TOOL_CALLS_ENV];
	process.env[MAX_TOOL_CALLS_ENV] = "1";
	try {
		const pi = guardPi();
		registerChildGuard(pi as never);
		const handler = pi.events.get("tool_call") as (event: {
			toolName: string;
			input: Record<string, unknown>;
		}) => { block?: boolean; reason?: string } | undefined;
		assert.equal(
			handler({ toolName: "read", input: { path: "a" } }),
			undefined,
		);
		const blocked = handler({ toolName: "read", input: { path: "b" } });
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /tool budget exceeded \(1/);
	} finally {
		if (previous === undefined) delete process.env[MAX_TOOL_CALLS_ENV];
		else process.env[MAX_TOOL_CALLS_ENV] = previous;
	}
});

test("child-guard wraps bash with timeout after classifying", () => {
	const previous = process.env[TOOL_TIMEOUT_MS_ENV];
	process.env[TOOL_TIMEOUT_MS_ENV] = "1500";
	try {
		const pi = guardPi();
		registerChildGuard(pi as never);
		const handler = pi.events.get("tool_call") as (event: {
			toolName: string;
			input: { command: string };
		}) => unknown;
		const event = { toolName: "bash" as const, input: { command: "ls -la" } };
		assert.equal(handler(event), undefined);
		assert.match(event.input.command, /^timeout --kill-after=2s 2s /);
	} finally {
		if (previous === undefined) delete process.env[TOOL_TIMEOUT_MS_ENV];
		else process.env[TOOL_TIMEOUT_MS_ENV] = previous;
	}
});

test("#315 scout's 600s budget wraps a bash call as `timeout --kill-after=2s 600s bash -lc …`", () => {
	// The number comes from the shipped scout card, not from a literal: this is
	// the whole chain #315 froze — card → env → child-guard → wrapped command.
	const scout = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin").find(
		(agent) => agent.name === "scout",
	);
	assert.ok(scout?.toolTimeoutMs, "scout must declare a per-bash timeout");
	const previous = process.env[TOOL_TIMEOUT_MS_ENV];
	process.env[TOOL_TIMEOUT_MS_ENV] = String(scout.toolTimeoutMs);
	try {
		const pi = guardPi();
		registerChildGuard(pi as never);
		const handler = pi.events.get("tool_call") as (event: {
			toolName: string;
			input: { command: string };
		}) => unknown;
		const event = { toolName: "bash" as const, input: { command: "rg -n main src" } };
		assert.equal(handler(event), undefined);
		assert.match(event.input.command, /^timeout --kill-after=2s 600s bash -lc /);
		assert.match(event.input.command, /rg -n main src/);

		// Existing behaviour kept: an already-bounded command is not wrapped a
		// second time (a nested `timeout` would shrink the outer bound to the
		// inner one and report the wrong failure).
		const already = { toolName: "bash" as const, input: { command: "timeout 5s rg foo" } };
		assert.equal(handler(already), undefined);
		assert.equal(already.input.command, "timeout 5s rg foo");
	} finally {
		if (previous === undefined) delete process.env[TOOL_TIMEOUT_MS_ENV];
		else process.env[TOOL_TIMEOUT_MS_ENV] = previous;
	}
});

test("#315 a role with no toolTimeoutMs keeps its bash commands untouched", () => {
	// worker / centurion deliberately have no default: a full build or
	// integration run must not be killed at a bound nobody chose.
	const previous = process.env[TOOL_TIMEOUT_MS_ENV];
	delete process.env[TOOL_TIMEOUT_MS_ENV];
	try {
		const pi = guardPi();
		registerChildGuard(pi as never);
		const handler = pi.events.get("tool_call") as (event: {
			toolName: string;
			input: { command: string };
		}) => unknown;
		const event = { toolName: "bash" as const, input: { command: "npm run test:integration" } };
		assert.equal(handler(event), undefined);
		assert.equal(event.input.command, "npm run test:integration");
	} finally {
		if (previous !== undefined) process.env[TOOL_TIMEOUT_MS_ENV] = previous;
	}
});

test("child-guard turn budget blocks tools after too many turns", () => {
	const previous = process.env[MAX_TURNS_ENV];
	process.env[MAX_TURNS_ENV] = "0";
	try {
		const pi = guardPi();
		registerChildGuard(pi as never);
		const turn = pi.events.get("turn_start") as () => void;
		const handler = pi.events.get("tool_call") as (event: {
			toolName: string;
			input: Record<string, unknown>;
		}) => { block?: boolean } | undefined;
		turn();
		const blocked = handler({ toolName: "read", input: {} });
		assert.equal(blocked?.block, true);
	} finally {
		if (previous === undefined) delete process.env[MAX_TURNS_ENV];
		else process.env[MAX_TURNS_ENV] = previous;
	}
});

// BUG: the redirect check was `/>{1,2}/` minus a preceding digit/&, so it both
// over- and under-blocked. `=>`, `>=` and `->` are not redirection, and a `>`
// inside quotes is literal text — yet those forms were refused, which blocked
// the read-only probes a reviewing agent needs (found by a reviewer whose own
// `node -e "[1].map(x => x+1)"` was rejected). Meanwhile `&>file` is a real
// write that the old pattern let through.
test("read-only role: comparison/arrow operators are not redirects", () => {
	const env = { acceptanceRole: "read-only" as const };
	// All of these are legitimate read-only work.
	assert.equal(forbiddenChildReason(`node -e "[1].map(x => x+1)"`, env), undefined);
	assert.equal(forbiddenChildReason(`node -e "if (a >= b) 1"`, env), undefined);
	assert.equal(forbiddenChildReason("rg 'x => y' src/", env), undefined);
	assert.equal(forbiddenChildReason("npm test", env), undefined);
	assert.equal(forbiddenChildReason("npm run typecheck", env), undefined);
	assert.equal(forbiddenChildReason(`node --experimental-strip-types -e "import('./src/x.ts')"`, env), undefined);
	// Descriptor duplication and /dev/null are not file writes either.
	assert.equal(forbiddenChildReason("cat f 2>&1", env), undefined);
	assert.equal(forbiddenChildReason("echo hi > /dev/null", env), undefined);
});

test("read-only role: real redirects are still blocked, including &>file", () => {
	const env = { acceptanceRole: "read-only" as const };
	assert.ok(forbiddenChildReason("echo hi > /tmp/out", env));
	assert.ok(forbiddenChildReason("echo hi >> /tmp/out", env));
	// The old regex excluded a preceding `&`, so this real write slipped through.
	assert.ok(forbiddenChildReason("echo hi &> /tmp/out", env));
});

test("#295: an in-process child takes its budget from the child context, not process.env", async () => {
	// The parent computes budgets into `SpawnInput.env`. An rpc child receives that
	// object AS its environment, so `process.env` has it. An in-process child shares
	// the HOST's environment instead, so reading only `process.env` gave the guard
	// the parent's values — `toolBudget: 3` permitted 12 tool calls and the run
	// finished normally.
	//
	// The context must win, and `process.env` must remain the rpc fallback.
	const { runInChildContext } = await import("../../src/supervisor/child-context.ts");
	const { effectiveChildBudget } = await import("../../src/extension/child-guard.ts");

	const ctx = {
		allowNested: false,
		utility: false,
		spawnMode: "inprocess" as const,
		budget: { maxToolCalls: 3 },
	};

	// Context present: it wins even when the process env says something else.
	await runInChildContext(ctx, async () => {
		assert.deepEqual(
			effectiveChildBudget(undefined, { [MAX_TOOL_CALLS_ENV]: "99" }),
			{ maxToolCalls: 3 },
			"the child context is authoritative for an in-process child",
		);
	});

	// No context (an rpc child, or a root session): fall back to the environment.
	assert.deepEqual(
		effectiveChildBudget(undefined, { [MAX_TOOL_CALLS_ENV]: "7" }),
		{ maxToolCalls: 7 },
		"rpc children still read their own process env",
	);
	assert.deepEqual(effectiveChildBudget(undefined, {}), {}, "nothing configured means no limit");
});
