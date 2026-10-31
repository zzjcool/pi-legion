/**
 * Subagent timing slash command (`/legion timing`).
 *
 * Reuses summary.ts duration resolution + session snapshots (via
 * aggregateSubagentRuns / the shared `sessionMapFor`, which reads through
 * `parseSessionFileCached`). Zero schema change — wall from spawnedAt/retiredAt|now,
 * generation from ParsedSession.generationMs, other = max(0, wall − gen).
 */

import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { sessionMapFor } from "../shared/session-map.ts";
import type { ChildRecord, RunRecord, TaskState } from "../shared/types.ts";
import {
	RunStore,
	pickChildByName,
} from "../runs/store.ts";
import { sendSlashText, type LegionSubcommand } from "./slash.ts";
import { resolveChildAcrossStores, unknownChildMessage } from "../runs/store-lookup.ts";
import {
	aggregateSubagentRuns,
	formatDuration,
	type SummaryChild,
	type SummarySession,
	type SubagentSummary,
} from "./summary.ts";
import { breakdown } from "../shared/timing-breakdown.ts";

export { breakdown } from "../shared/timing-breakdown.ts";

const TIMING_USAGE = "Usage: /legion timing [--json] [<name>]";

export interface TimingChild {
	name: string;
	role: string;
	state: TaskState;
	/** Still in a running lifecycle state (working/blocked/awaiting). */
	live: boolean;
	wall_ms: number;
	/** Session-derived model generation wall; null when no turn data. */
	generation_ms: number | null;
	/** max(0, wall − gen); null when generation_ms unavailable. Coarse bucket. */
	other_ms: number | null;
	turns: number | null;
	startedAtMs: number | null;
	endedAtMs: number | null;
	/** True when wall_ms tracks the live clock (retiredAt absent + running). */
	liveWall: boolean;
}

export interface TimingReport {
	children: TimingChild[];
	/** Earliest spawn → latest end across children with known endpoints. */
	span_ms: number | null;
	sum_wall_ms: number;
	cwd?: string;
}

export interface TimingFormatOptions {
	cwd?: string;
	json?: boolean;
}

function sessionHasTurns(
	session: SummarySession | undefined,
): session is SummarySession {
	return Boolean(session && session.turns.length > 0);
}

/** Map one SummaryChild (already duration-resolved) into a timing row. */
export function timingChildFromSummary(child: SummaryChild): TimingChild {
	const generation_ms = sessionHasTurns(child.session)
		? child.session.generationMs
		: null;
	const parts = breakdown(child.durationMs, generation_ms);
	return {
		name: child.child.name,
		role: child.role,
		state: child.child.state,
		live: child.running,
		wall_ms: parts.wall_ms,
		generation_ms: parts.generation_ms,
		other_ms: parts.other_ms,
		turns: child.turns,
		startedAtMs: child.startedAtMs,
		endedAtMs: child.endedAtMs,
		liveWall: child.liveDuration,
	};
}

/**
 * Build a timing report from the same aggregation path as `/legion summary`.
 * Children are sorted by startedAt (unknowns last), then name.
 */
export function buildTimingReport(
	summary: SubagentSummary,
	options: { cwd?: string } = {},
): TimingReport {
	const children: TimingChild[] = [];
	for (const group of summary.groups) {
		for (const child of group.children) {
			children.push(timingChildFromSummary(child));
		}
	}
	children.sort((a, b) => {
		if (a.startedAtMs === null && b.startedAtMs === null) {
			return a.name.localeCompare(b.name);
		}
		if (a.startedAtMs === null) return 1;
		if (b.startedAtMs === null) return -1;
		return a.startedAtMs - b.startedAtMs || a.name.localeCompare(b.name);
	});

	const started = children
		.map((c) => c.startedAtMs)
		.filter((v): v is number => v !== null);
	const ended = children
		.map((c) => c.endedAtMs)
		.filter((v): v is number => v !== null);
	const span_ms =
		started.length > 0 && ended.length > 0
			? Math.max(0, Math.max(...ended) - Math.min(...started))
			: null;
	const sum_wall_ms = children.reduce((sum, c) => sum + c.wall_ms, 0);

	return {
		children,
		span_ms,
		sum_wall_ms,
		...(options.cwd
			? { cwd: options.cwd }
			: summary.cwd
				? { cwd: summary.cwd }
				: {}),
	};
}

function formatMsCell(
	ms: number | null,
	opts: { live?: boolean } = {},
): string {
	if (ms === null) return "—";
	const rendered = formatDuration(ms);
	return opts.live ? `${rendered}+` : rendered;
}

function formatOptionalMs(ms: number | null): string {
	return ms === null ? "—" : formatDuration(ms);
}

function formatTurns(turns: number | null): string {
	return turns === null ? "—" : String(turns);
}

/** Human table for all children + optional concurrency footer. */
export function formatTimingTable(
	report: TimingReport,
	options: TimingFormatOptions = {},
): string {
	if (report.children.length === 0) {
		const cwd = options.cwd ?? report.cwd ?? process.cwd();
		return `No subagent runs under ${cwd}.\nLaunch children with the subagent tool to see timing here.`;
	}

	const lines = [
		`Subagent timing — ${report.children.length} children`,
		"",
		"| name | state | wall | gen | other | turns |",
		"|---|---|---|---|---|---|",
	];
	for (const child of report.children) {
		const wall =
			child.startedAtMs === null
				? "—"
				: formatMsCell(child.wall_ms, { live: child.liveWall });
		lines.push(
			`| ${child.name} | ${child.state} | ${wall} | ${formatOptionalMs(child.generation_ms)} | ${formatOptionalMs(child.other_ms)} | ${formatTurns(child.turns)} |`,
		);
	}

	if (report.span_ms !== null && report.children.length > 0) {
		const ratio =
			report.span_ms > 0
				? (report.sum_wall_ms / report.span_ms).toFixed(2)
				: "—";
		lines.push(
			"",
			`span ${formatDuration(report.span_ms)} · sum wall ${formatDuration(report.sum_wall_ms)} · concurrency ~${ratio}×`,
		);
	}
	return lines.join("\n");
}

/** Single-child detail (same口径 as summary detail, timing-focused). */
export function formatTimingDetail(child: TimingChild, run: RunRecord): string {
	const title = `${child.name} — ${child.role}`;
	const lines = [
		title,
		`  state: ${child.state}${child.live ? " (live)" : ""}`,
		`  run: ${run.runId}`,
	];
	const wall =
		child.startedAtMs === null
			? "—"
			: formatMsCell(child.wall_ms, { live: child.liveWall });
	lines.push(`  wall: ${wall}`);
	lines.push(`  generation: ${formatOptionalMs(child.generation_ms)}`);
	lines.push(
		`  other: ${formatOptionalMs(child.other_ms)} (wall − gen; not precise wait/tool)`,
	);
	lines.push(`  turns: ${formatTurns(child.turns)}`);
	return lines.join("\n");
}

function childToJson(child: TimingChild): Record<string, unknown> {
	return {
		name: child.name,
		role: child.role,
		state: child.state,
		live: child.live,
		wall_ms: child.wall_ms,
		generation_ms: child.generation_ms,
		other_ms: child.other_ms,
		turns: child.turns,
	};
}

export function formatTimingJson(
	report: TimingReport,
	detail?: { child: TimingChild; run: RunRecord },
): string {
	if (detail) {
		return JSON.stringify(
			{
				...childToJson(detail.child),
				runId: detail.run.runId,
			},
			null,
			2,
		);
	}
	return JSON.stringify(
		{
			children: report.children.map(childToJson),
			span_ms: report.span_ms,
			sum_wall_ms: report.sum_wall_ms,
			...(report.span_ms !== null && report.span_ms > 0
				? {
						concurrency_ratio: Number(
							(report.sum_wall_ms / report.span_ms).toFixed(4),
						),
					}
				: {}),
		},
		null,
		2,
	);
}

function parseTimingArgs(
	args: string,
):
	| { ok: true; json: boolean; name?: string }
	| { ok: false; message: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let json = false;
	let name: string | undefined;
	for (const token of tokens) {
		if (token === "--json") {
			if (json) return { ok: false, message: TIMING_USAGE };
			json = true;
			continue;
		}
		if (token.startsWith("-")) return { ok: false, message: TIMING_USAGE };
		if (name !== undefined) return { ok: false, message: TIMING_USAGE };
		name = token;
	}
	return { ok: true, json, ...(name ? { name } : {}) };
}

function timingCompletions(
	prefix: string,
	cwd: string,
): Array<{ value: string; label: string }> | null {
	const trimmed = prefix.trimStart();
	if (trimmed.startsWith("--") && !trimmed.includes(" ")) {
		return "--json".startsWith(trimmed)
			? [{ value: "--json", label: "--json" }]
			: [];
	}
	const json = /^--json\s+/.test(trimmed);
	const namePrefix = json ? trimmed.replace(/^--json\s+/, "") : prefix.trim();
	if (namePrefix.includes(" ")) return null;
	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	const names = new Set<string>();
	for (const run of store.listRuns()) {
		for (const child of run.children) names.add(child.name);
	}
	return [...names]
		.filter((name) => name.startsWith(namePrefix))
		.sort((a, b) => a.localeCompare(b))
		.map((name) => ({
			value: json ? `--json ${name}` : name,
			label: name,
		}));
}

/**
 * Miss reporting for `/legion timing <name>` (#288). Same cross-store lookup and
 * same message as `status` and `summary`, so a miss reads identically everywhere
 * and reports what was actually searched instead of advising an unknowable cwd.
 */
function notifyUnknownChild(
	ctx: ExtensionCommandContext,
	name: string,
): void {
	const { searched } = resolveChildAcrossStores({ name, cwd: ctx.cwd });
	ctx.ui.notify(unknownChildMessage({ name, cwd: ctx.cwd, searched }), "error");
}

function findTimingChild(
	report: TimingReport,
	summary: SubagentSummary,
	name: string,
): { timing: TimingChild; run: RunRecord; child: ChildRecord } | null {
	const picked = pickChildByName(summary.runs, name);
	if (!picked) return null;
	const timing = report.children.find((c) => c.name === picked.child.name);
	if (!timing) return null;
	return { timing, run: picked.run, child: picked.child };
}

/** Build the `/legion timing [--json] [<name>]` handler. */
export function createTimingCommand(pi: ExtensionAPI): LegionSubcommand {
	let completionCwd = process.cwd();
	return {
		description: "Show wall / generation / other timing for subagent children",
		getArgumentCompletions: (prefix) => timingCompletions(prefix, completionCwd),
		handler: async (args, ctx) => {
			completionCwd = ctx.cwd;
			const parsed = parseTimingArgs(args);
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			const store = new RunStore({
				rootDir: path.join(ctx.cwd, ".pi-subagents"),
			});
			const runs = store.listRuns();
			const sessions = sessionMapFor(runs);
			const now = Date.now();
			const summary = aggregateSubagentRuns(runs, { now, sessions });
			const report = buildTimingReport(summary, { cwd: ctx.cwd });

			if (parsed.name) {
				const found = findTimingChild(report, summary, parsed.name);
				if (!found) {
					notifyUnknownChild(ctx, parsed.name);
					return;
				}
				sendSlashText(
					pi,
					parsed.json
						? formatTimingJson(report, {
								child: found.timing,
								run: found.run,
							})
						: formatTimingDetail(found.timing, found.run),
				);
				return;
			}

			sendSlashText(
				pi,
				parsed.json
					? formatTimingJson(report)
					: formatTimingTable(report, { cwd: ctx.cwd }),
			);
		},
	};
}
