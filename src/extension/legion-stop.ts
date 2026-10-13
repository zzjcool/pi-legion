/**
 * User-facing stop controls for live subagents:
 *   - `/legion stop` (all) / `/legion stop <name>` — thin wrapper over the
 *     subagent tool's `stop` action (graceful retire; a retired parent's own
 *     session shutdown retires its subtree, so stopping a parent cascades).
 *   - Esc while the main agent is idle, the editor is empty and children are
 *     live → confirm → stop all.
 *   - `x` on the selected agent in the /legion view → confirm → stop it.
 * Everything here is pure/injectable so it can be unit tested.
 */

export interface StopJob {
	name: string;
	nodeId?: string;
	state: string;
}

export interface StopNode {
	id: string;
	name: string;
	parentId: string | null;
	depth: number;
	status: string;
}

export type StopTarget =
	| { kind: "all" }
	| { kind: "job"; name: string }
	/** A live descendant owned by a child session; only its owning child can be stopped from here. */
	| { kind: "nested"; label: string; owner: string }
	| { kind: "notFound"; query: string };

const TERMINAL = new Set(["settled", "failed", "retired"]);

export function liveJobs(jobs: readonly StopJob[]): StopJob[] {
	return jobs.filter((job) => job.state !== "retired");
}

function isLiveNode(node: StopNode): boolean {
	return !TERMINAL.has(node.status);
}

/** "parent/name" label used by the viz to disambiguate duplicate names. */
export function nodeLabel(node: StopNode, byId: ReadonlyMap<string, StopNode>): string {
	const parent = node.parentId ? byId.get(node.parentId) : undefined;
	return parent && node.depth > 1 ? `${parent.name}/${node.name}` : node.name;
}

function jobForNode(node: StopNode, live: readonly StopJob[]): StopJob | undefined {
	return live.find((job) => job.nodeId === node.id) ?? (node.depth <= 1 ? live.find((job) => !job.nodeId && job.name === node.name) : undefined);
}

export function resolveStopTarget(arg: string, jobs: readonly StopJob[], nodes: readonly StopNode[]): StopTarget {
	const query = arg.trim();
	if (query === "" || query === "all") return { kind: "all" };
	const live = liveJobs(jobs);
	const direct = live.find((job) => job.name === query);
	if (direct) return { kind: "job", name: direct.name };
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const matches = nodes.filter((node) => node.id === query || nodeLabel(node, byId) === query);
	const byName = nodes.filter((node) => node.name === query && isLiveNode(node));
	const node = matches[0] ?? (byName.length === 1 ? byName[0] : undefined);
	if (!node) return { kind: "notFound", query };
	const own = jobForNode(node, live);
	if (own) return { kind: "job", name: own.name };
	for (let parent = node.parentId ? byId.get(node.parentId) : undefined; parent; parent = parent.parentId ? byId.get(parent.parentId) : undefined) {
		const owner = jobForNode(parent, live);
		if (owner) return { kind: "nested", label: nodeLabel(node, byId), owner: owner.name };
	}
	return { kind: "notFound", query };
}

/** Completions for `/legion stop <prefix>`: `all`, live child names, then nested live agents as parent/name. */
export function stopCompletions(prefix: string, jobs: readonly StopJob[], nodes: readonly StopNode[]): Array<{ value: string; label: string }> {
	const live = liveJobs(jobs);
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const out: Array<{ value: string; label: string }> = [{ value: "all", label: `all (${live.length} live)` }];
	for (const job of live) out.push({ value: job.name, label: job.name });
	const seen = new Set(out.map((item) => item.value));
	for (const node of nodes) {
		if (node.depth <= 1 || !isLiveNode(node)) continue;
		const label = nodeLabel(node, byId);
		if (seen.has(label)) continue;
		seen.add(label);
		out.push({ value: label, label: `${label} (nested)` });
	}
	return out.filter((item) => item.value.startsWith(prefix));
}

export interface StopDeps {
	jobs(): readonly StopJob[];
	nodes(): readonly StopNode[];
	/** Graceful retire via the subagent `stop` action; resolves to its summary text. */
	stop(params: { name?: string; all?: boolean }): Promise<{ ok: boolean; text: string }>;
	notify(message: string, type: "info" | "warning" | "error"): void;
}

/** `/legion stop [name|all]`. Returns the notified message (for tests). */
export async function runLegionStop(arg: string, deps: StopDeps): Promise<string> {
	const target = resolveStopTarget(arg, deps.jobs(), deps.nodes());
	const say = (message: string, type: "info" | "warning" | "error" = "info"): string => {
		deps.notify(message, type);
		return message;
	};
	if (target.kind === "notFound") {
		const names = liveJobs(deps.jobs()).map((job) => job.name);
		return say(`No live subagent named "${target.query}".${names.length ? ` Live: ${names.join(", ")}` : " Nothing is running."}`, "warning");
	}
	if (target.kind === "nested") {
		return say(`${target.label} is owned by ${target.owner}; stop ${target.owner} to retire it with its subtree (/legion stop ${target.owner}).`, "warning");
	}
	if (target.kind === "all" && liveJobs(deps.jobs()).length === 0) return say("Nothing running: no live subagents.");
	const result = await deps.stop(target.kind === "all" ? { all: true } : { name: target.name });
	return say(result.text, result.ok ? "info" : "error");
}

export interface IdleEscDeps {
	/** Main agent not streaming / running a turn. */
	isIdle(): boolean;
	editorEmpty(): boolean;
	/** An overlay, dialog or non-editor component has focus. */
	uiBusy(): boolean;
	liveCount(): number;
	confirm(title: string, message: string): Promise<boolean>;
	stopAll(): Promise<void>;
}

/**
 * Raw terminal input hook: consumes a bare Esc only when the main agent is
 * idle, the editor is empty, nothing else owns focus and children are live.
 * Every other key (and Esc in any other state) passes through to pi.
 */
export function createIdleEscStop(deps: IdleEscDeps): (data: string) => { consume: true } | undefined {
	let prompting = false;
	return (data) => {
		if (data !== "\x1b" || prompting) return undefined;
		const count = deps.liveCount();
		if (count === 0 || !deps.isIdle() || !deps.editorEmpty() || deps.uiBusy()) return undefined;
		prompting = true;
		void deps.confirm("Stop subagents", `Stop ${count} running subagent${count === 1 ? "" : "s"}?`)
			.then((yes) => (yes ? deps.stopAll() : undefined))
			.catch(() => {})
			.finally(() => { prompting = false; });
		return { consume: true };
	};
}

/** Dim hint shown in the railway header while the main agent is idle and children are live. */
export const IDLE_STOP_HINT = "esc stop all · /legion stop [name]";
export const IDLE_STOP_HINT_SHORT = "esc stop all";
