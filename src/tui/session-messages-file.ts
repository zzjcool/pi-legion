/**
 * Incremental AgentMessage[] reader for the live-overlay path (#234).
 *
 * Reuses `readSessionJsonlDelta` / fingerprint rewrite detection from
 * `src/shared/session.ts` and projects newly complete JSONL lines through
 * `parseSessionMessages`. Does not invent its own truncate/rewrite checks.
 *
 * Trailing partial lines match session.ts: returned for this call only, never
 * committed to the cache. No fs.watch — callers keep polling via size/cursor.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	readSessionJsonlDelta,
	type SessionByteCursor,
} from "../shared/session.ts";
import { parseSessionMessages } from "./chat-items.ts";

interface OverlayMessageState {
	cursor: SessionByteCursor;
	messages: AgentMessage[];
	/** Last observed file size; unchanged size ⇒ skip open/parse. */
	fileSize: number;
}

const CACHE_MAX_ENTRIES = 64;
const overlayMessageCache = new Map<string, OverlayMessageState>();

/** Test hook: drop incremental overlay message state. */
export function clearOverlaySessionMessageCache(): void {
	overlayMessageCache.clear();
}

function touch(path: string, state: OverlayMessageState): void {
	overlayMessageCache.delete(path);
	overlayMessageCache.set(path, state);
	if (overlayMessageCache.size > CACHE_MAX_ENTRIES) {
		const oldest = overlayMessageCache.keys().next().value;
		if (oldest !== undefined) overlayMessageCache.delete(oldest);
	}
}

function projectLines(lines: readonly string[]): AgentMessage[] {
	if (lines.length === 0) return [];
	return parseSessionMessages(lines.join("\n"));
}

/**
 * Parse a session JSONL file into overlay messages, reading only bytes past the
 * cached fingerprint offset on warm polls.
 *
 * Returns `undefined` when the file is missing/unreadable. When `fileSize` is
 * unchanged since the last successful read, returns the cached messages without
 * re-reading the body (stat-equivalent short circuit is done by comparing the
 * caller's cursor in legion-commands; this also no-ops when the cache is warm
 * and the on-disk size matches).
 */
export function readSessionMessagesFile(path: string): {
	messages: readonly AgentMessage[];
	fileSize: number;
} | undefined {
	const cached = overlayMessageCache.get(path);
	const delta = readSessionJsonlDelta(path, cached?.cursor);
	if (!delta) {
		overlayMessageCache.delete(path);
		return undefined;
	}

	// Warm path: size unchanged and fingerprint still valid ⇒ nothing to do.
	if (
		cached &&
		!delta.reset &&
		delta.fileSize === cached.fileSize &&
		delta.lines.length === 0 &&
		!delta.provisional
	) {
		return { messages: cached.messages, fileSize: cached.fileSize };
	}

	const base = delta.reset || !cached ? [] : cached.messages;
	const committed = projectLines(delta.lines);
	const nextMessages = committed.length > 0 ? base.concat(committed) : base.slice();
	touch(path, {
		cursor: delta.cursor,
		messages: nextMessages,
		fileSize: delta.fileSize,
	});

	// Provisional tail: project for this call only (session.ts口径).
	if (!delta.provisional) {
		return { messages: nextMessages, fileSize: delta.fileSize };
	}
	const provisionalMessages = projectLines([delta.provisional]);
	if (provisionalMessages.length === 0) {
		return { messages: nextMessages, fileSize: delta.fileSize };
	}
	return {
		messages: nextMessages.concat(provisionalMessages),
		fileSize: delta.fileSize,
	};
}
