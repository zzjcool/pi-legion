/**
 * Command runner: spawns the `herdr` binary and captures stdout/stderr.
 *
 * Measured constraint (F21): herdr prints SUCCESS payloads on stdout but
 * ERROR payloads on STDERR. Both must be parsed, or errors look like
 * empty responses.
 */

import { spawn } from "node:child_process";
import { createCappedOutput, resolveMaxOutputBytes } from "../../shared/output-cap.ts";
import type { CommandRunner } from "./types.ts";

const HERDR_BIN_ENV = "HERDR_BIN";
const HERDR_BIN_PATH_ENV = "HERDR_BIN_PATH";

export function resolveHerdrBin(env: NodeJS.ProcessEnv = process.env): string {
	return env[HERDR_BIN_ENV] || env[HERDR_BIN_PATH_ENV] || "herdr";
}

export interface RunnerOptions {
	bin?: string;
	env?: NodeJS.ProcessEnv;
	/** Default timeout applied when a call does not specify one. */
	defaultTimeoutMs?: number;
}

/**
 * Create the default runner that shells out to herdr.
 * Errors are surfaced as a non-zero `code` plus whatever text was produced;
 * the caller (parseHerdrResponse) turns that into a structured HerdrError.
 */
export function createCommandRunner(
	options: RunnerOptions = {},
): CommandRunner {
	const bin = options.bin ?? resolveHerdrBin();
	const baseEnv = options.env ?? process.env;

	return (args, opts = {}) =>
		new Promise((resolve) => {
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(bin, args, {
					shell: false,
					windowsHide: true,
					env: { ...baseEnv, ...(opts.env ?? {}) },
				});
			} catch (cause) {
				resolve({ stdout: "", stderr: String(cause), code: -1 });
				return;
			}

			const cap = resolveMaxOutputBytes(baseEnv);
			const killOnOverflow = () => {
				child.stdout?.destroy();
				child.stderr?.destroy();
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			};
			const out = createCappedOutput(cap, killOnOverflow);
			const err = createCappedOutput(cap, killOnOverflow);
			let extraStderr = "";
			let settled = false;
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				const overflowed = out.truncated || err.truncated;
				resolve({ stdout: out.text(), stderr: `${err.text()}${extraStderr}`, code: overflowed && code === 0 ? -3 : code });
			};

			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeoutMs = opts.timeoutMs ?? options.defaultTimeoutMs;
			if (timeoutMs && timeoutMs > 0) {
				timer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already gone */
					}
					extraStderr += `\n[timeout after ${timeoutMs}ms]`;
					finish(-2);
				}, timeoutMs);
				timer.unref?.();
			}

			child.stdout?.on("data", (chunk) => {
				out.push(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				err.push(chunk);
			});
			child.on("error", (e) => {
				extraStderr += String(e);
				finish(-1);
			});
			child.on("close", (code) => finish(code ?? 0));
		});
}
