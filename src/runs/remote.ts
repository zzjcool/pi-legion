/**
 * Cross-machine spawn — host primitives (contract:
 * `docs/contracts/cross-machine-spawn-v1.md`, frozen).
 *
 * S0 laid down the skeleton (three pure predicates). S1 adds the target
 * resolution plus a THIN transport layer (`machine.exec` / `file.write`
 * wrappers) that lives next to them, never inside them — the decisions below
 * are the ones every other host-aware call site has to agree on, so they are
 * isolated here and covered by unit tests. Everything in this file is either a
 * pure function or one `client.request` round trip; no sockets, no processes.
 *
 * Naming (D2): legion speaks `host`; the `hc` wire parameter is `on` and the
 * mapping exists in exactly one place (`terminal-supervisor.ts`). `machine` is
 * already taken by the phase machine and must not be reused for a hostname.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HcRpcError, type HcClient } from "../hc/client.ts";
import {
	ErrorCodes,
	SubagentError,
	type SubagentsSettings,
} from "../shared/types.ts";

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
 * Map ONE argv element onto the target machine, or refuse (D6).
 *
 * Three answers, and the third is the point:
 *
 *   - a relative element (a flag value, a model id, a bare program name) is
 *     returned untouched;
 *   - a path already inside `remoteDir` was rewritten by the args builder and
 *     is returned untouched (idempotent, so the sweep cannot double-map);
 *   - a path under a configured `pathMap` prefix is re-rooted onto that entry's
 *     remote prefix (longest prefix first): this is how `-e <plugin>/index.ts`
 *     reaches the same content on the other machine;
 *   - a path inside THIS checkout is re-rooted onto `remoteCwd`: the git-remote
 *     delivery model says both machines hold the same content at their own
 *     root, so `<localCwd>/agents/x.md` is `<remoteCwd>/agents/x.md` there;
 *   - anything else is REFUSED by name. `-e <plugin install>/index.ts` and
 *     `--skill <abs path>` are files that are neither in the checkout nor
 *     mirrored into `remoteDir`, so rewriting them — which the first version did,
 *     by basename — hands the remote child a path to nothing. Refusing is the
 *     D6 rule ("cannot rewrite ⇒ do not start"), and the message names the fix.
 */
export function mapRemoteArgPath(opts: {
	arg: string;
	host: string;
	/** The target's checkout root (remote absolute, posix). */
	remoteCwd: string;
	/** Where this launch's mirrored files live (remote absolute, posix). */
	remoteDir: string;
	/** This machine's checkout root for the same repository. */
	localCwd: string;
	/** Prefix translations from `hosts.<host>.pathMap`, longest first. */
	pathMap?: readonly HostPathMapEntry[];
}): string {
	const { arg, host, remoteCwd, remoteDir, localCwd, pathMap = [] } = opts;
	if (!path.isAbsolute(arg)) return arg;
	if (isInsidePosix(remoteDir, arg)) return arg;
	for (const entry of pathMap) {
		if (!isInsideFsPath(entry.from, arg)) continue;
		const relative = path.relative(path.resolve(entry.from), path.resolve(arg)).split(path.sep).join("/");
		return path.posix.join(entry.to, relative);
	}
	if (isInsideFsPath(localCwd, arg)) {
		const relative = path.relative(path.resolve(localCwd), path.resolve(arg)).split(path.sep).join("/");
		return path.posix.join(remoteCwd, relative);
	}
	throw new SubagentError(
		`host '${host}': argv references '${arg}', which is neither in this checkout nor under a configured pathMap entry, so it cannot be mapped to that machine (add { "${arg.split(path.sep).slice(0, 2).join(path.sep)}": "/abs/path/on/${host}" } to subagents.crossMachine.hosts.${host}.pathMap, or drop the flag)`,
		ErrorCodes.INVALID_PARAMS,
		{ host, arg },
	);
}

/** POSIX "is `candidate` at or under `root`", both already absolute. */
function isInsidePosix(root: string, candidate: string): boolean {
	const rel = path.posix.relative(path.posix.resolve(root), path.posix.resolve(candidate));
	return rel === "" || (!rel.startsWith("..") && !path.posix.isAbsolute(rel));
}

/** The same question for paths produced by THIS machine's `path` rules. */
function isInsideFsPath(root: string, candidate: string): boolean {
	const rel = path.relative(path.resolve(root), path.resolve(candidate));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
export function assertLocalWorktree(record: { worktreePath?: string | null; worktreeHost?: string | null }): void {
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

/**
 * The worktree path of a record, but only when it is a LOCAL one (D5/D13).
 *
 * This is the pair-decides rule in one place: `worktreeHost` absent/blank means
 * this host (`normalizeHost`), so an old record's path is returned untouched —
 * which is what makes a pre-v4 `run.json`/`nodes` row resume exactly as before.
 * A pair that DOES name a host has no local path at all: the path is either on
 * another machine (nothing to hand to `loadCatalog`/`fs`/`git` here) or, worse, it
 * exists here and means something else — and `assertLocalWorktree` refuses that
 * spelling rather than letting a caller treat it as a local directory.
 */
export function localWorktreePath(record: {
	worktreePath?: string | null;
	worktreeHost?: string | null;
}): string | undefined {
	const host = normalizeHost(record.worktreeHost);
	if (host !== undefined) {
		// Throws for a (host, path) pair: see the doc comment. A host with no path
		// guards nothing and answers "no local path".
		assertLocalWorktree({ worktreePath: record.worktreePath, worktreeHost: host });
		return undefined;
	}
	return record.worktreePath ?? undefined;
}

/**
 * The LOCAL `cwd` a resume must work in (contract D5/D13/D17).
 *
 * This is the whole decision, in one place, because it is the one place a stored
 * `(host, path)` pair could become a path this machine reads:
 *
 *   - the child's own pair wins when it is local (`worktreeHost` absent — which is
 *     every record written before v4, so an old run.json + old nodes row resolves
 *     exactly as it always did);
 *   - a child whose tree is on another machine contributes NO local path, and the
 *     next candidate answers. Its tree's existence is checked later, on THAT
 *     machine, by `remotePathIsDirectory` (never here: `existsSync` on a remote
 *     spelling is the failure that destroys work);
 *   - the parent's tree is a pair too, and a REMOTE one is refused by
 *     `localWorktreePath` rather than silently resolved against this filesystem.
 *
 * `??`, not `||`: an empty parent-run cwd still wins, exactly as before.
 */
export function resolveResumeCwd(input: {
	saved: { worktreePath?: string | null; worktreeHost?: string | null };
	node: { worktreePath?: string | null; worktreeHost?: string | null };
	parent: { worktreePath?: string | null; worktreeHost?: string | null };
	parentRunCwd?: string | null;
	fallbackCwd: string;
}): string {
	const remoteWorktreeHost = normalizeHost(input.saved.worktreeHost ?? input.node.worktreeHost);
	const storedWorktreePath = input.saved.worktreePath ?? input.node.worktreePath;
	const parentCwd = localWorktreePath({
		worktreePath: input.parent.worktreePath,
		worktreeHost: input.parent.worktreeHost,
	});
	return (remoteWorktreeHost ? undefined : storedWorktreePath) ?? parentCwd ?? input.parentRunCwd ?? input.fallbackCwd;
}

// ── S1: the resolved target ────────────────────────────────────────────────

/** Directory (on the target machine) that holds a run's mirrored temp files. */
export const REMOTE_DIR_NAME = ".pi-subagents-remote";

/** The mirrored-file directory, a sibling of the worktree root (review M4). */
export const REMOTE_MIRROR_DIR_NAME = ".pi-subagents-mirror";

/**
 * `file.write`'s ceiling in `hc` (bytes of the DECODED payload). A file above
 * it is refused, never truncated: a half-written system prompt or session is a
 * child that misbehaves for reasons nobody can see (S1 risk note).
 */
export const MAX_REMOTE_FILE_BYTES = 8 * 1024 * 1024;

/** One local-prefix-to-remote-prefix translation (D6). */
export interface HostPathMapEntry {
	/** Absolute prefix on THIS machine. */
	from: string;
	/** Absolute prefix the same content has on the target. */
	to: string;
}

/** Everything a remote launch needs to know, already resolved from settings. */
export interface HostTarget {
	/** `hc machine ls` name — the value that travels as `on` (D2). */
	host: string;
	/** Absolute path ON that machine; never translated from this one (D6/D13). */
	cwd: string;
	/** Remote interpreter (`node` by default), resolved on that machine's PATH. */
	node: string;
	/** Remote CLI (`pi` by default), resolved on that machine's PATH. */
	piCli: string;
	/** Prefix translations for argv paths outside the checkout, longest first. */
	pathMap: HostPathMapEntry[];
	/**
	 * Where this package lives on that machine (review M2).
	 *
	 * `buildPiArgs` puts this package's extension entry into EVERY child's argv, so
	 * a remote launch always names one absolute path over there. The identity
	 * default ("same path as here") is a guess, and a guess that is wrong either
	 * fails at `pi` start-up or, worse, runs a child without the guard extension.
	 * The preflight therefore `test -f`s this file and names it when missing.
	 */
	piLegionRoot: string;
	/**
	 * Directory (on that machine) holding this launch's mirrored argv files.
	 *
	 * Beside the worktree root, never inside the checkout: a mirrored file in the
	 * checkout would land in the child's `git status` and could be committed into
	 * the delivered branch (review M4).
	 */
	mirrorRoot: string;
	/**
	 * Directory (absolute, posix, ON that machine) that holds remote child
	 * worktrees (contract D11/D12).
	 *
	 * Resolved here, once, from `hosts.<host>.worktreeRoot` (default:
	 * `dirname(cwd)/.pi-worktrees`), so no call site ever has to invent a remote
	 * path. It is a SIBLING of the checkout on purpose: a tree inside it would be
	 * seen by the nested-worktree probe (`isInsideChildWorktree`) as "already in a
	 * child worktree" and suppress the worktree its centurion asked for.
	 */
	worktreeRoot: string;
}

/** Defaults for the two programs, both resolved on the REMOTE machine. */
export const DEFAULT_REMOTE_NODE = "node";
export const DEFAULT_REMOTE_PI = "pi";

/**
 * Directory name (under `dirname(cwd)`) that holds remote child worktrees.
 *
 * `worktrees` is the local name too (`worktreePathFor` → `<runDir>/worktrees/<name>`),
 * but this is deliberately NOT under `cwd`: a remote tree inside the checkout would
 * be inside the repo the child commits to, adding its files to that repo's status.
 */
export const REMOTE_WORKTREE_DIR = ".pi-worktrees";

/**
 * Turn `subagents.crossMachine` + a host name into the five facts a remote
 * launch needs, or refuse with the one thing that is actually missing.
 *
 * Refusing is the whole point of this function (D1): a launch that names a host
 * can never fall back to this machine — a child that ran here while the caller
 * believed it ran elsewhere is the worst possible answer — and it can never
 * guess a remote cwd, because guessing is how a remote child lands in the wrong
 * directory (D6/D13).
 *
 * The three messages name the host, the setting and the value to write, because
 * the caller reading them is the one who can fix the settings file.
 */
export function resolveHostTarget(
	host: string,
	config: SubagentsSettings["crossMachine"] | undefined,
): HostTarget {
	const name = normalizeHost(host);
	if (name === undefined) {
		throw new SubagentError(
			"cross-machine launch needs a host name; omit `host` to run on this machine",
			ErrorCodes.INVALID_PARAMS,
		);
	}
	if (config?.enabled !== true) {
		throw new SubagentError(
			`host '${name}' needs subagents.crossMachine.enabled = true`,
			ErrorCodes.INVALID_PARAMS,
			{ host: name },
		);
	}
	const entry = config.hosts?.[name];
	if (entry === undefined) {
		throw new SubagentError(
			`host '${name}' has no entry in subagents.crossMachine.hosts (add { "cwd": "/abs/path/on/${name}" })`,
			ErrorCodes.INVALID_PARAMS,
			{ host: name },
		);
	}
	// The path must be absolute AND a path on that machine. `path.isAbsolute`
	// answers for the POSIX shape `hc` uses, and a relative value here is always
	// a mistake: it would silently resolve against the remote core's home.
	const cwd = typeof entry.cwd === "string" ? entry.cwd.trim() : "";
	if (cwd.length === 0 || !path.posix.isAbsolute(cwd)) {
		throw new SubagentError(
			`host '${name}' needs an absolute cwd in subagents.crossMachine.hosts.${name}.cwd (remote paths are not translated from this machine)`,
			ErrorCodes.INVALID_PARAMS,
			{ host: name, cwd },
		);
	}
	return {
		host: name,
		cwd,
		node: nonEmpty(entry.node) ?? DEFAULT_REMOTE_NODE,
		piCli: nonEmpty(entry.piCli) ?? DEFAULT_REMOTE_PI,
		pathMap: resolvePathMap(name, entry.pathMap, entry.piLegionRoot),
		piLegionRoot: typeof entry.piLegionRoot === "string" && entry.piLegionRoot.trim().length > 0
			? entry.piLegionRoot.trim()
			: thisPackageRoot(),
		mirrorRoot: path.posix.join(
			path.posix.dirname(resolveWorktreeRoot(name, cwd, entry.worktreeRoot)),
			REMOTE_MIRROR_DIR_NAME,
		),
		worktreeRoot: resolveWorktreeRoot(name, cwd, entry.worktreeRoot),
	};
}

/**
 * Where that machine keeps remote child worktrees (`src/runs/remote-worktree.ts`).
 *
 * Default `dirname(cwd)/.pi-worktrees` keeps the tree beside the checkout instead
 * of inside it (see {@link HostTarget.worktreeRoot}). A configured value must be
 * absolute ON THAT MACHINE for the same reason `cwd` must be: a relative value
 * would silently resolve against the remote core's home, which is how a remote
 * child's tree lands somewhere nobody can find (D6/D13).
 */
function resolveWorktreeRoot(host: string, cwd: string, configured: string | undefined): string {
	const raw = typeof configured === "string" ? configured.trim() : "";
	if (raw.length === 0) return path.posix.join(path.posix.dirname(cwd), REMOTE_WORKTREE_DIR);
	if (!path.posix.isAbsolute(raw)) {
		throw new SubagentError(
			`host '${host}' needs an absolute worktreeRoot in subagents.crossMachine.hosts.${host}.worktreeRoot (remote paths are not translated from this machine)`,
			ErrorCodes.INVALID_PARAMS,
			{ host, worktreeRoot: raw },
		);
	}
	return raw;
}

/**
 * The root of THIS package, discovered from this module rather than from cwd
 * (`src/runs/remote.ts` → the package root is two levels up). It is needed
 * because every child's argv carries this package's extension entry.
 */
export function thisPackageRoot(): string {
	return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

/**
 * Validate and order `hosts.<name>.pathMap`: both sides absolute, longest local
 * prefix first so `/opt/pi-legion/ext` beats `/opt/pi-legion`, and a relative
 * side is refused rather than silently resolved against two different homes.
 *
 * The package's own entry is added automatically, mapped to `piLegionRoot`
 * (default: the same path), because `buildPiArgs` puts it in EVERY child's argv
 * and the remote machine cannot be assumed to share this one's prefix. An
 * explicit `pathMap` entry for the same `from` wins, so an operator who maps the
 * package root by hand is not overruled.
 */
function resolvePathMap(
	host: string,
	pathMap: Record<string, string> | undefined,
	piLegionRoot: string | undefined,
): HostPathMapEntry[] {
	const entries: HostPathMapEntry[] = [];
	const explicit = Object.entries(pathMap ?? {});
	const configured = explicit.some(([from]) => from.trim() === thisPackageRoot());
	if (!configured) {
		const root = typeof piLegionRoot === "string" ? piLegionRoot.trim() : "";
		if (root.length > 0 && !path.posix.isAbsolute(root)) {
			throw new SubagentError(
				`host '${host}': piLegionRoot must be an absolute path on that machine (got '${root}')`,
				ErrorCodes.INVALID_PARAMS,
				{ host, piLegionRoot: root },
			);
		}
		entries.push({ from: thisPackageRoot(), to: root.length > 0 ? root : thisPackageRoot() });
	}
	for (const [from, to] of explicit) {
		const key = from.trim();
		const value = typeof to === "string" ? to.trim() : "";
		if (!path.posix.isAbsolute(key) || !path.posix.isAbsolute(value)) {
			throw new SubagentError(
				`host '${host}': pathMap entries must be absolute on both sides (got '${key}' => '${value}'); a relative prefix would resolve against two different homes`,
				ErrorCodes.INVALID_PARAMS,
				{ host, from: key, to: value },
			);
		}
		entries.push({ from: key, to: value });
	}
	entries.sort((a, b) => b.from.length - a.from.length);
	return entries;
}

/**
 * `<mirrorRoot>/<runId>/<sanitized handle>` — where mirrored argv files land (D9).
 *
 * The parent's own `tempDir` stays where it is — it is the parent's cleanup
 * right (`TEMP_OWNER_FILE`) — and this is the OTHER temp dir: the place the
 * argv-referenced files are mirrored to, so a remote child reads files that
 * exist on its machine. Both segments are sanitized because a handle can carry
 * `/` or `..` and this path is joined on posix rules.
 *
 * Review M4: this used to live INSIDE the checkout (`<target.cwd>/.pi-subagents-remote`).
 * But `<target.cwd>` is the tree the child delivers from, so a mirror there shows
 * up in that repo's `git status`, and a routine `git add -A` would commit a
 * system prompt (role text + injected settings context) and a session transcript
 * into the branch the parent then fetches. It is a SIBLING of the checkout now —
 * the same neighbourhood as the worktrees — so nothing the child delivers can
 * ever include it.
 *
 * `runId` is optional: the supervisor is constructed without one in production
 * (`index.ts` has no run id at that point), and a directory label is not a
 * credential, so an absent run id becomes a fixed segment instead of a guess.
 */
export function remoteDirFor(
	target: HostTarget,
	runId: string | undefined,
	name: string,
): string {
	const run = sanitizePathSegment(runId, "no-run");
	const handle = sanitizePathSegment(name, "child");
	return path.posix.join(target.mirrorRoot, run, handle);
}

/**
 * One path segment out of arbitrary text: `[A-Za-z0-9._-]` survives, everything
 * else becomes `-`, and `.`/`..`/empty are replaced by `fallback` so the join
 * cannot climb out of the remote dir.
 */
function sanitizePathSegment(value: string | undefined, fallback: string): string {
	const trimmed = typeof value === "string" ? value.trim() : "";
	const cleaned = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-");
	if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return fallback;
	return cleaned;
}

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

// ── S1: the transport layer (one round trip each) ──────────────────────────

/** The `hc` `machine.exec` result, with BASE64 stdout/stderr (real core shape). */
export interface HcExecResult {
	code?: number | null;
	ms?: number;
	signal?: string | null;
	stdout?: string;
	stderr?: string;
	truncated?: boolean;
	timed_out?: boolean;
}

/** Per-call bound for the two setup calls; both are local-core round trips. */
export const REMOTE_SETUP_TIMEOUT_S = 30;

/**
 * Decode `machine.exec`'s stdout/stderr (BASE64 on the wire, always) into text.
 *
 * The real core answers this way, so a caller that assumed plaintext would put
 * binary noise into an error message. Both streams are decoded and joined —
 * `mkdir` and `git` do not agree on which one carries the interesting line.
 */
export function execResultText(result: HcExecResult | undefined): string {
	const decode = (value: unknown): string => {
		if (typeof value !== "string" || value.length === 0) return "";
		return Buffer.from(value, "base64").toString("utf8").trim();
	};
	return [decode(result?.stdout), decode(result?.stderr)].filter(Boolean).join("\n");
}

/**
 * The preflight shell line for one target (POSIX `sh`).
 *
 * Three facts are checked before a single byte of argv is mirrored: the remote
 * cwd exists, the remote `node` exists, and the remote `pi` exists. The exit
 * codes are the contract with {@link remotePreflight} (11/12/13), so the error
 * can name WHICH fact failed instead of echoing a shell error.
 *
 * Every interpolated value is single-quoted by `shQuote`: a cwd is operator
 * input (a typo like `$(rm -rf ~)` must stay a path, not become a command), and
 * the shell is the one place on this path where that could matter.
 */
export function remotePreflightScript(target: HostTarget): string {
	return [
		`cd -- ${shQuote(target.cwd)} || { printf '%s\\n' ${shQuote(`cwd ${target.cwd} is not a directory`)} >&2; exit 11; }`,
		`command -v ${shQuote(target.node)} >/dev/null 2>&1 || exit 12`,
		`command -v ${shQuote(target.piCli)} >/dev/null 2>&1 || exit 13`,
		// Review M2: this is the one absolute path EVERY child's argv carries. If it
		// is missing the child either fails to start or starts without the guard
		// extension -- the second is the silent failure, so it is checked here.
		`test -f ${shQuote(path.posix.join(target.piLegionRoot, "index.ts"))} || exit 14`,
	].join(" ; ");
}

/** POSIX single-quote escaping: nothing inside the quotes is special. */
function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Prove the target can host this launch, BEFORE `terminal.run` (D6/D9).
 *
 * One `machine.exec` on that machine, three questions (see
 * {@link remotePreflightScript}). Failure classification is deliberate:
 * 11/12/13 are FACTS ABOUT THE TARGET (missing cwd / node / pi) and read as
 * `START_FAILED` naming the value to fix; a transport failure, a `timed_out`
 * or a `code === null` is the MACHINE and reads as `unreachable` — never as
 * "the cwd does not exist", which would send the operator to the wrong fix.
 */
export async function remotePreflight(
	client: HcClient,
	target: HostTarget,
): Promise<void> {
	// Spike constraint 4, first question: is the checkout there at all? Asked without
	// a `cwd`, so the answer is an exit code we can name instead of a core-level
	// chdir failure that looks like a missing program.
	let directoryExists = false;
	try {
		const probe = await client.request<HcExecResult>("machine.exec", {
			on: target.host,
			argv: ["test", "-d", target.cwd],
			timeout: REMOTE_SETUP_TIMEOUT_S,
		});
		directoryExists = probe?.code === 0;
	} catch (error) {
		throw unreachable(target, error);
	}
	if (!directoryExists) {
		throw new SubagentError(
			`host '${target.host}': cwd '${target.cwd}' does not exist on ${target.host} (remote paths are absolute on that machine; local paths are not translated)`,
			ErrorCodes.START_FAILED,
			{ host: target.host, cwd: target.cwd },
		);
	}
	let result: HcExecResult;
	try {
		result = await client.request<HcExecResult>("machine.exec", {
			on: target.host,
			line: remotePreflightScript(target),
			// The same `cwd` `terminal.run` will carry, so the CORE validates that this
			// path is on ITS filesystem (a path that exists here and not there is
			// rejected by the target). A MISSING directory never reaches this call:
			// `remotePathIsDirectory` above asked that question explicitly, because a
			// core told to chdir into a missing path cannot say which part failed
			// (spike constraint 4).
			cwd: target.cwd,
			timeout: REMOTE_SETUP_TIMEOUT_S,
		});
	} catch (error) {
		throw unreachable(target, error);
	}
	if (result?.timed_out === true) {
		throw new SubagentError(
			`host '${target.host}' unreachable: timed_out: preflight did not finish within ${REMOTE_SETUP_TIMEOUT_S}s (${execResultText(result) || "no output"})`,
			ErrorCodes.START_FAILED,
			{ host: target.host },
		);
	}
	const code = typeof result?.code === "number" ? result.code : null;
	if (code === null) {
		throw new SubagentError(
			`host '${target.host}' unreachable: no-exit-code: machine.exec returned no exit code (${execResultText(result) || "no output"})`,
			ErrorCodes.START_FAILED,
			{ host: target.host },
		);
	}
	if (code === 0) return;
	if (code === 11) {
		throw new SubagentError(
			`host '${target.host}': cwd '${target.cwd}' does not exist on ${target.host} (remote paths are absolute on that machine; local paths are not translated)`,
			ErrorCodes.START_FAILED,
			{ host: target.host, cwd: target.cwd },
		);
	}
	if (code === 12) {
		throw new SubagentError(
			`host '${target.host}': node '${target.node}' is not on PATH on ${target.host} (set subagents.crossMachine.hosts.${target.host}.node to a path on that machine)`,
			ErrorCodes.START_FAILED,
			{ host: target.host, node: target.node },
		);
	}
	if (code === 13) {
		throw new SubagentError(
			`host '${target.host}': pi CLI '${target.piCli}' is not on PATH on ${target.host} (set subagents.crossMachine.hosts.${target.host}.piCli to a path on that machine)`,
			ErrorCodes.START_FAILED,
			{ host: target.host, piCli: target.piCli },
		);
	}
	if (code === 14) {
		throw new SubagentError(
			`host '${target.host}': this package is not installed at ${target.piLegionRoot} on that machine (every child's argv loads ${path.posix.join(target.piLegionRoot, "index.ts")}; set subagents.crossMachine.hosts.${target.host}.piLegionRoot to where it really is, or install it there)`,
			ErrorCodes.INVALID_PARAMS,
			{ host: target.host, piLegionRoot: target.piLegionRoot },
		);
	}
	throw new SubagentError(
		`host '${target.host}': preflight failed with exit code ${code} (${execResultText(result) || "no output"})`,
		ErrorCodes.START_FAILED,
		{ host: target.host, code },
	);
}

/** `mkdir -p <dir>` on the target — the remote half of D9's two temp dirs. */
export async function ensureRemoteDir(
	client: HcClient,
	target: HostTarget,
	dir: string,
): Promise<void> {
	let result: HcExecResult;
	try {
		result = await client.request<HcExecResult>("machine.exec", {
			on: target.host,
			argv: ["mkdir", "-p", dir],
			timeout: REMOTE_SETUP_TIMEOUT_S,
		});
	} catch (error) {
		throw unreachable(target, error);
	}
	const code = typeof result?.code === "number" ? result.code : null;
	if (code === 0) return;
	if (result?.timed_out === true || code === null) {
		throw new SubagentError(
			`host '${target.host}' unreachable: ${result?.timed_out === true ? "timed_out" : "no-exit-code"}: mkdir did not complete (${execResultText(result) || "no output"})`,
			ErrorCodes.START_FAILED,
			{ host: target.host, dir },
		);
	}
	throw new SubagentError(
		`host '${target.host}': cannot create '${dir}' (mkdir exited ${code}: ${execResultText(result) || "no output"})`,
		ErrorCodes.START_FAILED,
		{ host: target.host, dir, code },
	);
}

/**
 * Copy one argv-referenced file to the target with `file.write` (D9).
 *
 * The size check happens on THIS side, before any request: `hc` answers
 * `too_large` above 8 MB, and the honest failure is a refusal with both numbers
 * — never a truncated system prompt, which would make the remote child answer
 * prompts nobody wrote. A core-side error is re-thrown as `START_FAILED` with
 * the core's own wording kept, so `too_large`/`write_failed` stay readable.
 */
export async function mirrorRemoteFile(
	client: HcClient,
	target: HostTarget,
	localPath: string,
	remotePath: string,
): Promise<number> {
	let data: Buffer;
	try {
		data = fs.readFileSync(localPath);
	} catch (error) {
		throw new SubagentError(
			`host '${target.host}': cannot read '${localPath}' for mirroring: ${describeError(error)}`,
			ErrorCodes.START_FAILED,
			{ host: target.host, localPath },
		);
	}
	if (data.length > MAX_REMOTE_FILE_BYTES) {
		throw new SubagentError(
			`host '${target.host}': refusing to mirror '${localPath}' to '${remotePath}': ${data.length} bytes exceeds the ${MAX_REMOTE_FILE_BYTES} byte limit of file.write (nothing was truncated)`,
			ErrorCodes.INVALID_PARAMS,
			{ host: target.host, localPath, remotePath, bytes: data.length },
		);
	}
	try {
		await client.request("file.write", {
			on: target.host,
			path: remotePath,
			data: data.toString("base64"),
		});
	} catch (error) {
		throw new SubagentError(
			`host '${target.host}': cannot mirror '${localPath}' to '${remotePath}': ${describeError(error)}`,
			ErrorCodes.START_FAILED,
			{ host: target.host, localPath, remotePath },
		);
	}
	return data.length;
}

/** `unreachable` is a fact about the MACHINE, never about a path (D14 wording). */
/**
 * One failure from the target, classified by what the CORE said (review M6).
 *
 * `unreachable` was the only class, so a host name the core does not know was
 * reported as a network problem — and, being START_FAILED, it also entered the
 * per-model retry chain, re-running preflight/mkdir/mirror for every candidate.
 * The core already names the fact (`machine_unknown`, `bad_cwd`, …); this maps
 * each name to the class the contract's D14 lists and refuses to guess.
 */
function unreachable(target: HostTarget, error: unknown): SubagentError {
	const kind = error instanceof HcRpcError ? error.kind : undefined;
	if (kind === "machine_unknown") {
		return new SubagentError(
			`host '${target.host}' is not a machine this core knows (machine_unknown: ${describeError(error)}); check \`hc machine ls\` and the spelling in subagents.crossMachine.hosts`,
			ErrorCodes.INVALID_PARAMS,
			{ host: target.host, unknownHost: true },
		);
	}
	if (kind === "bad_cwd") {
		return new SubagentError(
			`host '${target.host}': cwd '${target.cwd}' does not exist on ${target.host} (remote paths are absolute on that machine; local paths are not translated): ${describeError(error)}`,
			ErrorCodes.START_FAILED,
			{ host: target.host, cwd: target.cwd },
		);
	}
	return new SubagentError(
		`host '${target.host}' unreachable: ${describeError(error)}`,
		ErrorCodes.START_FAILED,
		// A setup failure is a fact about the TARGET, not about the model: retrying
		// the next candidate would repeat every remote round trip and bury the cause.
		{ host: target.host, noModelFallback: true },
	);
}

/**
 * One error as `<kind>: <message>` when the core named a kind.
 *
 * `HcRpcError.kind` is the core's own word for the failure (`too_large`,
 * `machine_unknown`, …) and is what a reader greps for; dropping it to keep only
 * the prose is how an operator ends up reading a sentence instead of a cause.
 */
function describeError(error: unknown): string {
	if (error instanceof HcRpcError) return `${error.kind}: ${error.message}`;
	if (error instanceof Error) return error.message;
	return String(error);
}
