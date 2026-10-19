import type { DatabaseSync, SqliteRow } from "./db.ts";

export const LEGION_EVENT_TYPES = [
	"node_launched",
	"node_settled",
	"node_failed",
	"node_retired",
	"node_resumed",
	"node_blocked",
	/**
	 * Written by hygiene's `markAbandoned` (#233). It was missing from this set
	 * while both the writer and `RETAINED_EVENT_TYPES` already treated it as a
	 * real event, so `mapEvent` threw on read and froze the db event cursor.
	 */
	"node_abandoned",
	"phase_change",
	"phase_timeout",
	"mail_sent",
	"mail_delivered",
	"mail_bounced",
	"budget_refused",
	"node_abandoned",
	"orphan_detected",
	"tree_finalized",
] as const;

export type LegionEventType = (typeof LEGION_EVENT_TYPES)[number];

export interface LegionEvent<T = unknown> {
	id: number;
	nodeId: string;
	type: LegionEventType;
	data: T | null;
	ts: number;
}

export interface AppendEventOptions {
	now?: () => number;
}

export interface ReadEventsOptions {
	nodeId?: string;
	limit?: number;
}

export interface ReadEventRowsOptions {
	nodeId?: string;
	limit?: number;
	/** Called for a row that cannot be decoded; the row is skipped, not thrown. */
	onInvalidRow?: (error: unknown, rowId: number) => void;
}

export function appendEvent<T>(
	db: DatabaseSync,
	nodeId: string,
	type: LegionEventType,
	data?: T,
	options: AppendEventOptions = {},
): LegionEvent<T> {
	if (typeof nodeId !== "string" || nodeId.length === 0) {
		throw new TypeError("nodeId must be a non-empty string");
	}
	if (!isLegionEventType(type)) {
		throw new TypeError(`invalid legion event type: ${String(type)}`);
	}
	const ts = (options.now ?? (() => Date.now()))();
	if (!Number.isFinite(ts)) throw new TypeError("event timestamp must be finite");
	const serialized = data === undefined ? null : JSON.stringify(data);
	if (serialized === undefined) {
		throw new TypeError("event data must be JSON serializable");
	}
	const result = db
		.prepare("INSERT INTO events (node_id, type, data, ts) VALUES (?, ?, ?, ?)")
		.run(nodeId, type, serialized, ts);
	const normalizedData = serialized === null ? null : (JSON.parse(serialized) as T);
	return {
		id: Number(result.lastInsertRowid),
		nodeId,
		type,
		data: normalizedData,
		ts,
	};
}

export function readEventsAfter(
	db: DatabaseSync,
	cursor: number,
	options: ReadEventsOptions = {},
): LegionEvent[] {
	return selectEventRows(db, cursor, options).map(mapEvent);
}

/**
 * Per-row tolerant read: an undecodable row is reported through `onInvalidRow` and
 * skipped instead of throwing, so one poisoned row cannot stall an event consumer.
 * `readEventsAfter` stays strict for callers that must fail loudly.
 */
export function readEventsAfterTolerant(
	db: DatabaseSync,
	cursor: number,
	options: ReadEventRowsOptions = {},
): LegionEvent[] {
	const events: LegionEvent[] = [];
	for (const row of selectEventRows(db, cursor, options)) {
		try {
			events.push(mapEvent(row));
		} catch (error) {
			options.onInvalidRow?.(error, Number(row.id));
		}
	}
	return events;
}

export function getEventById(db: DatabaseSync, id: number): LegionEvent | null {
	if (!Number.isSafeInteger(id) || id < 1) {
		throw new TypeError("event id must be a positive safe integer");
	}
	const row = db
		.prepare("SELECT id, node_id, type, data, ts FROM events WHERE id = ?")
		.get(id);
	return row ? mapEvent(row) : null;
}

/** PRAGMA data_version changes only when another connection commits. */
export function getDataVersion(db: DatabaseSync): number {
	return Number(db.prepare("PRAGMA data_version;").get()?.data_version ?? 0);
}

export function hasExternalChanges(db: DatabaseSync, lastDataVersion: number): boolean {
	if (!Number.isSafeInteger(lastDataVersion) || lastDataVersion < 0) {
		throw new TypeError("lastDataVersion must be a non-negative safe integer");
	}
	return getDataVersion(db) !== lastDataVersion;
}

export function isLegionEventType(value: unknown): value is LegionEventType {
	return (
		typeof value === "string" &&
		(LEGION_EVENT_TYPES as readonly string[]).includes(value)
	);
}

function mapEvent(row: SqliteRow): LegionEvent {
	const type = String(row.type);
	if (!isLegionEventType(type)) {
		throw new Error(`database contains unknown legion event type: ${type}`);
	}
	let data: unknown = null;
	if (typeof row.data === "string") {
		try {
			data = JSON.parse(row.data) as unknown;
		} catch (error) {
			throw new Error(`event ${String(row.id)} has invalid JSON data`, { cause: error });
		}
	}
	return {
		id: Number(row.id),
		nodeId: String(row.node_id),
		type,
		data,
		ts: Number(row.ts),
	};
}

function selectEventRows(
	db: DatabaseSync,
	cursor: number,
	options: ReadEventsOptions,
): SqliteRow[] {
	assertCursor(cursor);
	const limit = options.limit ?? 1_000;
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new TypeError("event limit must be a positive safe integer");
	}
	return options.nodeId
		? db
				.prepare(
					"SELECT id, node_id, type, data, ts FROM events WHERE id > ? AND node_id = ? ORDER BY id LIMIT ?",
				)
				.all(cursor, options.nodeId, limit)
		: db
				.prepare(
					"SELECT id, node_id, type, data, ts FROM events WHERE id > ? ORDER BY id LIMIT ?",
				)
				.all(cursor, limit);
}

function assertCursor(cursor: number): void {
	if (!Number.isSafeInteger(cursor) || cursor < 0) {
		throw new TypeError("event cursor must be a non-negative safe integer");
	}
}
