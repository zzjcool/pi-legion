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

export function attachUsageTotals<T extends { id: string }>(
	db: DatabaseSync,
	nodes: T[],
): Array<T & { tokensTotal?: number; tokensOut?: number }> {
	return nodes.map((node) => {
		if (node.id === "root") return { ...node } as T & { tokensTotal?: number; tokensOut?: number };
		const usage = getUsage(db, node.id);
		if (!usage) return { ...node } as T & { tokensTotal?: number; tokensOut?: number };
		const total = usage.tokensIn + usage.tokensOut;
		return {
			...node,
			...(total > 0 ? { tokensTotal: total } : {}),
			...(usage.tokensOut > 0 ? { tokensOut: usage.tokensOut } : {}),
		} as T & { tokensTotal?: number; tokensOut?: number };
	});
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
