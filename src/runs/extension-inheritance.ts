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
}

/**
 * Resolve a package directory to its extension entry points, exactly like pi's
 * own loader: `package.json`'s `pi.extensions` first, then `index.ts`/`index.js`.
 *
 * A directory with neither is not an extension package (a theme pack, a skill
 * bundle) and contributes nothing.
 */
export function resolveExtensionEntries(dir: string): string[] {
	const manifestPath = path.join(dir, "package.json");
	try {
		if (fs.existsSync(manifestPath)) {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
				pi?: { extensions?: unknown };
			};
			const declared = manifest.pi?.extensions;
			if (Array.isArray(declared)) {
				const resolved = declared
					.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
					.map((entry) => path.resolve(dir, entry))
					.filter((entry) => fs.existsSync(entry));
				if (resolved.length > 0) return resolved;
			}
		}
	} catch {
		// Unreadable/invalid manifest: fall through to the index-file convention.
	}
	for (const candidate of ["index.ts", "index.js"]) {
		const entry = path.join(dir, candidate);
		if (fs.existsSync(entry)) return [entry];
	}
	return [];
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
 * A FAILED discovery is deliberately not cached. The previous shape cached `[]`
 * permanently, so one transient `pi list` error disabled inheritance until the
 * process restarted. Only the in-flight slot is dropped, which is what lets the
 * next spawn retry.
 *
 * `env` is handed to `execFile` (a caller can point discovery at a specific
 * PATH); the cache itself is process-wide and does not vary by env.
 */
export async function ensureHostExtensions(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
	if (store.discovered) return store.discovered;
	if (!store.inFlight) {
		store.inFlight = (async () => {
			try {
				const resolved = await resolveHostExtensions(env);
				if (!resolved) return [];
				store.discovered = resolved;
				return resolved;
			} catch {
				// Belt and braces: the contract is "never rejects", and a launch must
				// never fail because the host could not be asked about packages.
				return [];
			} finally {
				// Success caches through `discovered`; failure must leave nothing behind
				// but a cleared in-flight slot, or the retry could never start.
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
