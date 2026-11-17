/**
 * Remote verify (contract `cross-machine-spawn-v1` D14, S3): run a launcher's
 * `verify:` command ON the machine the child worked on.
 *
 * Why this module exists rather than a flag on the local runner: the acceptance
 * chain (`applyVerification`) decides pass/fail from a `CommandResult`, and the
 * one thing that must never happen is a machine failure being recorded as a CODE
 * failure. A `rejected` verdict says "the child's work does not pass"; if the
 * machine was unreachable, that sentence is a fabrication about somebody else's
 * work. So this module answers with a classified result and `applyVerification`
 * turns every non-`code` class into `unknown`, never `rejected`.
 *
 * The channel is `machine.exec{on}`. The spike measured two facts it relies on:
 * the core's `timeout` genuinely kills the process (so a timeout is a real
 * deadline, not an abandoned promise), and `stdout`/`stderr` arrive BASE64.
 * `hc` caps `timeout` at 600 s, so a larger budget is clamped HERE and announced
 * — silently shortening a verify budget would be a deadline the operator never
 * agreed to.
 */

import { HcRpcError, hcCliClient, type HcClient } from "../hc/client.ts";
import { raceWithTimeout } from "../supervisor/race-timeout.ts";
import type { CrossMachineSettings } from "../shared/types.ts";
import type { CommandResult } from "./acceptance.ts";
import { execResultText, resolveHostTarget, type HcExecResult, type HostTarget } from "./remote.ts";

/** `hc`'s own ceiling for `machine.exec.timeout` (seconds). */
export const REMOTE_EXEC_TIMEOUT_CEILING_S = 600;

/**
 * How long past the core's own deadline this side waits before answering
 * `timeout` itself. The core kills the process at `seconds` and reports
 * `timed_out`; the slack only covers transport. A race that fires FIRST means the
 * core never answered — the verdict says timeout, and the reason says so.
 */
export const REMOTE_VERIFY_TIMEOUT_SLACK_MS = 5_000;

/** Why a remote verify did not produce a pass/fail code. */
export type RemoteVerifyFailure = "code" | "timeout" | "unreachable" | "unknown-host";

const TIMED_OUT = Symbol("remote-verify-timeout");

/**
 * The budget `machine.exec` will actually be given.
 *
 * `timeoutMs <= 0`/non-finite falls back to the ceiling (the local runner does
 * the same with its default). `clamped` is the announcement flag: the caller
 * writes it into the verdict and to stderr, so nobody wonders why a 30-minute
 * suite died at ten.
 */
export function clampRemoteVerifyTimeout(timeoutMs: number): { seconds: number; clamped: boolean } {
	const wanted = Number.isFinite(timeoutMs) && timeoutMs > 0
		? Math.ceil(timeoutMs / 1000)
		: REMOTE_EXEC_TIMEOUT_CEILING_S;
	const seconds = Math.min(Math.max(1, wanted), REMOTE_EXEC_TIMEOUT_CEILING_S);
	return { seconds, clamped: wanted > REMOTE_EXEC_TIMEOUT_CEILING_S };
}

/** BASE64 → utf8, tolerating a field the core omitted entirely. */
function decoded(value: string | undefined): string {
	if (typeof value !== "string" || value.length === 0) return "";
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		// A core that answers plain text is not worth failing a verification over.
		return value;
	}
}

/** A non-`code` answer, in the one shape `applyVerification` understands. */
function unavailable(
	target: HostTarget,
	failure: Exclude<RemoteVerifyFailure, "code">,
	detail: string,
	output: { stdout?: string; stderr?: string } = {},
): CommandResult {
	return {
		// 1, not 0: nothing about this result may read as success anywhere that only
		// looks at the code. `failure` is what decides the verdict.
		code: 1,
		stdout: output.stdout ?? "",
		stderr: output.stderr ?? "",
		failure,
		failureDetail: detail,
		host: target.host,
	};
}

/**
 * One `verify:` command on `target`, classified.
 *
 * Never throws: `applyVerification` has no try/catch around the runner (a local
 * runner failing to spawn IS a code failure), so a throw here would abort the
 * whole collect. Every outcome becomes a `CommandResult`.
 */
export async function remoteVerifyCommand(opts: {
	client: HcClient;
	target: HostTarget;
	command: string;
	/** Directory on THAT machine; absent = the target's checkout. */
	cwd?: string;
	timeoutMs: number;
}): Promise<CommandResult> {
	const { client, target, command } = opts;
	const cwd = typeof opts.cwd === "string" && opts.cwd.length > 0 ? opts.cwd : target.cwd;
	const { seconds, clamped } = clampRemoteVerifyTimeout(opts.timeoutMs);
	if (clamped) {
		// D14: "clamped explicitly and announced". The log header is the verdict, and
		// this is the run-time half of the same announcement.
		process.stderr.write(
			`[pi-legion] verify on host '${target.host}': timeout ${opts.timeoutMs}ms clamped to ${seconds}s (hc's machine.exec ceiling)\n`,
		);
	}

	// Spike constraint 4: an exec with a missing cwd cannot say which part failed.
	// Ask the directory question on its own first, exactly like the launch preflight.
	let directoryExists: boolean;
	try {
		const probe = await client.request<HcExecResult>("machine.exec", {
			on: target.host,
			argv: ["test", "-d", cwd],
			timeout: 10,
		});
		directoryExists = probe?.code === 0;
	} catch (error) {
		return classifyThrown(target, error, `could not ask ${target.host} for ${cwd}`);
	}
	if (!directoryExists) {
		return unavailable(
			target,
			"unreachable",
			`${cwd} does not exist on ${target.host} (the worktree may have been removed there; nothing was verified)`,
		);
	}

	let result: HcExecResult | typeof TIMED_OUT;
	try {
		const work = client.request<HcExecResult>("machine.exec", {
			on: target.host,
			line: command,
			cwd,
			timeout: seconds,
		});
		result = await raceWithTimeout<HcExecResult | typeof TIMED_OUT>(
			work,
			seconds * 1000 + REMOTE_VERIFY_TIMEOUT_SLACK_MS,
			() => TIMED_OUT,
		);
	} catch (error) {
		return classifyThrown(target, error, `verify \`${command}\` could not start on ${target.host}`);
	}

	if (result === TIMED_OUT) {
		return unavailable(
			target,
			"timeout",
			`${target.host} did not answer within ${seconds}s + ${REMOTE_VERIFY_TIMEOUT_SLACK_MS / 1000}s (the command may still be running there)`,
		);
	}

	const exec = result as HcExecResult;
	const stdout = decoded(exec?.stdout);
	const stderr = decoded(exec?.stderr);
	if (exec?.timed_out === true) {
		return unavailable(
			target,
			"timeout",
			`sleep longer than ${seconds}s: ${target.host} killed the command at the machine.exec deadline`,
			{ stdout, stderr },
		);
	}
	const code = typeof exec?.code === "number" ? exec.code : null;
	if (code === null) {
		return unavailable(
			target,
			"unreachable",
			`${target.host} returned no exit code for \`${command}\` (${execResultText(exec) || "no output"})`,
			{ stdout, stderr },
		);
	}
	return {
		code,
		stdout,
		stderr,
		// `code` is a real answer from that machine: pass/fail is now the child's work.
		failure: code === 0 ? undefined : "code",
		host: target.host,
		...(clamped ? { failureDetail: `timeout clamped to ${seconds}s (hc ceiling)` } : {}),
	};
}

/** One thrown request → the class it belongs to (never `code`). */
function classifyThrown(target: HostTarget, error: unknown, context: string): CommandResult {
	if (error instanceof HcRpcError && error.kind === "machine_unknown") {
		return unavailable(
			target,
			"unknown-host",
			`${target.host} is not a machine this core knows (machine_unknown: ${error.message}); nothing was verified`,
		);
	}
	const described = error instanceof HcRpcError
		? `${error.kind}: ${error.message}`
		: error instanceof Error
			? error.message
			: String(error);
	return unavailable(target, "unreachable", `${context}: ${described}`);
}

/** What the orchestrator hands a remote child's verify step. */
export interface RemoteVerifyRequest {
	host: string;
	command: string;
	/** Directory on that machine; absent = the configured checkout. */
	cwd?: string;
	timeoutMs: number;
}

export type RemoteVerifyRunner = (request: RemoteVerifyRequest) => Promise<CommandResult>;

/**
 * The runner the orchestrator calls for a child that ran elsewhere.
 *
 * One `hc` client per CALL, closed in `finally`: a verify can run for minutes, so a
 * connection is free relative to it, and a cached client would need a lifecycle
 * this layer does not own (a collect has no shutdown hook — a cache here would leak
 * one socket per remote collect). `resolveHostTarget` is the same resolver the
 * launch used, so the cwd/programs the verify sees are the ones the child was
 * started with — not a second interpretation of the same settings.
 */
export function createRemoteVerifyRunner(opts: {
	crossMachine: CrossMachineSettings | undefined;
	clientFactory?: () => HcClient;
}): RemoteVerifyRunner {
	return async (request: RemoteVerifyRequest): Promise<CommandResult> => {
		let target: HostTarget;
		try {
			target = resolveHostTarget(request.host, opts.crossMachine);
		} catch (error) {
			// A host that is not configured is not a machine failure: say which.
			return {
				code: 1,
				stdout: "",
				stderr: "",
				failure: "unknown-host",
				failureDetail: error instanceof Error ? error.message : String(error),
				host: request.host,
			};
		}
		const client = opts.clientFactory ? opts.clientFactory() : defaultClientFactory();
		try {
			await client.start();
		} catch (error) {
			return {
				code: 1,
				stdout: "",
				stderr: "",
				failure: "unreachable",
				failureDetail: `cannot reach the hc core: ${error instanceof Error ? error.message : String(error)}`,
				host: request.host,
			};
		}
		try {
			return await remoteVerifyCommand({
				client,
				target,
				command: request.command,
				...(request.cwd ? { cwd: request.cwd } : {}),
				timeoutMs: request.timeoutMs,
			});
		} finally {
			try {
				client.close();
			} catch {
				/* closing a socket is not a verdict */
			}
		}
	};
}

/** The production client, constructed lazily by the runner (never at import time). */
function defaultClientFactory(): HcClient {
	return hcCliClient({ env: process.env });
}
