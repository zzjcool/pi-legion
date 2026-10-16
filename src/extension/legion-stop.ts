/**
 * User-facing stop controls for live subagents:
 *   - `/legion stop` (all) / `/legion stop <name>` — thin wrapper over the
 *     subagent tool's `stop` action (graceful retire; a retired parent's own
 *     session shutdown retires its subtree, so stopping a parent cascades).
 *   - `/legion stop --force` / `-f` — same targets with `force: true` (hard
 *     retire; see #179 / StopDeps.force).
 *   - `x` on the selected agent in the /legion view → confirm → stop it.
 * Esc no longer stops children (esc-no-retire-v3); only `/legion stop` or
 * process exit retires. Everything here is pure/injectable for unit tests.
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

/** Strip `--force` / `-f` from `/legion stop` args; remainder is the name|all query. */
export function parseStopArg(arg: string): { query: string; force: boolean } {
	const tokens = arg.trim().split(/\s+/).filter(Boolean);
	let force = false;
	const rest: string[] = [];
	for (const token of tokens) {
		if (token === "--force" || token === "-f") force = true;
		else rest.push(token);
	}
	return { query: rest.join(" "), force };
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

/** Completions for `/legion stop <prefix>`: optional `--force`, `all`, live names, nested parent/name. */
export function stopCompletions(prefix: string, jobs: readonly StopJob[], nodes: readonly StopNode[]): Array<{ value: string; label: string }> {
	const { query, force } = parseStopArg(prefix);
	const flagPrefix = force ? "--force " : "";
	const live = liveJobs(jobs);
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const out: Array<{ value: string; label: string }> = [{ value: `${flagPrefix}all`, label: `all (${live.length} live)` }];
	for (const job of live) out.push({ value: `${flagPrefix}${job.name}`, label: job.name });
	const seen = new Set(out.map((item) => item.value));
	for (const node of nodes) {
		if (node.depth <= 1 || !isLiveNode(node)) continue;
		const label = nodeLabel(node, byId);
		const value = `${flagPrefix}${label}`;
		if (seen.has(value)) continue;
		seen.add(value);
		out.push({ value, label: `${label} (nested)` });
	}
	const trimmed = prefix.trim();
	const offerForce =
		!force && (trimmed === "" || "--force".startsWith(trimmed) || trimmed === "-f" || (trimmed.startsWith("-") && "-f".startsWith(trimmed)));
	const names = out.filter((item) => {
		const bare = force ? item.value.slice(flagPrefix.length) : item.value;
		return bare.startsWith(query);
	});
	if (offerForce) names.unshift({ value: "--force", label: "--force (hard retire)" });
	return names;
}

export interface StopDeps {
	jobs(): readonly StopJob[];
	nodes(): readonly StopNode[];
	/**
	 * Retire via the subagent `stop` action; resolves to its summary text.
	 * `/legion stop --force` passes `force: true` (hard retire). Default remains graceful.
	 */
	stop(params: { name?: string; all?: boolean; force?: boolean }): Promise<{ ok: boolean; text: string }>;
	notify(message: string, type: "info" | "warning" | "error"): void;
}

/** `/legion stop [--force|-f] [name|all]`. Returns the notified message (for tests). */
export async function runLegionStop(arg: string, deps: StopDeps): Promise<string> {
	const { query, force } = parseStopArg(arg);
	const target = resolveStopTarget(query, deps.jobs(), deps.nodes());
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
	const base = target.kind === "all" ? { all: true as const } : { name: target.name };
	const result = await deps.stop(force ? { ...base, force: true } : base);
	return say(result.text, result.ok ? "info" : "error");
}

/** Dim hint shown in the status strip while children are live (aboveEditor / tree). */
export const IDLE_STOP_HINT = "/legion stop [--force] [name|all]";
export const IDLE_STOP_HINT_SHORT = "/legion stop";
