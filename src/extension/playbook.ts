/**
 * Parent-side child dispatch guidance shared by tool descriptions and prompts.
 */

export const PLAYBOOK_NAME = "pi-legion-playbook";

export const PARENT_PLAYBOOK = [
	"Pi Legion playbook (frozen — do not invent a launch recipe):",
	"1. Call the `subagent` tool immediately with the matching role from the roster in this prompt. Do not substitute bash/curl/web fetch for a search or research role.",
	'   One child:  subagent({ agent: "<role>", task: "...", name?: "scout-a" })  // optional name= registers that handle (not auto scout-N)',
	"   Parallel:   subagent({ tasks: [{ agent, task }, { agent, task }] })",
	"2. Prefer tasks[] for independent parallel work. Children are in-process by default; a separate `pi` process is used only when the launch needs a worktree (centurion) or the role pins `spawnMode: rpc`. No pane or tab is created.",
	"3. Then return control. A completion message wakes this session when idle; if it is still working, the notice waits until the current turn ends. Use `wait` with `name` or `all: true` when you need blocking results, and `collect` to inspect a child's session JSONL. Esc / wait interrupt only ends the parent turn's wait — children keep running and settle still notifies; only an explicit `stop` or session exit retires them. A wait interrupted by Esc returns `interrupted (parent turn ended; children still running)`. In `pi --print` or JSON mode, session shutdown waits for live async children to settle (up to each child's turn timeout) before retiring them. Use same-turn `wait`/`collect` or `async: false` when that print turn must include the child's result.",
	"4. Later control is only through `subagent({ action, name?, message? })`; `status` with no name (or `all: true`) overviews live children, with `name` for one child; use `stop` to gracefully retire one child or all tracked children (`force: true` for hard retire when soft stop is insufficient). A `wait` timeout does not stop children — the result lists decisions (`extend` / `steer_again` / `stop` / `force_stop`) for the parent to choose. If a child exits oddly (Model not found, missing tools, memory refused, …), call `subagent({ action: \"diagnose\" })` or ask the user to run `/legion doctor` / `/legion doctor models` — children run without host extensions unless the role inherits them, so a provider package the child needs must be passed explicitly. Do not tell a child to message or prompt the parent directly.",
	"5. A collect timeout with a live child is a progress signal, not a verdict. Check status or session JSONL before deciding to steer or resume.",
	"6. Isolation belongs to centurion. For N parallel isolated writers, dispatch N centurions (each owns one worktree); members stay `worktree: false` in-process. Passing `worktree: true` on a non-centurion warns once and is forced false.",
	"7. Launch with `verify: [\"npm run typecheck\", \"npm test\"]` when the project has a mechanical verifier. The extension runs those commands itself in the child worktree at collect time; the child does not need to paste test output.",
	"Utility agents (`utility: true`, e.g. scout) can be dispatched by ANY role via the separate `vexillatio` tool — read-only helpers, always leaf, no depth budget. The `subagent` tool stays for the command chain (worker/centurion).",
	"Forbidden: direct bash access to legion.db, or launching child Pi processes by hand (use the subagent tool).",
].join("\n");

export const TOOL_DESCRIPTION = [
	PARENT_PLAYBOOK,
	"Roles: the system prompt lists every loaded role. Prefer the matching role over doing that work yourself.",
	"Launch is async by default. Outcomes come from the child session JSONL. In non-interactive `pi --print` / JSON mode, shutdown waits for those children before retiring them; pass `async: false` or call `wait`/`collect` in the same turn to fold the result into the print output.",
	"Actions: launch (default), continue, steer, resume, status, collect, wait, list, retire, stop, diagnose. `status` with no name (or `all: true`) returns a live-children overview; with `name` returns that one child (unknown → NOT_FOUND). `diagnose` prints the Legion doctor report (host vs child extensions/providers/models/memory). `wait` REQUIRES `name` or `all: true` (mutually exclusive); it is event-driven and returns when a child settles, times out, or the parent turn is interrupted; a timeout leaves children running and returns structured decisions for the parent. Esc does not retire children — use `stop` / `stop`+`force:true` (or exit the session) to retire them. Example: `subagent({ action: \"wait\", all: true })` or `subagent({ action: \"wait\", name: \"worker-0\" })`.",
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
