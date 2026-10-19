/**
 * TUI renderer for the `subagent` / `vexillatio` tool results.
 *
 * Pi never renders a tool result's `details` on its own: `renderResult` is the
 * only consumer, and a tool registered without one falls back to the plain
 * `content` text. So the arbitrated `spawnMode` (#209) stays invisible until a
 * renderer names it — that is all this file does.
 *
 * The summary line is derived from `details`, never from `content`: `content`
 * is model-facing, `details` is TUI-facing (`docs/design.md:258`). Keeping the
 * line out of `content` keeps it out of the LLM context.
 *
 * Renderers are called on every repaint, so nothing here may throw: the host
 * swallows a throwing renderer and falls back to the default block, silently
 * erasing the very fact this file exists to show. Every `details` read is
 * therefore optional-chained and shape-checked, AND both entry points are
 * wrapped in `try/catch`: a shape check is no defence against a getter or a
 * Proxy trap that throws (host: `tool-execution.js` catch → fallback card).
 */

import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** How many `content` lines a collapsed card keeps before the expand hint. */
const COLLAPSED_LINES = 10;

const SPAWN_MODES = new Set(["rpc", "inprocess"]);

/**
 * Binary control bytes that must never reach the terminal renderer.
 *
 * Same set as the host fallback (`shell.js:sanitizeBinaryOutput`, used by
 * `render-utils.js:getTextOutput`): TAB, LF and CR are excluded on purpose —
 * the carriage return is a line break here, see {@link resultLines}.
 */
const BINARY_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g;

export interface SpawnRenderOptions {
	expanded: boolean;
	isPartial: boolean;
}

function isSpawnMode(value: unknown): value is "rpc" | "inprocess" {
	return typeof value === "string" && SPAWN_MODES.has(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/** One `name=mode` entry from a `spawns[]` array (launch-family details). */
function entryFromSpawn(value: unknown): string | undefined {
	const spawn = asRecord(value);
	if (!spawn) return undefined;
	const name = spawn.name;
	const mode = spawn.spawnMode;
	if (typeof name !== "string" || !name) return undefined;
	// An unknown/absent mode is skipped, never printed as a guess: a legacy
	// handle must render as "no fact", not as `rpc`.
	if (!isSpawnMode(mode)) return undefined;
	return `${name}=${mode}`;
}

/** One `name=mode` entry from a `handles[]` object (vexillatio details). */
function entryFromHandle(value: unknown): string | undefined {
	const handle = asRecord(value);
	if (!handle) return undefined;
	return entryFromSpawn(handle);
}

/**
 * `spawn: scout-0=inprocess` or `spawn: worker-0=rpc, scout-1=inprocess`.
 *
 * Reads both documented detail shapes defensively:
 * - launch family: `details.spawns[]` (`{ name, agent, spawnMode }`)
 * - vexillatio:    `details.handles[]` (`{ name, agent, sessionFile, spawnMode? }`)
 *
 * One entry per child, first occurrence wins: a result that carries the same
 * handle in both arrays must not print `w=rpc, w=rpc`.
 *
 * Returns `undefined` when nothing survives — no details, wrong shape, or every
 * entry's mode unknown. Unknown modes are omitted rather than defaulted.
 *
 * Never throws: a `details` object with a throwing getter (or a Proxy) would
 * otherwise take the whole card down, because the host swallows renderer
 * exceptions and paints its fallback instead.
 */
export function spawnModeSummary(details: unknown): string | undefined {
	try {
		const record = asRecord(details);
		if (!record) return undefined;
		const entries: string[] = [];
		const seen = new Set<string>();
		const push = (entry: string | undefined): void => {
			if (!entry || seen.has(entry)) return;
			seen.add(entry);
			entries.push(entry);
		};
		const spawns = record.spawns;
		if (Array.isArray(spawns)) {
			for (const spawn of spawns) push(entryFromSpawn(spawn));
		}
		// `handles` may be a `string[]` (launch-family) or an object array
		// (vexillatio); string entries simply never match, so both shapes pass.
		const handles = record.handles;
		if (Array.isArray(handles)) {
			for (const handle of handles) push(entryFromHandle(handle));
		}
		if (entries.length === 0) return undefined;
		return `spawn: ${entries.join(", ")}`;
	} catch {
		// A hostile/throwing getter is not a rendering failure: no fact, no line.
		return undefined;
	}
}

/**
 * The model-facing text of a result, normalized the way it will be painted.
 *
 * Line counting has to happen on the text that actually renders, so
 * normalizing runs BEFORE the split: a carriage return is how a progress
 * stream redraws one line, not 20 rows — but `Text` treats `\r` as a line
 * break, so leaving it in lets 20 segments paint 20 rows and bypass
 * {@link COLLAPSED_LINES} with no hint. `\r` therefore becomes `\n` (so all
 * 20 segments stay readable instead of being concatenated into one blob) and
 * binary control bytes are dropped, matching the host fallback's intent
 * (`render-utils.js:40` sanitizes binary output and removes raw `\r`).
 */
function resultLines(result: AgentToolResult<unknown> | undefined): string[] {
	const content = result?.content;
	if (!Array.isArray(content)) return [];
	const text = content
		.flatMap((part) => {
			if (asRecord(part)?.type !== "text") return [];
			const value = asRecord(part)?.text;
			return typeof value === "string" ? [value] : [];
		})
		.join("\n");
	const normalized = stripTerminalSequences(text)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(BINARY_CONTROL, "");
	return normalized.split("\n");
}

/**
 * Build the card: the spawn summary line (when known) followed by the result
 * text, capped at {@link COLLAPSED_LINES} lines until `ctrl+o` expands it.
 *
 * Never throws by design; see the file comment.
 */
export function renderSpawnResult(
	result: AgentToolResult<unknown>,
	opts: SpawnRenderOptions,
	_theme: Theme,
) {
	const lines: string[] = [];
	// Double insurance: `spawnModeSummary` is already total, but this call site
	// must not depend on the callee's implementation staying that way (the host
	// silences a throw and drops the card). The `details` READ is inside the
	// guard too — a Proxy can throw on the property access itself.
	let summary: string | undefined;
	try {
		summary = spawnModeSummary(result?.details);
	} catch {
		summary = undefined;
	}
	if (summary) lines.push(summary);
	lines.push(...resultLines(result));
	// `opts` is host-supplied; optional-chained so a partial/absent options
	// object degrades to the collapsed view instead of throwing.
	if (opts?.expanded || lines.length <= COLLAPSED_LINES) {
		return new Text(lines.join("\n"), 0, 0);
	}
	const hidden = lines.length - COLLAPSED_LINES;
	const visible = lines.slice(0, COLLAPSED_LINES);
	visible.push(`... (${hidden} more lines, ctrl+o to expand)`);
	return new Text(visible.join("\n"), 0, 0);
}
