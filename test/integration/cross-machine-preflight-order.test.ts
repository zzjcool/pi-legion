/**
 * Guard ORDER inside `Orchestrator.launch` for a cross-machine delivery
 * (contract `cross-machine-demo-ux` D7 / D9).
 *
 * The failure this pins is about ORDER, not about either check being wrong. The
 * original launch validated the phase machine first and asked the delivery
 * questions second, so a caller whose `phases` had a typo AND whose remote could
 * not be reached learned about the typo, fixed it, relaunched, waited out the
 * whole remote setup — and only then got the sentence it could not act on at all
 * (`this checkout has no origin`). Both sentences were true; the order was wrong,
 * because the phase machine is a pure local typo (fixable by editing one argument)
 * while a broken delivery is a fact about another machine that this process cannot
 * repair.
 *
 * So the three cases below are the ORDER evidence, and they run through the real
 * `Orchestrator.launch`:
 *
 *   1. host + bad phases + FAILING preflight → the PREFLIGHT's error surfaces,
 *      and nothing was spawned;
 *   2. host + bad phases + PASSING preflight → the PHASES error surfaces, and the
 *      preflight was called exactly once. This is the proof of order: phases
 *      cannot have been validated first, or case 2 would have thrown before the
 *      preflight ran (count 0);
 *   3. no host + bad phases → the preflight is not called at all (a local launch
 *      owes no machine anything) and the phases error surfaces.
 *
 * The supervisor is the shared `FakeSupervisor` with the frozen optional
 * `preflightRemoteDelivery` added — the seam contract D7 says a backend may not
 * have, and whose absence must keep every other launch unchanged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import { TerminalSupervisor } from "../../src/supervisor/terminal-supervisor.ts";
import type { HcClient, HcMethod } from "../../src/hc/client.ts";
import type { HostTarget } from "../../src/runs/remote.ts";
import {
	lastDeliveryPreflight,
	resetDeliveryPreflightState,
	type DeliveryPreflightReport,
} from "../../src/runs/cross-machine-preflight.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const HOST = "vps";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "centurion",
		description: "preflight order test role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test centurion.",
		source: "user",
		filePath: "/fake/centurion.md",
		worktree: true,
		...overrides,
	};
}

function target(overrides: Partial<HostTarget> = {}): HostTarget {
	return {
		host: HOST,
		cwd: "/srv/app",
		node: "node",
		piCli: "pi",
		pathMap: [],
		piLegionRoot: "/srv/pi-legion",
		piExtensions: [],
		mirrorRoot: "/srv/.pi-subagents-mirror",
		worktreeRoot: "/srv/.pi-worktrees",
		...overrides,
	};
}

/**
 * The typo from the failure session: `implementing` lists itself as a successor.
 *
 * A `successor`-category problem, i.e. exactly what D1/D3 report — the caller's
 * one-argument fix. Deliberately NOT a shape error that could also be read as
 * "the machine never got built": the point is that a well-formed-but-wrong
 * machine still loses to a broken delivery.
 */
const BAD_PHASES = [
	{ id: "planning", next: [{ to: "implementing" }] },
	{ id: "implementing", next: [{ to: "implementing" }] },
	{ id: "done", terminal: true },
];

/**
 * `FakeSupervisor` + the optional D7 seam, recording every call.
 *
 * Subclassed here rather than added to the shared helper on purpose: absence is a
 * contract feature (every other launch path must keep working without it), so the
 * one suite that needs the seam owns it.
 */
class PreflightSpySupervisor extends FakeSupervisor {
	readonly preflights: Array<{ host: string; target: HostTarget; localRepo: string }> = [];
	private readonly outcome: DeliveryPreflightReport | Error;

	constructor(outcome: DeliveryPreflightReport | Error) {
		super();
		this.outcome = outcome;
	}

	async preflightRemoteDelivery(input: {
		host: string;
		target: HostTarget;
		localRepo: string;
	}): Promise<DeliveryPreflightReport> {
		this.preflights.push(input);
		if (this.outcome instanceof Error) throw this.outcome;
		return this.outcome;
	}
}

function okReport(): DeliveryPreflightReport {
	return { host: HOST, cwd: "/srv/app", at: Date.now(), ok: true, fetch: "ok" };
}

/**
 * The preflight's own refusal, as D5 throws it: `INVALID_PARAMS` with
 * `noModelFallback` (a machine fact must not walk the model chain).
 */
function deliveryFailure(): SubagentError {
	return new SubagentError(
		`cross-machine delivery needs one shared remote: this checkout (/tmp/repo) has no origin. Two ways out: 1) add one and retry — git -C /tmp/repo remote add origin <url>; 2) drop the worktree delivery — dispatch a worker instead.`,
		ErrorCodes.INVALID_PARAMS,
		{ host: HOST, category: "local-origin", noModelFallback: true },
	);
}

function gitRepo(root: string): string {
	const repo = path.join(root, "repo");
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);
	return repo;
}

interface Harness {
	root: string;
	supervisor: PreflightSpySupervisor;
	orchestrator: Orchestrator;
	cleanup(): void;
}

function harness(outcome: DeliveryPreflightReport | Error): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "xm-preflight-order-"));
	const repo = gitRepo(root);
	const supervisor = new PreflightSpySupervisor(outcome);
	return {
		root,
		supervisor,
		orchestrator: new Orchestrator({
			supervisor,
			runDir: path.join(root, "run"),
			cwd: repo,
		}),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Run `body` with the two hc env markers set (so `terminalHostAvailable` is true). */
async function insideHcTerminal(body: () => Promise<void>): Promise<void> {
	const socket = process.env.HC_TERMINAL_SOCKET;
	const id = process.env.HC_TERMINAL_ID;
	process.env.HC_TERMINAL_SOCKET = "/tmp/hc-preflight/default.sock";
	process.env.HC_TERMINAL_ID = "t1k";
	try {
		await body();
	} finally {
		if (socket === undefined) delete process.env.HC_TERMINAL_SOCKET;
		else process.env.HC_TERMINAL_SOCKET = socket;
		if (id === undefined) delete process.env.HC_TERMINAL_ID;
		else process.env.HC_TERMINAL_ID = id;
	}
}

test("D7 order: a failing delivery preflight is reported BEFORE the phases typo, and nothing is spawned", async () => {
	const failure = deliveryFailure();
	const h = harness(failure);
	await insideHcTerminal(async () => {
		try {
			const thrown = await h.orchestrator.launch({
				agent: agent(),
				task: "t",
				host: HOST,
				hostTarget: target(),
				worktree: true,
				phases: BAD_PHASES,
			}).then(
				() => assert.fail("the launch must be refused"),
				(error: unknown) => error,
			);
			// The SAME object the preflight threw: not a re-worded refusal, and not the
			// phases error that used to arrive first.
			assert.equal(thrown, failure, `expected the preflight's own error, got ${String(thrown)}`);
			assert.match((thrown as SubagentError).message, /delivery|origin/);
			assert.doesNotMatch((thrown as SubagentError).message, /invalid phase machine/);
			assert.deepEqual(
				(thrown as SubagentError).details,
				{ host: HOST, category: "local-origin", noModelFallback: true },
			);
			assert.equal(h.supervisor.preflights.length, 1, "the preflight ran exactly once");
			assert.equal(h.supervisor.preflights[0]!.host, HOST);
			assert.equal(h.supervisor.preflights[0]!.target.cwd, "/srv/app");
			assert.equal(h.supervisor.spawns.length, 0, "no child may be spawned after a failed preflight");
			assert.equal(h.supervisor.calls.length, 0, "not even a spawn attempt reached the supervisor");
		} finally {
			h.cleanup();
		}
	});
});

test("D7 order: with a passing preflight the phases typo is reported, and the preflight had already run", async () => {
	const h = harness(okReport());
	await insideHcTerminal(async () => {
		try {
			const thrown = await h.orchestrator.launch({
				agent: agent(),
				task: "t",
				host: HOST,
				hostTarget: target(),
				worktree: true,
				phases: BAD_PHASES,
			}).then(
				() => assert.fail("the launch must be refused"),
				(error: unknown) => error,
			);
			assert.ok(thrown instanceof SubagentError, `expected a SubagentError, got ${String(thrown)}`);
			assert.equal((thrown as SubagentError).code, ErrorCodes.INVALID_PARAMS);
			// The phases typo, named the D3 way (the aggregated machine report).
			assert.match((thrown as SubagentError).message, /invalid phase machine/);
			assert.match((thrown as SubagentError).message, /implementing/);
			// THE ORDER: exactly one preflight ran even though the launch died on phases.
			// Had phases been validated first, this count would be 0 — the launch would
			// have thrown before the preflight was ever asked.
			assert.equal(h.supervisor.preflights.length, 1);
			assert.equal(h.supervisor.spawns.length, 0);
		} finally {
			h.cleanup();
		}
	});
});

test("D7 order: a local launch (no host) never asks the preflight, and still reports the phases typo", async () => {
	const h = harness(okReport());
	try {
		const thrown = await h.orchestrator.launch({
			agent: agent(),
			task: "t",
			worktree: true,
			phases: BAD_PHASES,
		}).then(
			() => assert.fail("the launch must be refused"),
			(error: unknown) => error,
		);
		assert.ok(thrown instanceof SubagentError, `expected a SubagentError, got ${String(thrown)}`);
		assert.match((thrown as SubagentError).message, /invalid phase machine/);
		// A local delivery shares nothing with another machine, so the question is not
		// asked at all — not asked-and-skipped, not asked-and-ignored.
		assert.equal(h.supervisor.preflights.length, 0, "no host ⇒ no preflight");
		assert.equal(h.supervisor.spawns.length, 0);
	} finally {
		h.cleanup();
	}
});

// ── the two supervisor branches the preflight is routed through (D7) ────────
//
// The orchestrator talks to `LegionSupervisor`. The seam is optional, so there are
// exactly two live paths: a backend that can ask (terminal → the D5 module) and a
// facade that cannot (routing without a terminal backend → name the missing host).
// Both are pinned here because a silent skip on either would restore the original
// bug — a launch that reaches the remote setup without the delivery being checked.

/** `hc` answers stdout/stderr base64-encoded; the preflight decodes them. */
function b64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

/**
 * A recorded `hc` core that answers exactly the five questions D5 step 1–8 ask.
 *
 * The URL is a plain `https://` one on both sides on purpose: a `git@host:` remote
 * would be rewritten by whatever `url.<base>.insteadOf` the machine running the
 * suite happens to have, and this test is about the ORDER of questions, not about
 * the operator's git config.
 */
const SHARED_ORIGIN = "https://example.com/acme/app.git";
class FakePreflightCore implements HcClient {
	readonly execs: string[][] = [];
	started = 0;

	async start(): Promise<void> {
		this.started += 1;
	}

	async request<T = unknown>(method: HcMethod, params: Readonly<Record<string, unknown>> = {}): Promise<T> {
		const argv = Array.isArray(params.argv) ? params.argv.map(String) : [];
		this.execs.push(argv);
		const answered: Record<string, unknown> = {
			"test -d /srv/app": { code: 0, stdout: "" },
			"git --version": { code: 0, stdout: b64("git version 2.43.0\n") },
			"git -C /srv/app rev-parse --git-dir": { code: 0, stdout: b64(".git\n") },
			"git -C /srv/app remote get-url origin": { code: 0, stdout: b64(`${SHARED_ORIGIN}\n`) },
			"git -C /srv/app ls-remote origin": { code: 0, stdout: "" },
		};
		const key = argv.join(" ");
		if (key in answered) return answered[key] as T;
		throw new Error(`fake core: unexpected ${method} ${JSON.stringify(params)}`);
	}

	close(): void {}
}

function repoWithOrigin(root: string): string {
	const repo = gitRepo(root);
	execFileSync("git", ["-C", repo, "remote", "add", "origin", SHARED_ORIGIN]);
	return repo;
}

test("D7 wiring: the routing facade delegates to its terminal backend, which runs the D5 preflight", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "xm-route-preflight-"));
	const core = new FakePreflightCore();
	const routing = new RoutingSupervisor({
		terminal: new TerminalSupervisor({ clientFactory: () => core }),
	});
	resetDeliveryPreflightState();
	try {
		const report = await routing.preflightRemoteDelivery!({
			host: HOST,
			target: target(),
			localRepo: repoWithOrigin(root),
		});
		assert.equal(report.ok, true);
		assert.equal(report.host, HOST);
		assert.equal(report.fetch, "ok");
		assert.equal(core.started, 1, "the hc client is started once, exactly as a spawn would");
		// The five REMOTE questions of D5's eight steps, in order (steps 1 and 2 ask
		// this machine) — the real module, not a stand-in.
		assert.deepEqual(core.execs.map((argv) => argv.join(" ")), [
			"test -d /srv/app",
			"git --version",
			"git -C /srv/app rev-parse --git-dir",
			"git -C /srv/app remote get-url origin",
			"git -C /srv/app ls-remote origin",
		]);
		// …and the outcome is what `/legion doctor` reads afterwards.
		assert.equal(lastDeliveryPreflight()?.host, HOST);
		assert.equal(lastDeliveryPreflight()?.ok, true);
	} finally {
		resetDeliveryPreflightState();
		rmSync(root, { recursive: true, force: true });
	}
});

test("D7 wiring: a facade without a terminal backend refuses by name instead of skipping the check", async () => {
	const routing = new RoutingSupervisor({});
	await assert.rejects(
		() => routing.preflightRemoteDelivery!({ host: HOST, target: target(), localRepo: "/tmp/repo" }),
		(error: unknown) => {
			assert.ok(error instanceof SubagentError, `expected a SubagentError, got ${String(error)}`);
			assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
			assert.match((error as SubagentError).message, /host 'vps' needs an hc terminal host/);
			return true;
		},
	);
});
