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
	visibleWidth,
} from "@earendil-works/pi-tui";
import { isThinkingLevel } from "../shared/types.ts";

export const STATUS_WIDGET_KEY = "pi-legion-status";
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
	/** Legion tree identity; omitted for callers that still use the flat roster. */
	nodeId?: string;
	parentId?: string | null;
	depth?: number;
	/** Optional caller override. Active descendants always force the branch open. */
	childrenCollapsed?: boolean;
}

export function formatElapsed(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function activeEntries(entries: StatusEntry[]): StatusEntry[] {
	return entries.filter((entry) => ACTIVE_STATES.has(entry.herdrStatus ?? entry.state));
}

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
	return `⏳ ${active.length} subagent${active.length === 1 ? "" : "s"}${who}`;
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
	if (entry.kind && entry.kind !== "pi") bits.push(entry.kind);
	const model = formatModel(entry);
	if (model) bits.push(model);
	const elapsedEnd = TERMINAL_STATES.has(entry.state) ? entry.finishedAt ?? now : now;
	bits.push(formatElapsed(elapsedEnd - entry.startedAt));
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

const RUNNING_STATES = new Set(["starting", "working", "running"]);
const ACTIVE_STATES = new Set([...RUNNING_STATES, "blocked"]);
const TERMINAL_STATES = new Set([
	"settled",
	"success",
	"completed",
	"failed",
	"aborted",
	"retired",
	"awaiting",
	"unknown",
]);

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

function renderTreeWidgetLines(entries: StatusEntry[], now: number): string[] {
	const roots = treeEntries(entries);
	const running = entries.filter((entry) =>
		RUNNING_STATES.has(entry.herdrStatus ?? entry.state),
	).length;
	const lines = [`⏳ Legion · ${entries.length} agents · ${running} running`];
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
		const collapse = node.children.length > 0 && !activeSubtree &&
			(entry.childrenCollapsed ?? (node.depth > 2 || TERMINAL_STATES.has(entry.state)));
		const branch = `${ancestors}${isLast ? "└─ " : "├─ "}`;
		const linkedName = entry.nodeId
			? osc8NodeLink(entry.nodeId, entry.name)
			: cleanDisplayText(entry.name);
		if (collapse) {
			lines.push(
				`${branch}▸ ${linkedName} +${descendantCount(node)} collapsed`,
			);
			return;
		}

		const headline = headlineBits(entry, now);
		headline[0] = `${linkedName}${roleSuffix(entry)}`;
		lines.push(`${branch}● ${headline.join(" · ")}`);
		const detailPrefix = `${ancestors}${isLast ? "   " : "│  "}`;
		lines.push(`${detailPrefix}  ⎿  ${detailBits(entry).map(cleanDisplayText).join(" · ")}`);
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

/**
 * Compact status roster. Entries carrying Legion identity render as a tree;
 * callers without tree metadata keep the historical flat format.
 */
export function formatWidgetLines(
	entries: StatusEntry[],
	now: number,
): string[] {
	if (entries.length === 0) return [];
	if (entries.some((entry) => entry.nodeId !== undefined || entry.parentId !== undefined || entry.depth !== undefined)) {
		return renderTreeWidgetLines(entries, now);
	}
	if (entries.length === 1) {
		return formatEntryLines(entries[0]!, now, { head: "", detail: "" });
	}
	const lines = [`● Async agents · herdr`];
	for (const [index, entry] of entries.entries()) {
		const last = index === entries.length - 1;
		lines.push(
			...formatEntryLines(entry, now, {
				head: last ? "└─ " : "├─ ",
				detail: last ? "   " : "│  ",
			}),
		);
	}
	return lines;
}

type Theme = {
	fg(color: string, text: string): string;
};

type WidgetTui = { requestRender(): void };

export type WidgetFactory = (
	tui: WidgetTui,
	theme: Theme,
) => {
	render: (width?: number) => string[];
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

export interface StatusBoard {
	bind(ctx: StatusUi): void;
	paint(entries: StatusEntry[], now: number): void;
	clear(): void;
}

/**
 * Session-scoped painter: register the widget once, then `requestRender`.
 *
 * Calling `setWidget` on the tool-execute context after it returns is a
 * no-op (stale ctx). The factory keeps a TUI handle that outlives that ctx.
 */
export function createStatusBoard(): StatusBoard {
	let ctx: StatusUi | undefined;
	let ui: StatusUi["ui"] | undefined;
	let entries: StatusEntry[] = [];
	let registered = false;
	let tui: WidgetTui | undefined;

	const renderLines = (now: number, theme: Theme): string[] =>
		themeLines(formatWidgetLines(entries, now), theme);

	const safe = (fn: () => void): void => {
		try {
			fn();
		} catch (error) {
			if (!isStaleUiError(error)) throw error;
		}
	};

	const dropWidget = (): void => {
		if (registered && ui) {
			safe(() => ui!.setWidget(STATUS_WIDGET_KEY, undefined));
		}
		if (ui) safe(() => ui!.setStatus(STATUS_FOOTER_KEY, undefined));
		registered = false;
		tui = undefined;
	};

	const paint = (): void => {
		if (!ctx || !liveHasUi(ctx)) return;
		safe(() => ctx!.ui.setStatus(STATUS_FOOTER_KEY, formatFooterStatus(entries)));
		if (entries.length === 0) {
			dropWidget();
			return;
		}
		if (registered && tui) {
			tui.requestRender();
			return;
		}
		safe(() => {
			ctx!.ui.setWidget(
				STATUS_WIDGET_KEY,
				(nextTui, theme) => {
					tui = nextTui;
					return {
						render: (width) => fitLines(renderLines(Date.now(), theme), width),
						dispose: () => {
							if (tui === nextTui) {
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
	};

	return {
		bind(next) {
			if (ui && ui !== next.ui) dropWidget();
			ctx = next;
			ui = next.ui;
			paint();
		},
		paint(next, _now) {
			entries = next;
			paint();
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
		ctx.ui.setStatus(STATUS_FOOTER_KEY, formatFooterStatus(entries));
	} catch (error) {
		if (!isStaleUiError(error)) throw error;
	}
}

export function clearStatus(ctx: StatusUi): void {
	applyStatus(ctx, [], Date.now());
}
