import type { DatabaseSync, SqliteRow } from "./db.ts";
import { withTransaction } from "./db.ts";

export interface UsageSnapshot {
	nodeId: string;
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
	updatedAt: number | null;
}

export interface UpsertUsageInput {
	nodeId: string;
	tokensIn?: number;
	tokensOut?: number;
	costUsd?: number;
}

/**
 * Chunk size for `WHERE node_id IN (...)` in {@link attachUsageTotals}.
 * Stays under the common `SQLITE_MAX_VARIABLE_NUMBER` of 999 (some builds use
 * 32766); contract trees are far smaller, but `getSubtree` is unbounded.
 */
export const USAGE_IN_CHUNK = 500;

export function upsertUsage(
	db: DatabaseSync,
	input: UpsertUsageInput,
	now: () => number = () => Date.now(),
): UsageSnapshot {
	assertNodeId(input.nodeId);
	const tokensIn = input.tokensIn ?? 0;
	const tokensOut = input.tokensOut ?? 0;
	const costUsd = input.costUsd ?? 0;
	assertCount(tokensIn, "tokensIn");
	assertCount(tokensOut, "tokensOut");
	if (!Number.isFinite(costUsd) || costUsd < 0) {
		throw new TypeError("costUsd must be a finite non-negative number");
	}
	const updatedAt = now();
	if (!Number.isFinite(updatedAt)) throw new TypeError("updatedAt must be finite");
	withTransaction(db, () => {
		db.prepare(
			`INSERT INTO usage (node_id, tokens_in, tokens_out, cost_usd, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(node_id) DO UPDATE SET
				tokens_in = excluded.tokens_in,
				tokens_out = excluded.tokens_out,
				cost_usd = excluded.cost_usd,
				updated_at = excluded.updated_at`,
		).run(input.nodeId, tokensIn, tokensOut, costUsd, updatedAt);
	});
	const snapshot = getUsage(db, input.nodeId);
	if (!snapshot) throw new Error(`upserted usage could not be read for ${input.nodeId}`);
	return snapshot;
}

export function getUsage(db: DatabaseSync, nodeId: string): UsageSnapshot | null {
	assertNodeId(nodeId);
	const row = db
		.prepare("SELECT node_id, tokens_in, tokens_out, cost_usd, updated_at FROM usage WHERE node_id = ?")
		.get(nodeId);
	return row ? mapUsage(row) : null;
}

export function usageTotalTokens(db: DatabaseSync, nodeId: string): number {
	const usage = getUsage(db, nodeId);
	return usage ? usage.tokensIn + usage.tokensOut : 0;
}

/**
 * Annotate a node snapshot with per-node usage totals (#235).
 *
 * Signature and output shape are unchanged from the previous N+1 path:
 * - `root` is never annotated (even if a usage row exists)
 * - `tokensTotal` / `tokensOut` appear only when strictly > 0
 * - the input array / objects are not mutated
 *
 * Implementation: one (or chunked) `WHERE node_id IN (...)` query + Map lookup,
 * instead of one `getUsage` prepare/execute per node.
 */
export function attachUsageTotals<T extends { id: string }>(
	db: DatabaseSync,
	nodes: T[],
): Array<T & { tokensTotal?: number; tokensOut?: number }> {
	type Annotated = T & { tokensTotal?: number; tokensOut?: number };
	if (nodes.length === 0) return [];

	const ids: string[] = [];
	const seen = new Set<string>();
	for (const node of nodes) {
		if (node.id === "root") continue;
		assertNodeId(node.id);
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		ids.push(node.id);
	}

	const usageById = loadUsageByNodeIds(db, ids);

	return nodes.map((node) => {
		if (node.id === "root") return { ...node } as Annotated;
		const usage = usageById.get(node.id);
		if (!usage) return { ...node } as Annotated;
		const total = usage.tokensIn + usage.tokensOut;
		return {
			...node,
			...(total > 0 ? { tokensTotal: total } : {}),
			...(usage.tokensOut > 0 ? { tokensOut: usage.tokensOut } : {}),
		} as Annotated;
	});
}

/** Batch-load usage rows for the given node ids (chunked for SQLite bind limits). */
function loadUsageByNodeIds(db: DatabaseSync, ids: string[]): Map<string, UsageSnapshot> {
	const usageById = new Map<string, UsageSnapshot>();
	if (ids.length === 0) return usageById;

	for (let i = 0; i < ids.length; i += USAGE_IN_CHUNK) {
		const chunk = ids.slice(i, i + USAGE_IN_CHUNK);
		const placeholders = chunk.map(() => "?").join(",");
		const rows = db
			.prepare(
				`SELECT node_id, tokens_in, tokens_out, cost_usd, updated_at FROM usage WHERE node_id IN (${placeholders})`,
			)
			.all(...chunk);
		for (const row of rows) {
			const usage = mapUsage(row);
			usageById.set(usage.nodeId, usage);
		}
	}
	return usageById;
}

function mapUsage(row: SqliteRow): UsageSnapshot {
	return {
		nodeId: String(row.node_id),
		tokensIn: Number(row.tokens_in),
		tokensOut: Number(row.tokens_out),
		costUsd: Number(row.cost_usd),
		updatedAt: row.updated_at === null ? null : Number(row.updated_at),
	};
}

function assertNodeId(nodeId: string): void {
	if (typeof nodeId !== "string" || nodeId.length === 0) {
		throw new TypeError("nodeId must be a non-empty string");
	}
}

function assertCount(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${field} must be a non-negative safe integer`);
	}
}
