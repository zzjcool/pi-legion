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
 * Run one `pi list` and resolve it to extension entry paths.
 *
 * Returns `undefined` when discovery itself failed (no `pi` on PATH, non-zero
 * exit, timeout) so the caller can distinguish "nothing installed" from "could
 * not ask" — only the latter must stay retryable.
 */
async function resolveHostExtensions(env: NodeJS.ProcessEnv): Promise<string[] | undefined> {
	let dirs: string[];
	try {
		const { stdout } = await execFileAsync("pi", ["list"], {
			env,
			timeout: 15_000,
			maxBuffer: 4 * 1024 * 1024,
		});
		dirs = parsePiList(stdout);
	} catch {
		return undefined;
	}
	const entries = dirs.flatMap((dir) => resolveExtensionEntries(dir));
	const seen = new Set<string>();
	return entries.filter((entry) => {
		const key = path.resolve(entry);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
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
 * `env` is handed to `execFile` (a caller can point discovery at a specific
 * PATH); the cache itself is process-wide and does not vary by env.
 */
export async function ensureHostExtensions(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
	if (store.discovered) return store.discovered;
	if (store.failedAt !== undefined && Date.now() - store.failedAt < FAILURE_TTL_MS) return [];
	if (!store.inFlight) {
		store.inFlight = (async () => {
			try {
				const resolved = await resolveHostExtensions(env);
				if (!resolved) {
					store.failedAt = Date.now();
					return [];
				}
				store.discovered = resolved;
				// A success supersedes any earlier failure, so the backoff stamp must not
				// outlive it — otherwise a later re-probe (after a reset) would inherit an
				// unrelated window.
				delete store.failedAt;
				return resolved;
			} catch {
				// Belt and braces: the contract is "never rejects", and a launch must
				// never fail because the host could not be asked about packages.
				store.failedAt = Date.now();
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
