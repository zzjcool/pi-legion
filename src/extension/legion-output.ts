/**
 * `legion_output` — read a child's result artifact, and record how much was read.
 *
 * Contract: `docs/contracts/result-ledger-v1.md` §3 D7 (this tool), D6 (only a read
 * to EOF suppresses the notice), D10 (lookup is by artifact `id`, never by the
 * `artifacts.name` column) and §6 P5b.
 *
 * Why a second reader next to the host's `read`: the body lives at
 * `<runDir>/artifacts/<segment>/r<round>.md`, a path the model cannot derive (the
 * round, the sanitized segment), and a generic `read` of that file records a
 * consumption only through the D5 path hook (P5a), which cannot say "this was a
 * page" in the header. `legion_output` is the addressable reader: it resolves
 * `(name, round)` itself, prefixes a header that names the round, size, settled-at
 * and the producing node's phase, and is the one place that can tell the model
 * "a page is not a read" in the same breath (D6).
 *
 * Registration belongs to the PLUGIN layer (`pi.registerTool` in `index.ts`'s
 * plugin entry, where `subagent` / `vexillatio` live), not to
 * `registerLegionTools` (child-only): D7 wants root and child alike to have the
 * tool. The execute path therefore resolves the caller's
 * identity lazily, on every call — a root has no legion identity until its first
 * launch, and the tool must exist before that.
 *
 * Unlike the read-side seams (`markDelivered`), this module does not bail silently
 * when it cannot answer: the tool result IS the answer, so every failure is a
 * human sentence the model can act on, never a throw (a throw would surface as a
 * host-level tool error and lose the reason).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type { DatabaseSync } from "../legion/db.ts";
import { listArtifacts, markRead, type Artifact } from "../legion/ledger.ts";
import { getNode } from "../legion/nodes.ts";
import { artifactNameSegment, artifactPathFor, readLatestArtifact } from "../runs/artifacts.ts";
import { formatSize, sanitizeNoticeField } from "./notify.ts";

/** Model-facing tool name (§3 D7). */
export const LEGION_OUTPUT_TOOL_NAME = "legion_output";

/** Lines the collapsed TUI card keeps, header included — same budget as `spawn-render.ts`. */
const COLLAPSED_LINES = 10;

/** How many known names a not-found answer may list (§6 P5b: "最多 5 个"). */
const MAX_AVAILABLE_NAMES = 5;

/**
 * D6's header line for a paged read, verbatim (the user ruling: "read half is not
 * read"). Not paraphrased on purpose — the model has to read the same sentence the
 * contract froze.
 */
const PARTIAL_NOTICE = "notifications not suppressed — read to EOF to settle";

/**
 * The parameters the model sees.
 *
 * `offset` is 1-based and counts LINES (like the host `read` tool), so "page two"
 * is `offset: 21, limit: 20` for a 20-line page; it is not a byte offset. `round`
 * exists because a name can produce several artifacts (W6): without it, "the
 * newest" would be the only addressable round.
 */
const LegionOutputParams = Type.Object({
	name: Type.String({
		description:
			'Child name whose result to read (e.g. "worker-0"). Rounds of the same name are addressed with `round`.',
	}),
	round: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Artifact round (1-based). Defaults to the newest round recorded for this name.",
		}),
	),
	offset: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"1-based LINE offset. Present ⇒ the read is a page: the header says `partial …` and the completion notice is NOT suppressed.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Maximum number of LINES to return from `offset`. Present ⇒ the read is a page (see `offset`).",
		}),
	),
});

/** The caller's own ledger identity, resolved per call (`ownLegionIdentity()` in `index.ts`). */
export interface LegionOutputIdentity {
	/** The host's one connection; no second open. */
	db: DatabaseSync;
	/** The CONSUMER whose `consumptions` row a full read advances — a root's id is literally `"root"` (D3). */
	consumerId: string;
	/** `<runId>` component of the artifact id (D1). */
	runId: string;
	/** `<runDir>` that owns `artifacts/…`. */
	runDir: string;
}

export interface LegionOutputRequest {
	name: string;
	round?: number | undefined;
	offset?: number | undefined;
	limit?: number | undefined;
}

export interface LegionOutputOutcome {
	/** Header (plus the `partial` line for a page) and then the body — what the model reads. */
	text: string;
	/** TUI/automation facts: `{ artifactId, round, bytes, phase }` on success, `{ error }` otherwise. */
	details: Record<string, unknown>;
	/** True when the WHOLE body was returned unchanged and `markRead(bytes)` was written (D6). */
	recorded: boolean;
}

/**
 * Read one artifact and, when the whole body was returned, record the consumption.
 *
 * The accounting rule is D6 and it is deliberately narrow — a full read is
 * "no `offset`/`limit`, the body reached EOF, and `stat.size` still equals the
 * ledger's `bytes`". Anything else records NOTHING (not a partial high-water
 * mark): the projection keeps owing the notice, and a body that changed on disk
 * is not the artifact the ledger describes (A1's `changed-on-disk`).
 */
export function readLegionOutput(input: {
	identity: LegionOutputIdentity | undefined;
	request: LegionOutputRequest;
	now?: number;
}): LegionOutputOutcome {
	const now = input.now ?? Date.now();
	try {
		const identity = input.identity;
		if (!identity) {
			return failed(
				"legion_output needs a legion run: this session has no legion identity (it is neither a tree root nor a tree node).",
				"NO_LEGION_CONTEXT",
			);
		}
		const request = input.request ?? ({} as LegionOutputRequest);
		const name = typeof request.name === "string" ? request.name.trim() : "";
		if (name.length === 0) {
			return failed('legion_output needs a child name, e.g. legion_output({ name: "worker-0" }).', "INVALID_PARAMS");
		}
		for (const [field, value] of [
			["round", request.round],
			["offset", request.offset],
			["limit", request.limit],
		] as const) {
			if (value === undefined) continue;
			if (!Number.isSafeInteger(value) || value < 1) {
				return failed(`legion_output: \`${field}\` must be a positive integer (got ${String(value)}).`, "INVALID_PARAMS");
			}
		}

		// D10: the id segment, never the `name` column — after a rebuild that column
		// holds the sanitized directory name, so filtering on it would lose rows.
		const segment = artifactNameSegment(name);
		const resolved = resolveArtifact(identity, name, segment, request.round);
		if (!resolved) return failed(notFoundMessage(identity, name, request.round), "NOT_FOUND");

		let stats: fs.Stats;
		let content: string;
		try {
			stats = fs.statSync(resolved.path);
			if (!stats.isFile()) throw new Error("not a regular file");
			content = fs.readFileSync(resolved.path, "utf8");
		} catch (error) {
			return failed(
				`legion_output: the body of "${name}" (round ${resolved.round}) is unreadable at ${resolved.path}: ${messageOf(error)}`,
				"IO_ERROR",
			);
		}
		// A1/D7: the ledger's `bytes` is the number the projection compares against.
		// A file that no longer has that size is marked, never "read to EOF".
		const changedOnDisk = stats.size !== resolved.bytes;

		const lines = splitLines(content);
		const total = lines.length;
		const paged = request.offset !== undefined || request.limit !== undefined;
		const start = paged ? clampOffset(request.offset, total) : 1;
		const wanted = request.limit ?? Math.max(total - start + 1, 0);
		const end = paged ? Math.min(total, start - 1 + wanted) : total;
		const page = paged ? lines.slice(start - 1, end) : lines;
		// The last 1-based line number actually returned (0 for an empty page).
		const reached = start - 1 + page.length;
		const body = paged
			? page.join("\n") + (page.length > 0 && reached === total && content.endsWith("\n") ? "\n" : "")
			: content;

		const phase = phaseOf(identity.db, resolved.nodeId);
		const header: string[] = [
			sanitizeNoticeField(name),
			`round ${resolved.round}`,
			formatSize(resolved.bytes),
			`settled ${formatAgo(resolved.createdAt, now)}`,
		];
		if (phase) header.push(`phase=${sanitizeNoticeField(phase)}`);
		if (changedOnDisk) header.push("changed-on-disk");

		const partialLine =
			paged && (start > 1 || reached < total)
				? `partial ${reached}/${total} lines · ${PARTIAL_NOTICE}`
				: undefined;
		const text = partialLine
			? `${header.join(" · ")}\n${partialLine}\n${body}`
			: `${header.join(" · ")}\n${body}`;

		let recorded = false;
		if (!paged && !changedOnDisk && resolved.inLedger) {
			try {
				// Same write `markDelivered` performs, with the same `consumerId`
				// (`identity.consumerId`) the orchestrator recorded as `parent_id`.
				markRead(identity.db, {
					artifactId: resolved.id,
					consumerId: identity.consumerId,
					bytesRead: resolved.bytes,
					at: now,
				});
				recorded = true;
			} catch {
				// D1e: a ledger write is a fact ABOUT the read, never a condition of it.
			}
		}

		return {
			text,
			details: { artifactId: resolved.id, round: resolved.round, bytes: resolved.bytes, phase },
			recorded,
		};
	} catch (error) {
		return failed(`legion_output failed: ${messageOf(error)}`, "FAILED");
	}
}

/** What a resolved artifact looks like to the reader, from the ledger or from disk. */
interface ResolvedArtifact {
	/** `"<runId>/<segment>/r<round>"` — the ledger key (§3 D1). */
	id: string;
	round: number;
	path: string;
	/** The ledger's byte count; `stat.size` for a disk-only artifact (§3 D10). */
	bytes: number;
	/** `artifacts.created_at`, or the file mtime when no row exists. */
	createdAt: number;
	/** The producing child node id, when a row names one (needed for `phase`). */
	nodeId: string | null;
	/** True only when a ledger row exists — the only case a read can be recorded. */
	inLedger: boolean;
}

/**
 * `(name, round)` → artifact, ledger first, disk second (§6 P5b).
 *
 * The ledger wins when it has rows, because `artifacts.bytes` is the number the
 * projection compares against; only a name with no row at all falls back to the
 * scanner in `src/runs/artifacts.ts` (the same D1a fallback the round generator
 * uses). An explicit `round` is looked up on its own, so reading round 1 never
 * depends on which round is newest.
 *
 * Every candidate is scoped to this consumer: `listArtifacts(db, consumerId)` is
 * the `parent_id` half of the projection, so a node can never read a sibling's or
 * another run's result by guessing a name.
 */
function resolveArtifact(
	identity: LegionOutputIdentity,
	name: string,
	segment: string,
	requestedRound: number | undefined,
): ResolvedArtifact | null {
	const rows = ledgersRounds(identity, segment);
	if (requestedRound !== undefined) {
		const row = rows.get(requestedRound);
		if (row) return fromRow(row);
		return diskArtifact(identity, name, segment, requestedRound);
	}
	if (rows.size > 0) {
		let newest: Artifact | undefined;
		for (const row of rows.values()) {
			if (!newest || row.round > newest.round) newest = row;
		}
		return fromRow(newest!);
	}
	// No ledger row at all → the disk's own answer, exactly like the writer's D1a
	// fallback (`readLatestArtifact` keeps the file's real name, so an `r01.md`
	// does not silently answer "nothing").
	const latest = readLatestArtifact({ runDir: identity.runDir, name, runId: identity.runId });
	if (!latest) return null;
	try {
		const stats = fs.statSync(latest.path);
		if (!stats.isFile()) return null;
		return {
			id: `${identity.runId}/${segment}/r${latest.round}`,
			round: latest.round,
			path: latest.path,
			bytes: stats.size,
			createdAt: stats.mtimeMs,
			nodeId: null,
			inLedger: false,
		};
	} catch {
		return null;
	}
}

/** This consumer's rows for one `<segment>`, keyed by round (§3 D10: keyed by `id`). */
function ledgersRounds(identity: LegionOutputIdentity, segment: string): Map<number, Artifact> {
	const prefix = `${identity.runId}/${segment}/r`;
	const rounds = new Map<number, Artifact>();
	for (const artifact of listArtifacts(identity.db, identity.consumerId)) {
		if (!artifact.id.startsWith(prefix)) continue;
		const round = Number(artifact.id.slice(prefix.length));
		// Canonical spelling only: the writer emits `r<round>`, and the id compares
		// by exact text (`r01.md` must not borrow `r1`'s identity — see
		// `artifactIdFromPath`).
		if (!Number.isSafeInteger(round) || round < 1 || artifact.id !== `${prefix}${round}`) continue;
		rounds.set(round, artifact);
	}
	return rounds;
}

function fromRow(row: Artifact): ResolvedArtifact {
	return {
		id: row.id,
		round: row.round,
		path: row.path,
		bytes: row.bytes,
		createdAt: row.createdAt,
		nodeId: row.nodeId,
		inLedger: true,
	};
}

/** A round that exists on disk but has no ledger row (a deleted db, or before `rebuild`). */
function diskArtifact(
	identity: LegionOutputIdentity,
	name: string,
	segment: string,
	round: number,
): ResolvedArtifact | null {
	const file = artifactPathFor(identity.runDir, name, round);
	try {
		const stats = fs.statSync(file);
		if (!stats.isFile()) return null;
		return {
			id: `${identity.runId}/${segment}/r${round}`,
			round,
			path: file,
			bytes: stats.size,
			createdAt: stats.mtimeMs,
			nodeId: null,
			inLedger: false,
		};
	} catch {
		return null;
	}
}

/**
 * The child node whose phase the header names.
 *
 * The artifact's `node_id` is the producer, and `phase` is the producer's own
 * phase (`nodes.phase`), not the reader's: the header answers "what was this child
 * doing when it produced this result". A node with no phase (never governed by a
 * machine) or a disk-only artifact (no `node_id`) omits the segment — a guessed
 * phase would be worse than none.
 */
function phaseOf(db: DatabaseSync, nodeId: string | null): string | null {
	if (!nodeId) return null;
	try {
		const phase = getNode(db, nodeId)?.phase ?? null;
		return phase !== null && phase.length > 0 ? phase : null;
	} catch {
		return null;
	}
}

/** Up to {@link MAX_AVAILABLE_NAMES} names this consumer could have asked for. */
function availableNames(identity: LegionOutputIdentity): string[] {
	const names: string[] = [];
	const add = (value: string): void => {
		if (!value || names.includes(value) || names.length >= MAX_AVAILABLE_NAMES) return;
		names.push(value);
	};
	try {
		for (const artifact of listArtifacts(identity.db, identity.consumerId)) add(artifact.name);
	} catch {
		/* a closed/refusing db must not hide the disk half */
	}
	if (names.length < MAX_AVAILABLE_NAMES) {
		try {
			const directory = path.join(identity.runDir, "artifacts");
			for (const entry of fs.readdirSync(directory).sort()) add(entry);
		} catch {
			/* no artifacts directory = no disk half either */
		}
	}
	return names;
}

function notFoundMessage(
	identity: LegionOutputIdentity,
	name: string,
	round: number | undefined,
): string {
	const names = availableNames(identity);
	const target = round === undefined ? `"${name}"` : `"${name}" at round ${round}`;
	const tail = names.length > 0 ? `available: ${names.join(", ")}` : "nothing has been recorded yet";
	return `legion_output: no artifact named ${target} for this node — ${tail}.`;
}

/** `partial`-friendly line split: the file's own newline budget, no phantom last line. */
function splitLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** 1-based offset, clamped into `[1, total + 1]`; `total + 1` is the empty page past EOF. */
function clampOffset(offset: number | undefined, total: number): number {
	const raw = offset ?? 1;
	return Math.min(Math.max(1, raw), total + 1);
}

/**
 * `settled 2m ago` — the artifact's `created_at`, said the way the contract's
 * header sample says it. Second granularity below a minute; a re-read never
 * refreshes this clock (the timestamp is the artifact's, not the call's).
 */
function formatAgo(createdAt: number, now: number): string {
	if (!Number.isFinite(createdAt)) return "unknown";
	const secs = Math.max(0, Math.floor((now - createdAt) / 1000));
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function failed(text: string, code: string): LegionOutputOutcome {
	return { text, details: { error: code }, recorded: false };
}

/** An empty result the TUI can always paint, even after a hostile `details`. */
function emptyRender(): Text {
	return new Text("", 0, 0);
}

/**
 * The model-facing text of a result, normalized the way it will paint.
 *
 * Mirrors `spawn-render.ts`'s `resultLines`: `\r` is a redraw, not a line break,
 * and binary control bytes never reach the terminal. The header is the first line,
 * so keeping the FIRST lines visible is what keeps it on screen.
 */
function resultLines(result: AgentToolResult<unknown> | undefined): string[] {
	const content = result?.content;
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (part === null || typeof part !== "object") continue;
		const entry = part as { type?: unknown; text?: unknown };
		if (entry.type !== "text" || typeof entry.text !== "string") continue;
		parts.push(entry.text);
	}
	const normalized = stripTerminalSequences(parts.join("\n"))
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	return normalized.split("\n");
}

/**
 * TUI card for `legion_output`: the header line first, capped at
 * {@link COLLAPSED_LINES} until `ctrl+o`.
 *
 * The host swallows a throwing renderer and paints its fallback instead, which
 * would erase exactly the header this renderer exists to show — hence the
 * try/catch around every read, including the shape check.
 */
export function renderLegionOutputResult(
	result: AgentToolResult<unknown>,
	opts: { expanded?: boolean; isPartial?: boolean } | undefined,
	_theme: Theme,
) {
	let lines: string[];
	try {
		lines = resultLines(result);
	} catch {
		return emptyRender();
	}
	if (lines.length === 0) return emptyRender();
	try {
		if (opts?.expanded || lines.length <= COLLAPSED_LINES) return new Text(lines.join("\n"), 0, 0);
		const hidden = lines.length - COLLAPSED_LINES;
		const visible = lines.slice(0, COLLAPSED_LINES);
		visible.push(`... (${hidden} more lines, ctrl+o to expand)`);
		return new Text(visible.join("\n"), 0, 0);
	} catch {
		return emptyRender();
	}
}

export interface RegisterLegionOutputOptions {
	/** Resolved per call: a root has no identity until its first launch (§3 D7). */
	resolveIdentity: () => LegionOutputIdentity | undefined;
	/** Injected clock (tests); defaults to `Date.now`. */
	now?: () => number;
}

/**
 * Register `legion_output` on the host.
 *
 * Called from the PLUGIN entry, where `subagent` / `vexillatio` are registered —
 * never from `registerLegionTools` (child-only, `index.ts`'s `nodeId !== "root"`
 * gate): D7 wants the tool in a root session too, and the identity it needs is
 * resolved lazily inside `execute`.
 */
export function registerLegionOutputTool(
	pi: ExtensionAPI,
	options: RegisterLegionOutputOptions,
): void {
	pi.registerTool({
		name: LEGION_OUTPUT_TOOL_NAME,
		label: "Legion output",
		description:
			"Read a child's result artifact (the immutable body behind a completion notice). " +
			"`round` defaults to the newest round of that name. " +
			"Reading the WHOLE body (no `offset`/`limit`) settles it: its completion notice will not be sent (or, if already sent, it is not re-sent). " +
			"`offset` (1-based) and `limit` page by LINES; a page settles nothing — read to EOF to settle.",
		parameters: LegionOutputParams,
		renderResult: (result, opts, theme) => renderLegionOutputResult(result, opts, theme),
		async execute(_id, params): Promise<AgentToolResult<unknown>> {
			const outcome = readLegionOutput({
				identity: options.resolveIdentity(),
				request: params,
				...(options.now ? { now: options.now() } : {}),
			});
			return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
		},
	});
}
