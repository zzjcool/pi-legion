/**
 * Parent-side RPC dispatch guidance shared by tool descriptions and prompts.
 */

export const PLAYBOOK_NAME = "pi-legion-playbook";

export const PARENT_PLAYBOOK = [
	"Pi Legion playbook (frozen — do not invent a launch recipe):",
	"1. Call the `subagent` tool immediately with the matching role from the roster in this prompt. Do not substitute bash/curl/web fetch for a search or research role.",
	'   One child:  subagent({ agent: "<role>", task: "..." })',
	"   Parallel:   subagent({ tasks: [{ agent, task }, { agent, task }] })",
	"2. Prefer tasks[] for independent parallel work. Child processes are headless RPC children; no pane or tab is created.",
	"3. Then return control. A completion message wakes this session when idle; if it is still working, the notice waits until the current turn ends. Use `wait` when you need blocking results, and `collect` to inspect a child's session JSONL.",
	"4. Later control is only through `subagent({ action, name, message })`; use `stop` to gracefully retire one child or all tracked children. Do not tell a child to message or prompt the parent directly.",
	"5. A collect timeout with a live RPC child is a progress signal, not a verdict. Check status or session JSONL before deciding to steer or resume.",
	"6. Isolation is YOUR call. Pass `worktree: true` when another parent may write this repo or the child must ship via MR; pass `worktree: false` to share the checkout. Omit it for the role default.",
	"7. Launch with `verify: [\"npm run typecheck\", \"npm test\"]` when the project has a mechanical verifier. The extension runs those commands itself in the child worktree at collect time; the child does not need to paste test output.",
	"Utility agents (`utility: true`, e.g. scout) can be dispatched by ANY role via the separate `vexillatio` tool — read-only helpers, always leaf, no depth budget. The `subagent` tool stays for the command chain (worker/centurion).",
	"Forbidden: direct bash access to legion.db, hand-launching child Pi processes, or using herdr pane/tab/agent commands for dispatch.",
].join("\n");

export const TOOL_DESCRIPTION = [
	PARENT_PLAYBOOK,
	"Roles: the system prompt lists every loaded role. Prefer the matching role over doing that work yourself.",
	"Launch is async by default. Outcomes come from the child session JSONL.",
	"Actions: launch (default), continue, steer, resume, status, collect, wait, list, retire, stop. `wait` is event-driven: it returns when a child settles, times out, or the parent turn is aborted; `stop` gracefully retires selected children.",
].join(" ");

/** Split shell commands into sequential chunks while preserving old helper API. */
export function shellChunks(command: string): string[] {
	return command
		.split(/\s*(?:&&|\|\||;|\n)\s*/)
		.map((chunk) => chunk.replace(/\s+/g, " ").trim())
		.filter(Boolean);
}

/** RPC v2 has no herdr dispatch ritual to intercept in parent bash. */
export function forbiddenDispatchReason(_command: string): string | undefined {
	return undefined;
}

export function blockMessage(reason: string): string {
	return `${reason}\n\n${PARENT_PLAYBOOK}`;
}
