import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parseSubagentSettings,
	resolveSubagentSettings,
} from "../../src/agents/settings.ts";
import { CHILD_ROLE_ENV } from "../../src/extension/child-guard.ts";
import {
	DEFAULT_SCOUT_GUARD_COOLDOWN_MS,
	DEFAULT_SCOUT_GUARD_THRESHOLD,
	SCOUT_GUARD_NOTIFY_TYPE,
	classifyBash,
	classifyScoutToolCall,
	registerScoutGuard,
	resolveScoutGuardConfig,
	scoutGuardReminder,
	stepScoutGuard,
	initialScoutGuardState,
	type ScoutGuardState,
	type ScoutToolKind,
} from "../../src/extension/scout-guard.ts";

const REMINDER_8 = "连续 8 次文件类调用且未派发 subagent——若这是侦察工作，请停下来拆 scout（规则：侦察必须并行）。";

test("settings: scoutGuard parses, rejects bad values, and project overrides field-wise", () => {
	assert.equal(parseSubagentSettings({ subagents: {} }, "/s.json").scoutGuard, undefined);
	assert.deepEqual(
		parseSubagentSettings({
			subagents: { scoutGuard: { enabled: false, threshold: 4, cooldownMs: 0 } },
		}, "/s.json").scoutGuard,
		{ enabled: false, threshold: 4, cooldownMs: 0 },
	);
	assert.deepEqual(
		parseSubagentSettings({ subagents: { scoutGuard: { threshold: 3 } } }, "/s.json").scoutGuard,
		{ threshold: 3 },
	);
	for (const scoutGuard of [[], "on", { enabled: "yes" }, { threshold: 0 }, { threshold: 1.5 }, { cooldownMs: -1 }, { cooldownMs: 1.2 }]) {
		assert.throws(
			() => parseSubagentSettings({ subagents: { scoutGuard } }, "/s.json"),
			/scoutGuard/,
		);
	}
	const merged = resolveSubagentSettings(
		{ scoutGuard: { enabled: true, threshold: 8, cooldownMs: 120000 } },
		{ scoutGuard: { threshold: 4 } },
	);
	assert.deepEqual(merged.scoutGuard, { enabled: true, threshold: 4, cooldownMs: 120000 });
	const kept = resolveSubagentSettings(
		{ scoutGuard: { enabled: false, threshold: 5 } },
		{ defaultModel: "cb/mid" },
	);
	assert.deepEqual(kept.scoutGuard, { enabled: false, threshold: 5 });
});

test("resolveScoutGuardConfig defaults on, and a session override wins", () => {
	assert.deepEqual(resolveScoutGuardConfig(undefined, undefined), {
		enabled: true,
		threshold: DEFAULT_SCOUT_GUARD_THRESHOLD,
		cooldownMs: DEFAULT_SCOUT_GUARD_COOLDOWN_MS,
	});
	assert.equal(DEFAULT_SCOUT_GUARD_THRESHOLD, 8);
	assert.equal(DEFAULT_SCOUT_GUARD_COOLDOWN_MS, 120_000);
	assert.equal(resolveScoutGuardConfig({ enabled: false }, undefined).enabled, false);
	assert.equal(resolveScoutGuardConfig({ enabled: false }, true).enabled, true);
	assert.equal(resolveScoutGuardConfig({ enabled: true, threshold: 3 }, false).enabled, false);
	assert.equal(scoutGuardReminder(8), REMINDER_8);
	assert.equal(scoutGuardReminder(3), REMINDER_8.replace("8", "3"));
});

test("bash classification: listed readers count, writes reset, ambiguous is ignored", () => {
	for (const command of [
		"cat file",
		"head -n 20 file",
		"tail -n 5 file",
		"less README.md",
		"rg TODO src",
		"grep -n foo src",
		"find . -name '*.ts'",
		"ls -la",
		"stat file",
		"wc -l file",
		"file bin",
		"jq .a package.json",
		"git show HEAD:index.ts",
		"git log -1 --oneline",
		"git diff",
		"git status",
		"git blame file",
		"sed -n '1,20p' file",
		"sed 's/a/b/' file",
		"sed -e's/i/x/' file",
		"rg foo | head",
		"cat a && ls",
		"FOO=1 cat file",
		"/usr/bin/rg TODO",
		"git -C repo log -5",
		"git --no-pager diff",
		"cat file 2>&1",
		"cat file > /dev/null",
		"rg 'a => b' src",
	]) assert.equal(classifyBash(command), "read", command);

	for (const command of [
		"sed -i 's/a/b/' file",
		"sed -i.bak 's/a/b/' file",
		"sed --in-place 's/a/b/' file",
		"echo hi > out",
		"echo hi >> out",
		"echo hi &> out",
		"cat a > b",
		"cat a >| b",
		"rm file",
		"mv a b",
		"mkdir d",
		"tee out",
		"git commit -m x",
		"git checkout main",
		"git add .",
		"git pull",
		"find . -delete",
		"find . -exec rm {} \\;",
		"ls && rm file",
		"npm install left-pad",
		"npm --silent ci",
	]) assert.equal(classifyBash(command), "write", command);

	for (const command of [
		"npm test",
		"node -e '1'",
		"echo hi",
		"git rev-parse HEAD",
		"cat $(echo file)",
		"ls && npm test",
		"",
		"   ",
		"python3 script.py",
		"node -e \"[1].map(x => x+1)\"",
	]) assert.equal(classifyBash(command), "ignore", command);
});

test("tool classification: read counts, edit/write reset, only launches dispatch", () => {
	assert.equal(classifyScoutToolCall("read", { path: "a" }), "read");
	assert.equal(classifyScoutToolCall("bash", { command: "rg TODO src" }), "read");
	assert.equal(classifyScoutToolCall("edit", { path: "a" }), "write");
	assert.equal(classifyScoutToolCall("write", { path: "a" }), "write");
	assert.equal(classifyScoutToolCall("bash", { command: "sed -i 's/a/b/' a" }), "write");
	assert.equal(classifyScoutToolCall("subagent", {}), "dispatch");
	assert.equal(classifyScoutToolCall("subagent", { action: "launch", agent: "worker", task: "x" }), "dispatch");
	assert.equal(classifyScoutToolCall("subagent", { tasks: [{ agent: "scout", task: "look" }] }), "dispatch");
	assert.equal(classifyScoutToolCall("vexillatio", { task: "survey" }), "dispatch");
	assert.equal(classifyScoutToolCall("subagent", { action: "status" }), "ignore");
	assert.equal(classifyScoutToolCall("subagent", { action: "collect", name: "worker-0" }), "ignore");
	assert.equal(classifyScoutToolCall("subagent", { action: "continue", name: "worker-0" }), "ignore");
	assert.equal(classifyScoutToolCall("grep", { pattern: "TODO" }), "ignore");
	assert.equal(classifyScoutToolCall("bash", {}), "ignore");
});

function drive(kinds: ScoutToolKind[], config: { threshold: number; cooldownMs: number }, times: number[]): { state: ScoutGuardState; fires: number[] } {
	let state = initialScoutGuardState();
	const fires: number[] = [];
	kinds.forEach((kind, index) => {
		const next = stepScoutGuard(state, kind, config, times[index] ?? 0);
		state = next.state;
		if (next.notify) fires.push(index);
	});
	return { state, fires };
}

test("state machine: N reads fire once, dispatch clears, cooldown blocks, writes reset without cooldown", () => {
	const config = { threshold: 8, cooldownMs: 120_000 };
	const reads = Array<ScoutToolKind>(8).fill("read");
	const first = drive(reads, config, reads.map(() => 1_000));
	assert.deepEqual(first.fires, [7]);
	assert.equal(first.state.streak, 0);
	assert.equal(first.state.cooldownUntil, 1_000 + 120_000);

	const during = drive(
		[...reads, ...Array<ScoutToolKind>(8).fill("read")],
		config,
		[...reads.map(() => 1_000), ...Array<number>(8).fill(50_000)],
	);
	assert.deepEqual(during.fires, [7]);
	assert.equal(during.state.streak, 0);

	const after = drive(
		[...reads, ...Array<ScoutToolKind>(8).fill("read")],
		config,
		[...reads.map(() => 1_000), ...Array<number>(8).fill(1_000 + 120_000)],
	);
	assert.deepEqual(after.fires, [7, 15]);

	const dispatched = drive(
		[...Array<ScoutToolKind>(7).fill("read"), "dispatch", ...Array<ScoutToolKind>(7).fill("read")],
		config,
		Array<number>(15).fill(0),
	);
	assert.deepEqual(dispatched.fires, []);
	assert.equal(dispatched.state.streak, 7);

	const exitCooldown = drive(
		[...reads, "dispatch", ...reads],
		config,
		[...reads.map(() => 0), 10, ...reads.map(() => 10)],
	);
	assert.deepEqual(exitCooldown.fires, [7, 16]);
	assert.equal(exitCooldown.state.cooldownUntil, 10 + 120_000);

	const written = drive(
		[...Array<ScoutToolKind>(7).fill("read"), "write", ...Array<ScoutToolKind>(7).fill("read")],
		config,
		Array<number>(15).fill(0),
	);
	assert.deepEqual(written.fires, []);
	assert.equal(written.state.streak, 7);
	assert.equal(written.state.cooldownUntil, null);

	const writeNoCooldown = drive(
		[...Array<ScoutToolKind>(7).fill("read"), "write", ...reads],
		config,
		Array<number>(16).fill(0),
	);
	assert.deepEqual(writeNoCooldown.fires, [15]);
	assert.equal(writeNoCooldown.state.cooldownUntil, 120_000);

	const ambiguous = drive(
		[...Array<ScoutToolKind>(7).fill("read"), "ignore", "read"],
		config,
		Array<number>(9).fill(5),
	);
	assert.deepEqual(ambiguous.fires, [8]);

	const statusDoesNotClear = drive(
		[...Array<ScoutToolKind>(7).fill("read"), "ignore", "read"],
		{ threshold: 8, cooldownMs: 120_000 },
		Array<number>(9).fill(0),
	);
	assert.deepEqual(statusDoesNotClear.fires, [8]);
});

interface SentMessage {
	customType: string;
	content: string;
	display: boolean;
}

interface SentOptions {
	triggerTurn?: boolean;
	deliverAs?: string;
}

function guardPi(input?: {
	loadSettings?: (cwd: string) => { scoutGuard?: { enabled?: boolean; threshold?: number; cooldownMs?: number } };
	now?: () => number;
	schedule?: (run: () => void) => void;
	env?: NodeJS.ProcessEnv;
}) {
	const sent: Array<{ message: SentMessage; options?: SentOptions }> = [];
	const queued: Array<() => void> = [];
	const commands = new Map<string, { handler: (args: string, ctx: { ui: { notify: (message: string, level?: string) => void } }) => Promise<void> }>();
	const events = new Map<string, (event: { toolName: string; input?: unknown }, ctx?: { cwd?: string }) => unknown>();
	const notices: string[] = [];
	const pi = {
		on(name: string, handler: unknown) {
			events.set(name, handler as (event: { toolName: string; input?: unknown }, ctx?: { cwd?: string }) => unknown);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: { ui: { notify: (message: string, level?: string) => void } }) => Promise<void> }) {
			commands.set(name, command);
		},
		sendMessage(message: SentMessage, options?: SentOptions) {
			sent.push({ message, options });
		},
	};
	registerScoutGuard(pi as never, {
		loadSettings: input?.loadSettings ?? (() => ({})),
		now: input?.now ?? (() => 0),
		schedule: input?.schedule ?? ((run) => queued.push(run)),
		env: input?.env,
	});
	const call = (toolName: string, toolInput?: unknown) =>
		events.get("tool_call")?.({ toolName, input: toolInput }, { cwd: "/work" });
	return {
		sent,
		queued,
		commands,
		events,
		notices,
		call,
		flush() {
			for (const run of queued.splice(0)) run();
		},
		reminders() {
			return sent.filter((entry) => entry.message.customType === SCOUT_GUARD_NOTIFY_TYPE);
		},
	};
}

test("hook: N consecutive reads inject one followUp reminder and do not block tool_call", () => {
	const guard = guardPi({ loadSettings: () => ({ scoutGuard: { threshold: 8, cooldownMs: 120_000 } }) });
	for (let index = 0; index < 7; index += 1) {
		assert.equal(guard.call("read", { path: `f${index}` }), undefined);
	}
	assert.equal(guard.reminders().length, 0);
	assert.equal(guard.queued.length, 0);
	const eighth = guard.call("bash", { command: "rg TODO src" });
	assert.equal(eighth, undefined);
	assert.equal(guard.reminders().length, 0, "sendMessage must not run inside tool_call");
	assert.equal(guard.queued.length, 1);
	guard.flush();
	const [reminder] = guard.reminders();
	assert.ok(reminder);
	assert.equal(reminder.message.content, REMINDER_8);
	assert.equal(reminder.message.display, true);
	assert.deepEqual(reminder.options, { triggerTurn: true, deliverAs: "followUp" });
	guard.call("read", { path: "again" });
	guard.flush();
	assert.equal(guard.reminders().length, 1);
});

test("hook: default scheduler fires only after tool_call returns", async () => {
	const sent: Array<{ message: SentMessage; options?: SentOptions }> = [];
	let hookReturned = false;
	const events = new Map<string, (event: { toolName: string; input?: unknown }, ctx?: { cwd?: string }) => unknown>();
	const pi = {
		on(name: string, handler: unknown) {
			events.set(name, handler as (event: { toolName: string; input?: unknown }, ctx?: { cwd?: string }) => unknown);
		},
		registerCommand() {},
		sendMessage(message: SentMessage, options?: SentOptions) {
			assert.equal(hookReturned, true);
			sent.push({ message, options });
		},
	};
	registerScoutGuard(pi as never, {
		loadSettings: () => ({ scoutGuard: { threshold: 1, cooldownMs: 60_000 } }),
		now: () => 5,
	});
	const result = events.get("tool_call")?.({ toolName: "read", input: { path: "a" } }, { cwd: "/work" });
	assert.equal(result, undefined);
	assert.equal(sent.length, 0);
	hookReturned = true;
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.message.customType, SCOUT_GUARD_NOTIFY_TYPE);
	assert.equal(sent[0]?.message.content, scoutGuardReminder(1));
	assert.deepEqual(sent[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
});

test("hook: dispatch, writes, cooldown, and slash/settings bypass", async () => {
	let now = 0;
	const guard = guardPi({
		loadSettings: () => ({ scoutGuard: { enabled: true, threshold: 4, cooldownMs: 120_000 } }),
		now: () => now,
	});
	const read = () => guard.call("read", { path: "a" });
	read(); read(); read();
	guard.call("vexillatio", { task: "survey" });
	read(); read(); read();
	assert.equal(guard.queued.length, 0);
	read();
	guard.flush();
	assert.equal(guard.reminders().length, 1);
	assert.match(guard.reminders()[0]?.message.content ?? "", /连续 4 次/);

	now = 1_000;
	read(); read(); read(); read();
	guard.flush();
	assert.equal(guard.reminders().length, 1, "cooldown suppresses the next streak");

	guard.call("subagent", { action: "launch", agent: "scout", task: "look" });
	read(); read(); read(); read();
	guard.flush();
	assert.equal(guard.reminders().length, 2, "dispatch ends cooldown immediately");

	now = 500_000;
	read(); read(); read();
	guard.call("edit", { path: "a" });
	read(); read(); read();
	assert.equal(guard.queued.length, 0);
	guard.call("bash", { command: "sed -i 's/a/b/' a" });
	read(); read(); read();
	assert.equal(guard.queued.length, 0);
	guard.call("write", { path: "b", contents: "x" });
	read(); read(); read(); read();
	guard.flush();
	assert.equal(guard.reminders().length, 3, "writes reset the streak and do not start cooldown");

	now = 700_000;
	read(); read();
	guard.call("bash", { command: "npm test" });
	read(); read();
	guard.flush();
	assert.equal(guard.reminders().length, 4, "ambiguous bash does not count and does not reset");

	const errors: string[] = [];
	await guard.commands.get("no-scout-guard")?.handler("extra", { ui: { notify: (message) => errors.push(message) } });
	assert.match(errors[0] ?? "", /Usage: \/no-scout-guard/);
	await guard.commands.get("no-scout-guard")?.handler("", { ui: { notify: () => {} } });
	for (let index = 0; index < 12; index += 1) read();
	guard.flush();
	assert.equal(guard.reminders().length, 4, "slash off bypasses counting");
	await guard.commands.get("scout-guard")?.handler("", { ui: { notify: () => {} } });
	now = 1_000_000;
	read(); read(); read(); read();
	guard.flush();
	assert.equal(guard.reminders().length, 5, "slash on is a session override");
});

test("hook: settings enabled false bypasses until /scout-guard", async () => {
	const guard = guardPi({
		loadSettings: () => ({ scoutGuard: { enabled: false, threshold: 2 } }),
	});
	guard.call("read", {});
	guard.call("read", {});
	guard.call("read", {});
	guard.flush();
	assert.equal(guard.reminders().length, 0);
	assert.equal(guard.queued.length, 0);
	await guard.commands.get("scout-guard")?.handler("", { ui: { notify: () => {} } });
	guard.call("read", {});
	guard.call("read", {});
	guard.flush();
	assert.equal(guard.reminders().length, 1);
	assert.equal(guard.reminders()[0]?.options?.deliverAs, "followUp");
});

test("hook: streak persists across turns and children do not register", () => {
	const guard = guardPi({ loadSettings: () => ({ scoutGuard: { threshold: 4, cooldownMs: 10 } }) });
	assert.equal(guard.events.has("turn_start"), false);
	guard.call("read", {});
	guard.call("bash", { command: "git log -1" });
	guard.call("read", {});
	guard.call("bash", { command: "sed -n '1p' file" });
	guard.flush();
	assert.equal(guard.reminders().length, 1);

	const child = guardPi({ env: { [CHILD_ROLE_ENV]: "scout" } });
	assert.equal(child.events.has("tool_call"), false);
	assert.equal(child.commands.has("scout-guard"), false);
	assert.equal(child.commands.has("no-scout-guard"), false);
});

test("parent tool_call observes reads and does not block or rewrite bash", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const path = await import("node:path");
	const herdrSubagents = (await import("../../index.ts")).default;
	const { FakeSupervisor } = await import("../helpers/fake-supervisor.ts");
	const dir = mkdtempSync(path.join(tmpdir(), "scout-guard-parent-"));
	const previous = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		child: process.env.PI_SUBAGENT_CHILD,
		role: process.env[CHILD_ROLE_ENV],
	};
	try {
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.PI_SUBAGENT_CHILD;
		delete process.env[CHILD_ROLE_ENV];
		const events = new Map<string, (event: { toolName: string; input: { command: string } }, ctx?: { cwd?: string }) => unknown>();
		const pi = {
			registerMessageRenderer() {},
			registerTool() {},
			registerCommand() {},
			sendMessage() {},
			events: { emit() {} },
			on(name: string, handler: unknown) {
				events.set(name, handler as (event: { toolName: string; input: { command: string } }, ctx?: { cwd?: string }) => unknown);
			},
		};
		herdrSubagents(pi as never, { supervisor: new FakeSupervisor() });
		const handler = events.get("tool_call");
		assert.equal(typeof handler, "function");
		const event = { toolName: "bash", input: { command: "echo hi" } };
		assert.equal(handler?.(event, { cwd: dir }), undefined);
		assert.equal(event.input.command, "echo hi");
	} finally {
		if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
		if (previous.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous.child;
		if (previous.role === undefined) delete process.env[CHILD_ROLE_ENV];
		else process.env[CHILD_ROLE_ENV] = previous.role;
		rmSync(dir, { recursive: true, force: true });
	}
});
