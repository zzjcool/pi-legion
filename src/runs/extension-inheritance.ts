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

/** Host-discovered package extension paths, resolved once per process. */
let discovered: string[] | undefined;
/** In-flight discovery, so concurrent launches share one `pi list`. */
let discovery: Promise<string[]> | undefined;

/** Reset the cache. Test seam only. */
export function resetExtensionDiscoveryCache(): void {
	discovered = undefined;
	discovery = undefined;
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
 * Ask pi which packages are installed and resolve them to extension files.
 *
 * Never throws: a host without `pi` on PATH, or a `pi list` failure, degrades to
 * "no discovered extensions" (children still get their explicit list plus the
 * child-guard). Failure to discover must not fail a launch.
 */
export async function discoverHostExtensions(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
	if (discovered) return discovered;
	discovery ??= (async () => {
		let dirs: string[] = [];
		try {
			const { stdout } = await execFileAsync("pi", ["list"], {
				env,
				timeout: 15_000,
				maxBuffer: 4 * 1024 * 1024,
			});
			dirs = parsePiList(stdout);
		} catch {
			dirs = [];
		}
		const entries = dirs.flatMap((dir) => resolveExtensionEntries(dir));
		const seen = new Set<string>();
		discovered = entries.filter((entry) => {
			const key = path.resolve(entry);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		return discovered;
	})();
	return discovery;
}

/** Synchronous read of whatever discovery has already produced. */
export function discoveredHostExtensions(): string[] | undefined {
	return discovered;
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
