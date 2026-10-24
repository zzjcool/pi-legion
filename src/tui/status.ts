/**
 * Live subagent status above the parent input box.
 *
 * pi-subagents' async widget uses Pi's default `aboveEditor` placement and a
 * persistent component so elapsed time keeps ticking after the tool call
 * returns (the execute ctx is then stale). We match that: a factory widget
 * plus `requestRender`, not a one-shot `string[]` on a dying context.
 */

import {
	hyperlink,
	stripTerminalSequences,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { isThinkingLevel } from "../shared/types.ts";
import {
	NON_TERMINAL,
	TERMINAL_STATES as LIVENESS_TERMINAL_STATES,
	displayStatusFromState,
} from "../extension/liveness.ts";
import { nodesFromEntries, type VizNode } from "./viz/model.ts";
import { RateSampler } from "./viz/rate.ts";
import { railwayLines, type RailScroll } from "./viz/railway.ts";
import { IDLE_STOP_HINT, IDLE_STOP_HINT_SHORT } from "../extension/legion-stop.ts";

export const STATUS_WIDGET_KEY = "pi-legion-status";
/** @deprecated Footer segment removed (#192); kept for API soft-land. Prefer the aboveEditor widget. */
export const STATUS_FOOTER_KEY = "pi-legion";
export const STATUS_WIDGET_PLACEMENT = "aboveEditor" as const;

export interface StatusEntry {
	name: string;
	agent: string;
	state: string;
	startedAt: number;
	/** Frozen endpoint for settled nodes; omitted for live entries. */
	finishedAt?: number;
	herdrStatus?: string;
	kind?: string;
	model?: string;
	thinking?: string | false;
	worktreeBranch?: string;
	turns?: number;
	lastTools?: string[];
	phase?: string;
	/**
	 * Unix ms start of the agent's current turn. Kept after the turn settles
	 * so the headline can freeze that turn until the next one starts.
	 */
	currentTurnStartedAt?: number;
	/** Unix ms the current turn settled. Absent while the turn is still in flight. */
	currentTurnEndedAt?: number;
	/**
	 * Unix ms of the agent's last visible activity (edit / reply / status or
	 * output refresh). Not the run wall-clock start.
	 */
	lastActivityAt?: number;
	/** Cumulative tokens (input+cache+output); from session jsonl (fresh) or ledger usage (≤30s stale). */
	tokensTotal?: number;
	/** Cumulative output tokens only; numerator for tok/s / t/s. */
	tokensOut?: number;
	/**
	 * Cumulative model-generation wall ms from the session (assistant − prior
	 * user/toolResult). Denominator for t/s when known.
	 */
	generationMs?: number;
	/** Legion tree identity; omitted for callers that still use the flat roster. */
	nodeId?: string;
	parentId?: string | null;
	depth?: number;
	/**
	 * Backend the child was actually spawned on (#209). Absent for legacy
	 * records and for tree-only rows — consumers render `unknown`, never `rpc`.
	 */
	spawnMode?: string;
	/**
	 * Own OS process of an `rpc` child. Never persisted (pids are host-scoped),
	 * so a row restored from disk has none. `inprocess` children have none by
	 * definition — they share this process.
	 */
	pid?: number;
	/** Prompt size of the last assistant message; absolute tokens, not a ratio. */
	contextTokens?: number;
	/**
	 * Resident memory of this child in MB. Only ever set for a child with its own
	 * process (D2): an `inprocess` child has no separate RSS and must render
	 * blank rather than a share of the host figure.
	 */
	rss?: number;
}

/** Session-wide totals for the tree header: every launched agent (incl. aged-out), root excluded. */
export interface StatusTotals {
	agents: number;
	tokensTotal: number;
}

/** Aggregate all non-root entries (live + aged-out) for the header overview. */
export function statusTotals(entries: StatusEntry[]): StatusTotals | undefined {
	const agents = entries.filter((entry) => entry.nodeId && entry.nodeId !== "root");
	if (agents.length === 0) return undefined;
	return {
		agents: agents.length,
		tokensTotal: agents.reduce((sum, entry) => sum + (entry.tokensTotal ?? 0), 0),
	};
}

/**
 * Elapsed time. Sub-hour values keep seconds (`42s`, `12m12s`). Hour-scale
 * lifetime totals drop leftover seconds (`1h03m`). Pass `hourSeconds` for the
 * current-turn side, which stays precise to the second (`1h03m12s`).
 */
function formatElapsedParts(ms: number, hourSeconds: boolean): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		const hoursMinutes = `${hours}h${String(minutes).padStart(2, "0")}m`;
		return hourSeconds ? `${hoursMinutes}${String(seconds).padStart(2, "0")}s` : hoursMinutes;
	}
	if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

export function formatElapsed(ms: number): string {
	return formatElapsedParts(ms, false);
}

/**
 * Age floor for the railway "last activity" field. Below it the field is
 * dropped entirely instead of reading `1s ago` on every live lane.
 */
export const ACTIVITY_AGO_MIN_SECS = 60;

/**
 * Relative age for railway "last activity" (`2m ago` / `1h ago`).
 *
 * Missing timestamp → `—` (placeholder; see #159). Anything fresher than a
 * minute → `""`, meaning "say nothing": a lane that just printed activity is
 * already visibly live, so `1s ago` was pure noise on every running agent.
 */
export function formatActivityAgo(lastActivityAt: number | undefined, now: number): string {
	if (lastActivityAt === undefined || !Number.isFinite(lastActivityAt)) return "—";
	const secs = Math.max(0, Math.floor((now - lastActivityAt) / 1000));
	if (secs < ACTIVITY_AGO_MIN_SECS) return "";
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** Compact token count: 950 -> "950", 1200 -> "1.2K", 2500000 -> "2.5M". */
function formatTokensCompact(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1000) return String(Math.round(value));
	const absolute = Math.abs(value);
	const unit = absolute >= 1_000_000_000 ? "B" : absolute >= 1_000_000 ? "M" : "K";
	const divisor = unit === "B" ? 1_000_000_000 : unit === "M" ? 1_000_000 : 1_000;
	return `${(value / divisor).toFixed(1).replace(/\.0$/, "")}${unit}`;
}

/**
 * Elapsed since the most recent task (turn) started, shown next to the
 * lifetime elapsed.
 *
 * Ticks with `now` for as long as the agent itself is live — including the
 * quiet gap after a turn settles and before the next message arrives, which
 * is part of "time since the last task started". It freezes only when the
 * agent ends: a terminal entry clamps at `finishedAt` so the clock does not
 * run on after the agent exits. Undefined when the turn start is unknown, or
 * when the entry is alive but not doing work — an `idle`/`queued`/`awaiting`
 * seat has no meaningful running clock.
 */
function currentTurnElapsedMs(
	entry: Pick<StatusEntry, "state" | "herdrStatus" | "finishedAt" | "currentTurnStartedAt">,
	now: number,
): number | undefined {
	if (entry.currentTurnStartedAt === undefined) return undefined;
	const start = entry.currentTurnStartedAt;
	const status = entry.herdrStatus ?? entry.state;
	if (TERMINAL_STATES.has(status)) return Math.max(0, (entry.finishedAt ?? now) - start);
	// Only a *busy* entry has a live turn clock. An `idle` seat (and a `queued`
	// one, and an `awaiting` centurion waiting on its squad) is visible but not
	// working, so it keeps no running clock: the doc above says so, and letting
	// it tick would show time accruing against nothing.
	if (!BUSY_STATES.has(status)) return undefined;
	return Math.max(0, now - start);
}

/** Lifetime elapsed. Frozen once the entry's own state is terminal. */
function lifetimeElapsedMs(
	entry: Pick<StatusEntry, "state" | "startedAt" | "finishedAt">,
	now: number,
): number {
	const elapsedEnd = TERMINAL_STATES.has(entry.state) ? entry.finishedAt ?? now : now;
	return elapsedEnd - entry.startedAt;
}

/**
 * How close `currentTurnStartedAt` may sit to `startedAt` and still count as
 * the same event (round 1). Only a fallback for entries that report no turn
 * count: the turn start comes from the session's first user message while
 * `startedAt` is the process spawn, so they differ by the spawn handshake
 * (~1s) even on round 1.
 */
export const SAME_TURN_START_MS = 5_000;

/**
 * Headline clock: `12m12s / 1h03m` (since last task start / lifetime).
 *
 * Lifetime only when the leading clock adds nothing: either this turn has no
 * timing yet, or it is still round 1 — that turn started with the agent, so
 * the two clocks are one fact and `16s / 17s` is just the spawn gap.
 */
export function formatAgentElapsed(
	entry: Pick<StatusEntry, "state" | "herdrStatus" | "startedAt" | "finishedAt" | "currentTurnStartedAt" | "turns">,
	now: number,
): string {
	const total = formatElapsed(lifetimeElapsedMs(entry, now));
	const turnElapsed = currentTurnElapsedMs(entry, now);
	if (turnElapsed === undefined) return total;
	if (entry.turns !== undefined) {
		if (entry.turns <= 1) return total;
	} else if (entry.currentTurnStartedAt !== undefined
		&& Math.abs(entry.currentTurnStartedAt - entry.startedAt) <= SAME_TURN_START_MS) {
		return total;
	}
	return `${formatElapsedParts(turnElapsed, true)} / ${total}`;
}

export function activeEntries(entries: StatusEntry[]): StatusEntry[] {
	return entries.filter((entry) =>
		entry.parentId !== null && entry.depth !== 0 && BUSY_STATES.has(entry.herdrStatus ?? entry.state),
	);
}

/**
 * Panel-visibility gate for the status board: with any Legion-identity
 * entries present, the board mirrors the live-tree filter (completed
 * branches age out; busy counts stay consistent with the widget).
 * Legacy flat rosters keep the historical always-shown behavior.
 */
function hasTreeIdentity(entries: StatusEntry[]): boolean {
	return entries.some((entry) => entry.nodeId !== undefined || entry.parentId !== undefined || entry.depth !== undefined);
}

export function visiblePanelEntries(entries: StatusEntry[]): StatusEntry[] {
	const hasTreeIdentity = entries.some(
		(entry) => entry.nodeId !== undefined || entry.parentId !== undefined || entry.depth !== undefined,
	);
	if (!hasTreeIdentity) return entries;
	const live = filterLiveTree(entries);
	// Busy labels key off activeEntries(); keep the ledger root row out
	// of the visible set entirely (it is not an agent).
	return live.filter((entry) => entry.nodeId !== "root");
}

/**
 * @deprecated Footer `N agents running` removed (#192); the aboveEditor widget
 * already shows the same count. Kept for API soft-land — do not call from new code.
 */
export function formatFooterStatus(entries: StatusEntry[]): string | undefined {
	const active = activeEntries(entries);
	if (active.length === 0) return undefined;
	return active.length === 1
		? "1 agent running"
		: `${active.length} agents running`;
}

export function formatBusyLabel(entries: StatusEntry[]): string | undefined {
	const active = activeEntries(entries);
	if (active.length === 0) return undefined;
	const names = active.map((entry) => entry.name);
	const who =
		names.length > 0
			? ` (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""})`
			: "";
	return `${active.length} subagent${active.length === 1 ? "" : "s"}${who}`;
}

function roleSuffix(entry: StatusEntry): string {
	return entry.agent && entry.agent !== entry.name ? ` (${entry.agent})` : "";
}

function entryStatus(entry: StatusEntry): string {
	return entry.herdrStatus ?? entry.state;
}

function formatModel(entry: StatusEntry): string | undefined {
	const raw = entry.model?.trim();
	if (!raw) return undefined;
	const idx = raw.lastIndexOf(":");
	const suffix = idx === -1 ? undefined : raw.slice(idx + 1);
	const suffixIsThinking = Boolean(suffix && isThinkingLevel(suffix));
	const base = suffixIsThinking ? raw.slice(0, idx) : raw;
	const fromModel =
		suffixIsThinking && suffix !== "off" ? suffix : undefined;
	const thinking =
		fromModel ??
		(typeof entry.thinking === "string" &&
		entry.thinking !== "off" &&
		isThinkingLevel(entry.thinking)
			? entry.thinking
			: undefined);
	return thinking ? `${base}:${thinking}` : base;
}

function formatWorktreeBranch(branch: string): string {
	return branch.replace(/^pi-subagent\//, "");
}

function headlineBits(entry: StatusEntry, now: number): string[] {
	const bits = [`${entry.name}${roleSuffix(entry)}`];
	// `entry.kind` is deliberately not rendered: v4 has one kind (`pi`), so the
	// label would repeat a constant on every row.
	const model = formatModel(entry);
	if (model) bits.push(model);
	bits.push(formatAgentElapsed(entry, now));
	if (entry.tokensTotal && entry.tokensTotal > 0) bits.push(`${formatTokensCompact(entry.tokensTotal)} tok`);
	return bits;
}

function detailBits(entry: StatusEntry): string[] {
	const status = entryStatus(entry);
	const bits = [entry.phase ? `${entry.phase}/${status}` : status];
	if (entry.turns && entry.turns > 0) bits.push(`turn ${entry.turns}`);
	if (entry.lastTools?.length) {
		bits.push(entry.lastTools.slice(0, 2).join(", "));
	}
	if (entry.worktreeBranch) {
		bits.push(`wt ${formatWorktreeBranch(entry.worktreeBranch)}`);
	}
	// Lifetime avg output tok/s over generationMs (not the header 60s window / live-only nowRate).
	if (entry.tokensOut && entry.tokensOut > 0 && entry.generationMs && entry.generationMs >= 1_000) {
		bits.push(`${formatTokensCompact(Math.round(entry.tokensOut / (entry.generationMs / 1_000)))} avg t/s`);
	}
	return bits;
}

function formatEntryLines(
	entry: StatusEntry,
	now: number,
	prefix: { head: string; detail: string },
): string[] {
	return [
		`${prefix.head}● ${headlineBits(entry, now).join(" · ")}`,
		`${prefix.detail}  ⎿  ${detailBits(entry).join(" · ")}`,
	];
}

interface TreeStatusEntry {
	id: string;
	parentId: string | null;
	depth: number;
	entry: StatusEntry;
	children: TreeStatusEntry[];
}

type WidgetRow = { text: string; nodeId?: string };

function widgetRow(text: string, nodeId?: string): WidgetRow {
	return nodeId === undefined ? { text } : { text, nodeId };
}

/**
 * Terminal / active / busy / running: one derivation from the liveness
 * authority (contract `docs/contracts/display-liveness-v1.md` D1-a, D5).
 *
 * This file used to carry its own three tables, and the terminal one disagreed
 * with every other surface: it listed `awaiting` and `unknown` as terminal
 * (so a centurion waiting on its squad vanished from the widget) and omitted
 * `error`/`truncated`/`done` (so those kept a live clock). `TERMINAL_STATES` is
 * therefore imported, never re-declared.
 */
const TERMINAL_STATES: ReadonlySet<string> = LIVENESS_TERMINAL_STATES;

/**
 * "This row describes something that is still alive": the liveness module's
 * in-flight labels plus `awaiting`, which D1-a places on the non-terminal side
 * ("alive, waiting on downstream"). Drives visibility (`filterLiveTree`,
 * `isActiveEntry`) and the open-ended clocks.
 *
 * This stays a known-label set on purpose. D1-a's "use the complement, not a
 * whitelist" rule governs `liveness()`'s ledger rule, where the question is
 * *may we declare this lifecycle over?* — the safe answer for an unrecognised
 * label is "no". Here the question is the opposite one, *may this row count as
 * alive?*, and a permissive answer would promote the widget's own synthetic
 * `waiting` label (and any legacy/foreign label) to activity: rows that must
 * age out would be resurrected and the `N running` count would inflate.
 */
const ACTIVE_STATES: ReadonlySet<string> = new Set([...NON_TERMINAL, "awaiting"]);

/**
 * "This row is doing work": active and not merely holding a slot. An `idle`
 * seat is alive and visible (D5) but has no running clock and must not keep the
 * busy label lit forever; same for a `queued` seat that has not started and an
 * `awaiting` centurion whose squad is the thing actually running.
 *
 * Kept separate from `ACTIVE_STATES` because conflating "should I show this?"
 * with "is this busy?" is precisely the mistake that made `idle`/`awaiting`
 * disappear instead of being shown grey.
 */
const BUSY_STATES: ReadonlySet<string> = new Set(
	[...ACTIVE_STATES].filter((state) => displayStatusFromState(state) === "running"),
);

/**
 * Working states for the header's `N running` count, derived from the busy set
 * so it can never list a state the panel considers dead. `blocked` is an
 * approval gate: busy, but not generating, so it does not count as running.
 */
const RUNNING_STATES: ReadonlySet<string> = new Set(
	[...BUSY_STATES].filter((state) => state !== "blocked"),
);

function cleanDisplayText(value: string): string {
	return stripTerminalSequences(value)
		.replace(/[\r\n\t]/g, " ")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

/** Return the OSC 8 fallback link used by the status and tree views. */
export function osc8NodeLink(nodeId: string, label: string): string {
	const target = `pi-legion://node/${encodeURIComponent(nodeId)}`;
	return hyperlink(cleanDisplayText(label), target);
}

function treeEntries(entries: StatusEntry[]): TreeStatusEntry[] {
	const nodes = new Map<string, TreeStatusEntry>();
	for (const [index, entry] of entries.entries()) {
		const id = entry.nodeId ?? `legacy-${index}-${entry.name}`;
		const separator = id.lastIndexOf(".");
		const parentId = entry.parentId !== undefined
			? entry.parentId
			: separator > 0
				? id.slice(0, separator)
				: null;
		const derivedDepth = parentId === null ? 0 : id.split(".").length - 1;
		const depth = entry.depth ?? derivedDepth;
		nodes.set(id, { id, parentId, depth, entry, children: [] });
	}

	const roots: TreeStatusEntry[] = [];
	for (const node of nodes.values()) {
		const parent = node.parentId ? nodes.get(node.parentId) : undefined;
		if (!parent || parent === node) roots.push(node);
		else parent.children.push(node);
	}
	for (const node of nodes.values()) {
		node.children.sort((left, right) =>
			left.entry.startedAt - right.entry.startedAt ||
			left.entry.name.localeCompare(right.entry.name),
		);
	}
	roots.sort((left, right) =>
		left.entry.startedAt - right.entry.startedAt ||
		left.entry.name.localeCompare(right.entry.name),
	);
	// Malformed cyclic parent links have no root. Keep those facts visible once.
	if (roots.length === 0) roots.push(...nodes.values());
	return roots;
}

function isActiveEntry(entry: StatusEntry): boolean {
	return ACTIVE_STATES.has(entry.herdrStatus ?? entry.state);
}

function descendantCount(node: TreeStatusEntry, seen = new Set<string>()): number {
	if (seen.has(node.id)) return 0;
	seen.add(node.id);
	let count = 0;
	for (const child of node.children) {
		count += 1 + descendantCount(child, seen);
	}
	return count;
}

function hasActiveSubtree(
	node: TreeStatusEntry,
	memo: Map<string, boolean>,
	visiting: Set<string> = new Set(),
): boolean {
	const cached = memo.get(node.id);
	if (cached !== undefined) return cached;
	if (visiting.has(node.id)) return false;
	visiting.add(node.id);
	const active = isActiveEntry(node.entry) || node.children.some((child) =>
		hasActiveSubtree(child, memo, visiting),
	);
	visiting.delete(node.id);
	memo.set(node.id, active);
	return active;
}

/**
 * Live-activity filter for the resident tree widget: keep a node when it is
 * active itself or when an active descendant keeps its branch alive (a
 * centurion waiting on its squad stays visible, rendered as "waiting").
 * Completed leaves age out — full history remains in /legion and the ledger.
 * The ledger "root" row is never active on its own: it only appears while a
 * descendant runs, so the panel clears once the whole tree is at rest.
 */
function filterLiveTree(entries: StatusEntry[]): StatusEntry[] {
	const activeIds = new Set<string>();
	for (const entry of entries) {
		if (entry.nodeId && entry.nodeId !== "root" && isActiveEntry(entry)) {
			activeIds.add(entry.nodeId);
		}
	}
	if (activeIds.size === 0) return [];
	const keepAncestors = new Set<string>();
	for (const id of activeIds) {
		let separator = id.lastIndexOf(".");
		while (separator > 0) {
			const ancestor = id.slice(0, separator);
			keepAncestors.add(ancestor);
			separator = ancestor.lastIndexOf(".");
		}
	}
	return entries.filter((entry) => {
		if (entry.nodeId) {
			return activeIds.has(entry.nodeId) || keepAncestors.has(entry.nodeId);
		}
		// Legacy flat entries (no Legion identity): active ones stay.
		return isActiveEntry(entry);
	});
}

function renderTreeWidgetLines(
	entries: StatusEntry[],
	now: number,
	totals?: StatusTotals,
): WidgetRow[] {
	// The resident widget is a live-activity view: completed agents drop out
	// once nothing in their subtree is still running (the centurion waiting on
	// its squad counts as running and keeps the branch alive). Full history
	// stays available in /legion and the ledger — this panel is for "what is
	// happening now".
	const liveEntries = filterLiveTree(entries);
	if (liveEntries.length === 0) return [];
	const roots = treeEntries(liveEntries);
	const running = liveEntries.filter((entry) =>
		RUNNING_STATES.has(entry.herdrStatus ?? entry.state),
	).length;
	const liveAgents = liveEntries.filter((entry) => entry.nodeId !== "root");
	const overviewBits: string[] = [];
	if (totals && totals.agents > liveAgents.length) overviewBits.push(`Σ ${totals.agents} agents`);
	if (totals && totals.tokensTotal > 0) overviewBits.push(`${formatTokensCompact(totals.tokensTotal)} tok`);
	const header = overviewBits.length > 0
		? `⏳ Legion · ${liveEntries.length} agents · ${running} running · ${overviewBits.join(" · ")}`
		: `⏳ Legion · ${liveEntries.length} agents · ${running} running`;
	const lines: WidgetRow[] = [widgetRow(header)];
	const activeMemo = new Map<string, boolean>();
	const visited = new Set<string>();

	const visit = (
		node: TreeStatusEntry,
		ancestors: string,
		isLast: boolean,
	): void => {
		if (visited.has(node.id)) return;
		visited.add(node.id);
		const { entry } = node;
		const activeSubtree = hasActiveSubtree(node, activeMemo);
		// A terminal node whose subtree is still running is waiting on
		// downstream work (e.g. a centurion between turns while its squad
		// executes) — render it as "waiting" instead of a dead settled state.
		//
		// D1-a: a row that is *already* `awaiting` is not rewritten. `awaiting`
		// means "alive, waiting on downstream", so it is active (ACTIVE_STATES)
		// and this branch never sees it — which is the point: it must neither
		// vanish from the panel nor be relabelled as a finished state. It renders
		// grey, as itself, because `themeLines` dims every non-header row.
		const effectiveEntry = !isActiveEntry(entry) && activeSubtree
			? { ...entry, state: "waiting" as const, herdrStatus: "waiting" as const }
			: entry;
		const collapse = node.children.length > 0 && !activeSubtree &&
			(node.depth > 2 || TERMINAL_STATES.has(entry.state));
		const branch = `${ancestors}${isLast ? "└─ " : "├─ "}`;
		const linkedName = entry.nodeId
			? osc8NodeLink(entry.nodeId, entry.name)
			: cleanDisplayText(entry.name);
		if (collapse) {
			lines.push(widgetRow(
				`${branch}▸ ${linkedName} +${descendantCount(node)} collapsed`,
				entry.nodeId,
			));
			return;
		}

		const headline = headlineBits(effectiveEntry, now);
		headline[0] = `${linkedName}${roleSuffix(effectiveEntry)}`;
		lines.push(widgetRow(`${branch}● ${headline.join(" · ")}`, entry.nodeId));
		const detailPrefix = `${ancestors}${isLast ? "   " : "│  "}`;
		lines.push(widgetRow(
			`${detailPrefix}  ⎿  ${detailBits(effectiveEntry).map(cleanDisplayText).join(" · ")}`,
			entry.nodeId,
		));
		const childPrefix = `${ancestors}${isLast ? "   " : "│  "}`;
		for (const [index, child] of node.children.entries()) {
			visit(child, childPrefix, index === node.children.length - 1);
		}
	};

	for (const [index, root] of roots.entries()) {
		const prefix = root.parentId && !entries.some((entry) => entry.nodeId === root.parentId)
			? "  ".repeat(Math.max(0, root.depth - 1))
			: "";
		visit(root, prefix, index === roots.length - 1);
	}
	return lines;
}

function formatWidgetRows(entries: StatusEntry[], now: number, totals?: StatusTotals): WidgetRow[] {
	if (entries.length === 0) return [];
	if (entries.some((entry) => entry.nodeId !== undefined || entry.parentId !== undefined || entry.depth !== undefined)) {
		return renderTreeWidgetLines(entries, now, totals);
	}
	if (entries.length === 1) {
		return formatEntryLines(entries[0]!, now, { head: "", detail: "" })
			.map((text) => ({ text }));
	}
	const rows: WidgetRow[] = [{ text: "● Async agents" }];
	for (const [index, entry] of entries.entries()) {
		const last = index === entries.length - 1;
		rows.push(
			...formatEntryLines(entry, now, {
				head: last ? "└─ " : "├─ ",
				detail: last ? "   " : "│  ",
			}).map((text) => ({ text })),
		);
	}
	return rows;
}

/**
 * Compact status roster. Entries carrying Legion identity render as a tree;
 * callers without tree metadata keep the historical flat format.
 */
export function formatWidgetLines(
	entries: StatusEntry[],
	now: number,
	totals?: StatusTotals,
): string[] {
	return formatWidgetRows(entries, now, totals).map((row) => row.text);
}

type Theme = {
	fg(color: string, text: string): string;
};

export type WidgetTui = { requestRender(): void };

export type WidgetFactory = (
	tui: WidgetTui,
	theme: Theme,
) => {
	render: (width?: number) => string[];
	handleMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
	dispose?: () => void;
};

export interface StatusUi {
	hasUI: boolean;
	ui: {
		theme: Theme;
		setStatus(key: string, text: string | undefined): void;
		setWidget(
			key: string,
			content: string[] | WidgetFactory | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
	};
}

function isStaleUiError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes("This extension ctx is stale") ||
			error.message.includes("Extension context no longer active"))
	);
}

function liveHasUi(ctx: StatusUi): boolean {
	try {
		return ctx.hasUI;
	} catch (error) {
		if (!isStaleUiError(error)) throw error;
		return false;
	}
}

function themeLines(lines: string[], theme: Theme): string[] {
	if (lines.length === 0) return lines;
	const [header, ...rest] = lines;
	const out = [theme.fg("accent", header ?? "")];
	for (const line of rest) out.push(theme.fg("dim", line));
	return out;
}

/** Pi TUI asserts every rendered line's visibleWidth <= columns. */
function fitLines(lines: string[], width?: number): string[] {
	if (width === undefined || !Number.isFinite(width) || width <= 0) {
		return lines;
	}
	return lines.map((line) =>
		visibleWidth(line) <= width ? line : truncateToWidth(line, width),
	);
}

/** Above-input strip style: the railway lanes (default in the extension) or the classic tree roster. */
export type StatusStripStyle = "railway" | "tree";

export interface StatusVizSnapshot {
	nodes: VizNode[];
	sampler: RateSampler;
	now: number;
	/** Header tok/s (60s window, live nodes only; 0 when none running). */
	rate: number;
}

export interface StatusBoard {
	bind(ctx: StatusUi): void;
	/** Live data for the /legion view (same sampler; rate is header nowRate). */
	vizSnapshot?(now?: number): StatusVizSnapshot;
	paint(entries: StatusEntry[], now: number): void;
	clear(): void;
	/** The TUI the widget is mounted in, when registered (for focus/overlay checks). */
	getTui?(): WidgetTui | undefined;
}

/**
 * Session-scoped painter: register the widget once, then `requestRender`.
 *
 * Calling `setWidget` on the tool-execute context after it returns is a
 * no-op (stale ctx). The factory keeps a TUI handle that outlives that ctx.
 */
export function createStatusBoard(options: {
	onNodeClick?: (nodeId: string) => void;
	strip?: StatusStripStyle;
	sampler?: RateSampler;
	/** Railway repaint cadence while a subagent is live (default 1000ms). */
	tickMs?: number;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
} = {}): StatusBoard {
	const tickMs = options.tickMs ?? 1000;
	const startInterval = options.setInterval ?? ((fn: () => void, ms: number) => {
		const handle = setInterval(fn, ms);
		(handle as { unref?: () => void }).unref?.();
		return handle;
	});
	const stopInterval = options.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
	let ticker: unknown;
	const sampler = options.sampler ?? new RateSampler();
	const strip: StatusStripStyle = options.strip ?? "tree";
	let ctx: StatusUi | undefined;
	let ui: StatusUi["ui"] | undefined;
	let entries: StatusEntry[] = [];
	let registered = false;
	let tui: WidgetTui | undefined;
	let railScroll: RailScroll = { offset: 0 };
	let railWindow: { offset: number; total: number; maxLanes: number } | undefined;

	const renderLines = (now: number, theme: Theme, width?: number): {
		lines: string[];
		/** Node whose glyph occupies cell (x, y), from the same render pass; undefined = no-op. */
		hitAt: (x: number, y: number) => string | undefined;
	} => {
		if (strip === "railway" && hasTreeIdentity(entries) && width !== undefined && width >= 20) {
			const nodes = nodesFromEntries(entries);
			// Live-child gate: railway only renders when lanes exist; always show stop hint.
			const hint = { hint: IDLE_STOP_HINT, hintShort: IDLE_STOP_HINT_SHORT };
			const rendered = railwayLines({ nodes, now, width, rate: sampler.nowRate(now, nodes), scroll: railScroll, ...hint }, theme);
			// Persist the clamped window (anchored on the top lane's agent) so later
			// renders follow ends/starts without jumping; resets to 0 when all fit.
			railWindow = rendered.window;
			railScroll = rendered.window ? { offset: rendered.window.offset, topId: rendered.window.topId } : { offset: 0 };
			return rendered;
		}
		railWindow = undefined;
		const visible = visiblePanelEntries(entries);
		const totals = statusTotals(entries);
		let rows = formatWidgetRows(visible, now, totals);
		// Tree strip + Legion identity: short stop hint on its own row (survives width squeeze).
		if (strip === "tree" && hasTreeIdentity(entries) && rows.length > 0) {
			rows = [rows[0]!, { text: IDLE_STOP_HINT_SHORT }, ...rows.slice(1)];
		}
		const nodeIdsByRow = rows.map((row) => row.nodeId);
		return {
			lines: themeLines(rows.map((row) => row.text), theme),
			hitAt: (_x, y) => nodeIdsByRow[y],
		};
	};

	const safe = (fn: () => void): void => {
		try {
			fn();
		} catch (error) {
			if (!isStaleUiError(error)) throw error;
		}
	};

	const hasLiveAgent = (): boolean => nodesFromEntries(entries).some((node) => node.status === "running" && node.parentId !== null && node.id !== "root");
	const stopTicker = (): void => {
		if (ticker !== undefined) stopInterval(ticker);
		ticker = undefined;
	};
	/** Railway clocks, lanes and tok/s advance with time: repaint every tickMs while anything is live, never when idle. */
	const syncTicker = (): void => {
		if (strip !== "railway" || !registered || !tui || !hasLiveAgent()) return stopTicker();
		if (ticker !== undefined) return;
		ticker = startInterval(() => {
			if (!registered || !tui || !hasLiveAgent()) return stopTicker();
			tui.requestRender();
		}, tickMs);
	};

	const dropWidget = (): void => {
		stopTicker();
		if (registered && ui) {
			safe(() => ui!.setWidget(STATUS_WIDGET_KEY, undefined));
		}
		registered = false;
		tui = undefined;
	};

	const paint = (): void => {
		if (!ctx || !liveHasUi(ctx)) return;
		// Widget uses the live-tree visibility filter (completed branches age out).
		const visible = visiblePanelEntries(entries);
		if (visible.length === 0) {
			dropWidget();
			return;
		}
		if (registered && tui) {
			tui.requestRender();
			syncTicker();
			return;
		}
		safe(() => {
			ctx!.ui.setWidget(
				STATUS_WIDGET_KEY,
				(nextTui, theme) => {
					tui = nextTui;
					let hitAt: (x: number, y: number) => string | undefined = () => undefined;
					let latchedNodeId: string | undefined;
					return {
						render: (width) => {
							const rendered = renderLines(Date.now(), theme, width);
							// Build the identity map before styling or width fitting can change the display rows.
							hitAt = rendered.hitAt;
							return fitLines(rendered.lines, width);
						},
						handleMouse: (event) => {
							if (event.type === "wheel") {
								// Wheel over the railway scrolls lanes; when everything fits, let pi scroll the chat.
								const win = railWindow;
								const delta = Math.trunc(event.wheelDelta ?? 0);
								if (!win || win.total <= win.maxLanes || delta === 0) return undefined;
								const maxOffset = win.total - win.maxLanes;
								const next = Math.min(maxOffset, Math.max(0, win.offset + delta));
								railScroll = { offset: next };
								railWindow = { ...win, offset: next };
								tui?.requestRender();
								return { handled: true };
							}
							if (event.type === "press") {
								latchedNodeId = undefined;
								if (event.button !== "left") return undefined;
								const nodeId = hitAt(event.x, event.y);
								if (nodeId === undefined) return undefined;
								latchedNodeId = nodeId;
								return { handled: true };
							}
							if (event.type !== "click" || event.button !== "left") return undefined;
							const nodeId = hitAt(event.x, event.y);
							if (latchedNodeId === undefined || nodeId !== latchedNodeId) return undefined;
							const clickedNodeId = latchedNodeId;
							latchedNodeId = undefined;
							options.onNodeClick?.(clickedNodeId);
							return { handled: true };
						},
						dispose: () => {
							if (tui === nextTui) {
								stopTicker();
								tui = undefined;
								registered = false;
							}
						},
					};
				},
				{ placement: STATUS_WIDGET_PLACEMENT },
			);
			registered = true;
		});
		syncTicker();
	};

	return {
		bind(next) {
			if (ui && ui !== next.ui) dropWidget();
			ctx = next;
			ui = next.ui;
			paint();
		},
		paint(next, _now) {
			// Store the raw snapshot, but render only the live tree: the resident
			// panel is a "what is happening now" view (completed agents age out;
			// footer counts follow the same filter).
			entries = next;
			if (hasTreeIdentity(next)) sampler.record(_now, nodesFromEntries(next));
			paint();
		},
		getTui() {
			return tui;
		},
		vizSnapshot(now = Date.now()) {
			const nodes = nodesFromEntries(entries);
			return { nodes, sampler, now, rate: sampler.nowRate(now, nodes) };
		},
		clear() {
			entries = [];
			dropWidget();
			ctx = undefined;
			ui = undefined;
		},
	};
}

/**
 * One-shot paint used by tests. Production uses `createStatusBoard` so the
 * widget survives a stale execute context.
 */
export function applyStatus(
	ctx: StatusUi,
	entries: StatusEntry[],
	now: number,
): void {
	if (!liveHasUi(ctx)) return;
	const lines = formatWidgetLines(entries, now);
	const themed = themeLines(lines, ctx.ui.theme);
	try {
		ctx.ui.setWidget(
			STATUS_WIDGET_KEY,
			themed.length ? themed : undefined,
			{ placement: STATUS_WIDGET_PLACEMENT },
		);
	} catch (error) {
		if (!isStaleUiError(error)) throw error;
	}
}

export function clearStatus(ctx: StatusUi): void {
	applyStatus(ctx, [], Date.now());
}
