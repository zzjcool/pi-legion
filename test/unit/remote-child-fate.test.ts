/**
 * `docs/contracts/remote-child-fate-v1.md` — a cross-machine launch that
 * produced no transcript must say WHY.
 *
 * Everything here runs against a recording fake client: no socket, no `hc`, no
 * second machine. What is pinned:
 *
 *   §2  `probeRemoteChild` classifies in the frozen order, from two round trips
 *       (`terminal.get` + one `machine.exec`), and the four anchor sentences.
 *   §3  the preflight's exit 17: a `piExtensions` entry that does not exist on
 *       the target is a refusal that names the file and the key.
 *   §5  a failed read-back carries `fate` / `evidence` / `nextStep`, and
 *       `unreachable` is the honest answer when nothing can be classified.
 *   §6  the three frozen render lines: the classed `FAILED (<fate>)` block, the
 *       `· read-back: <fate>` suffix, and the dropped-extensions notice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { HcRpcError, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import {
	probeRemoteChild,
	remoteChildProbeScript,
	remotePreflight,
	remotePreflightScript,
	type HcExecResult,
	type HostTarget,
} from "../../src/runs/remote.ts";
import { createRemoteSessionReadback, remoteMirrorPathFor } from "../../src/runs/remote-artifact.ts";
import { TerminalSupervisor } from "../../src/supervisor/terminal-supervisor.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";
import { ErrorCodes, SubagentError, type AgentConfig, type SubagentsSettings } from "../../src/shared/types.ts";
import { renderCollect } from "../../index.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

type Params = Record<string, unknown>;

interface Call {
	method: HcMethod;
	params: Params;
}

/** A protocol client that records every call and answers through handlers. */
class FakeRemoteClient implements HcClient {
	readonly calls: Call[] = [];
	private readonly handlers = new Map<string, (params: Params) => unknown>();

	on(method: HcMethod, handler: (params: Params) => unknown): this {
		this.handlers.set(method, handler);
		return this;
	}

	async start(): Promise<void> {}

	async request<T = unknown>(method: HcMethod, params: Params = {}): Promise<T> {
		this.calls.push({ method, params });
		const handler = this.handlers.get(method);
		if (!handler) throw new Error(`fake remote client: no handler for ${method}`);
		return (await handler(params)) as T;
	}

	close(): void {}

	paramsFor(method: HcMethod): Params[] {
		return this.calls.filter((call) => call.method === method).map((call) => call.params);
	}
}

const HOST = "vps";

function config(): SubagentsSettings["crossMachine"] {
	return { enabled: true, hosts: { [HOST]: { cwd: "/srv/app" } } };
}

function target(overrides: Partial<HostTarget> = {}): HostTarget {
	return {
		host: HOST,
		cwd: "/srv/app",
		node: "node",
		piCli: "pi",
		// In production `resolveHostTarget` adds this entry automatically
		// (`thisPackageRoot()` → `piLegionRoot`): every child's argv carries
		// `<this package>/index.ts` as the guard extension, and v1.2 refuses an
		// absolute argv path no rule can map instead of dropping it.
		pathMap: [{ from: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), to: "/srv/pi-legion" }],
		piLegionRoot: "/srv/pi-legion",
		piExtensions: [],
		mirrorRoot: "/srv/.pi-subagents-mirror",
		worktreeRoot: "/srv/.pi-worktrees",
		...overrides,
	};
}

function b64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

function execResult(overrides: Partial<HcExecResult> = {}): HcExecResult {
	return { code: 0, ms: 3, signal: null, stdout: "", stderr: "", truncated: false, timed_out: false, ...overrides };
}

function notFound(message = "no such terminal: vps/lgl-worker-0"): HcRpcError {
	return new HcRpcError({ code: -32000, message, data: { kind: "not_found" } });
}

/**
 * The two answers a probe needs, in one place: the terminal facts and the shell
 * listing. `session` is what `machine.exec` reports for `session=`.
 */
function probeClient(opts: {
	terminal?: { state?: string; exit_code?: number | null; screen?: string } | "missing";
	session?: boolean;
	dir?: boolean;
	entries?: string[];
	/** The text `terminal.read` answers (the core's screen, not the mode word). */
	screen?: string;
}): FakeRemoteClient {
	const client = new FakeRemoteClient();
	client.on("terminal.get", () => {
		if (opts.terminal === "missing") throw notFound();
		// The real core's answer: `screen` is a MODE, never the text (#423).
		return { terminal: `vps/lgl-worker-0`, screen: "exact", ...(opts.terminal ?? { state: "live", turn: 0 }) };
	});
	// #423: the screen TEXT is read through `terminal.read` (a real core's
	// `terminal.get.screen` is the mode word "exact"), so the fake answers it the
	// way the core does — the same text `terminal.get` used to carry.
	client.on("terminal.read", () => ({ text: opts.terminal === "missing" ? "" : opts.screen ?? "", how: "screen", complete: true }));
	client.on("machine.exec", () =>
		execResult({
			stdout: b64(
				[
					`dir=${opts.dir === false ? 0 : 1}`,
					`session=${opts.session === true ? 1 : 0}`,
					...(opts.entries ?? []).map((entry) => `entry=${entry}`),
				].join("\n") + "\n",
			),
		}),
	);
	return client;
}

// ── §2: the probe and its classification order ─────────────────────────────

test("§2: `started` wins over everything else — a transcript that exists is a fact", async () => {
	// The terminal is finished AND has an exit code AND the recorded dir differs:
	// none of that may outvote the file that is actually there.
	const client = probeClient({
		terminal: { state: "finished", exit_code: 1 },
		session: true,
		entries: ["session.jsonl", "system-prompt.md"],
	});
	const fate = await probeRemoteChild({
		client,
		target: target(),
		terminal: "vps/lgl-worker-0",
		sessionPath: "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl",
		recordedDir: "/srv/elsewhere/no-run/worker-0",
	});
	assert.equal(fate.kind, "started");
	assert.equal(fate.sessionExists, true);
	assert.equal(fate.exitCode, 1, "the exit code still travels — it is evidence, not a class");
	assert.equal(fate.summary, "the transcript exists on that machine");
	assert.equal(fate.nextStep, "—");
});

test("§2: a dead terminal is `no-child`; the core not knowing it is the same verdict", async () => {
	const finished = await probeRemoteChild({
		client: probeClient({ terminal: { state: "finished", exit_code: 1 }, session: false, entries: ["system-prompt.md"] }),
		target: target(),
		terminal: "vps/lgl-worker-0",
		sessionPath: "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl",
	});
	assert.equal(finished.kind, "no-child");
	assert.equal(
		finished.summary,
		"the child's terminal ended before it wrote a transcript",
	);
	assert.equal(
		finished.nextStep,
		"run the command below on that machine: the child's own error is on its terminal, and pi exits before its first turn when a --extension / --model is not usable there",
	);

	// `not_found` from `terminal.get` is not an error: the core forgetting the
	// terminal is exactly the state the parent has to render.
	const gone = await probeRemoteChild({
		client: probeClient({ terminal: "missing", session: false }),
		target: target(),
		terminal: "vps/lgl-worker-0",
		sessionPath: "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl",
	});
	assert.equal(gone.kind, "no-child");
	assert.equal(gone.terminalState, "missing");

	// An exit code alone is proof too (a core that reports it before `finished`).
	const coded = await probeRemoteChild({
		client: probeClient({ terminal: { state: "live", exit_code: 130 }, session: false }),
		target: target(),
		terminal: "vps/lgl-worker-0",
		sessionPath: "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl",
	});
	assert.equal(coded.kind, "no-child");
	assert.equal(coded.exitCode, 130);
});

test("§2: an INFERRED terminal name never turns `missing` into proof of death", async () => {
	// A record written before `remoteTerminal` existed makes the read-back recompute
	// `host/lgl-<name>`; a run-scoped launch holds `host/lgl-<runid8>-<name>`. The core
	// not knowing the invented name says nothing about the child, so the same reply
	// that is `no-child` for a real address must fall back to `no-session` here.
	const inferred = await probeRemoteChild({
		client: probeClient({ terminal: "missing", session: false }),
		target: target(),
		terminal: "vps/lgl-worker-0",
		sessionPath: "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl",
		terminalInferred: true,
	});
	assert.equal(inferred.terminalState, "missing");
	assert.equal(inferred.kind, "no-session", "a guessed name is not evidence the child ended");
});

test("§2: a live terminal with no transcript is `no-session`, never a verdict", async () => {
	const fate = await probeRemoteChild({
		client: probeClient({ terminal: { state: "live" }, session: false, dir: true, entries: [] }),
		target: target(),
		terminal: "vps/lgl-worker-0",
		sessionPath: "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl",
	});
	assert.equal(fate.kind, "no-session");
	assert.equal(fate.terminalState, "live");
	assert.equal(fate.summary, "the child's terminal is alive but has written no transcript yet");
	assert.equal(
		fate.nextStep,
		"collect after it reaches a turn, or `status` for liveness — a live terminal with no transcript is not a verdict",
	);
});

test("§2: `path` when the record's dir and this configuration disagree", async () => {
	const fate = await probeRemoteChild({
		client: probeClient({ terminal: { state: "live" }, session: false }),
		target: target(),
		terminal: "vps/lgl-worker-0",
		sessionPath: "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl",
		recordedDir: "/old/mirror/no-run/worker-0",
	});
	assert.equal(fate.kind, "path");
	assert.equal(fate.summary, "the record and this configuration disagree about the mirror dir");
	assert.equal(
		fate.nextStep,
		"the transcript may have landed in the recorded dir; fix `subagents.crossMachine.hosts.vps.cwd`/`worktreeRoot`, or retire and relaunch the child",
	);
});

test("§2: three round trips (get + read + exec), and the shell line is quoted", async () => {
	const client = probeClient({ terminal: { state: "live" }, session: false });
	await probeRemoteChild({
		client,
		target: target(),
		terminal: "vps/lgl-worker-0",
		sessionPath: "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl",
	});
	// #423: `terminal.read` joined the probe because a real core answers
	// `terminal.get.screen` with the mode word `"exact"` — the text is a separate
	// read. One of each, and nothing else.
	assert.deepEqual(client.calls.map((call) => call.method).sort(), ["machine.exec", "terminal.get", "terminal.read"]);
	assert.equal(client.paramsFor("terminal.get")[0]?.terminal, "vps/lgl-worker-0");
	assert.equal(client.paramsFor("terminal.read")[0]?.terminal, "vps/lgl-worker-0");
	const exec = client.paramsFor("machine.exec")[0] ?? {};
	assert.equal(exec.on, HOST);
	const line = String(exec.line ?? "");
	assert.ok(
		line.includes("if [ -d '/srv/.pi-subagents-mirror/no-run/worker-0' ];"),
		`operator paths stay data, not code: ${line}`,
	);
	assert.ok(line.includes("if [ -e '/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl' ];"), line);
	assert.match(remoteChildProbeScript("/tmp/a b/session.jsonl"), /'\/tmp\/a b'/);
});

test("§2: the screen tail is the child's own words — ANSI stripped, last six non-empty lines", async () => {
	const screen = [
		"\u001b[2J\u001b[1;1Hstarting pi",
		"",
		"\u001b[31mError: Failed to load extension \"/missing/index.ts\"\u001b[0m",
		"provider: none",
		"hint: check --extension",
		"line5",
		"line6",
		"line7 (last)",
	].join("\n");
	const fate = await probeRemoteChild({
		client: probeClient({ terminal: { state: "finished", exit_code: 1, screen }, session: false }),
		target: target(),
		terminal: "vps/lgl-worker-0",
		sessionPath: "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl",
	});
	assert.equal(fate.screenTail.length, 6);
	assert.equal(fate.screenTail[fate.screenTail.length - 1], "line7 (last)");
	assert.ok(
		fate.screenTail.some((line) => line === 'Error: Failed to load extension "/missing/index.ts"'),
		`ANSI escapes must not survive: ${JSON.stringify(fate.screenTail)}`,
	);
});

test("§2: a terminal the core cannot answer for is NOT classified — the probe throws", async () => {
	const client = new FakeRemoteClient();
	client.on("terminal.get", () => {
		throw new HcRpcError({ code: -32000, message: "socket closed", data: { kind: "transport" } });
	});
	await assert.rejects(
		() => probeRemoteChild({
			client,
			target: target(),
			terminal: "vps/lgl-worker-0",
			sessionPath: "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl",
		}),
		/socket closed/,
	);
});

// ── §3: the preflight refuses a piExtensions entry that is not there ───────

test("§3: the preflight checks every piExtensions entry, between exit 14 and exit 15", async () => {
	const script = remotePreflightScript(target({ piExtensions: ["/srv/ext/provider/index.ts", "/srv/ext/two/index.ts"] }));
	assert.match(script, /test -e '\/srv\/ext\/provider\/index\.ts' \|\| \{ printf '%s\\n' '\/srv\/ext\/provider\/index\.ts' >&2; exit 17; \}/);
	assert.match(script, /test -e '\/srv\/ext\/two\/index\.ts'/);
	assert.ok(script.indexOf("exit 14") < script.indexOf("exit 17"), "the package entry is still checked first");
	assert.ok(script.indexOf("exit 17") < script.indexOf("exit 15"), "the legion-identity refusal stays last");
	// An empty list adds nothing: an existing target's script is unchanged.
	assert.doesNotMatch(remotePreflightScript(target()), /exit 17/);
});

test("§3: exit 17 names the missing file and the key that declared it", async () => {
	const client = new FakeRemoteClient();
	client.on("machine.exec", (params) =>
		Array.isArray(params.argv)
			? execResult({ code: 0 })
			: execResult({ code: 17, stderr: b64("/srv/ext/provider/index.ts\n") }),
	);
	const error = await remotePreflight(client, target({ piExtensions: ["/srv/ext/provider/index.ts"] })).then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
	assert.ok(error instanceof SubagentError, "exit 17 must throw");
	assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	assert.match(
		(error as SubagentError).message,
		/host 'vps': piExtensions entry '\/srv\/ext\/provider\/index\.ts' does not exist on that machine/,
	);
	assert.match((error as SubagentError).message, /subagents\.crossMachine\.hosts\.vps\.piExtensions is read ON vps/);
	assert.match((error as SubagentError).message, /makes pi exit 1 before its first turn/);
	assert.deepEqual((error as SubagentError).details, { host: HOST, missingExtension: "/srv/ext/provider/index.ts" });
});

// ── §5: read-back failures carry the class ─────────────────────────────────

function readbackClient(opts: {
	terminal?: { state?: string; exit_code?: number | null; screen?: string } | "missing";
	session?: boolean;
	dir?: boolean;
	entries?: string[];
	execThrows?: boolean;
}): FakeRemoteClient {
	const client = probeClient(opts);
	client.on("file.read", () => {
		throw notFound("no such file: /srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl");
	});
	if (opts.execThrows) {
		client.on("machine.exec", () => {
			throw new HcRpcError({ code: -32000, message: "socket closed", data: { kind: "transport" } });
		});
	}
	return client;
}

async function readback(
	client: HcClient,
	request: { host?: string; name?: string; remoteDir?: string },
): Promise<Awaited<ReturnType<ReturnType<typeof createRemoteSessionReadback>>>> {
	const root = mkdtempSync(path.join(tmpdir(), "remote-fate-"));
	try {
		const seam = createRemoteSessionReadback({ crossMachine: config(), clientFactory: () => client });
		return await seam({
			host: request.host ?? HOST,
			name: request.name ?? "worker-0",
			localPath: remoteMirrorPathFor(root, request.name ?? "worker-0"),
			...(request.remoteDir ? { remoteDir: request.remoteDir } : {}),
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("§5: a dead child's failed read-back is `no-child`, with evidence and a next step", async () => {
	const result = await readback(
		readbackClient({ terminal: { state: "finished", exit_code: 1, screen: "Error: no model\n" }, session: false, entries: ["system-prompt.md"] }),
		{ remoteDir: "/srv/.pi-subagents-mirror/no-run/worker-0" },
	);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.fate, "no-child");
	assert.match(result.reason, /no such file/, "the core's own text is preserved");
	assert.ok(result.evidence.length > 0 && result.evidence.length <= 5);
	assert.ok(result.evidence.includes("terminal finished"), result.evidence.join("; "));
	assert.ok(result.evidence.includes("exit 1"), result.evidence.join("; "));
	assert.ok(result.evidence.includes("dir holds: system-prompt.md"), result.evidence.join("; "));
	assert.match(result.nextStep, /the child's own error is on its terminal/);
	assert.deepEqual(result.screenTail, ["Error: no model"]);
});

test("§5: a record without a terminal address says the name was inferred", async () => {
	// `readback()` never passes `remoteTerminal`, which is exactly the legacy record:
	// the seam recomputes the address, and the class must not claim death on it.
	const result = await readback(
		readbackClient({ terminal: "missing", session: false, entries: [] }),
		{ remoteDir: "/srv/.pi-subagents-mirror/no-run/worker-0" },
	);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.fate, "no-session", "missing + inferred must not be `no-child`");
	assert.ok(
		result.evidence.some((line) => /the terminal name was inferred/.test(line)),
		result.evidence.join("; "),
	);
});

test("§5: a live child with no transcript is `no-session`", async () => {
	const result = await readback(
		readbackClient({ terminal: { state: "live" }, session: false, entries: [] }),
		{ remoteDir: "/srv/.pi-subagents-mirror/no-run/worker-0" },
	);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.fate, "no-session");
	assert.ok(result.evidence.includes("terminal live"));
	assert.match(result.nextStep, /is not a verdict/);
});

test("§5: record/config disagreement is `path`, naming both dirs", async () => {
	const result = await readback(
		readbackClient({ terminal: { state: "live" }, session: false }),
		{ remoteDir: "/old/mirror/no-run/worker-0" },
	);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.fate, "path");
	const evidence = result.evidence.join("; ");
	assert.match(evidence, /recorded dir: \/old\/mirror\/no-run\/worker-0/, evidence);
	assert.match(evidence, /configured dir: \/srv\/\.pi-subagents-mirror\/no-run\/worker-0/, evidence);
	assert.match(result.nextStep, /subagents\.crossMachine\.hosts\.vps/);
});

test("§5: `started` can never be a failure — a present file that would not read is `path`", async () => {
	// `file.read` failed but the probe found the transcript on that machine: the
	// bytes came back wrong, which is a read/path problem, never "no child".
	const result = await readback(
		readbackClient({ terminal: { state: "live" }, session: true }),
		{ remoteDir: "/srv/.pi-subagents-mirror/no-run/worker-0" },
	);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.fate, "path");
	assert.match(result.evidence.join("; "), /the transcript exists at /);
});

test("§5: what cannot be classified is `unreachable`, and it names the config or the connection", async () => {
	// 1. The target does not resolve at all.
	const unresolved = await createRemoteSessionReadback({ crossMachine: undefined })({
		host: HOST,
		name: "worker-0",
		localPath: "/tmp/never.jsonl",
	});
	assert.equal(unresolved.ok, false);
	if (unresolved.ok) return;
	assert.equal(unresolved.fate, "unreachable");
	assert.match(unresolved.nextStep, /subagents\.crossMachine\.hosts\.vps/);
	assert.ok(unresolved.evidence.length > 0);

	// 2. The probe's own `machine.exec` rejects: a transport failure, not a class.
	const probeFailed = await readback(
		readbackClient({ terminal: { state: "live" }, session: false, execThrows: true }),
		{ remoteDir: "/srv/.pi-subagents-mirror/no-run/worker-0" },
	);
	assert.equal(probeFailed.ok, false);
	if (probeFailed.ok) return;
	assert.equal(probeFailed.fate, "unreachable");
	assert.match(probeFailed.evidence.join("; "), /the probe could not classify it/);
	assert.match(probeFailed.nextStep, /subagents\.crossMachine\.hosts\.vps/);
});

// ── §6: the render ─────────────────────────────────────────────────────────

function snapshot(overrides: Record<string, unknown> = {}): Parameters<typeof renderCollect>[1] {
	return {
		execution: { status: "unknown", reason: "no messages in session" },
		output: "",
		acceptance: { status: "unknown" },
		...overrides,
	} as Parameters<typeof renderCollect>[1];
}

test("§6.1/6.2: a classed read-back failure renders the class, evidence, screen and next step", () => {
	const rendered = renderCollect("worker-0", snapshot({
		remoteReadback: {
			host: HOST,
			lines: 0,
			returned: 0,
			truncated: false,
			reason: "not_found: no such file",
			fate: "no-child",
			evidence: ["terminal finished", "exit 1"],
			nextStep: "run the command below on that machine",
			screenTail: ["Error: Failed to load extension", "provider: none"],
		},
	}));
	const lines = rendered.split("\n");
	assert.equal(lines[1], "execution: unknown (no messages in session) · read-back: no-child");
	assert.match(rendered, /read-back from host 'vps': FAILED \(no-child\) — not_found: no such file \(the verdict below rests on no transcript at all\)/);
	assert.match(rendered, /^ {2}evidence: terminal finished; exit 1$/m);
	assert.match(rendered, /^ {2}screen: Error: Failed to load extension ⏎ provider: none$/m);
	assert.match(rendered, /^ {2}next: run the command below on that machine$/m);
});

test("§6.1: a failure with no class keeps the old line byte for byte", () => {
	const rendered = renderCollect("worker-0", snapshot({
		remoteReadback: { host: HOST, lines: 0, returned: 0, truncated: false, reason: "host 'vps' needs subagents.crossMachine.enabled = true" },
	}));
	assert.match(rendered, /read-back from host 'vps': FAILED — host 'vps' needs subagents\.crossMachine\.enabled = true \(the verdict below rests on no transcript at all\)/);
	assert.equal(rendered.split("\n")[1], "execution: unknown (no messages in session)", "no suffix without a class");
});

test("§6.2: a successful read-back adds no suffix to the execution line", () => {
	const rendered = renderCollect("worker-0", snapshot({
		execution: { status: "success" },
		remoteReadback: { host: HOST, lines: 40, returned: 40, truncated: false },
	}));
	assert.doesNotMatch(rendered, /read-back:/);
	assert.match(rendered, /40 of 40 lines \(complete\)/);
});

// ── §4: the launch gate — proof of death, not a guess ──────────────────────

// Hermetic: an inherited extension list is a set of absolute paths from whatever
// machine runs the suite, and a remote launch refuses an argv path it cannot map.
process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = "0";

const RUN_ID = "run-fate";
const CHILD = "worker-0";
const SESSION_PATH = `/srv/.pi-subagents-mirror/${RUN_ID}/${CHILD}/session.jsonl`;

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "remote fate test role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test worker.",
		source: "user",
		filePath: "/fake/worker.md",
		worktree: false,
	};
}

/**
 * A launch that reaches `terminal.run` and then either confirms, proves death or
 * says nothing — the three states §4 distinguishes, with nothing else moving.
 */
function launchHarness(opts: {
	sessionArrives?: boolean;
	terminal?: { state?: string; exit_code?: number; screen?: string };
	remoteStartupConfirmMs?: number;
}): { supervisor: TerminalSupervisor; client: FakeRemoteClient; root: string; cleanup: () => void } {
	const root = mkdtempSync(path.join(tmpdir(), "remote-startup-"));
	const client = new FakeRemoteClient();
	client.on("machine.exec", (params) => {
		// argv = preflight's `test -d`, mkdir, rm; line = preflight script, the S5.6
		// `--list-models` probe, or the fate probe.
		if (Array.isArray(params.argv)) return execResult({ code: 0 });
		const line = String(params.line ?? "");
		if (line.includes("--list-models")) return execResult({ code: 0 });
		return execResult({ code: 0, stdout: b64(["dir=1", `session=${opts.sessionArrives === true ? 1 : 0}`, "entry=system-prompt.md"].join("\n") + "\n") });
	});
	client.on("file.write", (params) => ({ path: params.path, bytes: 1 }));
	client.on("file.read", () => {
		if (opts.sessionArrives === true) return { text: "", first: 1, last: 0, lines: 0 };
		throw notFound(`no such file: ${SESSION_PATH}`);
	});
	client.on("terminal.get", (params) => ({
		address: String(params.terminal),
		name: `lgl-${CHILD}`,
		state: opts.terminal?.state ?? "live",
		turn: 0,
		status: { state: "idle" },
		...(opts.terminal?.exit_code !== undefined ? { exit_code: opts.terminal.exit_code } : {}),
		screen: opts.terminal?.screen ?? "",
	}));
	// #423: the child's own words come from `terminal.read` on a real core.
	client.on("terminal.read", () => ({ text: opts.terminal?.screen ?? "", how: "screen", complete: true }));
	client.on("terminal.run", () => ({ address: "t9", name: `lgl-${CHILD}`, state: "running", turn: 0, status: { state: "idle" }, pid: 4242 }));
	const supervisor = new TerminalSupervisor({
		clientFactory: () => client,
		env: { PATH: "/usr/bin" },
		runId: RUN_ID,
		pollIntervalMs: 5,
		remoteStartupConfirmMs: opts.remoteStartupConfirmMs ?? 8_000,
	});
	return { supervisor, client, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function spawnInput(root: string): SpawnInput {
	return {
		name: CHILD,
		task: "Do the slice.",
		agent: agent(),
		sessionFile: path.join(root, "session.jsonl"),
		tempDir: root,
		cwd: root,
		host: HOST,
		hostTarget: target(),
		env: {},
	} as SpawnInput;
}

test("§4.1: a terminal that ended during start-up fails the LAUNCH, quoting the child", async () => {
	const h = launchHarness({
		sessionArrives: false,
		terminal: { state: "finished", exit_code: 1, screen: '\u001b[31mError: Failed to load extension "/missing/index.ts"\u001b[0m' },
	});
	try {
		const error = await h.supervisor.spawnChild(spawnInput(h.root)).then(() => undefined, (thrown: unknown) => thrown);
		assert.ok(error instanceof SubagentError, "a proven death must fail the launch");
		assert.equal((error as SubagentError).code, ErrorCodes.START_FAILED);
		const message = (error as SubagentError).message;
		assert.match(message, /^host 'vps': the child did not survive startup — its terminal ended before it wrote \/srv\/\.pi-subagents-mirror\/run-fate\/worker-0\/session\.jsonl$/m);
		assert.match(message, /^ {2}exit: 1$/m);
		assert.match(message, /^ {2}dir: the mirror dir is there \(\/srv\/\.pi-subagents-mirror\/run-fate\/worker-0\)$/m);
		assert.match(message, /^ {2}screen: Error: Failed to load extension "\/missing\/index\.ts"$/m);
		assert.match(message, /^ {2}next: run the command below on that machine: /m);
		assert.match(message, /^ {2}Command \(run on 'vps' to reproduce\):$/m);
		assert.match(message, /--list-models/, "the reproduce command is the child's own argv");
		assert.deepEqual((error as SubagentError).details, { host: HOST, fate: "no-child", exitCode: 1 });
		// #409: a cross-machine launch creates the machine's anchor first, so the
		// child's own request is the one under test here — it must have reached the core
		// before the gate judged it.
		const childRuns = h.client.paramsFor("terminal.run").filter((params) => params.name !== "lgl-anchor");
		assert.equal(childRuns.length, 1, "the terminal was reached before the gate judged it");
	} finally {
		h.cleanup();
	}
});

test("§4: a confirmed transcript launches, and the handle carries the address the core holds", async () => {
	const h = launchHarness({ sessionArrives: true });
	try {
		const handle = await h.supervisor.spawnChild(spawnInput(h.root));
		assert.equal(handle.remoteTerminal, "vps/lgl-worker-0");
		assert.equal(handle.remoteDir, `/srv/.pi-subagents-mirror/${RUN_ID}/${CHILD}`);
	} finally {
		h.cleanup();
	}
});

test("§4 (#423): silence is NOT a launch — no transcript within the window refuses with START_FAILED", async () => {
	// #423 reversed this half of §4. The old rule ("warn and launch anyway") left a
	// child the parent renders as `working` and cannot verify; measured, four of them
	// in one day, and one retired as `execution: success` without ever running. The
	// refusal (with the machine, cwd, terminal, hc error and the terminal's last
	// lines) is `test/unit/remote-launch-refusal.test.ts`'s subject; here only the
	// §4 boundary is pinned: the gate fires, and no child record survives.
	const h = launchHarness({ sessionArrives: false, remoteStartupConfirmMs: 40 });
	try {
		const error = await h.supervisor.spawnChild(spawnInput(h.root)).then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
		assert.ok(error instanceof SubagentError, `a silent launch must be refused, got ${String(error)}`);
		assert.equal(error.code, ErrorCodes.START_FAILED);
		assert.match(error.message, new RegExp(`no session file appeared at ${SESSION_PATH.replaceAll("/", "\\/")}`));
		assert.equal(h.supervisor.isAlive(CHILD), false, "no `working` shell may be registered");
	} finally {
		h.cleanup();
	}
});

/**
 * #460: the incident this file's sibling covers a corner of — a supervision READ
 * failing on a child that is still running on the other machine.
 *
 * The address is the whole point: `stop` (and the #456 orphan sweep) reach a remote
 * child by `host/name`, so an outage must not degrade it to a bare name or drop the
 * host. This is the one case in this file that asks a REMOTE child, because a local
 * fixture could never observe the `host/` prefix.
 */
test("#460: a remote child that becomes unreachable keeps its host-qualified address, and stop still kills it there", async () => {
	const h = launchHarness({ sessionArrives: true });
	try {
		const handle = await h.supervisor.spawnChild(spawnInput(h.root));
		assert.equal(handle.remoteTerminal, "vps/lgl-worker-0");
		// The channel dies AFTER the launch was confirmed — exactly the incident.
		h.client.on("terminal.get", () => {
			throw new HcRpcError({ code: -32603, message: "hc connect exited (code 0)", data: { kind: "transport" } });
		});
		const settled = await h.supervisor.waitSettled(CHILD, 5_000);
		assert.equal(settled.abnormal, false, "the child was never observed to end");
		assert.notEqual(settled.unreachable, undefined);
		assert.equal(h.supervisor.isAlive(CHILD), true, "status still lists it");

		h.client.on("terminal.kill", () => ({ address: "t9", state: "finished" }));
		h.client.on("terminal.rm", () => ({ removed: "t9" }));
		await h.supervisor.retire(CHILD);
		assert.deepEqual(
			h.client.paramsFor("terminal.kill").map((params) => params.terminal),
			["vps/lgl-worker-0"],
			"the host-qualified address survived the outage",
		);
	} finally {
		h.cleanup();
	}
});
