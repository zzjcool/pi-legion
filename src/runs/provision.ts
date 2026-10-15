/**
 * Post-create provisioning for child worktrees.
 *
 * A fresh `git worktree add` is a bare checkout: no `node_modules`, no
 * language-specific dependency state. Children then spend turns (observed
 * in the wild: repeated ln -s / unlink dances) recreating the environment
 * before they can run the project's own verifier — and plugin-run verify
 * commands would fail red for the wrong reason.
 *
 * `worktreeBootstrap` (legion settings) declares how to prepare the tree:
 *   - "npm-install": run the repo's own install command if a package
 *     manager manifest is present (npm ci / npm install fallback).
 *   - any other non-empty string: an arbitrary shell command, run with
 *     bash -lc in the worktree cwd (e.g. "pnpm install --frozen-lockfile",
 *     "ln -sfn ../../node_modules ./node_modules").
 *
 * Idempotency: a marker file (`.pi-provisioned`, JSON with the applied mode)
 * makes provisioning a no-op on resume of the same worktree. Failure throws
 * SubagentError; the orchestrator's existing launch rollback removes the
 * whole worktree, so provisioning never leaves a half-prepared tree behind.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ErrorCodes, SubagentError } from "../shared/types.ts";

export const PROVISION_MARKER = ".pi-provisioned";

export const BOOTSTRAP_MODE_INSTALL = "npm-install";

export interface ProvisionResult {
	/** Mode actually applied, or "skip" when the marker was already present. */
	applied: string;
}

export function provisionMarkerPath(worktreePath: string): string {
	return path.join(worktreePath, PROVISION_MARKER);
}

function readMarker(worktreePath: string): { mode?: string } | null {
	try {
		return JSON.parse(
			fs.readFileSync(provisionMarkerPath(worktreePath), "utf8"),
		) as { mode?: string };
	} catch {
		return null;
	}
}

function writeMarker(worktreePath: string, mode: string): void {
	const file = provisionMarkerPath(worktreePath);
	const payload = JSON.stringify({ mode, at: new Date().toISOString() });
	// Atomic tmp+rename (same shape as the RunStore): a partial marker would
	// let a later resume skip provisioning on a half-prepared tree.
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, payload, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** Repo-relative manifests, in resolution order, for the npm-install mode.
 *
 * The bare package.json fallback was removed: a package.json without any
 * lockfile is far more often a non-npm repo caught by mistake (Java/Maven
 * repos carry stray package.json files for docs/tooling) than a real npm
 * project (which always has a lockfile). Without a lockfile we skip
 * provisioning instead of firing npm install into a Java checkout. */
function installCommandFor(worktreePath: string): string | null {
	if (fs.existsSync(path.join(worktreePath, "pnpm-lock.yaml"))) {
		return "pnpm install --frozen-lockfile";
	}
	if (fs.existsSync(path.join(worktreePath, "bun.lockb"))) {
		return "bun install --frozen-lockfile";
	}
	if (fs.existsSync(path.join(worktreePath, "yarn.lock"))) {
		return "yarn install --frozen-lockfile";
	}
	if (fs.existsSync(path.join(worktreePath, "package-lock.json"))) {
		return "npm ci";
	}
	return null;
}

function shellEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.npm_config_prefix;
	return env;
}

function resolveCommand(mode: string, worktreePath: string): string | null {
	if (mode === BOOTSTRAP_MODE_INSTALL) return installCommandFor(worktreePath);
	const trimmed = mode.trim();
	return trimmed ? trimmed : null;
}

/**
 * Prepare a freshly created worktree according to `mode`.
 * A missing/blank mode is a no-op (provisioning is opt-in); so is a marker
 * from a previous provisioning pass, so resume never re-installs.
 */
export function provisionWorktree(opts: {
	worktreePath: string;
	mode?: string;
	timeoutMs?: number;
}): ProvisionResult {
	const mode = (opts.mode ?? "").trim();
	if (!mode) return { applied: "skip" };
	const marker = readMarker(opts.worktreePath);
	if (marker?.mode === mode) return { applied: "skip" };

	const command = resolveCommand(mode, opts.worktreePath);
	// npm-install with no manifest: a repo with nothing to install is
	// provisioned by definition — record the marker and move on.
	if (!command) {
		writeMarker(opts.worktreePath, mode);
		return { applied: mode };
	}

	try {
		execFileSync("bash", ["-lc", command], {
			cwd: opts.worktreePath,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: opts.timeoutMs ?? 600_000,
			// npm lifecycle scripts export npm_config_prefix. A login shell
			// that sources nvm then refuses to start and `npm` disappears
			// from PATH. Local installs do not need that prefix.
			env: shellEnv(),
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new SubagentError(
			`worktree bootstrap failed (${mode}): ${detail.slice(0, 500)}`,
			ErrorCodes.START_FAILED,
		);
	}
	writeMarker(opts.worktreePath, mode);
	return { applied: mode };
}
