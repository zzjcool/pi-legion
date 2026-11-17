/**
 * Cross-machine spawn — host primitives (contract:
 * `docs/contracts/cross-machine-spawn-v1.md`, frozen).
 *
 * S0 lays down the skeleton only: three pure functions, no side effects, no
 * wiring. Everything that reaches a socket (`machine.exec`, `file.read`,
 * `file.write`, origin checks) lands in a later stage and will live NEXT TO
 * these helpers, never inside them — the decisions below are the ones every
 * other host-aware call site has to agree on, so they are isolated here and
 * covered by unit tests.
 *
 * Naming (D2): legion speaks `host`; the `hc` wire parameter is `on` and the
 * mapping exists in exactly one place (`terminal-supervisor.ts`). `machine` is
 * already taken by the phase machine and must not be reused for a hostname.
 */

import { ErrorCodes, SubagentError } from "../shared/types.ts";

/**
 * The ONE host predicate (D5).
 *
 * Absent, `null`, a non-string, an empty string and a whitespace-only string
 * all mean "this host" — the same meaning as a `run.json` / `nodes` row written
 * before the field existed. Every host decision must come through here: a
 * second `value?.trim() || undefined` elsewhere is how "absent = local" starts
 * drifting between call sites.
 */
export function normalizeHost(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const host = value.trim();
	return host.length > 0 ? host : undefined;
}

/**
 * The address `hc` accepts for a child's terminal (§3.6).
 *
 * A local child is addressed by its bare name, exactly as before, so the whole
 * existing call shape is unchanged when `host` is absent. A remote child is
 * addressed as `machine/terminal` — the form `hc`'s own schema documents for
 * `terminal.get`/`send`/`kill`/`rm` and the only unambiguous one once two
 * machines both hold an `lgl-…` terminal.
 */
export function terminalAddress(record: { terminalName: string; host?: string }): string {
	const host = normalizeHost(record.host);
	return host ? `${host}/${record.terminalName}` : record.terminalName;
}

/**
 * Refuse a local filesystem/git operation on a worktree that another machine
 * owns (D13, R1).
 *
 * `worktreePath` on a cross-machine child is a path ON `worktreeHost`; running
 * `existsSync`, `git -C`, `rm -rf` or a verify command against it locally is the
 * one failure in this design that destroys data instead of failing loudly —
 * the path may exist here and mean something else. There is no downgrade: the
 * caller either has an owner-local worktree or it has no business touching it.
 *
 * A record with no path has nothing to guard, so that case returns: the guard
 * protects a path, not the mere presence of a host.
 */
export function assertLocalWorktree(record: { worktreePath?: string; worktreeHost?: string }): void {
	const host = normalizeHost(record.worktreeHost);
	if (!host) return;
	const worktreePath = typeof record.worktreePath === "string" ? record.worktreePath.trim() : "";
	if (!worktreePath) return;
	throw new SubagentError(
		`worktree '${worktreePath}' belongs to host '${host}': local filesystem and git operations on it are refused (a remote path may exist on this machine and mean something else; deliver through the shared git remote instead)`,
		ErrorCodes.INVALID_PARAMS,
		{ host, worktreePath },
	);
}
