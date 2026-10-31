/**
 * Session summary slash command.
 *
 * The command itself only assembles the inputs (RunStore + session jsonl). The
 * data reduction and rendering below are deliberately side-effect free so the
 * summary can be tested with a small, in-memory fixture.
 */

import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { deriveOutcome } from "../shared/session.ts";
import { sessionMapFor } from "../shared/session-map.ts";
import type { ParsedSession } from "../shared/types.ts";
import {
	RunStore,
	pickChildByName,
} from "../runs/store.ts";
import { resolveChildAcrossStores, unknownChildMessage } from "../runs/store-lookup.ts";
import type {
	ChildRecord,
	ExecutionStatus,
	RunRecord,
	TaskState,
	Usage,
} from "../shared/types.ts";
import { sendSlashText, type LegionSubcommand } from "./slash.ts";

const RUNNING_STATES: ReadonlySet<TaskState> = new Set([
	"working",
	"blocked",
	"awaiting",
]);

const OUTCOME_ORDER: readonly ExecutionStatus[] = [
	"success",
	"failed",
	"aborted",
	"truncated",
	"running",
	"unknown",
];

const SUMMARY_USAGE = "Usage: /legion summary [--all] [<name>]";

/** Session data supplied by the command layer to the pure aggregator. */
export type SummarySession = ParsedSession;

export interface SummaryAggregationOptions {
	/** The clock used for live-child durations. */
	now?: number | Date;
	/** Parsed session files, keyed by ChildRecord.sessionFile. */
	sessions?: ReadonlyMap<string, SummarySession>;
}

export interface SummaryChild {
	run: RunRecord;
	child: ChildRecord;
	role: string;
	running: boolean;
	/** Terminal execution snapshot, when run.json has one. */
	executionStatus: ExecutionStatus | null;
	/** Session-derived or execution-snapshot usage. Null means unavailable. */
	usage: Usage | null;
	turns: number | null;
	toolErrors: number | null;
	durationMs: number;
	startedAtMs: number | null;
	endedAtMs: number | null;
	/** Whether durationMs is based on the live clock rather than retiredAt. */
	liveDuration: boolean;
	session?: SummarySession;
}

export interface SummaryGroup {
	role: string;
	children: SummaryChild[];
	count: number;
	outcomes: Partial<Record<ExecutionStatus, number>>;
	usage: Usage | null;
	turns: number | null;
	totalDurationMs: number;
	runningDurationMs: number;
	live: boolean;
}

export interface SummaryTotals {
	outcomes: Partial<Record<ExecutionStatus, number>>;
	usage: Usage | null;
	turns: number | null;
	totalDurationMs: number;
}

export interface SubagentSummary {
	runs: RunRecord[];
	runCount: number;
	childCount: number;
	groups: SummaryGroup[];
	totals: SummaryTotals;
	earliestSpawnedAtMs: number | null;
	latestUpdatedAtMs: number | null;
	cwd?: string;
}

export interface SummaryFormatOptions {
	/** Used only by the empty-state message and relative session paths. */
	cwd?: string;
}

export interface SummaryDetailInput {
	run: RunRecord;
	child: ChildRecord;
	session?: SummarySession;
	now?: number | Date;
	cwd?: string;
}

/**
 * Return the role used for grouping. Child execution kind is intentionally not
 * used: one logical role may be relaunched under the same run record.
 */
export function summaryRole(child: Pick<ChildRecord, "agent" | "name">): string {
	const role = child.agent ?? child.name.replace(/-\d+$/, "");
	return role || "unknown";
}

function isRunningState(state: TaskState): boolean {
	return RUNNING_STATES.has(state);
}

function asExecutionStatus(value: unknown): ExecutionStatus | null {
	if (
		value === "success" ||
		value === "failed" ||
		value === "aborted" ||
		value === "truncated" ||
		value === "running" ||
		value === "unknown"
	) {
		return value;
	}
	return null;
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeUsage(value: unknown): Usage | null {
	if (!value || typeof value !== "object") return null;
	const usage = value as Partial<Record<keyof Usage, unknown>>;
	return {
		input: finiteNumber(usage.input),
		output: finiteNumber(usage.output),
		cacheRead: finiteNumber(usage.cacheRead),
		cacheWrite: finiteNumber(usage.cacheWrite),
		cost: finiteNumber(usage.cost),
	};
}

function usageIsZero(usage: Usage): boolean {
	return (
		usage.input === 0 &&
		usage.output === 0 &&
		usage.cacheRead === 0 &&
		usage.cacheWrite === 0 &&
		usage.cost === 0
	);
}

function addUsage(left: Usage | null, right: Usage | null): Usage | null {
	if (!left && !right) return null;
	const a = left ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	const b = right ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
	};
}

function parseClock(value: number | Date | undefined): number {
	if (value instanceof Date) {
		return Number.isFinite(value.getTime()) ? value.getTime() : Date.now();
	}
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return Date.now();
}

function parseTimestamp(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function resolveDuration(
	child: ChildRecord,
	nowMs: number,
	running: boolean,
): { durationMs: number; startedAtMs: number | null; endedAtMs: number | null; liveDuration: boolean } {
	const startedAtMs = parseTimestamp(child.spawnedAt);
	if (startedAtMs === null) {
		return {
			durationMs: 0,
			startedAtMs: null,
			endedAtMs: null,
			liveDuration: false,
		};
	}

	const retiredAtMs = parseTimestamp(child.retiredAt);
	const liveDuration = retiredAtMs === null && running;
	const endedAtMs = retiredAtMs ?? (liveDuration ? nowMs : null);
	if (endedAtMs === null) {
		return { durationMs: 0, startedAtMs, endedAtMs: null, liveDuration: false };
	}
	return {
		durationMs: Math.max(0, endedAtMs - startedAtMs),
		startedAtMs,
		endedAtMs,
		liveDuration,
	};
}

/** A parsed session with no turns is a pre-created or missing file, not data. */
function sessionHasData(
	session: SummarySession | undefined,
): session is SummarySession {
	return Boolean(session && session.turns.length > 0);
}

/**
 * Session-jsonl usage fallback, gated three ways:
 *  - no parsed turns → the file is missing or still empty (F4 pre-creation,
 *    pruned, or a hard kill before the first write), so the parser-shaped
 *    zero usage is absence, not evidence — a pi child must not render a fake
 *    `0 / 0 / 0 · $0.000` row into the table and the totals;
 *  - a non-pi CLI never writes this file (F7), so non-zero content is only
 *    trustworthy once the child is finished — a live child would otherwise
 *    show stale partial usage from an earlier turn;
 *  - a pi session with at least one turn carries real usage, zero included
 *    (a free model legitimately reports zero).
 */
function usageFromSession(
	child: ChildRecord,
	session: SummarySession | undefined,
): Usage | null {
	if (!sessionHasData(session)) return null;
	const sessionUsage = normalizeUsage(session.usage);
	if (!sessionUsage) return null;
	if (child.kind !== "pi") {
		if (isRunningState(child.state)) return null;
		if (usageIsZero(sessionUsage)) return null;
	}
	return sessionUsage;
}

function resolveChild(
	run: RunRecord,
	child: ChildRecord,
	nowMs: number,
	sessions: ReadonlyMap<string, SummarySession> | undefined,
): SummaryChild {
	const session = sessions?.get(child.sessionFile);
	const running = isRunningState(child.state);
	const explicitExecutionStatus = asExecutionStatus(child.execution?.status);
	const executionStatus =
		explicitExecutionStatus ??
		(!running && sessionHasData(session)
			? asExecutionStatus(deriveOutcome(session).status)
			: null);
	const usage =
		normalizeUsage(child.execution?.usage) ?? usageFromSession(child, session);
	const turns =
		typeof child.execution?.turns === "number" &&
		Number.isFinite(child.execution.turns)
			? child.execution.turns
			: sessionHasData(session)
				? session.turns.length
				: null;
	const toolErrors =
		typeof child.execution?.toolErrors === "number" &&
		Number.isFinite(child.execution.toolErrors)
			? child.execution.toolErrors
			: sessionHasData(session)
				? session.toolErrors
				: null;

	const duration = resolveDuration(child, nowMs, running);
	return {
		run,
		child,
		role: summaryRole(child),
		running,
		executionStatus,
		usage,
		turns,
		toolErrors,
		durationMs: duration.durationMs,
		startedAtMs: duration.startedAtMs,
		endedAtMs: duration.endedAtMs,
		liveDuration: duration.liveDuration,
		...(session ? { session } : {}),
	};
}

function incrementOutcome(
	outcomes: Partial<Record<ExecutionStatus, number>>,
	status: ExecutionStatus,
): void {
	outcomes[status] = (outcomes[status] ?? 0) + 1;
}

function outcomeForChild(child: SummaryChild): ExecutionStatus | null {
	if (child.running) {
		// An awaiting child may retain a terminal execution snapshot while its
		// process is still open. Count that status as well as running. Working
		// and blocked snapshots are stale lifecycle data, so do not present them
		// as terminal outcomes.
		if (child.child.state !== "awaiting") return null;
		return child.executionStatus && child.executionStatus !== "running"
			? child.executionStatus
			: null;
	}
	if (child.executionStatus) return child.executionStatus;
	return "unknown";
}

function addChildOutcomes(
	outcomes: Partial<Record<ExecutionStatus, number>>,
	child: SummaryChild,
): void {
	if (child.running) incrementOutcome(outcomes, "running");
	const terminal = outcomeForChild(child);
	if (terminal) incrementOutcome(outcomes, terminal);
}

function sumOptional(values: readonly (number | null)[]): number | null {
	const known = values.filter((value): value is number => value !== null);
	if (known.length === 0) return null;
	return known.reduce((sum, value) => sum + value, 0);
}

function makeGroup(role: string, children: SummaryChild[]): SummaryGroup {
	const outcomes: Partial<Record<ExecutionStatus, number>> = {};
	let usage: Usage | null = null;
	for (const child of children) {
		addChildOutcomes(outcomes, child);
		usage = addUsage(usage, child.usage);
	}
	const turns = sumOptional(children.map((child) => child.turns));
	const totalDurationMs = children.reduce(
		(total, child) => total + child.durationMs,
		0,
	);
	const runningDurationMs = children.reduce(
		(longest, child) =>
			child.running ? Math.max(longest, child.durationMs) : longest,
		0,
	);
	return {
		role,
		children,
		count: children.length,
		outcomes,
		usage,
		turns,
		totalDurationMs,
		runningDurationMs,
		live: children.some((child) => child.running),
	};
}

/**
 * Aggregate run records without reading the filesystem. Pass parsed session
 * snapshots in `sessions`; the command layer obtains them with
 * {@link sessionMapFor}, i.e. through `parseSessionFileCached` — a display path,
 * so an unchanged session file is served from the #348 `(size, mtimeMs)` gate.
 * `parseSessionFileCached` is exported from `src/api.ts` for a host that wants to
 * build the same map itself; a read-only `parseSessionFile` snapshot works too.
 */
export function aggregateSubagentRuns(
	runs: readonly RunRecord[],
	options: SummaryAggregationOptions = {},
): SubagentSummary {
	// `?? {}` so a nullish options object from an API consumer degrades to
	// defaults instead of throwing — the rest of this module tolerates garbage.
	const opts = options ?? {};
	const nowMs = parseClock(opts.now);
	const allChildren: SummaryChild[] = [];
	const earliestCandidates: number[] = [];
	let latestUpdatedAtMs: number | null = null;
	for (const run of runs) {
		const updatedAtMs = parseTimestamp(run.updatedAt);
		if (updatedAtMs !== null) {
			latestUpdatedAtMs =
				latestUpdatedAtMs === null
					? updatedAtMs
					: Math.max(latestUpdatedAtMs, updatedAtMs);
		}
		for (const child of run.children) {
			const resolved = resolveChild(run, child, nowMs, opts.sessions);
			allChildren.push(resolved);
			if (resolved.startedAtMs !== null) earliestCandidates.push(resolved.startedAtMs);
		}
	}

	const byRole = new Map<string, SummaryChild[]>();
	for (const child of allChildren) {
		const current = byRole.get(child.role);
		if (current) current.push(child);
		else byRole.set(child.role, [child]);
	}
	const groups = [...byRole.entries()]
		.map(([role, children]) => makeGroup(role, children))
		.sort((a, b) => b.count - a.count || a.role.localeCompare(b.role));

	const outcomes: Partial<Record<ExecutionStatus, number>> = {};
	let usage: Usage | null = null;
	for (const child of allChildren) {
		addChildOutcomes(outcomes, child);
		usage = addUsage(usage, child.usage);
	}
	return {
		runs: [...runs],
		runCount: runs.length,
		childCount: allChildren.length,
		groups,
		totals: {
			outcomes,
			usage,
			turns: sumOptional(allChildren.map((child) => child.turns)),
			totalDurationMs: allChildren.reduce(
				(total, child) => total + child.durationMs,
				0,
			),
		},
		earliestSpawnedAtMs:
			earliestCandidates.length > 0 ? Math.min(...earliestCandidates) : null,
		latestUpdatedAtMs,
		...(runs[0]?.cwd ? { cwd: runs[0].cwd } : {}),
	};
}

/** Format a token count for the compact table representation. */
export function formatTokens(
	value: number | null | undefined,
	options: { keepTrailingZero?: boolean } = {},
): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	if (value < 1000) return String(value);
	const absolute = Math.abs(value);
	const unit = absolute >= 1_000_000_000 ? "B" : absolute >= 1_000_000 ? "M" : "K";
	const divisor = unit === "B" ? 1_000_000_000 : unit === "M" ? 1_000_000 : 1_000;
	let rendered = (value / divisor).toFixed(1);
	if (!options.keepTrailingZero) rendered = rendered.replace(/\.0$/, "");
	return `${rendered}${unit}`;
}

/** Format a dollar cost; null/undefined means that no usage was available. */
export function formatCost(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	return `$${value < 0.01 ? value.toFixed(3) : value.toFixed(2)}`;
}

/** Format milliseconds as seconds, minutes+seconds, or hours+minutes. */
export function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) {
		const seconds = totalSeconds % 60;
		return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function formatLocalTime(timestampMs: number | null, withSeconds = false): string {
	if (timestampMs === null || !Number.isFinite(timestampMs)) return "??";
	const date = new Date(timestampMs);
	if (withSeconds) {
		return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
	}
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function cacheTokens(usage: Usage): number {
	return usage.cacheRead + usage.cacheWrite;
}

function formatUsageCell(usage: Usage | null): string {
	if (!usage) return "—";
	return `${formatTokens(usage.input)} / ${formatTokens(usage.output)} / ${formatTokens(cacheTokens(usage))}`;
}

function formatDetailToken(value: number): string {
	const rendered = formatTokens(value);
	// The detail view keeps a tenths place for sub-100K token values, matching
	// the diagnostic style (`34.0K`, `7.6K`) while large cache counts stay
	// compact (`525K`). The public compact formatter remains canonical.
	if (value >= 1_000 && value < 100_000 && /^\d+K$/.test(rendered)) {
		return rendered.replace(/K$/, ".0K");
	}
	return rendered;
}

function formatDetailUsage(usage: Usage | null): string | null {
	if (!usage) return null;
	return `${formatDetailToken(usage.input)} in · ${formatDetailToken(usage.output)} out · ${formatDetailToken(cacheTokens(usage))} cache · ${formatCost(usage.cost)}`;
}

function formatOutcomePart(
	status: ExecutionStatus,
	count: number,
	runningDurationMs: number,
): string {
	if (status === "running") {
		const countPrefix = count > 1 ? `${count} ` : "";
		return `${countPrefix}running ${formatDuration(runningDurationMs)}`;
	}
	return count === 1 ? status : `${count} ${status}`;
}

function formatOutcomes(
	outcomes: Partial<Record<ExecutionStatus, number>>,
	runningDurationMs: number,
): string {
	const parts: string[] = [];
	for (const status of OUTCOME_ORDER) {
		const count = outcomes[status] ?? 0;
		if (count > 0) parts.push(formatOutcomePart(status, count, runningDurationMs));
	}
	return parts.join(", ") || "unknown";
}

function formatTotalOutcomes(
	outcomes: Partial<Record<ExecutionStatus, number>>,
): string[] {
	const parts: string[] = [];
	for (const status of OUTCOME_ORDER) {
		const count = outcomes[status] ?? 0;
		if (count > 0) parts.push(`${count} ${status}`);
	}
	return parts;
}

/**
 * Format the default seven-column markdown table. `summary` comes from
 * aggregateSubagentRuns; the command handler is the only caller that has one.
 */
export function formatSubagentSummary(
	summary: SubagentSummary,
	options: SummaryFormatOptions = {},
): string {
	if (summary.childCount === 0) {
		const cwd = options.cwd ?? summary.cwd ?? process.cwd();
		return `No subagent runs under ${cwd}.\nLaunch children with the subagent tool to see them here.`;
	}

	const start = formatLocalTime(summary.earliestSpawnedAtMs);
	const end = formatLocalTime(summary.latestUpdatedAtMs);
	const lines = [
		`Subagents session summary — ${summary.runCount} runs · ${summary.childCount} children · ${start}–${end}`,
		"",
		"| role | n | outcome | turns | tokens in/out/cache | cost | agent-time |",
		"|---|---|---|---|---|---|---|",
	];
	for (const group of summary.groups) {
		const time = `${formatDuration(group.totalDurationMs)}${group.live ? "+" : ""}`;
		lines.push(
			`| ${group.role} | ${group.count} | ${formatOutcomes(group.outcomes, group.runningDurationMs)} | ${group.turns === null ? "—" : group.turns} | ${formatUsageCell(group.usage)} | ${formatCost(group.usage?.cost)} | ${time} |`,
		);
	}
	const totalOutcomes = formatTotalOutcomes(summary.totals.outcomes);
	const totalUsage = summary.totals.usage
		? `${formatTokens(summary.totals.usage.input)} in / ${formatTokens(summary.totals.usage.output)} out / ${formatTokens(cacheTokens(summary.totals.usage))} cache`
		: "— in / — out / — cache";
	lines.push(
		"",
		`**Totals**: ${[...totalOutcomes, totalUsage, formatCost(summary.totals.usage?.cost), `${formatDuration(summary.totals.totalDurationMs)} agent-time`].join(" · ")}`,
	);
	return lines.join("\n");
}

/** Format the one-child detail view. */
export function formatSubagentDetail(input: SummaryDetailInput): string {
	const { run, child } = input;
	const nowMs = parseClock(input.now);
	// Same resolution pass as the table: the detail view must never disagree
	// with the aggregate on usage/turns for the same child. A missing
	// `input.session` degrades to an empty map — resolveChild then reports
	// absence (null) rather than parser-shaped zeros.
	const resolved = resolveChild(run, child, nowMs, input.session ? new Map([[child.sessionFile, input.session]]) : undefined);
	const { usage, turns, toolErrors, running } = resolved;
	const model = child.model ?? child.execution?.model ?? input.session?.model ?? undefined;
	const derivedExecution = resolved.executionStatus ?? undefined;
	const title = `${child.name} — ${summaryRole(child)}${child.kind ? ` (${child.kind})` : ""}`;
	const stateBits = [`state: ${child.state}`];
	if (derivedExecution) stateBits.push(`execution: ${derivedExecution}`);
	if (model) stateBits.push(`model: ${model}`);
	if (child.thinking !== undefined) stateBits.push(`thinking: ${child.thinking}`);
	const lines = [title, `  ${stateBits.join(" · ")}`];

	const runBits = [`run: ${run.runId}`, `supervisor: ${run.herdr.supervisor ?? "unknown"}`];
	lines.push(`  ${runBits.join(" · ")}`);

	const startedAtMs = parseTimestamp(child.spawnedAt);
	const retiredAtMs = parseTimestamp(child.retiredAt);
	const endedAtMs = retiredAtMs ?? (running ? nowMs : null);
	if (startedAtMs !== null && endedAtMs !== null) {
		lines.push(
			`  time: ${formatLocalTime(startedAtMs, true)} → ${formatLocalTime(endedAtMs, true)} (${formatDuration(Math.max(0, endedAtMs - startedAtMs))})`,
		);
	}

	const renderedUsage = formatDetailUsage(usage);
	if (renderedUsage) lines.push(`  usage: ${renderedUsage}`);
	const detailBits: string[] = [];
	if (turns !== null) detailBits.push(`turns: ${turns}`);
	if (toolErrors !== null) detailBits.push(`tool errors: ${toolErrors}`);
	if (child.acceptance) {
		detailBits.push(
			`acceptance: ${child.acceptance.status}${child.acceptance.level ? ` (${child.acceptance.level})` : ""}`,
		);
	}
	if (detailBits.length > 0) lines.push(`  ${detailBits.join(" · ")}`);

	if (child.worktreeBranch || child.worktreePath) {
		lines.push(`  worktree: ${child.worktreeBranch ?? child.worktreePath}`);
	}
	if (child.sessionFile) {
		const base = input.cwd ?? run.cwd;
		const relative = path.relative(base, child.sessionFile);
		lines.push(`  session: ${relative || child.sessionFile}`);
	}
	return lines.join("\n");
}

function parseSummaryArgs(
	args: string,
): { ok: true; all: boolean; name?: string } | { ok: false; message: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let all = false;
	let name: string | undefined;
	for (const token of tokens) {
		if (token === "--all") {
			if (all) return { ok: false, message: SUMMARY_USAGE };
			all = true;
			continue;
		}
		if (token.startsWith("-")) return { ok: false, message: SUMMARY_USAGE };
		if (name !== undefined) return { ok: false, message: SUMMARY_USAGE };
		name = token;
	}
	return { ok: true, all, ...(name ? { name } : {}) };
}

function filteredRuns(runs: readonly RunRecord[], _all: boolean): RunRecord[] {
	return [...runs];
}

function completionRuns(cwd: string, all: boolean): RunRecord[] {
	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	return filteredRuns(store.listRuns(), all);
}

function summaryCompletions(
	prefix: string,
	cwd: string,
): Array<{ value: string; label: string }> | null {
	const trimmed = prefix.trimStart();
	if (trimmed.startsWith("--") && !trimmed.includes(" ")) {
		return "--all".startsWith(trimmed)
			? [{ value: "--all", label: "--all" }]
			: [];
	}
	const all = /^--all\s+/.test(trimmed);
	const namePrefix = all ? trimmed.replace(/^--all\s+/, "") : prefix.trim();
	if (namePrefix.includes(" ")) return null;
	const names = new Set<string>();
	for (const run of completionRuns(cwd, all)) {
		for (const child of run.children) names.add(child.name);
	}
	return [...names]
		.filter((name) => name.startsWith(namePrefix))
		.sort((a, b) => a.localeCompare(b))
		.map((name) => ({ value: all ? `--all ${name}` : name, label: name }));
}

/**
 * Miss reporting for `/legion summary <name>` (#288).
 *
 * Was a hand-rolled sentence telling the caller to "pass the same cwd used for
 * launch" -- advice that the cross-store lookup had already made obsolete, and
 * advice the caller could not act on anyway (they do not know that cwd).
 *
 * Now it runs the same lookup `status` uses and prints `unknownChildMessage`,
 * so every named operation reports a miss identically and lists what WAS found.
 */
function notifyUnknownChild(
	ctx: ExtensionCommandContext,
	name: string,
): void {
	const { searched } = resolveChildAcrossStores({ name, cwd: ctx.cwd });
	ctx.ui.notify(unknownChildMessage({ name, cwd: ctx.cwd, searched }), "error");
}

/** Build the `/legion summary [--all] [<name>]` handler. */
export function createSummaryCommand(pi: ExtensionAPI): LegionSubcommand {
	let completionCwd = process.cwd();
	return {
		description: "Summarize subagent runs under the current session",
		getArgumentCompletions: (prefix) => summaryCompletions(prefix, completionCwd),
		handler: async (args, ctx) => {
			completionCwd = ctx.cwd;
			const parsed = parseSummaryArgs(args);
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			const store = new RunStore({
				rootDir: path.join(ctx.cwd, ".pi-subagents"),
			});
			const runs = filteredRuns(store.listRuns(), parsed.all);
			const sessions = sessionMapFor(runs);
			const now = Date.now();
			if (parsed.name) {
				const picked = pickChildByName(runs, parsed.name);
				if (!picked) {
					notifyUnknownChild(ctx, parsed.name);
					return;
				}
				sendSlashText(
					pi,
					formatSubagentDetail({
						run: picked.run,
						child: picked.child,
						session: sessions.get(picked.child.sessionFile),
						now,
						cwd: ctx.cwd,
					}),
				);
				return;
			}
			const summary = aggregateSubagentRuns(runs, { now, sessions });
			sendSlashText(
				pi,
				formatSubagentSummary(summary, { cwd: ctx.cwd }),
			);
		},
	};
}
