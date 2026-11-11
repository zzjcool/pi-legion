import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";

/** A host `create*ToolDefinition` result: the object carrying `renderShell` / `renderCall` / `renderResult`. */
type ToolDefinitionFactory = (cwd: string) => object;

/**
 * Host tool name → the public definition factory that owns that tool's renderers (D1). The built-in
 * `renderCall` / `renderResult` / `renderShell` of the definition are handed to
 * `ToolExecutionComponent` as-is — no wrapping, no re-implementation, so the viewer draws exactly
 * what the main TUI draws.
 *
 * Only the host package root is imported: its `exports` map exposes `dist/index.js` alone, and
 * `createAllToolRenderers` is not exported there.
 */
const BUILTIN_RENDERER_FACTORIES: Readonly<Record<string, ToolDefinitionFactory>> = {
	bash: (cwd) => createBashToolDefinition(cwd),
	read: (cwd) => createReadToolDefinition(cwd),
	edit: (cwd) => createEditToolDefinition(cwd),
	write: (cwd) => createWriteToolDefinition(cwd),
	grep: (cwd) => createGrepToolDefinition(cwd),
	find: (cwd) => createFindToolDefinition(cwd),
	ls: (cwd) => createLsToolDefinition(cwd),
	// PowerShell only exists on win32; elsewhere the host does not register the tool at all, so a
	// session recorded on Windows still falls back to the generic block here.
	...(process.platform === "win32" ? { powershell: (cwd: string) => createPowerShellToolDefinition(cwd) } : {}),
};

/** Per-cwd lazy cache: one process keeps at most one definition per (cwd, tool) pair. */
const RENDERER_CACHES = new Map<string, Map<string, ToolRenderers>>();
/**
 * A Legion run gives every node its own worktree, so `cwd` is effectively unbounded over a long
 * session (a viewer is also opened per node). Definitions are cheap but permanent, so the oldest
 * cwd is evicted once the table fills; an already-open viewer keeps its own reference to the map and
 * is unaffected.
 */
const MAX_CACHED_RENDERER_CWDS = 8;

/**
 * Build a tool-name → renderers lookup for one working directory (D1).
 *
 * Definitions are built on first use and cached, so opening a viewer costs nothing for tool names
 * that never appear in the transcript. Unknown tool names return `undefined` and keep the host's
 * generic JSON block (D12: the host's missing duration in that fallback is not ours to fix).
 */
export function createToolRendererLookup(cwd: string): (toolName: string) => ToolRenderers | undefined {
	let cache = RENDERER_CACHES.get(cwd);
	if (!cache) {
		if (RENDERER_CACHES.size >= MAX_CACHED_RENDERER_CWDS) {
			const oldest = RENDERER_CACHES.keys().next().value;
			if (oldest !== undefined) RENDERER_CACHES.delete(oldest);
		}
		cache = new Map<string, ToolRenderers>();
		RENDERER_CACHES.set(cwd, cache);
	}
	const perCwd = cache;
	return (toolName) => {
		if (typeof toolName !== "string" || toolName.length === 0) return undefined;
		const cached = perCwd.get(toolName);
		if (cached) return cached;
		if (!Object.prototype.hasOwnProperty.call(BUILTIN_RENDERER_FACTORIES, toolName)) return undefined;
		const factory = BUILTIN_RENDERER_FACTORIES[toolName];
		if (!factory) return undefined;
		let renderers: ToolRenderers;
		try {
			// `ToolRenderers` erases a tool's argument type to `unknown` while a definition keeps its
			// concrete `Static<TParams>`, so the two only meet under this widening — the three methods,
			// though, are exactly the ones the definition exposes.
			renderers = factory(cwd) as ToolRenderers;
		} catch {
			// A viewer must never fail to paint because one definition could not be built.
			return undefined;
		}
		perCwd.set(toolName, renderers);
		return renderers;
	};
}
