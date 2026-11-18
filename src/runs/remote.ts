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
import { HcCliClient, HcRpcError, type HcClient } from "../hc/client.ts";
import { modelMatches, parseListModels } from "../shared/list-models.ts";
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
 * The npm package a file belongs to on THIS machine, found by walking up.
 *
 * Why by manifest and not by path shape: an extension entry can be
 * `<pkg>/extensions/index.ts`, `<pkg>/src/index.ts` or `<pkg>/dist/x/index.js`,
 * and the only stable identity across two machines is the `name` in the nearest
 * `package.json`. The walk stops at the filesystem root, so a path that is not
 * inside a package answers `undefined` (and gets the pre-v1.2 refusal).
 */
export function localPackageForFile(file: string): { name: string; dir: string } | undefined {
	let dir = path.dirname(path.resolve(file));
	for (;;) {
		try {
			const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown };
			const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
			if (name.length > 0) return { name, dir };
		} catch {
			/* no manifest here: keep walking */
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** The three answers a package re-root can give (see {@link resolvePackagePathOnHost}). */
export type PackagePathResolution =
	| { ok: true; path: string; packageName: string; relative: string }
	| {
			ok: false;
			reason: "no-package" | "not-installed" | "entry-missing";
			packageName?: string;
			relative?: string;
			/** Package dir on the target, when the package IS installed there. */
			remoteDir?: string;
			/** Entries the installed package DOES declare (entry-missing). */
			declared?: HostPackageEntry[];
	  };

/**
 * Re-root a parent package path onto the target by PACKAGE NAME (v1.2).
 *
 * The failure this removes (real run): a Mac parent inherited five extensions as
 * Mac absolute paths — `pi-sysmon/src/index.ts`,
 * `pi-any-endpoint/extensions/index.ts`, … — none of which exist on the Linux
 * target, so all five were dropped and the child silently lost its provider.
 * Both machines have the packages; only the roots differ. Asking "which package
 * is this, and where is that package there?" answers it without a `pathMap`.
 *
 * Deliberately conservative: a package that IS installed there but does NOT
 * expose the same relative entry (a different version/layout) is a REFUSAL, not
 * a best-effort guess — `entry-missing` names what the package does declare.
 */
export function resolvePackagePathOnHost(
	file: string,
	index: HostPackageIndex | undefined,
): PackagePathResolution {
	if (index === undefined) return { ok: false, reason: "no-package" };
	const local = localPackageForFile(file);
	if (local === undefined) return { ok: false, reason: "no-package" };
	const relative = path.relative(local.dir, path.resolve(file)).split(path.sep).join("/").replace(/^\.\//, "");
	const install = index.packages.find((entry) => entry.name === local.name);
	if (install === undefined) {
		return { ok: false, reason: "not-installed", packageName: local.name, relative };
	}
	const declared = index.entries.filter((entry) => entry.name === local.name);
	const same = declared.find((entry) => entry.relative === relative);
	if (same !== undefined) return { ok: true, path: same.path, packageName: local.name, relative };
	return {
		ok: false,
		reason: "entry-missing",
		packageName: local.name,
		relative,
		remoteDir: install.dir,
		declared,
	};
}

/**
 * The refusal for a package path that exists here but not in the same shape there.
 *
 * D4: the MISSING-package refusal carries the fix, not a lesson, and it names the
 * concrete role the fix is written for: `mapRemoteArgv(..., { role })` is fed by
 * `terminal-supervisor` from `input.agent.name`, because the key that keeps an
 * extension on THIS machine only is a key PER ROLE. Without it the reader has to
 * open `src/runs/extension-inheritance.ts`, which is the failure D4 removes.
 */
function packagePathError(
	host: string,
	file: string,
	resolution: PackagePathResolution,
	role?: string,
): SubagentError {
	if (resolution.ok) throw new Error("packagePathError called with a successful resolution");
	const name = resolution.packageName ?? path.basename(file);
	const settingsPath = `subagents.crossMachine.hosts.${host}.pathMap`;
	const fix = `Install '${name}' on '${host}' (same entry names are then mapped automatically), or add an explicit prefix to ${settingsPath}, or stop inheriting the parent's extensions (PI_LEGION_CHILD_INHERIT_EXTENSIONS=0 / inheritExtensions: false on the card).`;
	const roleName = typeof role === "string" ? role.trim() : "";
	if (resolution.reason === "not-installed") {
		// D4's frozen shape: install it there, or keep it here for ONE concrete role
		// with the settings JSON this reader would otherwise have to look up.
		const keepHere = roleName.length > 0
			? `keep it on this machine only, for role '${roleName}': subagents.agentOverrides.${roleName}.excludeExtensions — {"subagents":{"agentOverrides":{"${roleName}":{"excludeExtensions":["${name}"]}}}}`
			: "keep it on this machine only, for the role you launch: subagents.agentOverrides.<role>.excludeExtensions";
		return new SubagentError(
			`host '${host}': the extension '${file}' belongs to package '${name}', which is not installed on that machine (the launch would have silently dropped it). Two ways out: 1) install it there — hc exec --on ${host} -- pi install npm:${name} (same entry names are then mapped automatically); 2) ${keepHere}`,
			ErrorCodes.INVALID_PARAMS,
			{ host, extension: file, package: name, reason: resolution.reason, ...(roleName.length > 0 ? { role: roleName } : {}) },
		);
	}
	const declared = resolution.declared ?? [];
	const available = declared.length > 0
		? declared.map((entry) => `./${entry.relative} -> ${entry.path}`).join(", ")
		: "(it declares no pi.extensions entries)";
	return new SubagentError(
		`host '${host}': package '${name}' IS installed there at ${resolution.remoteDir}, but it does not expose './${resolution.relative}' (declared: ${available}); the launch would have loaded a different entry than the one this machine asked for. ${fix}`,
		ErrorCodes.INVALID_PARAMS,
		{ host, extension: file, package: name, reason: resolution.reason, declared },
	);
}

/** Map a whole argv, including `-e/--extension` pairs (one rule, no drops). */
export function mapRemoteArgv(
	args: readonly string[],
	opts: {
		host: string;
		remoteCwd: string;
		remoteDir: string;
		localCwd: string;
		pathMap?: readonly HostPathMapEntry[];
		packages?: HostPackageIndex;
		/** The role being launched; only the D4 refusal reads it. */
		role?: string;
	},
): string[] {
	return args.map((arg) => mapRemoteArgPath({ arg, ...opts }));
}

/**
 * Does this argv contain a path that only PACKAGE-NAME resolution can map?
 *
 * The question exists to keep a fully explicit pre-v1.1 launch at ZERO extra
 * round trips: every child argv carries this package's own extension entry, but
 * that one is under the automatic `pathMap` entry, so it does not need the
 * target's package list. Only inherited extensions (paths in the parent's npm
 * tree) do — and only then is the probe paid for.
 */
export function needsPackageIndex(
	args: readonly string[],
	opts: {
		remoteCwd: string;
		remoteDir: string;
		localCwd: string;
		pathMap?: readonly HostPathMapEntry[];
	},
): boolean {
	const pathMap = opts.pathMap ?? [];
	for (const arg of args) {
		if (!path.isAbsolute(arg)) continue;
		if (isInsidePosix(opts.remoteDir, arg)) continue;
		if (pathMap.some((entry) => isInsideFsPath(entry.from, arg))) continue;
		if (isInsideFsPath(opts.localCwd, arg)) continue;
		return true;
	}
	return false;
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
	/** Packages installed on the target; enables re-rooting by package name (v1.2). */
	packages?: HostPackageIndex;
	/** The role being launched; the missing-package refusal names it (D4). */
	role?: string;
}): string {
	const { arg, host, remoteCwd, remoteDir, localCwd, pathMap = [], role } = opts;
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
	// v1.2: a path inside an installed npm package is re-rooted by PACKAGE NAME,
	// which is how the parent's inherited extensions reach a machine whose pi home
	// is elsewhere. A package that is installed but lacks this entry is a refusal
	// (not a drop): a child that quietly lost its provider is the failure this
	// whole branch exists to remove.
	const byPackage = resolvePackagePathOnHost(arg, opts.packages);
	if (byPackage.ok) return byPackage.path;
	if (byPackage.reason !== "no-package") throw packagePathError(host, arg, byPackage, role);
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
	 * Extensions the child must LOAD on that machine (S5.6).
	 *
	 * A child argv carries `--no-extensions`; where the model provider itself is an
	 * extension, that switch also removes the model. These are appended as
	 * `--extension <p>` after the switch, untouched by `pathMap` (they are already
	 * paths on that machine). Absent ⇒ nothing is appended.
	 */
	piExtensions: string[];
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
	/**
	 * Field names that came from the discovery probe instead of the settings file
	 * (addendum v1.1). Absent when every field was written by the operator, which
	 * is what keeps a pre-v1.1 host entry byte-identical.
	 */
	discovered?: string[];
	/** The probe result those fields came from, for diagnostics. */
	discovery?: HostDiscoveryReport;
	/**
	 * Packages installed on that machine, by name (v1.2).
	 *
	 * The extension-inheritance path is a list of THIS machine's package paths
	 * (`.../node_modules/pi-any-endpoint/extensions/index.ts`). Re-rooting them by
	 * PACKAGE NAME is what makes them usable over there without an operator-written
	 * `pathMap`; this index is the remote half of that mapping.
	 */
	packageIndex?: HostPackageIndex;
	/**
	 * Re-probe and re-resolve this target (self-heal). Present only when something
	 * was discovered: a stale cached `piCli` (the target upgraded `pi` and the
	 * bundle moved to a new release directory) is retried ONCE with this, and a
	 * fully explicit host never re-probes.
	 */
	rediscover?: () => Promise<HostTarget>;
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
/**
 * Ask the child's exact argv (minus its task) whether it can SEE its model, and
 * classify the answer (S5.6).
 *
 * The failure this exists for is silent in shape and loud in effect: a `pi` that
 * starts, prints `No models available`, and then hangs until the collect deadline.
 * Waiting five minutes to learn "the model provider was switched off with
 * `--no-extensions`" is the wrong trade.
 *
 * The probe asks `--list-models`, and that choice is the fix: a LISTING proves
 * model visibility and says nothing about credentials, which is exactly the
 * question worth asking before a terminal exists. The first version asked
 * `-p ping` and read `No API key found for any-endpoint` as "no model" — but a
 * registry can hold several providers, and one keyless provider that the child
 * would never have used made a perfectly serviceable launch look dead. With
 * `--list-models`, a model that is VISIBLE in the table is a pass even when the
 * same output carries another provider's `No API key` complaint.
 *
 * `no-model` therefore means "the listing is empty AND says why". Output we
 * cannot parse is NOT a verdict (`undefined`): the launch proceeds, because a
 * fake or unknown `pi` must not be turned into a refusal by a diagnostic.
 * `model-missing` is the tighter case — the machine lists models, just not this
 * one.
 */
export function classifyRemoteStartupProbe(
	output: string,
	expectedModel?: string,
): "no-model" | "conflict" | "model-missing" | undefined {
	// First, because a collision kills the process before any listing is printed.
	if (/conflicts with/i.test(output)) return "conflict";
	// Without a table header there is no listing to compare; the two failure phrases
	// still mean "this machine has no model", and any other output is undecidable.
	// (`parseListModels` would read `No API key found for ...` as a provider/model row.)
	if (!/^\s*provider\s+model\b/im.test(output)) {
		return /No models available|No API key( found)?/i.test(output) ? "no-model" : undefined;
	}
	const models = parseListModels(output);
	if (models.length === 0) {
		return /No models available|No API key( found)?/i.test(output) ? "no-model" : undefined;
	}
	const expected = expectedModel?.trim() ?? "";
	if (expected.length > 0 && !modelMatches(expected, models)) {
		// pi accepts an unregistered id under a known provider ("Using custom model
		// id") and lets the endpoint decide, which is a supported usage. A listing
		// without that id is therefore not proof the launch cannot work; only pi's
		// own refusal is.
		if (/Using custom model id/i.test(output)) return undefined;
		return "model-missing";
	}
	return undefined;
}

/** Bound on that probe. Same "ten seconds or name the problem" rule as preflight. */
export const REMOTE_STARTUP_PROBE_TIMEOUT_S = 10;

/**
 * The shell line for that probe: the launch's argv with its task replaced by
 * `--list-models`.
 */
export function remoteStartupProbeLine(argv: string[], cwd: string): string {
	// Drop the task (the last element the backend appended) and ask the same binary
	// the same flags one trivial question. `--list-models` prints the registry the
	// child would see, without spending a turn and without needing a credential: it
	// answers "is this model visible there", which is the question the launch can
	// actually act on.
	const flags = argv.slice(0, -1);
	const command = [...flags, "--list-models"].map((part) => shQuote(part)).join(" ");
	return `cd -- ${shQuote(cwd)} && ${command}`;
}

/**
 * `hosts.<host>.piExtensions`, validated as "already a path/package on THAT machine".
 *
 * These are handed to `pi` verbatim, so a relative entry is refused by name rather
 * than resolved against some cwd: the child's cwd is its worktree, and a relative
 * extension would be read from a directory nobody meant.
 */
function resolvePiExtensions(host: string, value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new SubagentError(
			`host '${host}': subagents.crossMachine.hosts.${host}.piExtensions must be an array of paths on that machine`,
			ErrorCodes.INVALID_PARAMS,
			{ host },
		);
	}
	return value.map((entry) => {
		const text = typeof entry === "string" ? entry.trim() : "";
		if (text.length === 0 || !path.posix.isAbsolute(text)) {
			throw new SubagentError(
				`host '${host}': piExtensions entry '${String(entry)}' must be an absolute path on that machine`,
				ErrorCodes.INVALID_PARAMS,
				{ host },
			);
		}
		return text;
	});
}

/**
 * Everything a per-call resolution may add on top of the settings file.
 *
 * `cwd` is the ONLY per-call override (addendum v1.1): one machine can host many
 * projects, so "the cwd" is a property of the launch rather than of the host.
 * The other fields are filled by {@link resolveHostTargetAsync} after its probe,
 * and exist so this function stays a pure decision function with no `hc` round
 * trip inside it.
 */
export interface HostTargetOverrides {
	/** Per-call remote cwd (`subagent({ host, cwd })`), absolute on that machine. */
	cwd?: string;
	/** Values discovered on the target; used only where the settings are silent. */
	discovered?: DiscoveredHostFields;
	/** Field names that came from discovery (diagnostics + self-heal). */
	discoveredFields?: string[];
	/** The report those fields came from, kept for `/legion doctor`. */
	discovery?: HostDiscoveryReport;
	/** Re-probe closure; see {@link HostTarget.rediscover}. */
	rediscover?: () => Promise<HostTarget>;
	/** Package index discovered on the target (v1.2 extension re-rooting). */
	packageIndex?: HostPackageIndex;
	/** Teach the per-call cwd override in the "no cwd" refusal (v1.1 callers). */
	mentionPerCallCwd?: boolean;
}

/**
 * D2: a launch that did not name the directory on THAT machine is a QUESTION.
 *
 * The one thing a caller cannot get from anywhere else is which directory on the
 * other machine the child should work in — it is not in `hc machine ls`, it is
 * not derivable from this machine's cwd (remote paths are never translated), and
 * a guess lands the child in the wrong tree, where it edits the wrong files and
 * reports success. So the tool asks, in one message: what the missing input is,
 * the exact call that passes it, whose answer it is when this conversation has
 * not named one, and the one workaround that must NOT be attempted.
 *
 * Produced in exactly two places — `resolveHostTarget`'s per-call-cwd branch and
 * the async resolver's refusal BEFORE discovery starts — so a launch can never
 * grow a second, drifting version of this sentence.
 */
export function missingRemoteCwdQuestion(host: string): string {
	return `host '${host}' needs a directory on that machine, and this call did not name one — which directory should the child work in? Pass it with the call: subagent({ agent: "centurion", host: "${host}", cwd: "/abs/path/on/${host}", task: "..." }) (that path is read ON ${host}; it is never translated from here). If this conversation has not named a directory on ${host}, ask the user which one to use. Do not ssh or run \`hc exec\` to browse that machine — a guess here becomes a child in the wrong tree.`;
}

export function resolveHostTarget(
	host: string,
	config: SubagentsSettings["crossMachine"] | undefined,
	overrides: HostTargetOverrides = {},
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
	// The path must be absolute AND a path on that machine. It is judged by
	// `path.posix.isAbsolute`, deliberately and not by the platform helper (m8,
	// review s01): `hc` speaks remote POSIX paths, and a Windows parent that read
	// `C:\srv` as absolute-or-not with its own rules would be answering a question
	// about a filesystem it cannot see. Every "is this a path on THAT machine"
	// check in this file uses `path.posix`; every "is this a path on THIS machine"
	// check uses the platform `path` (`isInsideFsPath`).
	//
	// v1.1: the per-call override wins over the host's default, and both are
	// judged by the same rule — a relative value on either side would resolve
	// against the remote core's home, the one directory nobody asked for.
	const overrideCwd = typeof overrides.cwd === "string" ? overrides.cwd.trim() : "";
	if (overrides.cwd !== undefined && (overrideCwd.length === 0 || !path.posix.isAbsolute(overrideCwd))) {
		throw new SubagentError(
			`host '${name}': the per-call cwd override must be an absolute path on that machine (got '${String(overrides.cwd)}'); remote paths are not translated from this machine`,
			ErrorCodes.INVALID_PARAMS,
			{ host: name, cwd: overrides.cwd },
		);
	}
	const configuredCwd = typeof entry.cwd === "string" ? entry.cwd.trim() : "";
	const cwd = overrideCwd.length > 0 ? overrideCwd : configuredCwd;
	if (cwd.length === 0) {
		// Never HOME, never the remote core's cwd: a child that lands in the wrong
		// directory is the failure this whole file is built to refuse (D1/D6).
		//
		// The v1.1 resolver ALSO offers the per-call override, because that is the
		// new way out of this error; a pre-v1.1 caller (and its pinned test) gets the
		// old sentence, untouched.
		throw new SubagentError(
			overrides.mentionPerCallCwd === true
				? missingRemoteCwdQuestion(name)
				: `host '${name}' needs an absolute cwd in subagents.crossMachine.hosts.${name}.cwd (remote paths are not translated from this machine)`,
			ErrorCodes.INVALID_PARAMS,
			overrides.mentionPerCallCwd === true
				? { host: name, cwd: "", reason: "cwd-missing", noModelFallback: true }
				: { host: name, cwd: "" },
		);
	}
	if (!path.posix.isAbsolute(cwd)) {
		throw new SubagentError(
			`host '${name}' needs an absolute cwd in subagents.crossMachine.hosts.${name}.cwd (remote paths are not translated from this machine)`,
			ErrorCodes.INVALID_PARAMS,
			{ host: name, cwd },
		);
	}
	const discovered = overrides.discovered;
	const discoveredRoot = nonEmpty(discovered?.piLegionRoot);
	// Explicit wins, including an explicitly EMPTY `piExtensions: []` — an operator
	// who wrote the key has answered the question, and a discovered provider must
	// not sneak past that answer.
	const piExtensions = entry.piExtensions !== undefined
		? resolvePiExtensions(name, entry.piExtensions)
		: (discovered?.piExtensions ?? []).filter((value) => path.posix.isAbsolute(value));
	return {
		host: name,
		cwd,
		node: nonEmpty(entry.node) ?? nonEmpty(discovered?.node) ?? DEFAULT_REMOTE_NODE,
		piCli: nonEmpty(entry.piCli) ?? nonEmpty(discovered?.piCli) ?? DEFAULT_REMOTE_PI,
		pathMap: resolvePathMap(name, entry.pathMap, entry.piLegionRoot ?? discoveredRoot),
		piLegionRoot: nonEmpty(entry.piLegionRoot) ?? discoveredRoot ?? thisPackageRoot(),
		piExtensions,
		mirrorRoot: path.posix.join(
			path.posix.dirname(resolveWorktreeRoot(name, cwd, entry.worktreeRoot)),
			REMOTE_MIRROR_DIR_NAME,
		),
		worktreeRoot: resolveWorktreeRoot(name, cwd, entry.worktreeRoot),
		// Only present when a probe actually contributed: a fully explicit entry
		// resolves to exactly the pre-v1.1 object, field for field.
		...(overrides.discoveredFields && overrides.discoveredFields.length > 0
			? { discovered: [...overrides.discoveredFields] }
			: {}),
		...(overrides.discovery ? { discovery: overrides.discovery } : {}),
		...(overrides.packageIndex ? { packageIndex: overrides.packageIndex } : {}),
		...(overrides.rediscover ? { rediscover: overrides.rediscover } : {}),
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
 * Two different LOCAL files whose basenames collide inside one remote dir (m11).
 *
 * The remote dir is flat (one name per file), so `a/system-prompt.md` and
 * `b/system-prompt.md` would both become `<remoteDir>/system-prompt.md`: the second
 * mirror silently overwrites the first, and the child reads one file where two were
 * written. Returns the colliding basenames, sorted; empty means the set is safe.
 */
export function basenameCollisions(paths: string[]): string[] {
	const firstFor = new Map<string, string>();
	const collisions = new Set<string>();
	for (const candidate of paths) {
		const base = path.posix.basename(candidate);
		const previous = firstFor.get(base);
		if (previous === undefined) firstFor.set(base, candidate);
		else if (previous !== candidate) collisions.add(base);
	}
	return [...collisions].sort();
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

// ── v1.1: host discovery (one probe, then cached) ─────────────────────────
//
// The problem this section removes: `subagents.crossMachine.hosts.<h>` used to
// require `cwd`/`node`/`piCli` (and often `piLegionRoot`/`piExtensions`) to be
// written by hand, on the PARENT, about a machine the parent is not sitting on.
// Nothing about those values is a secret: they are answers to three shell
// questions (`command -v node`, `command -v pi`, where is the bundle). So they
// are ASKED, once, over the same `hc machine.exec` the preflight already uses,
// and cached; the settings block becomes an override list instead of a form to
// fill in.
//
// Two rules keep this safe:
//   - explicit configuration always wins (a discovered value only fills a hole);
//   - a discovered `node`/`piCli` is a VALIDATED absolute path on the target,
//     never a name this machine would have to resolve and never a shim.

/** The `pi` install locations the probe searches, relative to the launcher. */
export const DISCOVERY_TIMEOUT_S = 20;

/** How long a discovery result is reused before the target is asked again. */
export const DEFAULT_DISCOVERY_TTL_S = 900;

/** One installed pi extension found on the target. */
export interface HostDiscoveryExtension {
	/** Package name from its `package.json`. */
	name: string;
	/** Absolute path (on that machine) of the extension entry. */
	path: string;
	/** True when the package looks like a model provider. */
	provider: boolean;
}

/** One installed npm package on the target, by name and directory. */
export interface HostPackage {
	name: string;
	dir: string;
}

/** One declared `pi.extensions` entry of an installed package. */
export interface HostPackageEntry {
	name: string;
	/** Entry path relative to the package dir, posix, no leading `./`. */
	relative: string;
	/** Absolute path (on that machine). */
	path: string;
}

/**
 * What the target has installed, keyed by package name.
 *
 * This is what turns a PARENT extension path into a path on the other machine
 * without an operator-written `pathMap`: both machines run the same packages,
 * just from different roots (`/Users/me/.pi/...` vs `/root/.pi/...`).
 */
export interface HostPackageIndex {
	packages: HostPackage[];
	entries: HostPackageEntry[];
}

/** What one probe found on the target machine. */
export interface HostDiscoveryReport {
	/** `uname -n`, diagnostics only. */
	machine?: string;
	/** `command -v node` and the REAL binary behind it. */
	node?: { command: string; binary: string; version?: string; shim?: string };
	/** `command -v node` even when that path could not be turned into a binary. */
	nodeCommand?: string;
	/** `command -v pi` and the JavaScript entry node can execute. */
	pi?: { command: string; entry: string; version?: string };
	/** `command -v pi` even when no runnable JavaScript entry sits behind it. */
	piCommand?: string;
	/** Where this package (pi-legion) lives there. */	piLegionRoot?: string;
	/** Installed extensions that declare `pi.extensions`. */
	extensions: HostDiscoveryExtension[];
	/** Every installed package, by name (v1.2: extension re-rooting). */
	packages: HostPackage[];
	/** Declared `pi.extensions` entries, by package-relative path (v1.2). */
	packageEntries: HostPackageEntry[];
	/** Epoch ms of the probe (or of the cached probe this came from). */
	at: number;
	/** Where the answer came from, for diagnostics. */
	source: "probe" | "memory-cache" | "disk-cache";
}

/** The subset of a report that fills holes in a host entry. */
export interface DiscoveredHostFields {
	node?: string;
	piCli?: string;
	piLegionRoot?: string;
	piExtensions?: string[];
}

/**
 * The discovery shell line (POSIX `sh`), one `machine.exec` round trip.
 *
 * Output is `KEY<TAB>VALUE`, one fact per line, because the three questions have
 * three-valued answers (`found`, `found a shim`, `absent`) and prose is not a
 * protocol. Everything is best-effort: a missing tool prints a marker line and
 * the rest of the probe still runs, so the error the caller sees can name
 * exactly what the machine does have.
 *
 * The two hard parts, both learned from real runs:
 *
 *   - `command -v node` can be a version-manager SHIM (mise/asdf), i.e. a shell
 *     script. Handing that path to `terminal.run` as argv[0] is the 6.1.0 bug in
 *     a different costume, so the probe asks node itself (`process.execPath`) and
 *     reports the REAL binary; the shim is kept only for diagnostics.
 *   - `command -v pi` is a shell LAUNCHER (`…/bin/pi`, a `case "$0"` wrapper),
 *     and every child's argv is `[node, piCli, …]`. The probe therefore resolves
 *     the launcher to a `.js` entry and then PROVES it by running
 *     `<node> <entry> --version` — the same question the preflight asks, asked
 *     here so the failure can name the field instead of surfacing as
 *     `SyntaxError: Unexpected token case` ten layers down.
 */
export function remoteDiscoveryScript(): string {
	// Heredoc-free on purpose: the body is a single `sh -c` line list, and every
	// dynamic value is a quoted variable, never an interpolated path.
	return [
		`emit() { printf '%s\\t%s\\n' "$1" "$2"; }`,
		`emit MACHINE "$(uname -n 2>/dev/null || true)"`,
		// ── node ───────────────────────────────────────────────────────────────
		`NODE_CMD=$(command -v node 2>/dev/null || true)`,
		`NODE_BIN=""`,
		`if [ -n "$NODE_CMD" ]; then`,
		`  emit NODE_CMD "$NODE_CMD"`,
		`  NODE_REAL=$("$NODE_CMD" -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)`,
		`  if [ -n "$NODE_REAL" ] && [ -x "$NODE_REAL" ]; then`,
		`    NODE_BIN=$NODE_REAL`,
		`    emit NODE_BIN "$NODE_REAL"`,
		`    emit NODE_VERSION "$("$NODE_REAL" -v 2>/dev/null || true)"`,
		`    [ "$NODE_REAL" = "$NODE_CMD" ] || emit NODE_SHIM "$NODE_CMD"`,
		`  else`,
		`    emit NODE_UNUSABLE "$NODE_CMD"`,
		`  fi`,
		`else`,
		`  emit NODE_MISSING 1`,
		`fi`,
		// ── realpath (node when there is one: `readlink -f` is GNU-only) ───────
		`rp() { if [ -n "$NODE_BIN" ]; then "$NODE_BIN" -e 'try{console.log(require("node:fs").realpathSync(process.argv[1]))}catch{}' "$1" 2>/dev/null && return 0; fi; if readlink -f "$1" >/dev/null 2>&1; then readlink -f "$1"; else readlink "$1" 2>/dev/null || printf '%s\\n' "$1"; fi; }`,
		// ── pi ─────────────────────────────────────────────────────────────────
		`PI_CMD=$(command -v pi 2>/dev/null || true)`,
		`PI_ENTRY=""`,
		`if [ -n "$PI_CMD" ]; then`,
		`  emit PI_CMD "$PI_CMD"`,
		`  PI_REAL=$(rp "$PI_CMD")`,
		// The install root comes from the LAUNCHER's real path: `/usr/local/bin/pi`
		// may be a symlink into `…/.pi/agent/bin/pi`, and `../install` only means
		// anything next to the real launcher.
		`  PI_DIR=$(dirname "$PI_REAL")`,
		`  PI_CANDIDATES=$( {`,
		`    printf '%s\\n' "$PI_CMD"`,
		`    printf '%s\\n' "$PI_REAL"`,
		`    CURRENT=$(cat "$PI_DIR/../install/current-version" 2>/dev/null || true)`,
		`    [ -n "$CURRENT" ] && [ -e "$PI_DIR/../install/releases/$CURRENT/node_modules/.bin/pi" ] && rp "$PI_DIR/../install/releases/$CURRENT/node_modules/.bin/pi"`,
		`    for c in "$PI_DIR"/../install/releases/*/node_modules/.bin/pi "$PI_DIR"/../install/releases/*/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js "$PI_DIR"/../npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js "$PI_DIR"/../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js; do`,
		`      [ -e "$c" ] && rp "$c"`,
		`    done`,
		`    if [ -f "$PI_CMD" ]; then grep -oE '(/[A-Za-z0-9._+@-]+)+[.](m?js|cjs)' "$PI_CMD" 2>/dev/null | head -n 20; fi`,
		`  } | awk '!seen[$0]++' 2>/dev/null )`,
		`  if [ -n "$NODE_BIN" ]; then`,
		`    PI_ENTRY=$(printf '%s\\n' "$PI_CANDIDATES" | while IFS= read -r candidate; do`,
		`      [ -n "$candidate" ] || continue`,
		`      case "$candidate" in *.js|*.mjs|*.cjs) ;; *) continue ;; esac`,
		`      [ -f "$candidate" ] || continue`,
		`      if "$NODE_BIN" "$candidate" --version >/dev/null 2>&1; then printf '%s' "$candidate"; break; fi`,
		`    done)`,
		`  fi`,
		`  if [ -n "$PI_ENTRY" ]; then`,
		`    emit PI_ENTRY "$PI_ENTRY"`,
		`    emit PI_VERSION "$("$NODE_BIN" "$PI_ENTRY" --version 2>/dev/null | head -n 1)"`,
		`  else`,
		`    emit PI_ENTRY_MISSING "$PI_CMD"`,
		`  fi`,
		`else`,
		`  emit PI_MISSING 1`,
		`fi`,
		// ── this package (pi-legion) ─────────────────────────────────────────
		`LEGION_CANDIDATES=$( {`,
		`  printf '%s\\n' "$PI_DIR/../npm/node_modules/pi-legion" "$HOME/.pi/agent/npm/node_modules/pi-legion"`,
		`  if command -v npm >/dev/null 2>&1; then NPM_ROOT=$(npm root -g 2>/dev/null || true); [ -n "$NPM_ROOT" ] && printf '%s\\n' "$NPM_ROOT/pi-legion"; fi`,
		`} | awk '!seen[$0]++' 2>/dev/null )`,
		`LEGION_ROOT=$(printf '%s\\n' "$LEGION_CANDIDATES" | while IFS= read -r candidate; do`,
		`  [ -n "$candidate" ] || continue`,
		`  [ -f "$candidate/index.ts" ] || continue`,
		`  if [ -f "$candidate/package.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"pi-legion"' "$candidate/package.json" 2>/dev/null; then rp "$candidate"; break; fi`,
		`done)`,
		`if [ -n "$LEGION_ROOT" ]; then`,
		`  emit LEGION_ROOT "$LEGION_ROOT"`,
		`  emit LEGION_VERSION "$("$NODE_BIN" -e 'try{process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version||"")}catch{}' "$LEGION_ROOT/package.json" 2>/dev/null || true)"`,
		`else`,
		`  emit LEGION_ROOT_MISSING 1`,
		`fi`,
		// ── installed pi extensions (providers matter: --no-extensions) ────
		`EXT_DIRS=$( {`,
		`  for d in "$HOME/.pi/agent/npm/node_modules" "$PI_DIR"/../npm/node_modules; do`,
		`    [ -d "$d" ] && for p in "$d"/*; do [ -d "$p" ] && rp "$p"; done`,
		`  done`,
		`  if command -v npm >/dev/null 2>&1; then G=$(npm root -g 2>/dev/null || true); [ -n "$G" ] && [ -d "$G" ] && for p in "$G"/*; do [ -d "$p" ] && rp "$p"; done; fi`,
		`} | awk '!seen[$0]++' 2>/dev/null )`,
		`if [ -n "$NODE_BIN" ] && [ -n "$EXT_DIRS" ]; then`,
		`  "$NODE_BIN" -e '`,
		`const fs = require("node:fs"), path = require("node:path");`,
		`for (const dir of process.argv.slice(1)) {`,
		`  let pkg; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { continue; }`,
		`  const name = typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : "";`,
		// v1.2: EVERY installed package is reported by name+dir, so a parent
		// extension path can be re-rooted onto that machine without a pathMap.
		`  if (!name || name === "pi-legion") continue;`,
		`  process.stdout.write(["PKG", name, dir].join("\\t") + "\\n");`,
		`  const list = pkg && pkg.pi && pkg.pi.extensions;`,
		`  if (!Array.isArray(list)) continue;`,
		`  let provider = (Array.isArray(pkg.keywords) ? pkg.keywords : []).includes("provider");`,
		`  for (const rel of list) {`,
		`    if (typeof rel !== "string") continue;`,
		`    const abs = path.resolve(dir, rel);`,
		`    if (!fs.existsSync(abs)) continue;`,
		`    const relative = path.relative(dir, abs).split(path.sep).join("/");`,
		`    if (!provider) { try { provider = /registerProvider|registerModelProvider/.test(fs.readFileSync(abs, "utf8")); } catch {} }`,
		`    process.stdout.write(["EXT", name, abs, provider ? "1" : "0"].join("\\t") + "\\n");`,
		`    process.stdout.write(["PKGENTRY", name, relative, abs].join("\\t") + "\\n");`,
		`  }`,
		`}' $EXT_DIRS 2>/dev/null || true`,
		`fi`,
		`emit PROBE_OK 1`,
	].join("\n");
}

/** The probe's answers: `get` is the last row for a key, `all` keeps every row. */
export interface DiscoveryFacts {
	get(key: string): string | undefined;
	all(key: string): string[];
	has(key: string): boolean;
}

/**
 * Split the probe's stdout into `KEY -> VALUE` rows.
 *
 * Repeated keys are KEPT (`all`): the probe emits one `EXT` row per installed
 * extension, and a plain `Map` would collapse them to the last one — the exact
 * shape of bug where a machine's provider extension silently disappears.
 */
export function parseDiscoveryReport(text: string): DiscoveryFacts {
	const rows = new Map<string, string[]>();
	for (const line of text.split(/\r?\n/)) {
		if (line.length === 0) continue;
		const tab = line.indexOf("\t");
		if (tab <= 0) continue;
		const key = line.slice(0, tab);
		const list = rows.get(key);
		if (list === undefined) rows.set(key, [line.slice(tab + 1)]);
		else list.push(line.slice(tab + 1));
	}
	return {
		get: (key) => rows.get(key)?.at(-1),
		all: (key) => rows.get(key) ?? [],
		has: (key) => rows.has(key),
	};
}

/** One probe answer, as the report the cache stores and errors quote. */
export function buildDiscoveryReport(facts: DiscoveryFacts, source: HostDiscoveryReport["source"] = "probe"): HostDiscoveryReport {
	const extensions: HostDiscoveryExtension[] = [];
	const seen = new Set<string>();
	for (const value of facts.all("EXT")) {
		const [name, entryPath, provider] = value.split("\t");
		if (!name || !entryPath || seen.has(entryPath)) continue;
		seen.add(entryPath);
		extensions.push({ name, path: entryPath, provider: provider === "1" });
	}
	const packages: HostPackage[] = [];
	const packageEntries: HostPackageEntry[] = [];
	const seenPackages = new Set<string>();
	const seenEntries = new Set<string>();
	for (const value of facts.all("PKG")) {
		const [name, dir] = value.split("\t");
		if (!name || !dir || seenPackages.has(name)) continue;
		seenPackages.add(name);
		packages.push({ name, dir });
	}
	for (const value of facts.all("PKGENTRY")) {
		const [name, relative, entryPath] = value.split("\t");
		if (!name || !relative || !entryPath) continue;
		const key = `${name}\u0000${relative}`;
		if (seenEntries.has(key)) continue;
		seenEntries.add(key);
		packageEntries.push({ name, relative, path: entryPath });
	}
	const nodeBinary = facts.get("NODE_BIN");
	const nodeCommand = facts.get("NODE_CMD");
	const piEntry = facts.get("PI_ENTRY");
	const piCommand = facts.get("PI_CMD");
	return {
		at: Date.now(),
		source,
		...(facts.get("MACHINE") ? { machine: facts.get("MACHINE") } : {}),
		...(nodeCommand ? { nodeCommand } : {}),
		...(piCommand ? { piCommand } : {}),
		...(nodeBinary && nodeCommand
			? {
				node: {
					command: nodeCommand,
					binary: nodeBinary,
					...(facts.get("NODE_VERSION") ? { version: facts.get("NODE_VERSION") } : {}),
					...(facts.get("NODE_SHIM") ? { shim: facts.get("NODE_SHIM") } : {}),
				},
			}
			: {}),
		...(piEntry && piCommand
			? {
				pi: {
					command: piCommand,
					entry: piEntry,
					...(facts.get("PI_VERSION") ? { version: facts.get("PI_VERSION") } : {}),
				},
			}
			: {}),
		...(facts.get("LEGION_ROOT") ? { piLegionRoot: facts.get("LEGION_ROOT") } : {}),
		extensions,
		packages,
		packageEntries,
	};
}

/**
 * The fields a report can fill, in the order an error message should name them.
 *
 * `piExtensions` only ever contributes PROVIDER extensions: those are the ones
 * `--no-extensions` silently removed (the `No models available` failure in
 * S5.6). A non-provider extension is reported for diagnostics but never added
 * on its own — the child's argv must stay the set the operator can predict.
 */
export function discoveredFields(report: HostDiscoveryReport): DiscoveredHostFields {
	const providers = report.extensions.filter((extension) => extension.provider).map((extension) => extension.path);
	return {
		...(report.node?.binary ? { node: report.node.binary } : {}),
		...(report.pi?.entry ? { piCli: report.pi.entry } : {}),
		...(report.piLegionRoot ? { piLegionRoot: report.piLegionRoot } : {}),
		...(providers.length > 0 ? { piExtensions: providers } : {}),
	};
}

/** Human-readable "what the probe found", used by every discovery error. */
export function describeDiscovery(report: HostDiscoveryReport): string {
	const lines: string[] = [];
	lines.push(`node: ${report.node ? `${report.node.version ?? "?"} at ${report.node.binary}${report.node.shim ? ` (via shim ${report.node.shim})` : ""}` : report.nodeCommand ? `${report.nodeCommand} is not a runnable node` : `not found on PATH`}`);
	lines.push(`pi: ${report.pi ? `${report.pi.version ?? "?"} entry ${report.pi.entry}` : report.piCommand ? `${report.piCommand} is a launcher, no JavaScript entry behind it` : `not found on PATH`}`);
	lines.push(`legion: ${report.piLegionRoot ?? "not found (no pi-legion install with a matching package.json)"}`);
	const providers = report.extensions.filter((extension) => extension.provider);
	if (providers.length > 0) lines.push(`provider extensions: ${providers.map((entry) => `${entry.name} -> ${entry.path}`).join(", ")}`);
	return lines.join("\n");
}

// ── the discovery cache (memory + optional disk, TTL) ──────────────────────

interface DiscoveryCacheEntry {
	report: HostDiscoveryReport;
	expiresAt: number;
}

const DISCOVERY_MEMORY = new Map<string, DiscoveryCacheEntry>();
/**
 * Probes in flight, keyed by host.
 *
 * A `tasks[]` batch resolves every step through the async resolver at the same
 * time; without this, N steps would each pay one `machine.exec` for the same
 * host. Sharing the promise is safe because the probe is read-only, and a
 * rejected promise is removed in `finally` so a failure is never cached.
 */
const DISCOVERY_INFLIGHT = new Map<string, Promise<HostDiscoveryReport>>();
/**
 * On-demand package-index loaders, keyed by the target they belong to (v1.2).
 *
 * Deliberately NOT a field on {@link HostTarget}: a fully explicit pre-v1.1 entry
 * must resolve to the byte-identical object it always did, and a closure on it
 * would be a visible difference for anything that compares targets. A WeakMap
 * keeps the loader attached without changing the shape, and lets it disappear
 * with the target.
 */
const PACKAGE_LOADERS = new WeakMap<HostTarget, () => Promise<HostPackageIndex | undefined>>();

/** Attach the on-demand package loader to a resolved target. */
export function registerPackageLoader(
	target: HostTarget,
	loader: () => Promise<HostPackageIndex | undefined>,
): void {
	PACKAGE_LOADERS.set(target, loader);
}

/** The loader registered for a target, if any (see {@link PACKAGE_LOADERS}). */
export function packageLoaderFor(target: HostTarget): (() => Promise<HostPackageIndex | undefined>) | undefined {
	return PACKAGE_LOADERS.get(target);
}
const MACHINE_LIST_MEMORY = new Map<string, { names: string[]; expiresAt: number }>();

/** Bound on the machine registry cache; it changes on operator action only. */
export const MACHINE_LIST_TTL_MS = 60_000;

/** Forget one host's probe (or all of them), in memory and on disk. */
export function clearHostDiscoveryCache(host?: string, env: NodeJS.ProcessEnv = process.env): void {
	if (host === undefined) {
		DISCOVERY_MEMORY.clear();
		MACHINE_LIST_MEMORY.clear();
		for (const file of listDiskCacheFiles(env)) {
			try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
		}
		return;
	}
	const name = normalizeHost(host);
	if (name === undefined) return;
	DISCOVERY_MEMORY.delete(name);
	// The registry is not host-specific knowledge, but a probe for one host and
	// the admission list are read together; clearing both keeps `refresh` honest.
	MACHINE_LIST_MEMORY.clear();
	try { fs.rmSync(diskCachePath(name, env), { force: true }); } catch { /* best effort */ }
}

function listDiskCacheFiles(env: NodeJS.ProcessEnv): string[] {
	try {
		return fs.readdirSync(diskCacheDir(env)).map((entry) => path.join(diskCacheDir(env), entry));
	} catch {
		return [];
	}
}

/**
 * `$XDG_CACHE_HOME/pi-legion/host-discovery` (or `~/.cache/...`).
 *
 * A disk cache, not a memory one, because the expensive unit is a launch: a
 * fresh `pi` process would otherwise re-probe the target on every dispatch even
 * though the answer changes only when that machine is re-provisioned.
 */
function diskCacheDir(env: NodeJS.ProcessEnv): string {
	const home = env.HOME ?? "";
	const base = env.XDG_CACHE_HOME ?? (home.length > 0 ? path.join(home, ".cache") : path.join(path.sep, "tmp"));
	return path.join(base, "pi-legion", "host-discovery");
}

function diskCachePath(host: string, env: NodeJS.ProcessEnv): string {
	const safe = host.replace(/[^A-Za-z0-9._-]+/g, "-");
	return path.join(diskCacheDir(env), `${safe}.json`);
}

function readDiskCache(host: string, env: NodeJS.ProcessEnv, now: number): DiscoveryCacheEntry | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(diskCachePath(host, env), "utf8")) as DiscoveryCacheEntry;
		if (typeof parsed?.expiresAt !== "number" || parsed.expiresAt <= now) return undefined;
		if (!parsed.report || !Array.isArray(parsed.report.extensions)) return undefined;
		// A cache written before v1.2 has no package list; normalize rather than
		// discard, so an upgrade does not turn into a surprise re-probe mid-launch.
		return {
			expiresAt: parsed.expiresAt,
			report: {
				...parsed.report,
				packages: Array.isArray(parsed.report.packages) ? parsed.report.packages : [],
				packageEntries: Array.isArray(parsed.report.packageEntries) ? parsed.report.packageEntries : [],
			},
		};
	} catch {
		return undefined;
	}
}

function writeDiskCache(host: string, entry: DiscoveryCacheEntry, env: NodeJS.ProcessEnv): void {
	try {
		fs.mkdirSync(diskCacheDir(env), { recursive: true });
		fs.writeFileSync(diskCachePath(host, env), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	} catch {
		/* a cache that cannot be written is not a launch failure */
	}
}

/** Options for the two discovery entry points. */
export interface HostDiscoveryOptions {
	/** Reuse this client; otherwise a short-lived one is created and closed. */
	client?: HcClient;
	env?: NodeJS.ProcessEnv;
	/** Ignore both caches (the `crossMachine.refresh` switch). */
	refresh?: boolean;
	/** Override the TTL in milliseconds. */
	ttlMs?: number;
	/** Disk cache directory; `null` disables the disk cache (tests). */
	cacheDir?: string | null;
	/** In-process cache switch (default true; `false` exercises the disk path). */
	useMemoryCache?: boolean;
	now?: () => number;
}

function cacheTtlMs(config: SubagentsSettings["crossMachine"] | undefined, options: HostDiscoveryOptions): number {
	if (options.ttlMs !== undefined) return options.ttlMs;
	const seconds = config?.discoveryTtlSeconds;
	return (typeof seconds === "number" && seconds > 0 ? seconds : DEFAULT_DISCOVERY_TTL_S) * 1000;
}

/**
 * Run ONE `machine.exec` probe on `host` and return its report.
 *
 * The probe is a fact-finding call, so a transport failure is reported as such
 * and is NEVER turned into "this field is missing": those two sentences send
 * the operator to different fixes (start the core vs install pi).
 */
export async function probeHost(
	host: string,
	options: HostDiscoveryOptions = {},
): Promise<HostDiscoveryReport> {
	const name = normalizeHost(host);
	if (name === undefined) {
		throw new SubagentError("host discovery needs a host name", ErrorCodes.INVALID_PARAMS);
	}
	const env = options.env ?? process.env;
	const client = options.client;
	const run = async (active: HcClient): Promise<HostDiscoveryReport> => {
		let result: HcExecResult;
		try {
			result = await active.request<HcExecResult>("machine.exec", {
				on: name,
				line: remoteDiscoveryScript(),
				timeout: DISCOVERY_TIMEOUT_S,
			});
		} catch (error) {
			throw discoveryTransportError(name, error);
		}
		const text = execResultText(result);
		if (result?.timed_out === true) {
			throw new SubagentError(
				`host '${name}': host discovery timed out after ${DISCOVERY_TIMEOUT_S}s (${text || "no output"}); the machine answered hc but not this probe. Set the fields by hand in subagents.crossMachine.hosts.${name} or retry with subagents.crossMachine.refresh = true`,
				ErrorCodes.START_FAILED,
				{ host: name, discovery: true, timedOut: true },
			);
		}
		const code = typeof result?.code === "number" ? result.code : null;
		if (code !== 0) {
			throw new SubagentError(
				`host '${name}': host discovery probe exited ${code === null ? "without a status" : code} (${text || "no output"}); set the fields by hand in subagents.crossMachine.hosts.${name} (${HOST_FIELD_HINT})`,
				ErrorCodes.START_FAILED,
				{ host: name, discovery: true, code },
			);
		}
		const report = buildDiscoveryReport(parseDiscoveryReport(text));
		if (!parseDiscoveryReport(text).has("PROBE_OK")) {
			throw new SubagentError(
				`host '${name}': host discovery produced no answer (${text || "empty output"}); the remote shell did not reach the end of the probe. Set the fields by hand in subagents.crossMachine.hosts.${name} (${HOST_FIELD_HINT})`,
				ErrorCodes.START_FAILED,
				{ host: name, discovery: true },
			);
		}
		return report;
	};
	if (client !== undefined) return run(client);
	const created = new HcCliClient({ env });
	try {
		await created.start();
		return await run(created);
	} finally {
		created.close();
	}
}

/** How to write the fields by hand, quoted in every discovery error. */
const HOST_FIELD_HINT = `"node" / "piCli" / "piLegionRoot"`;

function discoveryTransportError(host: string, error: unknown): SubagentError {
	const kind = error instanceof HcRpcError ? error.kind : undefined;
	if (kind === "machine_unknown") {
		return new SubagentError(
			`host '${host}' is not a machine this core knows (machine_unknown). Run \`hc machine ls\` here and \`hc machine add --name ${host} ssh://user@that-machine\` if it is missing; legion will not run the child on this host instead.`,
			ErrorCodes.INVALID_PARAMS,
			{ host, unknownHost: true },
		);
	}
	return new SubagentError(
		`host '${host}': host discovery could not run (${describeError(error)}); the machine may be unreachable. Nothing was guessed: set subagents.crossMachine.hosts.${host} by hand (${HOST_FIELD_HINT}) if the machine is meant to be offline`,
		ErrorCodes.START_FAILED,
		{ host, discovery: true, unreachable: true },
	);
}

/**
 * The host's discovery report, from memory, disk or one fresh probe.
 *
 * A FAILED probe is never cached: the next launch must be free to succeed after
 * the operator installs the missing tool. A successful one is cached for
 * {@link DEFAULT_DISCOVERY_TTL_S} seconds, and `refresh` bypasses both caches —
 * which is how a target that upgraded `pi` (moving its bundle to a new release
 * directory) heals without a restart.
 */
export async function discoverHost(
	host: string,
	config: SubagentsSettings["crossMachine"] | undefined,
	options: HostDiscoveryOptions = {},
): Promise<HostDiscoveryReport> {
	const name = normalizeHost(host) ?? "";
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const ttlMs = cacheTtlMs(config, options);
	const useMemory = options.useMemoryCache !== false;
	if (options.refresh !== true && (config?.refresh ?? false) !== true) {
		const memory = useMemory ? DISCOVERY_MEMORY.get(name) : undefined;
		if (memory && memory.expiresAt > now()) {
			return { ...memory.report, source: "memory-cache" };
		}
		if (options.cacheDir !== null) {
			const disk = readDiskCache(name, env, now());
			if (disk) {
				DISCOVERY_MEMORY.set(name, disk);
				return { ...disk.report, source: "disk-cache" };
			}
		}
	}
	const pending = DISCOVERY_INFLIGHT.get(name);
	if (pending !== undefined) return pending;
	const probe = probeHost(name, options);
	DISCOVERY_INFLIGHT.set(name, probe);
	let report: HostDiscoveryReport;
	try {
		report = await probe;
	} finally {
		DISCOVERY_INFLIGHT.delete(name);
	}
	const entry: DiscoveryCacheEntry = { report, expiresAt: now() + ttlMs };
	if (useMemory) DISCOVERY_MEMORY.set(name, entry);
	if (options.cacheDir !== null) writeDiskCache(name, entry, env);
	return report;
}

// ── the machine registry (admission, not configuration) ────────────────────

/** One row of `hc machine ls` / `machine.list`. */
export interface HcMachineEntry {
	name: string;
	kind?: string;
	address?: string;
}

/**
 * Read `machine.list` defensively.
 *
 * The registry is the ADMISSION list ("is this a machine this core knows?"),
 * so a shape this function does not recognize must not become "no machines":
 * it returns `undefined` and the caller falls back to the settings-only rule.
 */
export function parseMachineList(result: unknown): HcMachineEntry[] | undefined {
	const rows = Array.isArray(result)
		? result
		: result !== null && typeof result === "object"
			? ([ (result as Record<string, unknown>).machines, (result as Record<string, unknown>).items, (result as Record<string, unknown>).list, (result as Record<string, unknown>).rows ].find(Array.isArray) as unknown[] | undefined)
			: undefined;
	if (rows === undefined) return undefined;
	const out: HcMachineEntry[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		const record = row !== null && typeof row === "object" ? (row as Record<string, unknown>) : undefined;
		const rawName = typeof row === "string" ? row : record ? [record.name, record.machine, record.host, record.id].find((value) => typeof value === "string" && value.trim().length > 0) : undefined;
		if (typeof rawName !== "string") continue;
		const name = rawName.trim();
		if (name.length === 0 || seen.has(name)) continue;
		seen.add(name);
		out.push({
			name,
			...(record && typeof record.kind === "string" ? { kind: record.kind } : {}),
			...(record && typeof record.address === "string" ? { address: record.address } : {}),
		});
	}
	return out;
}

/**
 * The machines this core knows, or `undefined` when it cannot answer.
 *
 * `undefined` is a THIRD answer and must stay one: an old core without
 * `machine.list` predates registry admission, and turning its "unknown method"
 * into "no machines" would refuse every launch that used to work.
 */
export async function listHcMachines(
	options: HostDiscoveryOptions = {},
): Promise<HcMachineEntry[] | undefined> {
	const env = options.env ?? process.env;
	const key = `${env.HC_BIN ?? "hc"}\u0000${env.HC_SESSION ?? ""}`;
	const now = options.now ?? Date.now;
	if (options.refresh !== true) {
		const cached = MACHINE_LIST_MEMORY.get(key);
		if (cached && cached.expiresAt > now()) return cached.names.map((name) => ({ name }));
	}
	const run = async (client: HcClient): Promise<HcMachineEntry[] | undefined> => {
		try {
			const result = await client.request("machine.list");
			return parseMachineList(result);
		} catch (error) {
			const kind = error instanceof HcRpcError ? error.kind : "";
			const message = error instanceof Error ? error.message : String(error);
			if (/method_not_found|unknown_method|unsupported|not_found|invalid_method/i.test(kind) || /unknown method|not supported|method not found/i.test(message)) {
				return undefined;
			}
			// Any other failure (transport, core restarting) is not evidence about the
			// host: answer "cannot tell" and let `machine.exec` report the machine.
			return undefined;
		}
	};
	let names: string[] | undefined;
	if (options.client !== undefined) {
		const parsed = await run(options.client);
		names = parsed?.map((entry) => entry.name);
	} else {
		const created = new HcCliClient({ env });
		try {
			await created.start();
			const parsed = await run(created);
			names = parsed?.map((entry) => entry.name);
		} finally {
			created.close();
		}
	}
	if (names === undefined) return undefined;
	MACHINE_LIST_MEMORY.set(key, { names, expiresAt: now() + MACHINE_LIST_TTL_MS });
	return names.map((name) => ({ name }));
}

/** A "register it first" refusal that lists what this core DOES know. */
function unknownMachineError(host: string, known: string[]): SubagentError {
	const listing = known.length > 0 ? `\`hc machine ls\` here lists: ${known.join(", ")}` : "`hc machine ls` here lists no machines";
	return new SubagentError(
		`host '${host}' is not a machine this hc core knows (${listing}). Register it first:\n  hc machine add --name ${host} ssh://user@that-machine\n(or use one of the names above). Legion will not run the child on this machine instead.`,
		ErrorCodes.INVALID_PARAMS,
		{ host, unknownHost: true, known },
	);
}

/** What a caller may pass per launch. */
export interface HostResolutionRequest extends HostDiscoveryOptions {
	/** Per-call remote cwd override; absolute on that machine. */
	cwd?: string;
	/** Per-call discovery switch (wins over settings); `false` = explicit only. */
	discover?: boolean;
	/**
	 * When the `hc` registry decides whether this launch may happen at all.
	 *
	 *   - `always` — a NEW launch: the name must be a machine this core knows,
	 *     whether or not the settings describe it (admission and configuration are
	 *     two different questions).
	 *   - `when-unconfigured` (default) — the registry is consulted only when the
	 *     settings say nothing about the host, i.e. it provides the configuration.
	 *   - `never` — resume/read-back of a child that already ran there: the
	 *     machine registration is per `HC_SESSION`, and the operation's own gate
	 *     asks that machine directly with a better message.
	 */
	admission?: "always" | "when-unconfigured" | "never";
}

/**
 * Resolve a host the v1.1 way: admit it through `hc`, fill the holes by probe.
 *
 * Order is deliberate and each step names its own failure:
 *
 *   1. admission — a name this core does not know is refused with the names it
 *      DOES know (and the `hc machine add` line). This is the difference between
 *      "you never registered the machine" and "your settings entry is wrong".
 *   2. cwd — per-call override, else the host default, else a refusal. Never a
 *      guess: not HOME, not the remote core's cwd.
 *   3. discovery — only the fields the entry left empty, only when enabled.
 *      A failed probe that still names a missing field produces an error with
 *      the field, what WAS found, and the JSON to paste.
 *   4. resolution — the pure function above, so every caller (launch, resume,
 *      remote verify, artifact read-back) agrees on the target.
 */
export async function resolveHostTargetAsync(
	host: string,
	config: SubagentsSettings["crossMachine"] | undefined,
	request: HostResolutionRequest = {},
): Promise<HostTarget> {
	const name = normalizeHost(host);
	if (name === undefined) {
		throw new SubagentError(
			"cross-machine launch needs a host name; omit `host` to run on this machine",
			ErrorCodes.INVALID_PARAMS,
		);
	}
	if (config?.enabled === false) {
		throw new SubagentError(
			`host '${name}' needs subagents.crossMachine.enabled = true`,
			ErrorCodes.INVALID_PARAMS,
			{ host: name },
		);
	}
	let entry = config?.hosts?.[name];
	// 1. admission. The `hc` registry is the source of truth EXACTLY when the
	// settings say nothing about the host: that is the "why can't legion just use
	// hc?" case, and the name that travels as `on` is the same name hc knows.
	//
	// A host that DOES have a settings entry keeps the pre-v1.1 rule — the entry
	// is the operator's explicit claim, and a machine registered in another
	// `HC_SESSION` (the runbook's own warning) must not turn every resume of an
	// existing remote child into a refusal. A machine that is genuinely not
	// registered still fails, one step later, with `machine_unknown` and the same
	// `hc machine add` advice.
	const admission = request.admission ?? "when-unconfigured";
	if (admission !== "never" && (admission === "always" || entry === undefined)) {
		const machines = await listHcMachines({ ...request, env: request.env ?? process.env });
		if (machines !== undefined) {
			const known = machines.map((machine) => machine.name);
			if (!known.includes(name)) throw unknownMachineError(name, known);
			// A host the registry knows needs no settings entry at all: `{}` is the
			// normal, minimal configuration (and so is no `hosts` block whatsoever).
			entry ??= {};
		}
	}
	if (entry === undefined) {
		// D1's shape: the ACTION first (one pasteable command), the diagnosis second,
		// and the settings key once as an aside. `machine.list` did not answer, so
		// nothing has confirmed this machine exists — and running the child here
		// instead is exactly the substitution the operator did not ask for.
		throw new SubagentError(
			`host '${name}': register the machine, then retry — hc machine add --name ${name} ssh://user@that-machine. Nothing has confirmed it exists yet: this hc core did not answer \`machine list\`, and there is no entry in subagents.crossMachine.hosts for '${name}' either (an entry like { "cwd": "/abs/path/on/${name}" } works too). Legion will not run the child on this machine instead.`,
			ErrorCodes.INVALID_PARAMS,
			{ host: name, reason: "host-unconfirmed" },
		);
	}
	// 2. cwd is decided BEFORE the probe, so a missing cwd is a cwd error and not
	// a discovery error that happens to mention paths.
	const overrideCwd = typeof request.cwd === "string" ? request.cwd.trim() : "";
	const configuredCwd = typeof entry.cwd === "string" ? entry.cwd.trim() : "";
	const cwd = overrideCwd.length > 0 ? overrideCwd : configuredCwd;
	// D2: the directory on THAT machine is the one input nothing can discover, so
	// it is asked as a question — here, after admission (`machine.list` is one
	// round trip and is allowed) and BEFORE `discoverHost`, so a launch that
	// cannot name its directory costs zero `machine.exec`, no `test -d`, no
	// `--list-models`, and never a guess.
	if (cwd.length === 0) {
		throw new SubagentError(
			missingRemoteCwdQuestion(name),
			ErrorCodes.INVALID_PARAMS,
			{ host: name, cwd: "", reason: "cwd-missing", noModelFallback: true },
		);
	}
	// 3. discovery, only for the holes.
	const discoverEnabled = request.discover ?? entry.discover ?? config?.discover ?? true;
	const hole = (value: string | undefined): boolean => typeof value !== "string" || value.trim().length === 0;
	// `piExtensions` alone does NOT trigger a probe: a pre-v1.1 entry that wrote
	// `cwd`+`node`+`piCli`+`piLegionRoot` is complete, and probing it would change
	// an existing launch for no reason. When a probe runs for another hole, the
	// provider extensions it finds are added only if the key was never written.
	const wantsDiscovery = discoverEnabled && (hole(entry.node) || hole(entry.piCli) || hole(entry.piLegionRoot));
	let report: HostDiscoveryReport | undefined;
	let discovered: DiscoveredHostFields | undefined;
	let used: string[] = [];
	if (wantsDiscovery) {
		try {
			report = await discoverHost(name, config, { ...request, env: request.env ?? process.env });
		} catch (error) {
			// A probe that cannot RUN is not the same fact as a probe that ran and
			// found nothing. When the operator already wrote a workable pre-v1.1
			// entry (an absolute cwd plus at least one program), keep that entry and
			// let the preflight / the four-step resume gate name the machine problem
			// — a resume in a session where the machine is not registered must reach
			// its own gate, not die in discovery.
			const usableLegacy =
				!hole(entry.cwd) &&
				(!hole(entry.node) || !hole(entry.piCli));
			if (!usableLegacy) throw error;
			process.stderr.write(`[pi-legion] host '${name}': ${(error as Error).message}\n`);
		}
		if (report !== undefined) discovered = discoveredFields(report);
		// A field the machine genuinely lacks is a refusal that names the field, the
		// probe's own findings, and the JSON to paste. `piLegionRoot` is exempt: its
		// pre-v1.1 default ("same path as here") is kept, and the preflight names it
		// if that guess is wrong.
		const missing: string[] = [];
		if (hole(entry.node) && discovered?.node === undefined) missing.push("node");
		if (hole(entry.piCli) && discovered?.piCli === undefined) missing.push("piCli");
		if (report !== undefined && discovered !== undefined) {
			const facts = discovered;
			if (missing.length > 0) {
				// A probe that answered "this machine has no node" must not be reused:
				// the operator installs node/pi and retries, and the next launch has to
				// ask again rather than replay the refusal for a whole TTL.
				clearHostDiscoveryCache(name, request.env ?? process.env);
				throw discoveryIncompleteError(name, report, missing, entry.cwd, overrideCwd);
			}
			// Only the fields the RESOLVER will actually use count as discovered: a
			// probe runs for the holes, but an explicit value still wins, and neither
			// `discovered` nor `discovery` may appear on the target because of it.
			used = [
				...(facts.node !== undefined && hole(entry.node) ? ["node"] : []),
				...(facts.piCli !== undefined && hole(entry.piCli) ? ["piCli"] : []),
				...(facts.piLegionRoot !== undefined && hole(entry.piLegionRoot) ? ["piLegionRoot"] : []),
				...(facts.piExtensions !== undefined && entry.piExtensions === undefined ? ["piExtensions"] : []),
			];
			discovered = Object.fromEntries(
				used.map((field) => [field, facts[field as keyof DiscoveredHostFields]]),
			) as DiscoveredHostFields;
			if (used.length === 0) {
				report = undefined;
				discovered = undefined;
			}
		}
	}
	const discoveredList = used;
	const merged: SubagentsSettings["crossMachine"] = {
		enabled: true,
		hosts: { [name]: entry },
		...(config?.discover !== undefined ? { discover: config.discover } : {}),
		...(config?.discoveryTtlSeconds !== undefined ? { discoveryTtlSeconds: config.discoveryTtlSeconds } : {}),
	};
	const resolved = resolveHostTarget(name, merged, {
		...(overrideCwd.length > 0 ? { cwd: overrideCwd } : {}),
		...(discovered ? { discovered } : {}),
		...(discoveredList.length > 0 ? { discoveredFields: discoveredList } : {}),
		...(report
			? {
					discovery: report,
					packageIndex: { packages: report.packages, entries: report.packageEntries },
				}
			: {}),
		mentionPerCallCwd: true,
		...(discoveredList.length > 0
			? {
				rediscover: () => resolveHostTargetAsync(name, config, {
					...request,
					refresh: true,
					client: undefined,
					cwd: overrideCwd.length > 0 ? overrideCwd : request.cwd,
				}),
			}
			: {}),
	});
	// On demand, even for a fully explicit entry: the argv may carry the parent's
	// inherited extensions, and re-rooting them needs the remote package list.
	// `discover: false` is the operator's opt-out (and then an unmappable
	// extension is a refusal, never a silent drop).
	if (discoverEnabled) {
		registerPackageLoader(resolved, async () => {
			try {
				const fresh = await discoverHost(name, config, { ...request, client: undefined });
				return { packages: fresh.packages, entries: fresh.packageEntries };
			} catch {
				return undefined;
			}
		});
	}
	return resolved;
}


/**
 * The "probe ran, field is not there" refusal.
 *
 * Every sentence is load-bearing: what was missing (so the operator knows which
 * key), what the probe DID find (so "is this even the machine I meant?" has an
 * answer), and the exact JSON to paste — because the whole point of v1.1 is
 * that this should almost never be necessary.
 */
function discoveryIncompleteError(
	host: string,
	report: HostDiscoveryReport,
	missing: string[],
	configuredCwd: string | undefined,
	overrideCwd: string,
): SubagentError {
	const cwd = overrideCwd.length > 0 ? overrideCwd : configuredCwd ?? `/abs/path/on/${host}`;
	const fields = missing.map((field) => (field === "node" ? `"node": "/abs/path/on/${host}/bin/node"` : `"piCli": "/abs/path/on/${host}/…/dist/bundle/cli.js"`));
	const example = `"subagents": { "crossMachine": { "hosts": { "${host}": { "cwd": "${cwd}", ${fields.join(", ")} } } } }`;
	const hint = report.pi?.command !== undefined && missing.includes("piCli")
		? `\n\`command -v pi\` there answered ${report.pi.command}, which is not a JavaScript entry node can execute — point \`piCli\` at the bundle (\`…/dist/bundle/cli.js\`), never at the launcher.`
		: "";
	return new SubagentError(
		`host '${host}': host discovery could not find ${missing.join(" / ")} on that machine.\nWhat the probe found:\n${describeDiscovery(report)}\nWrite the missing field by hand and retry:\n  ${example}${hint}`,
		ErrorCodes.INVALID_PARAMS,
		{ host, discovery: true, missing, probe: report },
	);
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
 * The preflight's own bound (S3 requirement): a machine that cannot answer four
 * trivial shell questions in ten seconds is not a machine this launch should wait
 * on. It exists so "the remote exec is unusable" fails in ten seconds with a name,
 * instead of surfacing ten minutes later as a mysterious verify timeout.
 */
export const REMOTE_PREFLIGHT_TIMEOUT_S = 10;

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
	const probe = `${shQuote(target.node)} ${shQuote(target.piCli)} --version >/dev/null 2>&1`;
	// The two sentences are deliberately different: one is a refusal (absolute path we
	// can see and judge), the other is advice (a bare name this script cannot resolve
	// to a verdict).
	const piProbe = path.posix.isAbsolute(target.piCli)
		? `${probe} || { printf '%s\\n' ${shQuote(`piCli ${target.piCli} is not a JavaScript entry point node can execute (every child's argv is [node, piCli, …]; a shell launcher cannot be argv[1])`)} >&2; exit 16; }`
		: `${probe} || printf '%s\\n' ${shQuote(`piCli ${target.piCli} did not answer \`--version\` under node; if it is a launcher, give the absolute bundle cli.js path instead`)} >&2`;
	return [
		`cd -- ${shQuote(target.cwd)} || { printf '%s\\n' ${shQuote(`cwd ${target.cwd} is not a directory`)} >&2; exit 11; }`,
		`command -v ${shQuote(target.node)} >/dev/null 2>&1 || exit 12`,
		`command -v ${shQuote(target.piCli)} >/dev/null 2>&1 || exit 13`,
		// A `piCli` that EXISTS is not necessarily a pi CLI: the release ships a SHELL
		// LAUNCHER (`/root/.pi/agent/bin/pi`, a `case "$0"` wrapper around the bundle).
		// Every child's argv is `[node, piCli, …]`, so pointing `piCli` at the launcher
		// makes node parse shell as JavaScript (`SyntaxError: Unexpected token case`)
		// many layers deeper, where the message names nothing and no exit code points
		// here. Asking the pair to print a version is the cheapest question that
		// separates "a JS entry node can run" from "a file that happens to exist".
		//
		// An ABSOLUTE launcher is fatal (that is the shape the real run hit, and the
		// remote child cannot start at all); a bare name that merely fails this probe is
		// a warning, because `command -v` already proved it resolves and some setups do
		// run a launcher deliberately through their own wrapper.
		piProbe,
		// Review M2: this is the one absolute path EVERY child's argv carries. If it
		// is missing the child either fails to start or starts without the guard
		// extension -- the second is the silent failure, so it is checked here.
		`test -f ${shQuote(path.posix.join(target.piLegionRoot, "index.ts"))} || exit 14`,
		// `hosts.<host>.piExtensions` is read ON that machine and handed to `pi` as
		// `--extension <path>`. A missing entry is not a warning there: `pi` exits 1
		// before its first turn, and the parent only ever sees "no transcript". Asked
		// here, the same fact becomes a refusal that names the file and the key. The
		// path printed to stderr is what `remotePreflight` quotes back, because this
		// script knows WHICH entry failed and the caller does not.
		...target.piExtensions.map((entry) => `test -e ${shQuote(entry)} || { printf '%s\\n' ${shQuote(entry)} >&2; exit 17; }`),
		// D7's second half (m3, review s01): the launch is refused when THAT core
		// already carries legion identity. `terminal.run`'s `env` is a merge-only
		// overlay with no delete semantics, so a child started there would inherit a
		// ledger it cannot open and (worse) look like a node of THIS tree. Asking is
		// the only way to know — `hc` has no "read the core's env" method.
		`if [ -n "${'$'}{PI_LEGION_DB-}" ] || [ -n "${'$'}{PI_LEGION_NODE_ID-}" ]; then printf '%s\\n' ${shQuote("the hc core on that machine already carries legion identity")} >&2; exit 15; fi`,
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
			timeout: REMOTE_PREFLIGHT_TIMEOUT_S,
		});
		directoryExists = probe?.code === 0;
	} catch (error) {
		throw unreachable(target, error);
	}
	if (!directoryExists) {
		throw new SubagentError(
			`host '${target.host}': cwd '${target.cwd}' does not exist on ${target.host} (remote paths are absolute on that machine; local paths are not translated; ${remoteLsHint(target.host, target.cwd)})`,
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
			timeout: REMOTE_PREFLIGHT_TIMEOUT_S,
		});
	} catch (error) {
		throw unreachable(target, error);
	}
	if (result?.timed_out === true) {
		throw new SubagentError(
			`host '${target.host}' unreachable: timed_out: preflight did not finish within ${REMOTE_PREFLIGHT_TIMEOUT_S}s (${execResultText(result) || "no output"})`,
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
			`host '${target.host}': cwd '${target.cwd}' does not exist on ${target.host} (remote paths are absolute on that machine; local paths are not translated; ${remoteLsHint(target.host, target.cwd)})`,
			ErrorCodes.START_FAILED,
			{ host: target.host, cwd: target.cwd },
		);
	}
	if (code === 12) {
		throw new SubagentError(
			// D1: the action first (install it); the settings key appears once, as the
			// fallback for an install that exists but is off that core's PATH.
			`host '${target.host}': node '${target.node}' is not on PATH on ${target.host} — install node there, then retry. If it is installed but off that core's PATH, name it once in subagents.crossMachine.hosts.${target.host}.node.`,
			ErrorCodes.START_FAILED,
			{ host: target.host, node: target.node, code: 12 },
		);
	}
	if (code === 13) {
		throw new SubagentError(
			// Same shape: `install pi there` is the instruction; the settings key is
			// the fallback for a CLI that exists but is off that core's PATH.
			`host '${target.host}': pi CLI '${target.piCli}' is not on PATH on ${target.host} — install pi there, then retry (and put this package on that machine too: hc exec --on ${target.host} -- pi install npm:pi-legion, same entry names are then mapped automatically). Only if an existing CLI is off that core's PATH, name it in subagents.crossMachine.hosts.${target.host}.piCli.`,
			ErrorCodes.START_FAILED,
			{ host: target.host, piCli: target.piCli, code: 13 },
		);
	}
	if (code === 16) {
		throw new SubagentError(
			// Action first: the path to paste, then why the launcher cannot work.
			`host '${target.host}': point piCli at the JS entry node can execute, e.g. /root/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js. piCli '${target.piCli}' is not a JavaScript entry point node can execute: a shell launcher (a path like /root/.pi/agent/bin/pi, a \`case "$0"\` wrapper) cannot be the argv[1] of \`node\` — node parses it as JavaScript and dies with \`SyntaxError: Unexpected token case\`. That path goes in subagents.crossMachine.hosts.${target.host}.piCli.`,
			ErrorCodes.INVALID_PARAMS,
			{ host: target.host, piCli: target.piCli, code: 16 },
		);
	}
	if (code === 15) {
		throw new SubagentError(
			`host '${target.host}': the hc core there already carries legion identity (PI_LEGION_DB / PI_LEGION_NODE_ID), so a child started from it would join a tree it cannot open (D7). Start that core without them, or launch on this machine.`,
			ErrorCodes.INVALID_PARAMS,
			{ host: target.host, remoteIdentity: true },
		);
	}
	if (code === 14) {
		throw new SubagentError(
			// Two ways out, action first: install it there, or — when it IS installed
			// but somewhere else — point piLegionRoot at that root.
			`host '${target.host}': this package is not installed at ${target.piLegionRoot} on that machine — install this package there, then retry: hc exec --on ${target.host} -- pi install npm:pi-legion (every child's argv loads ${path.posix.join(target.piLegionRoot, "index.ts")}). If it is already installed somewhere else on that machine, put that root in subagents.crossMachine.hosts.${target.host}.piLegionRoot.`,
			ErrorCodes.INVALID_PARAMS,
			{ host: target.host, piLegionRoot: target.piLegionRoot, code: 14 },
		);
	}
	if (code === 17) {
		// The script prints the first missing entry to stderr, so the message names the
		// file rather than "one of your piExtensions". A script that printed nothing
		// still has to produce actionable text: fall back to the declared list.
		const missingExtension = execResultText(result).split("\n")[0]?.trim()
			|| target.piExtensions[0]
			|| "(unknown)";
		throw new SubagentError(
			`host '${target.host}': piExtensions entry '${missingExtension}' does not exist on that machine (subagents.crossMachine.hosts.${target.host}.piExtensions is read ON ${target.host}; the child's argv loads it with --extension, so a missing file makes pi exit 1 before its first turn)`,
			ErrorCodes.INVALID_PARAMS,
			{ host: target.host, missingExtension },
		);
	}
	throw new SubagentError(
		`host '${target.host}': preflight failed with exit code ${code} (${execResultText(result) || "no output"})`,
		ErrorCodes.START_FAILED,
		{ host: target.host, code },
	);
}

// ── remote child fate (contract `remote-child-fate-v1` §2) ────────────────

/**
 * What the parent can prove about a remote child it holds no transcript for.
 *
 * `started` — the transcript is there. `no-child` — the terminal is over (or the
 * core never knew it), so nothing more will ever be written. `no-session` — the
 * terminal is alive and simply has not written yet. `path` — the record and the
 * configuration disagree about the mirror dir, so the file may exist somewhere
 * this reader is not looking.
 */
export type RemoteFateClass = "started" | "no-child" | "no-session" | "path";

/** At most this many lines of the mirror dir travel back. */
export const REMOTE_FATE_DIR_LINES = 12;

/** The terminal's own words: at most this many trailing lines. */
export const REMOTE_FATE_SCREEN_LINES = 6;

/**
 * One remote child, as far as this machine can see it.
 *
 * The fields are the EVIDENCE for {@link RemoteChildFate.kind}, not decoration:
 * the parent renders them so an operator can act without attaching to the
 * terminal, and every one of them is something a core actually answered.
 */
export interface RemoteChildFate {
	kind: RemoteFateClass;
	host: string;
	/** `host/name` exactly as the launch addressed it. */
	terminal: string;
	/** `live` | `running` | `idle` | `finished` | `missing` (= the core does not know it). */
	terminalState: string;
	exitCode?: number;
	/**
	 * The pid the core reports for the child's program, when it reports one.
	 *
	 * A terminal can exist with nothing running in it (the core accepted the name
	 * but no program was ever started), and that is a different fault from a child
	 * that ran and stayed silent. `undefined` is not proof of either — it is the
	 * answer this core gave.
	 */
	pid?: number;
	/** Last non-empty lines the child's terminal rendered (its own stderr/stdout). At most 6. */
	screenTail: string[];
	sessionPath: string;
	dir: string;
	dirExists: boolean;
	sessionExists: boolean;
	/** At most 12 lines of the remote dir listing. */
	dirLines: string[];
	/** One sentence, no trailing period. What this class means. */
	summary: string;
	/** One sentence, actionable. Never empty. */
	nextStep: string;
}

/**
 * The frozen anchor sentences (contract §2), one pair per class.
 *
 * They are frozen because they are the only place the product turns a class
 * into an instruction; a reworded sentence is a reworded verdict for whoever
 * reads the parent's output. `<host>` is the single substitution — a config key
 * the operator has to edit is useless without the host they must edit it for.
 */
const REMOTE_FATE_TEXT: Record<RemoteFateClass, { summary: string; nextStep: string }> = {
	"no-child": {
		summary: "the child's terminal ended before it wrote a transcript",
		nextStep:
			"run the command below on that machine: the child's own error is on its terminal, and pi exits before its first turn when a --extension / --model is not usable there",
	},
	"no-session": {
		summary: "the child's terminal is alive but has written no transcript yet",
		nextStep:
			"collect after it reaches a turn, or `status` for liveness — a live terminal with no transcript is not a verdict",
	},
	path: {
		summary: "the record and this configuration disagree about the mirror dir",
		nextStep:
			"the transcript may have landed in the recorded dir; fix `subagents.crossMachine.hosts.<host>.cwd`/`worktreeRoot`, or retire and relaunch the child",
	},
	started: {
		summary: "the transcript exists on that machine",
		nextStep: "—",
	},
};

/** The frozen `nextStep` for one class, with `<host>` resolved to the real host. */
export function remoteFateNextStep(kind: RemoteFateClass, host: string): string {
	return REMOTE_FATE_TEXT[kind].nextStep.split("<host>").join(host);
}

/** The frozen `summary` for one class. */
export function remoteFateSummary(kind: RemoteFateClass): string {
	return REMOTE_FATE_TEXT[kind].summary;
}

/**
 * The shell line that answers "what is on that machine" in one round trip.
 *
 * Three prefixed lines, never prose: the answer has to survive a core that
 * prepends its own warnings to stdout. `dir=` and `session=` are existence
 * facts (`test -d` / `test -e`), and `entry=` repeats the dir listing so an
 * operator can see whether the mirror was ever written. Everything interpolated
 * is `shQuote`d: a mirror path comes from operator settings.
 */
export function remoteChildProbeScript(sessionPath: string): string {
	const dir = path.posix.dirname(sessionPath);
	return [
		`if [ -d ${shQuote(dir)} ]; then printf '%s\\n' dir=1; else printf '%s\\n' dir=0; fi`,
		`if [ -e ${shQuote(sessionPath)} ]; then printf '%s\\n' session=1; else printf '%s\\n' session=0; fi`,
		`ls -A1 ${shQuote(dir)} 2>/dev/null | head -n ${REMOTE_FATE_DIR_LINES} | sed 's/^/entry=/'`,
	].join(" ; ");
}

/** The three facts {@link remoteChildProbeScript} prints, parsed back. */
interface RemoteChildProbeFacts {
	dirExists: boolean;
	sessionExists: boolean;
	dirLines: string[];
}

function parseChildProbeFacts(text: string): RemoteChildProbeFacts {
	let dirExists = false;
	let sessionExists = false;
	const dirLines: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("dir=")) dirExists = line.slice(4) === "1";
		else if (line.startsWith("session=")) sessionExists = line.slice(8) === "1";
		else if (line.startsWith("entry=") && dirLines.length < REMOTE_FATE_DIR_LINES) {
			// A file name is anything after the prefix; it may itself contain `=`.
			dirLines.push(line.slice(6));
		}
	}
	return { dirExists, sessionExists, dirLines };
}

/**
 * The last few lines a terminal rendered, ANSI stripped.
 *
 * This is the child's OWN words — on pi 1.5.2 a startup death is one line
 * (`Error: Failed to load extension …`, `No API key found…`) and that line is
 * the whole answer. Escape sequences are noise in a one-line error, and a TUI's
 * blank padding is not evidence either.
 */
function screenTailOf(screen: unknown): string[] {
	if (typeof screen !== "string" || screen.length === 0) return [];
	const cleaned = screen
		// OSC (title/hyperlink) first: it may contain `[` and would defeat the CSI rule.
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[@-_]/g, "")
		.replace(/\r/g, "");
	return cleaned
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.slice(-REMOTE_FATE_SCREEN_LINES);
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof HcRpcError && /not.?found/i.test(`${error.kind} ${error.message}`);
}

/**
 * Ask the core and the machine what became of one remote child (§2).
 *
 * Two round trips, both already in the whitelist (no new `hc` method): the
 * terminal is the only place the child's own error survives, the shell is the
 * only place its files are visible. The classification order is the contract's
 * and matters: a transcript that exists is `started` no matter what else is
 * odd, and only after that can a dir disagreement, a dead terminal or mere
 * silence be claimed.
 *
 * A `terminal.get` that says `not_found` is a FACT (`terminalState: "missing"`),
 * never an error — the core not knowing the terminal is exactly the state the
 * parent has to render. Every other failure means this probe cannot see enough
 * to classify, so it is thrown and the caller answers `unreachable`; a class
 * invented from a failed read would send the operator to the wrong fix.
 */
export async function probeRemoteChild(opts: {
	client: HcClient;
	target: HostTarget;
	/** `host/name` — the address the core holds, not a bare name (D2). */
	terminal: string;
	sessionPath: string;
	/** The record's persisted mirror dir, when it differs from dirname(sessionPath). */
	recordedDir?: string;
	/**
	 * `true` when `terminal` was RECOMPUTED from the record instead of read from it.
	 *
	 * `terminal.get` answering `not_found` for a name this process invented is not
	 * proof that the child ended: the core may simply hold a different spelling
	 * (a run-scoped prefix, a core-shortened name). Death may only be claimed on an
	 * address the launch really recorded, so an inferred one never yields
	 * `no-child` on its own.
	 */
	terminalInferred?: boolean;
}): Promise<RemoteChildFate> {
	const dir = path.posix.dirname(opts.sessionPath);
	let terminalState = "missing";
	let exitCode: number | undefined;
	let pid: number | undefined;
	let screenTail: string[] = [];
	try {
		const facts = await opts.client.request<{ state?: string; exit_code?: number | null; pid?: number | null; screen?: string }>(
			"terminal.get",
			{ terminal: opts.terminal },
		);
		terminalState = typeof facts?.state === "string" && facts.state.length > 0 ? facts.state : "missing";
		if (typeof facts?.exit_code === "number") exitCode = facts.exit_code;
		if (typeof facts?.pid === "number") pid = facts.pid;
		screenTail = screenTailOf(facts?.screen);
	} catch (error) {
		if (!isNotFoundError(error)) throw error;
	}
	const listing = await opts.client.request<HcExecResult>("machine.exec", {
		on: opts.target.host,
		line: remoteChildProbeScript(opts.sessionPath),
		timeout: REMOTE_PREFLIGHT_TIMEOUT_S,
	});
	const probe = parseChildProbeFacts(execResultText(listing));
	const recorded = typeof opts.recordedDir === "string" ? opts.recordedDir.trim() : "";
	// Death is a claim about the ADDRESS. An inferred name that the core does not
	// know says nothing about the child, so `missing` stops counting as proof there.
	const terminalGone = exitCode !== undefined || terminalState === "finished"
		|| (terminalState === "missing" && opts.terminalInferred !== true);
	const kind: RemoteFateClass = probe.sessionExists
		? "started"
		: recorded.length > 0 && recorded !== dir
			? "path"
			: terminalGone
				? "no-child"
				: "no-session";
	return {
		kind,
		host: opts.target.host,
		terminal: opts.terminal,
		terminalState,
		...(exitCode !== undefined ? { exitCode } : {}),
		...(pid !== undefined ? { pid } : {}),
		screenTail,
		sessionPath: opts.sessionPath,
		dir,
		dirExists: probe.dirExists,
		sessionExists: probe.sessionExists,
		dirLines: probe.dirLines,
		summary: remoteFateSummary(kind),
		nextStep: remoteFateNextStep(kind, opts.target.host),
	};
}

/** `mkdir -p <dir>` on the target — the remote half of D9's two temp dirs. */
/**
 * Best-effort removal of a mirror directory THIS launch created (m10).
 *
 * `hc` has no `file.remove`, so this is a `rm -rf` through `machine.exec`. It is
 * only ever called for a directory whose name this process just made
 * (`ensureRemoteDir` on the same `remoteDir`), and only on a failure path — a
 * successful launch keeps its mirror, because the child reads those files for its
 * whole life.
 */
export async function removeRemoteDir(
	client: HcClient,
	target: HostTarget,
	dir: string,
): Promise<void> {
	await client.request<HcExecResult>("machine.exec", {
		on: target.host,
		argv: ["rm", "-rf", dir],
		timeout: REMOTE_SETUP_TIMEOUT_S,
	});
}

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
/**
 * "Go look at it on that machine" — the command an operator can paste.
 *
 * A remote path that does not exist is the one failure where the fix is almost
 * always "you are thinking of a directory on THIS machine". Naming the exact
 * `hc exec … ls` line turns a settings guess into an observable fact (and the
 * core is already reachable, so it is one cheap call away).
 */
function remoteLsHint(host: string, candidate: string): string {
	return `list it on that machine with \`hc exec --on ${host} -- ls -ld ${candidate}\``;
}

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
			`host '${target.host}': cwd '${target.cwd}' does not exist on ${target.host} (remote paths are absolute on that machine; local paths are not translated; ${remoteLsHint(target.host, target.cwd)}): ${describeError(error)}`,
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
