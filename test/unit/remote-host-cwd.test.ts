/**
 * First-run success, D2/D1 (contract `first-run-success-v1`, frozen).
 *
 * The two failures this file exists to prevent, both from one real 103-line
 * session:
 *
 *   1. a launch that did not name the directory on the OTHER machine used to be
 *      answered with a settings lesson ("set a default in
 *      subagents.crossMachine.hosts.vps.cwd") — a key the reader then had to
 *      find, in a configuration that only exists because the tool would not ask.
 *      D2 turns that into ONE question, and the question must be asked BEFORE
 *      anything is executed over there: a probe that runs first has already
 *      guessed a directory, and the guess is what lands the child in the wrong
 *      tree.
 *   2. the preflight's "missing program" refusals named a settings key as the
 *      instruction. D1: the ACTION is the instruction (install node / install pi
 *      / point piCli at the JS entry), the key is one trailing aside.
 *
 * Everything here is an in-process recording fake client (no socket, no `hc`,
 * no second machine), the same construction `cross-machine-preflight.test.ts`
 * uses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { type HcClient, type HcMethod, HcRpcError } from "../../src/hc/client.ts";
import {
	clearHostDiscoveryCache,
	missingRemoteCwdQuestion,
	remotePreflight,
	resolveHostTarget,
	resolveHostTargetAsync,
	type HcExecResult,
	type HostTarget,
} from "../../src/runs/remote.ts";
import { ErrorCodes, SubagentError } from "../../src/shared/types.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

type Params = Record<string, unknown>;

/** An in-process client that records EVERY request, in order. */
class RecordingClient implements HcClient {
	readonly calls: Array<{ method: HcMethod; params: Params }> = [];
	private readonly exec?: (params: Params) => unknown;

	constructor(handlers: { machines?: () => unknown; exec?: (params: Params) => unknown } = {}) {
		clearHostDiscoveryCache();
		this.machines = handlers.machines;
		this.exec = handlers.exec;
	}

	private readonly machines?: () => unknown;

	async start(): Promise<void> {}
	close(): void {}

	async request<T = unknown>(method: HcMethod, params: Params = {}): Promise<T> {
		this.calls.push({ method, params });
		if (method === "machine.list") {
			if (this.machines === undefined) {
				// The old-core shape: the method does not exist at all.
				throw new HcRpcError({ code: -32601, message: "unknown method: machine.list", data: { kind: "method_not_found" } });
			}
			return this.machines() as T;
		}
		if (method === "machine.exec") {
			return (this.exec?.(params) ?? { code: 0, stdout: "", stderr: "", timed_out: false }) as T;
		}
		throw new Error(`fake client: unexpected ${method}`);
	}

	methods(): HcMethod[] {
		return this.calls.map((call) => call.method);
	}

	paramsFor(method: HcMethod): Params[] {
		return this.calls.filter((call) => call.method === method).map((call) => call.params);
	}
}

const HOST = "vps";
const REMOTE_CWD = "/srv/app";

function execResult(overrides: Partial<HcExecResult> = {}): HcExecResult {
	return { code: 0, ms: 1, signal: null, stdout: "", stderr: "", truncated: false, timed_out: false, ...overrides };
}

function thrownSync(work: () => unknown): unknown {
	try {
		work();
	} catch (error) {
		return error;
	}
	return undefined;
}

async function thrown(work: () => Promise<unknown>): Promise<unknown> {
	try {
		await work();
	} catch (error) {
		return error;
	}
	return undefined;
}

/** The resolved target the preflight refusals are asserted against. */
function target(): HostTarget {
	return resolveHostTarget(HOST, {
		enabled: true,
		hosts: { [HOST]: { cwd: REMOTE_CWD, node: "/opt/node/bin/node", piCli: "/opt/pi/cli.js", piLegionRoot: "/srv/legion" } },
	});
}

/** A preflight client: `test -d` succeeds, the script exits with `code`. */
function preflightClient(code: number): RecordingClient {
	return new RecordingClient({
		exec: (params) => (Array.isArray(params.argv) ? execResult({ code: 0 }) : execResult({ code })),
	});
}

// ── 1. the D2 question is ONE shared sentence ──────────────────────────────

test("D2: missingRemoteCwdQuestion is the frozen four-sentence question, with the host interpolated", () => {
	// Literal, not a regex: this text IS the contract, and a paraphrase is the
	// regression (the old text was "set a default in …", i.e. a config lesson).
	assert.equal(
		missingRemoteCwdQuestion(HOST),
		`host 'vps' needs a directory on that machine, and this call did not name one — which directory should the child work in? `
			+ `Pass it with the call: subagent({ agent: "centurion", host: "vps", cwd: "/abs/path/on/vps", task: "..." }) `
			+ `(that path is read ON vps; it is never translated from here). `
			+ `If this conversation has not named a directory on vps, ask the user which one to use. `
			+ `Do not ssh or run \`hc exec\` to browse that machine — a guess here becomes a child in the wrong tree.`,
	);
	// Every sentence the acceptance list names, one by one — so deleting any one
	// of them (in particular the "ask the user" and "do not ssh" sentences) is red.
	const text = missingRemoteCwdQuestion("hw-nj");
	assert.match(text, /^host 'hw-nj' needs a directory on that machine, and this call did not name one — which directory should the child work in\?/);
	assert.match(text, /Pass it with the call: subagent\(\{ agent: "centurion", host: "hw-nj", cwd: "\/abs\/path\/on\/hw-nj", task: "\.\.\." \}\)/);
	assert.match(text, /\(that path is read ON hw-nj; it is never translated from here\)/);
	assert.match(text, /If this conversation has not named a directory on hw-nj, ask the user which one to use\./);
	assert.match(text, /Do not ssh or run `hc exec` to browse that machine — a guess here becomes a child in the wrong tree\./);
	// Four sentences, no more: the old second instruction must not come back.
	assert.doesNotMatch(text, /subagents\.crossMachine\.hosts/);
	assert.doesNotMatch(text, /set a default/);
});

test("D2: the resolver's per-call branch throws the question, with details that stop the model chain", () => {
	const error = thrownSync(() => resolveHostTarget(HOST, { enabled: true, hosts: { [HOST]: {} } }, { mentionPerCallCwd: true }));
	assert.ok(error instanceof SubagentError);
	assert.equal(error.code, ErrorCodes.INVALID_PARAMS);
	assert.equal(error.message, missingRemoteCwdQuestion(HOST));
	assert.deepEqual(error.details, { host: HOST, cwd: "", reason: "cwd-missing", noModelFallback: true });
});

test("D2: the pure resolver used DIRECTLY asks the same question (read-back paths included)", () => {
	// `remote-verify` / `remote-artifact` call `resolveHostTarget` with no overrides
	// at all: a resume that cannot name the directory must get the QUESTION too,
	// not a settings lesson — the first-run session's whole failure mode was one
	// sentence telling the reader to edit a file it could not edit.
	const error = thrownSync(() => resolveHostTarget(HOST, { enabled: true, hosts: { [HOST]: {} } }));
	assert.ok(error instanceof SubagentError);
	assert.equal(error.message, missingRemoteCwdQuestion(HOST));
	assert.deepEqual(error.details, { host: HOST, cwd: "", reason: "cwd-missing", noModelFallback: true });
});

test("D2 ordering: the async resolver asks the question with ZERO machine.exec (machine.list is allowed)", async () => {
	const client = new RecordingClient({ machines: () => ({ machines: [{ name: HOST }] }) });
	const error = await thrown(() => resolveHostTargetAsync(HOST, { enabled: true }, { client, admission: "always", cacheDir: null }));
	assert.ok(error instanceof SubagentError, `expected a refusal, got ${String(error)}`);
	assert.equal(error.code, ErrorCodes.INVALID_PARAMS);
	// The whole message, not a fragment: the question IS the error.
	assert.equal(error.message, missingRemoteCwdQuestion(HOST));
	assert.deepEqual(error.details, { host: HOST, cwd: "", reason: "cwd-missing", noModelFallback: true });
	// The ordering is the point (D2): one admission round trip, and NOTHING run.
	assert.deepEqual(client.methods(), ["machine.list"], "admission may ask, discovery may not");
	assert.deepEqual(client.paramsFor("machine.exec"), [], "no probe, no `test -d`, no `--list-models` before the question");
});

test("D2 ordering: the same client resolves once the call names the directory (the refusal is about cwd, not the client)", async () => {
	const client = new RecordingClient({ machines: () => ({ machines: [{ name: HOST }] }) });
	const resolved = await resolveHostTargetAsync(HOST, { enabled: true }, {
		client,
		admission: "always",
		cwd: REMOTE_CWD,
		// A complete entry needs no probe; the point here is that `{ enabled: true }`
		// plus a cwd is a LAUNCH, and only the missing input was refused.
		discover: false,
		cacheDir: null,
	});
	assert.equal(resolved.cwd, REMOTE_CWD);
	assert.equal(resolved.host, HOST);
});

test("D2: a cwd that is given but RELATIVE keeps the frozen byte-identical refusal", async () => {
	// `srv/app` is a path THIS machine cannot judge for the other one; the message
	// is pinned elsewhere and must not be replaced by the question.
	const client = new RecordingClient({ machines: () => ({ machines: [{ name: HOST }] }) });
	const error = await thrown(() => resolveHostTargetAsync(HOST, { enabled: true, hosts: { [HOST]: { cwd: "srv/app" } } }, { client, cacheDir: null, discover: false }));
	assert.ok(error instanceof SubagentError);
	assert.equal(
		error.message,
		"host 'vps' needs an absolute cwd in subagents.crossMachine.hosts.vps.cwd (remote paths are not translated from this machine)",
	);
	assert.deepEqual(client.paramsFor("machine.exec"), []);
});

// ── 2. F2: a host nothing has confirmed (D1 shape) ─────────────────────────

test("D1/F2: an unconfirmed host gets the ACTION first and the settings key once, not a config lesson", async () => {
	// No `machines` handler: this core is older than `machine.list`, so nothing
	// has confirmed the name and there is no entry to fall back to.
	const client = new RecordingClient();
	const error = await thrown(() => resolveHostTargetAsync(HOST, { enabled: true }, { client, cacheDir: null }));
	assert.ok(error instanceof SubagentError, `expected a refusal, got ${String(error)}`);
	assert.equal(error.code, ErrorCodes.INVALID_PARAMS);
	assert.deepEqual(error.details, { host: HOST, reason: "host-unconfirmed" });
	const message = error.message;
	// Action first: one pasteable command, before any diagnosis.
	assert.match(message, /^host 'vps': register the machine, then retry — hc machine add --name vps ssh:\/\/user@that-machine\./);
	// The diagnosis names the two facts that are missing, once.
	assert.match(message, /this hc core did not answer `machine list`/);
	assert.match(message, /no entry in subagents\.crossMachine\.hosts/);
	// …and it never substitutes this machine for the one that was asked for.
	assert.match(message, /Legion will not run the child on this machine instead\./);
	assert.deepEqual(client.paramsFor("machine.exec"), []);
});

// ── 3. D1: the preflight's missing-program refusals lead with the action ───

test("D1: exit 12 (no node) says install node there, and the settings key is the trailing aside", async () => {
	const error = await thrown(() => remotePreflight(preflightClient(12), target()));
	assert.ok(error instanceof SubagentError);
	assert.equal(error.code, ErrorCodes.START_FAILED, "the exit-code semantics are unchanged");
	const message = error.message;
	assert.match(message, /^host 'vps': node '\/opt\/node\/bin\/node' is not on PATH on vps — install node there, then retry\./);
	assert.match(message, /subagents\.crossMachine\.hosts\.vps\.node/);
	assert.ok(message.indexOf("install node there") < message.indexOf("subagents.crossMachine.hosts.vps.node"), "the action comes first");
	assert.deepEqual(error.details, { host: HOST, node: "/opt/node/bin/node", code: 12 });
});

test("D1: exit 13 (no pi CLI) says install pi there and names the one-liner that puts this package there", async () => {
	const error = await thrown(() => remotePreflight(preflightClient(13), target()));
	assert.ok(error instanceof SubagentError);
	assert.equal(error.code, ErrorCodes.START_FAILED);
	const message = error.message;
	assert.match(message, /^host 'vps': pi CLI '\/opt\/pi\/cli\.js' is not on PATH on vps — install pi there, then retry/);
	assert.match(message, /hc exec --on vps -- pi install npm:pi-legion/);
	assert.match(message, /subagents\.crossMachine\.hosts\.vps\.piCli/);
});

test("D1: exit 14 (this package is not there) keeps the two ways out, install first", async () => {
	const error = await thrown(() => remotePreflight(preflightClient(14), target()));
	assert.ok(error instanceof SubagentError);
	assert.equal(error.code, ErrorCodes.INVALID_PARAMS, "the exit-code semantics are unchanged");
	const message = error.message;
	assert.match(message, /this package is not installed at \/srv\/legion on that machine — install this package there, then retry/);
	assert.match(message, /hc exec --on vps -- pi install npm:pi-legion/);
	// The second way out is still there (an install at another root), as an aside.
	assert.match(message, /If it is already installed somewhere else on that machine, put that root in subagents\.crossMachine\.hosts\.vps\.piLegionRoot\./);
	assert.match(message, /every child's argv loads \/srv\/legion\/index\.ts/);
});

test("D1: exit 16 (piCli is a shell launcher) points at the JS entry FIRST, then explains", async () => {
	const error = await thrown(() => remotePreflight(preflightClient(16), target()));
	assert.ok(error instanceof SubagentError);
	assert.equal(error.code, ErrorCodes.INVALID_PARAMS);
	const message = error.message;
	assert.match(
		message,
		/^host 'vps': point piCli at the JS entry node can execute, e\.g\. \/root\/\.pi\/agent\/npm\/node_modules\/@earendil-works\/pi-coding-agent\/dist\/bundle\/cli\.js\./,
	);
	// The greppable fact and its explanation are preserved.
	assert.match(message, /piCli '\/opt\/pi\/cli\.js' is not a JavaScript entry point node can execute/);
	assert.match(message, /a shell launcher .* cannot be the argv\[1\] of `node`/);
	assert.match(message, /That path goes in subagents\.crossMachine\.hosts\.vps\.piCli\./);
});

test("D1: exit 11/15/17 are untouched (a missing checking checkout, identity, a missing piExtensions entry)", async () => {
	// Not a rewrite: the exit codes that already led with the fix keep their text.
	const eleven = await thrown(() => remotePreflight(preflightClient(11), target()));
	assert.match(String((eleven as Error)?.message ?? eleven), /cwd '\/srv\/app' does not exist on vps/);
	const fifteen = await thrown(() => remotePreflight(preflightClient(15), target()));
	assert.match(String((fifteen as Error)?.message ?? fifteen), /already carries legion identity/);
	const seventeen = await thrown(() => remotePreflight(preflightClient(17), { ...target(), piExtensions: ["/srv/legion/ext/missing.ts"] }));
	assert.match(String((seventeen as Error)?.message ?? seventeen), /piExtensions entry '\/srv\/legion\/ext\/missing\.ts' does not exist on that machine/);
});
