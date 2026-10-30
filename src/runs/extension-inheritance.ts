/**
 * Which extensions a child session loads (#280).
 *
 * Policy has flipped. Children used to load extensions only when a role card
 * opted in (`inheritExtensions: true`) or an operator set
 * `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1`. #43 made that the default because a
 * heavy host extension (an LSP stack) cost ~1 GB per child, and at the time
 * every child was a separate process.
 *
 * Two things changed that reasoning:
 *
 *   - children are in-process by default now (#279), so "one more extension per
 *     child" no longer means another process's worth of memory
 *   - the opt-in list was per-role and hand-maintained, so in practice children
 *     silently lost host capabilities (a provider extension, a guard) that the
 *     role never knew to name
 *
 * The default is therefore "inherit everything the parent has", with two ways to
 * narrow it: `excludeExtensions` (subtract specific ones) and
 * `inheritExtensions: false` (load only what the card lists explicitly).
 *
 * Where the parent's list comes from: pi exposes no "list loaded extensions"
 * API, and `pi list` reports only package DIRECTORIES. So discovery resolves
 * each directory the same way pi's own loader does — `package.json`'s
 * `pi.extensions`, else `index.ts`/`index.js` — and caches the result for the
 * process. That covers package-shaped extensions, which is what `pi list`
 * reports; single-file `--extension` arguments and builtins are not discoverable
 * this way and must still be named explicitly (documented limitation, #280).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentConfig } from "../shared/types.ts";

/** Env kill-switch, shared with the rpc path. Kept here to avoid a cycle. */
const CHILD_INHERIT_EXTENSIONS_ENV = "PI_LEGION_CHILD_INHERIT_EXTENSIONS";

/**
 * Whether a child loads the host's discovered extensions (#280).
 *
 * Default TRUE: a child starts from everything the parent has and narrows from
 * there. `inheritExtensions: false` on the card, or the env var, loads only the
 * card's own list. The env var accepts either polarity so an operator can flip
 * the whole tree without editing every card.
 *
 * Duplicated in `args.ts` (which re-exports it for the rpc argument builder)
 * rather than imported, because `args.ts` already imports this module.
 */
export function childInheritsExtensions(
	agent: Pick<AgentConfig, "inheritExtensions">,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (agent.inheritExtensions === false) return false;
	const raw = env[CHILD_INHERIT_EXTENSIONS_ENV]?.trim().toLowerCase();
	if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
	if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
	return true;
}

const execFileAsync = promisify(execFile);

/**
 * Where the discovery cache lives: `globalThis` under `Symbol.for(...)`.
 *
 * A module-level `let` would be invisible to the other module *instances* in
 * this process. A child's `--extension` load re-evaluates this module with
 * `moduleCache: false`, and `/reload` plus a cwd change clear pi's extension
 * cache, so each re-evaluation would start from an empty cache and throw away
 * the parent's warm result — "discover once per process" would degrade to
 * "discover once per module instance", and a child spawned from a re-loaded
 * instance would silently inherit nothing.
 *
 * `Symbol.for` is registry-backed and `globalThis` survives re-evaluation; the
 * same escape hatch is used by `supervisor/child-context.ts`,
 * `supervisor/inprocess-depth.ts` and `supervisor/admission-queue.ts` for the
 * same reason.
 *
 * Do NOT turn this back into a module-level variable, and do not re-assign the
 * holder in `resetExtensionDiscoveryCache` — two module instances would then
 * point at two different holders and the reset would silently stop working.
 */
const STORE_KEY = Symbol.for("pi-legion.extension-discovery");

interface DiscoveryStore {
	/** Resolved extension list, or undefined until a discovery succeeds. */
	discovered?: string[];
	/** In-flight discovery, so concurrent launches share one `pi list`. */
	inFlight?: Promise<string[]>;
	/**
	 * When the last discovery FAILED, in `Date.now()` terms.
	 *
	 * A failure is still not cached as `[]` (F23: one blip must not disable
	 * inheritance until restart), but every caller is not allowed to re-probe
	 * either: three warm-up points (router, rpc backend, in-process backend) turn
	 * one spawn into two `pi list` calls when each of them retries. This stamp is
	 * the short memory that makes the retry storm impossible while keeping the
	 * failure recoverable — see `FAILURE_TTL_MS`.
	 */
	failedAt?: number;
}

/** Symbol-indexed view of globalThis so the cache survives module re-evaluation. */
type StoreHolder = { [key: symbol]: DiscoveryStore | undefined };

// SAFETY: `globalThis` is an object, so a `Symbol.for`-keyed property on it is
// readable; the only invariant TypeScript cannot check is that whoever wrote
// that slot first stored a `DiscoveryStore`. Both sides of that contract live in
// this file, so the declared slot type is authoritative.
const store = ((globalThis as unknown as StoreHolder)[STORE_KEY] ??= {});

/**
 * Reset the cache. Test seam only.
 *
 * Clears the holder's FIELDS rather than replacing the holder: a replacement
 * would be invisible to every other module instance still pointing at the old
 * object (the exact failure mode the shared holder exists to prevent).
 */
export function resetExtensionDiscoveryCache(): void {
	delete store.discovered;
	delete store.inFlight;
	// The failure stamp is part of the cache: leaving it behind would make the
	// next case inherit this one's backoff and silently skip its `pi list`.
	delete store.failedAt;
}

/**
 * Expand one declared `pi.extensions` entry into loadable files (#280 R1-a).
 *
 * A manifest may name a DIRECTORY (`pi.extensions: ["./extensions"]` — that is
 * what `pi-diff-review` ships). Handing that path to `pi -e` is fatal: pi's
 * loader requires an entry point and exits 1 with `Failed to load extension:
 * Cannot find module`. So a directory is resolved the way pi's own
 * `discoverAndLoadExtensions` resolves an explicitly configured path: the
 * directory's own `pi.extensions`, else its `index.ts`/`index.js`, else the
 * `*.ts`/`*.js` files sitting directly in it.
 *
 * `allowNestedManifest` bounds the walk to one extra level: a nested package's
 * manifest is read, but the directories IT declares expand to their files
 * instead of recursing again. Without that bound a manifest declaring `"./"`
 * would re-enter itself forever.
 *
 * Returns `[]` when nothing loadable is inside, so the caller can DROP the entry
 * rather than emit a path that cannot be loaded.
 */
function expandDeclaredEntry(entry: string, allowNestedManifest: boolean): string[] {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(entry);
	} catch {
		return [];
	}
	if (stat.isFile()) return [entry];
	if (!stat.isDirectory()) return [];
	if (allowNestedManifest) {
		const nested = resolveExtensionEntries(entry, false);
		if (nested.length > 0) return nested;
	}
	const index = indexEntryIn(entry);
	if (index) return [index];
	// The sweep inherits the same depth budget: a declared directory reached from
	// inside a nested resolution may list its own files, but must not descend into
	// subdirectories again (otherwise a manifest declaring `"./"` deep in the tree
	// would walk without a bound).
	return discoverExtensionFiles(entry, allowNestedManifest);
}

/** `<dir>/index.ts`, else `<dir>/index.js`, else undefined. */
function indexEntryIn(dir: string): string | undefined {
	for (const candidate of ["index.ts", "index.js"]) {
		const entry = path.join(dir, candidate);
		if (fs.existsSync(entry)) return entry;
	}
	return undefined;
}

/**
 * Sweep a declared directory the way pi's `collectAutoExtensionEntries` does.
 *
 * Same shape as pi, because anything less silently loses extensions:
 *
 *   - `.`-prefixed entries and `node_modules` are skipped (pi skips both; a
 *     dotfile such as `.eslintrc.js` is never an entry point)
 *   - a `*.ts`/`*.js` file is collected as-is
 *   - a subdirectory is resolved as a package of its own, which is what makes
 *     the documented `extensions/<name>/index.ts` layout loadable at all; a
 *     subdirectory that resolves to nothing contributes nothing
 *
 * `allowNestedDirs` is the depth bound. pi stops after one level
 * (`collectAutoExtensionEntries` → `resolveExtensionEntries` → no further), and
 * so do we: the top-level sweep may resolve subdirectories, but a directory
 * reached from inside a nested resolution sweeps files only. That keeps a
 * mistyped or self-declaring path from becoming an unbounded walk.
 *
 * Sorted, so the child's argv is stable between runs and platforms.
 */
function discoverExtensionFiles(dir: string, allowNestedDirs: boolean): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const full = path.join(dir, entry.name);
		let isFile = entry.isFile();
		let isDir = entry.isDirectory();
		if (entry.isSymbolicLink()) {
			try {
				const stats = fs.statSync(full);
				isFile = stats.isFile();
				isDir = stats.isDirectory();
			} catch {
				continue;
			}
		}
		if (isFile) {
			if (/\.(ts|js)$/.test(entry.name)) files.push(full);
			continue;
		}
		if (isDir && allowNestedDirs) {
			// `allowNestedManifest: false` is the gate: the nested resolution sweeps
			// files but never descends into subdirectories itself.
			files.push(...resolveExtensionEntries(full, false));
		}
	}
	return files.sort();
}

/**
 * Resolve a package directory to its extension entry points, exactly like pi's
 * own loader: `package.json`'s `pi.extensions` first, then `index.ts`/`index.js`.
 *
 * Declared entries may themselves be directories (R1-a); those expand into
 * loadable files, and an entry that expands to nothing is dropped so the caller
 * never sees a path `pi -e` would refuse. Every returned path is a file.
 *
 * A directory with neither is not an extension package (a theme pack, a skill
 * bundle) and contributes nothing.
 */
export function resolveExtensionEntries(dir: string, allowNestedManifest = true): string[] {
	const manifestPath = path.join(dir, "package.json");
	try {
		if (fs.existsSync(manifestPath)) {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
				pi?: { extensions?: unknown };
			};
			const declared = manifest.pi?.extensions;
			if (Array.isArray(declared)) {
				// R1-a: directories expand; empty expansions are dropped. Only files
				// reach the caller, because that is all `-e` can load. Deduped because a
				// manifest may name both a directory and a file inside it.
				const resolved: string[] = [];
				const seen = new Set<string>();
				for (const entry of declared) {
					if (typeof entry !== "string" || entry.length === 0) continue;
					for (const file of expandDeclaredEntry(path.resolve(dir, entry), allowNestedManifest)) {
						if (seen.has(file)) continue;
						seen.add(file);
						resolved.push(file);
					}
				}
				if (resolved.length > 0) return resolved;
			}
		}
	} catch {
		// Unreadable/invalid manifest: fall through to the index-file convention.
	}
	const index = indexEntryIn(dir);
	return index ? [index] : [];
}

/** Parse `pi list` output into the package directories it reports. */
export function parsePiList(output: string): string[] {
	const dirs: string[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		// Package dirs are the indented absolute paths; headers are `User packages:`
		// and `npm:name@version` lines carry no leading slash.
		if (!line.startsWith("/")) continue;
		dirs.push(line);
	}
	return dirs;
}

/**
 * How much of `pi list`'s stderr the one-shot warning may echo.
 *
 * The warning has to be actionable (#317: "could not ask" used to look exactly
 * like "nothing installed"), but it is also a single log line that must not turn
 * a stack trace into the operator's terminal.
 */
export const DISCOVERY_STDERR_LIMIT = 200;

/** Best-effort text of an unknown error field: never throws. */
function asText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	try {
		return String(value);
	} catch {
		return "";
	}
}

/**
 * One bounded line explaining why a probe failed.
 *
 * `pi list` can fail with no stderr at all (a killed child, a bare `exit 4`), so
 * the summary degrades through stderr → exit code → `error.message`. The code
 * sits BEFORE the message on purpose: Node's `execFile` always fills `message`
 * with `Command failed: pi list`, so a message-first order would make the exit
 * code branch unreachable — and `pi list exited 4` says more than the generic
 * wrapper text. A non-numeric code (`ENOENT`) still falls through to the message
 * (`spawn pi ENOENT`), which is the actionable one there. It must never throw: a
 * warning is not allowed to fail a launch (#317).
 */
function describeProbeFailure(error: unknown): string {
	const err = error as { stderr?: unknown; message?: unknown; code?: unknown } | undefined;
	const stderr = asText(err?.stderr).replace(/\s+/g, " ").trim();
	if (stderr) {
		return stderr.length > DISCOVERY_STDERR_LIMIT ? `${stderr.slice(0, DISCOVERY_STDERR_LIMIT)}…` : stderr;
	}
	if (typeof err?.code === "number") return `pi list exited ${err.code} with no stderr`;
	const message = asText(err?.message).replace(/\s+/g, " ").trim();
	if (message) {
		return message.length > DISCOVERY_STDERR_LIMIT ? `${message.slice(0, DISCOVERY_STDERR_LIMIT)}…` : message;
	}
	return "pi list failed with no output";
}

/** One probe's outcome: resolved entries, or the reason the probe could not answer. */
type DiscoveryProbe = { ok: true; entries: string[] } | { ok: false; reason: string };

/**
 * Run one `pi list` and resolve it to extension entry paths.
 *
 * Returns a failure (with a short reason) when discovery itself failed — no `pi`
 * on PATH, non-zero exit, timeout — so the caller can both distinguish "nothing
 * installed" from "could not ask" and say which one happened (#317). Only the
 * latter stays retryable.
 */
async function resolveHostExtensions(env: NodeJS.ProcessEnv): Promise<DiscoveryProbe> {
	let dirs: string[];
	try {
		const { stdout } = await execFileAsync("pi", ["list"], {
			env,
			timeout: 15_000,
			maxBuffer: 4 * 1024 * 1024,
		});
		dirs = parsePiList(stdout);
	} catch (error) {
		return { ok: false, reason: describeProbeFailure(error) };
	}
	const entries = dirs.flatMap((dir) => resolveExtensionEntries(dir));
	const seen = new Set<string>();
	return {
		ok: true,
		entries: entries.filter((entry) => {
			const key = path.resolve(entry);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
	};
}

/**
 * How long a FAILED discovery is remembered, in milliseconds.
 *
 * A failure cannot be cached as `[]` (F23), but it cannot be re-probed by every
 * caller either: three warm-up points sit on one spawn (router + rpc backend +
 * in-process backend), so an always-failing host pays twice per spawn today, and
 * `pi list` costs 0.3–0.9 s measured (up to its 15 s timeout in the worst case) —
 * before the memory gate even runs.
 *
 * 5 s covers every warm call of the same spawn with a wide margin (they are
 * tens of milliseconds apart at most) while staying short enough that a
 * transient failure costs a bounded window, not the process lifetime. Measured
 * `pi list` latency (0.3–0.9 s) makes 5 s roughly one order of magnitude above a
 * single probe, i.e. a retry is never more than a few spawns away.
 */
export const FAILURE_TTL_MS = 5_000;

/**
 * Record a failed probe (the `failedAt` backoff stamp) and warn ONCE.
 *
 * The stamp doubles as the "already told the operator" bit (#317): while it is
 * set, a later failing probe updates the time but stays quiet, so a host that
 * will never have `pi list` working cannot flood the log once per spawn.
 *
 * Scope of "once": one warning per PROCESS. A successful probe caches through
 * `discovered`, and `ensureHostExtensions` short-circuits on that forever — so
 * once discovery has worked there is no further probe to fail, and the stamp
 * being deleted on success cannot produce a second warning in production. The
 * only way back is `resetExtensionDiscoveryCache`, which is a test seam and also
 * clears the stamp, i.e. a genuinely fresh start. No extra state is needed for
 * this bound (the frozen backoff already models exactly this window).
 *
 * Never throws: the warning itself must not be able to fail a launch, and an
 * empty `pi list` stderr must not turn into a TypeError here.
 */
function noteDiscoveryFailure(reason: string): void {
	const alreadyReported = store.failedAt !== undefined;
	store.failedAt = Date.now();
	if (alreadyReported) return;
	const retryS = Math.round(FAILURE_TTL_MS / 1000);
	try {
		console.error(
			`[pi-legion] host extension discovery failed (pi list): ${reason}. ` +
				`Children get 0 inherited extensions until a probe succeeds (next attempt after ${retryS}s); ` +
				"run `/legion doctor` (Extensions) or set PI_LEGION_CHILD_EXTENSIONS=<paths> to load them explicitly.",
		);
	} catch {
		// A log line that cannot be written must not break the spawn either.
	}
}

/**
 * Discover the host's extensions once per process and return them.
 *
 * Idempotent and concurrency-safe: the first caller runs `pi list`, concurrent
 * callers await the same in-flight promise, and once resolved every later call
 * returns the cache without spawning anything.
 *
 * Never throws and never rejects: a host without `pi`, or a failing `pi list`,
 * degrades to `[]` (children still get their explicit list plus the
 * child-guard). Failure to discover must not fail a launch.
 *
 * A FAILED discovery is deliberately not cached as `[]`. The previous shape
 * cached `[]` permanently, so one transient `pi list` error disabled inheritance
 * until the process restarted. Instead the failure stamps `failedAt` and calls
 * inside `FAILURE_TTL_MS` short-circuit to `[]` without a probe — the backoff
 * that keeps the three warm-up points idempotent (R2-b). Once the stamp ages out,
 * the next call probes again, so a failure is never a permanent off switch (F23).
 *
 * #317 adds visibility only: the failure is now also reported once (see
 * `noteDiscoveryFailure`) and is readable through `hostExtensionDiscoveryState`.
 * Neither the never-reject contract nor the backoff semantics changed.
 *
 * `env` is handed to `execFile` (a caller can point discovery at a specific
 * PATH); the cache itself is process-wide and does not vary by env.
 */
export async function ensureHostExtensions(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
	if (store.discovered) return store.discovered;
	if (store.failedAt !== undefined && Date.now() - store.failedAt < FAILURE_TTL_MS) return [];
	if (!store.inFlight) {
		store.inFlight = (async () => {
			try {
				const probe = await resolveHostExtensions(env);
				if (!probe.ok) {
					noteDiscoveryFailure(probe.reason);
					return [];
				}
				store.discovered = probe.entries;
				// A success supersedes any earlier failure, so the backoff stamp must not
				// outlive it — otherwise a later re-probe (after a reset) would inherit an
				// unrelated window.
				delete store.failedAt;
				return probe.entries;
			} catch (error) {
				// Belt and braces: the contract is "never rejects", and a launch must
				// never fail because the host could not be asked about packages.
				noteDiscoveryFailure(describeProbeFailure(error));
				return [];
			} finally {
				// Success caches through `discovered`; failure leaves the `failedAt`
				// stamp behind (the backoff) plus a cleared in-flight slot, or the
				// retry could never start.
				delete store.inFlight;
			}
		})();
	}
	return store.inFlight;
}

/**
 * Historical name for the same resolver; kept for callers that still use it.
 *
 * Aliased rather than wrapped so both names are literally one function: a
 * second `async` wrapper would only add a promise layer and a second identity
 * for the same cache.
 */
export const discoverHostExtensions = ensureHostExtensions;

/** Synchronous read of whatever discovery has already produced. */
export function discoveredHostExtensions(): string[] | undefined {
	return store.discovered;
}

/**
 * What this process knows about host extension discovery, read-only (#317).
 *
 * Exists because `discoveredHostExtensions() ?? []` collapses two different
 * situations into one empty array: "the host really ships no package extensions"
 * and "we could not ask" (and a third: "we never asked"). A caller that wants to
 * tell them apart — `/legion doctor` does — reads this instead of guessing.
 *
 * Pure in-memory read: no probe, no subprocess. That is deliberate, so doctor
 * can report `never` without silently kicking off a 0.3–0.9 s `pi list`.
 */
export interface HostExtensionDiscoveryState {
	/** `ok` = a probe succeeded (count is the resolved set, possibly 0). */
	status: "ok" | "failed" | "unknown";
	/** Entries the last successful probe resolved; 0 unless `status` is `ok`. */
	count: number;
	/** `Date.now()` of the last FAILED probe (only set when `status` is `failed`). */
	at?: number;
}

export type HostExtensionDiscoveryStatus = HostExtensionDiscoveryState["status"];

/**
 * Read the discovery state without changing it.
 *
 * A success wins over a stale stamp on purpose: `ensureHostExtensions` deletes
 * `failedAt` on success, so both being set only means a reset raced a re-probe —
 * the cache is the newer truth either way.
 */
export function hostExtensionDiscoveryState(): HostExtensionDiscoveryState {
	if (store.discovered !== undefined) return { status: "ok", count: store.discovered.length };
	if (store.failedAt !== undefined) return { status: "failed", count: 0, at: store.failedAt };
	return { status: "unknown", count: 0 };
}

/**
 * Does this extension match an `excludeExtensions` entry?
 *
 * Both spellings are accepted because they answer different questions and both
 * are natural to write:
 *
 *   - a PATH (`/abs/.../index.ts`, `./relative`, `~/...`) compares resolved
 *     paths, so an exact file can be excluded
 *   - a NAME (`pi-lens`, `pi-any-endpoint`) compares against the containing
 *     package directory name, so a package can be excluded without knowing its
 *     entry layout
 *
 * A bare name never matches by path, and a path never matches by name, so the
 * two cannot interfere.
 */
export function matchesExcludedExtension(extension: string, exclude: string): boolean {
	const target = exclude.trim();
	if (!target) return false;
	const isPathLike = target.startsWith("/") || target.startsWith("./") || target.startsWith("../") || target.startsWith("~");
	if (isPathLike) {
		const expanded = target.startsWith("~") ? path.join(process.env.HOME ?? "", target.slice(1)) : target;
		return path.resolve(extension) === path.resolve(expanded);
	}
	// Name form: match the package directory that contains the entry file, or the
	// entry file's own basename for a loose `foo.ts`.
	const ext = extension.trim();
	if (ext === target) return true;
	const parts = path.resolve(ext).split(path.sep);
	// `.../node_modules/<name>/...` — the package dir is the segment after node_modules.
	const nodeModulesAt = parts.lastIndexOf("node_modules");
	if (nodeModulesAt >= 0 && parts[nodeModulesAt + 1] === target) return true;
	// `.../<name>/extensions/index.ts` or `.../<name>/index.ts`.
	const file = parts.at(-1) ?? "";
	const dir = parts.at(-2) ?? "";
	if (dir === target) return true;
	if (file === `${target}.ts` || file === `${target}.js`) return true;
	return false;
}

/**
 * The extensions a child should load explicitly.
 *
 * `inherit: false` (role card opted out) loads ONLY the card's own list. The
 * default additionally carries every discovered host extension minus
 * `excludeExtensions`. The child-guard is appended by the caller and is never
 * subject to this policy — a child that skips it would lose the prompt/format
 * contract regardless of what the card asked for.
 */
export function inheritedExtensions(
	agent: Pick<AgentConfig, "inheritExtensions" | "excludeExtensions">,
	host: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	// `inheritExtensions: false` (card) or the env kill-switch both mean "load
	// only what the card names". Checked here rather than at the call sites so
	// rpc and in-process cannot drift apart.
	if (!childInheritsExtensions(agent, env)) return [];
	const excluded = agent.excludeExtensions ?? [];
	if (excluded.length === 0) return [...host];
	return host.filter((ext) => !excluded.some((pattern) => matchesExcludedExtension(ext, pattern)));
}
