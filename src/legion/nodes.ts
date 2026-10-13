import type { DatabaseSync, SqliteRow } from "./db.ts";
import { withTransaction } from "./db.ts";

const NODE_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const DEFAULT_SUBTREE_MAX_DEPTH = 64;

export const NODE_STATUSES = [
	"starting",
	"running",
	"blocked",
	"settled",
	"failed",
	"retired",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const NON_TERMINAL_NODE_STATUSES = [
	"starting",
	"running",
	"blocked",
	"retired",
] as const satisfies readonly NodeStatus[];

export interface LegionNode {
	id: string;
	parentId: string | null;
	name: string;
	role: string;
	kind: string;
	depth: number;
	runId: string | null;
	sessionFile: string | null;
	worktreePath: string | null;
	model: string | null;
	team: string | null;
	status: NodeStatus;
	phase: string | null;
	phaseSince: number | null;
	reworkCount: number;
	contractPath: string | null;
	taskSummary: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface NewLegionNode {
	id?: string;
	parentId: string | null;
	name: string;
	role: string;
	kind?: string;
	depth?: number;
	runId?: string | null;
	sessionFile?: string | null;
	worktreePath?: string | null;
	model?: string | null;
	team?: string | null;
	status?: NodeStatus;
	phase?: string | null;
	phaseSince?: number | null;
	reworkCount?: number;
	contractPath?: string | null;
	taskSummary?: string | null;
	createdAt?: number;
	updatedAt?: number;
}

export type MutableNodeFields = Partial<
	Pick<
		LegionNode,
		| "role"
		| "kind"
		| "depth"
		| "runId"
		| "sessionFile"
		| "worktreePath"
		| "model"
		| "team"
		| "status"
		| "phase"
		| "phaseSince"
		| "reworkCount"
		| "contractPath"
		| "taskSummary"
	>
>;

export class NodeNameConflictError extends Error {
	constructor(parentId: string | null, name: string, idCollision = false) {
		super(
			idCollision
				? `node id collision for ${JSON.stringify(name)} under ${parentId ?? "<root>"}`
				: `a child named ${JSON.stringify(name)} already exists under ${parentId ?? "<root>"}`,
		);
		this.name = "NodeNameConflictError";
	}
}

/** Sanitize to the frozen slug grammar; periods are separators and never survive. */
export function sanitizeNodeSlug(name: string): string {
	if (typeof name !== "string") throw new TypeError("node name must be a string");
	const normalized = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[^a-z]+/, "")
		.replace(/[-_]+$/, "");
	const slug = (normalized.slice(0, 32).replace(/[-_]+$/, "") || "agent");
	return NODE_SLUG_PATTERN.test(slug) ? slug : "agent";
}

export function isValidNodeSlug(value: string): boolean {
	return NODE_SLUG_PATTERN.test(value);
}

export function nodeIdForChild(parentId: string, name: string): string {
	if (typeof parentId !== "string" || parentId.length === 0) {
		throw new TypeError("parentId must be a non-empty node id");
	}
	return `${parentId}.${sanitizeNodeSlug(name)}`;
}

export function insertNode(
	db: DatabaseSync,
	input: NewLegionNode,
	now: () => number = () => Date.now(),
): LegionNode {
	if (typeof input.name !== "string" || input.name.trim().length === 0) {
		throw new TypeError("node name must not be empty");
	}
	if (typeof input.role !== "string" || input.role.trim().length === 0) {
		throw new TypeError("node role must not be empty");
	}
	const name = input.parentId === null ? "root" : sanitizeNodeSlug(input.name);
	const expectedId = input.parentId === null ? "root" : nodeIdForChild(input.parentId, name);
	const id = input.id ?? expectedId;
	if (id !== expectedId) {
		throw new TypeError(`node id must be ${JSON.stringify(expectedId)}`);
	}
	if (input.status !== undefined && !isNodeStatus(input.status)) {
		throw new TypeError(`invalid node status: ${String(input.status)}`);
	}
	if (
		input.reworkCount !== undefined &&
		(!Number.isInteger(input.reworkCount) || input.reworkCount < 0)
	) {
		throw new TypeError("reworkCount must be a non-negative integer");
	}

	return withTransaction(db, () => {
		if (childNameExists(db, input.parentId, name)) {
			throw new NodeNameConflictError(input.parentId, name);
		}
		if (getNode(db, id)) {
			throw new NodeNameConflictError(input.parentId, name, true);
		}

		let expectedDepth = 0;
		if (input.parentId !== null) {
			const parent = getNode(db, input.parentId);
			if (!parent) throw new Error(`parent node not found: ${input.parentId}`);
			expectedDepth = parent.depth + 1;
		}
		const depth = input.depth ?? expectedDepth;
		if (!Number.isInteger(depth) || depth < 0) {
			throw new TypeError("node depth must be a non-negative integer");
		}
		if (depth !== expectedDepth) {
			throw new TypeError(
				`node depth must be ${expectedDepth} for parent ${input.parentId ?? "<root>"}`,
			);
		}

		const timestamp = now();
		assertTimestamp(timestamp, "clock");
		const createdAt = input.createdAt ?? timestamp;
		const updatedAt = input.updatedAt ?? timestamp;
		assertTimestamp(createdAt, "createdAt");
		assertTimestamp(updatedAt, "updatedAt");

		db.prepare(
			`INSERT INTO nodes (
				id, parent_id, name, role, kind, depth, run_id, session_file,
				worktree_path, model, team, status, phase, phase_since, rework_count,
				contract_path, task_summary, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			input.parentId,
			name,
			input.role.trim(),
			input.kind ?? "pi",
			depth,
			input.runId ?? null,
			input.sessionFile ?? null,
			input.worktreePath ?? null,
			input.model ?? null,
			input.team ?? null,
			input.status ?? "starting",
			input.phase ?? null,
			input.phaseSince ?? null,
			input.reworkCount ?? 0,
			input.contractPath ?? null,
			input.taskSummary ?? null,
			createdAt,
			updatedAt,
		);
		const inserted = getNode(db, id);
		if (!inserted) throw new Error(`inserted node could not be read: ${id}`);
		return inserted;
	});
}

export function getNode(db: DatabaseSync, id: string): LegionNode | null {
	const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
	return row ? mapNode(row) : null;
}

export function getChildByName(
	db: DatabaseSync,
	parentId: string,
	name: string,
): LegionNode | null {
	const row = db
		.prepare("SELECT * FROM nodes WHERE parent_id = ? AND name = ? LIMIT 1")
		.get(parentId, sanitizeNodeSlug(name));
	return row ? mapNode(row) : null;
}

export function childNameExists(
	db: DatabaseSync,
	parentId: string | null,
	name: string,
	excludeId?: string,
): boolean {
	const slug = parentId === null ? name : sanitizeNodeSlug(name);
	const row = excludeId
		? db
				.prepare(
					"SELECT 1 AS found FROM nodes WHERE parent_id IS ? AND name = ? AND id <> ? LIMIT 1",
				)
				.get(parentId, slug, excludeId)
		: db
				.prepare(
					"SELECT 1 AS found FROM nodes WHERE parent_id IS ? AND name = ? LIMIT 1",
				)
				.get(parentId, slug);
	return row !== undefined;
}

export function getChildren(db: DatabaseSync, parentId: string): LegionNode[] {
	return db
		.prepare("SELECT * FROM nodes WHERE parent_id = ? ORDER BY created_at, id")
		.all(parentId)
		.map(mapNode);
}

/** Return the requested node and its descendants using a recursive CTE. */
export function getSubtree(
	db: DatabaseSync,
	rootId: string,
	options: { maxDepth?: number; includeRoot?: boolean } = {},
): LegionNode[] {
	const maxDepth = options.maxDepth ?? DEFAULT_SUBTREE_MAX_DEPTH;
	if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
		throw new TypeError("maxDepth must be a non-negative safe integer");
	}
	const rows = db
		.prepare(
			`WITH RECURSIVE subtree(id, distance) AS (
				SELECT id, 0 FROM nodes WHERE id = ?
				UNION ALL
				SELECT child.id, subtree.distance + 1
				FROM nodes AS child
				JOIN subtree ON child.parent_id = subtree.id
				WHERE subtree.distance < ?
			)
			SELECT nodes.*
			FROM nodes
			JOIN subtree ON subtree.id = nodes.id
			WHERE (? = 1 OR subtree.distance > 0)
			ORDER BY subtree.distance, nodes.created_at, nodes.id`,
		)
		.all(rootId, maxDepth, (options.includeRoot ?? true) ? 1 : 0);
	return rows.map(mapNode);
}

export function updateNode(
	db: DatabaseSync,
	id: string,
	patch: MutableNodeFields,
	now: () => number = () => Date.now(),
): LegionNode {
	if (patch.status !== undefined && !isNodeStatus(patch.status)) {
		throw new TypeError(`invalid node status: ${String(patch.status)}`);
	}
	if (patch.depth !== undefined) {
		const current = getNode(db, id);
		if (!current) throw new Error(`node not found: ${id}`);
		if (!Number.isInteger(patch.depth) || patch.depth < 0) {
			throw new TypeError("node depth must be a non-negative integer");
		}
		const expectedDepth = current.parentId === null
			? 0
			: (getNode(db, current.parentId)?.depth ?? -1) + 1;
		if (patch.depth !== expectedDepth) {
			throw new TypeError(`node depth must be ${expectedDepth} for parent ${current.parentId ?? "<root>"}`);
		}
	}
	if (
		patch.reworkCount !== undefined &&
		(!Number.isInteger(patch.reworkCount) || patch.reworkCount < 0)
	) {
		throw new TypeError("reworkCount must be a non-negative integer");
	}
	const timestamp = now();
	assertTimestamp(timestamp, "clock");
	const result = db
		.prepare(
			`UPDATE nodes SET
				role = CASE WHEN ? THEN ? ELSE role END,
				kind = CASE WHEN ? THEN ? ELSE kind END,
				depth = CASE WHEN ? THEN ? ELSE depth END,
				run_id = CASE WHEN ? THEN ? ELSE run_id END,
				session_file = CASE WHEN ? THEN ? ELSE session_file END,
				worktree_path = CASE WHEN ? THEN ? ELSE worktree_path END,
				model = CASE WHEN ? THEN ? ELSE model END,
				team = CASE WHEN ? THEN ? ELSE team END,
				status = CASE WHEN ? THEN ? ELSE status END,
				phase = CASE WHEN ? THEN ? ELSE phase END,
				phase_since = CASE WHEN ? THEN ? ELSE phase_since END,
				rework_count = CASE WHEN ? THEN ? ELSE rework_count END,
				contract_path = CASE WHEN ? THEN ? ELSE contract_path END,
				task_summary = CASE WHEN ? THEN ? ELSE task_summary END,
				updated_at = ?
			WHERE id = ?`,
		)
		.run(
			patch.role !== undefined ? 1 : 0, patch.role ?? null,
			patch.kind !== undefined ? 1 : 0, patch.kind ?? null,
			patch.depth !== undefined ? 1 : 0, patch.depth ?? null,
			patch.runId !== undefined ? 1 : 0, patch.runId ?? null,
			patch.sessionFile !== undefined ? 1 : 0, patch.sessionFile ?? null,
			patch.worktreePath !== undefined ? 1 : 0, patch.worktreePath ?? null,
			patch.model !== undefined ? 1 : 0, patch.model ?? null,
			patch.team !== undefined ? 1 : 0, patch.team ?? null,
			patch.status !== undefined ? 1 : 0, patch.status ?? null,
			patch.phase !== undefined ? 1 : 0, patch.phase ?? null,
			patch.phaseSince !== undefined ? 1 : 0, patch.phaseSince ?? null,
			patch.reworkCount !== undefined ? 1 : 0, patch.reworkCount ?? null,
			patch.contractPath !== undefined ? 1 : 0, patch.contractPath ?? null,
			patch.taskSummary !== undefined ? 1 : 0, patch.taskSummary ?? null,
			timestamp,
			id,
		);
	if (Number(result.changes) === 0) throw new Error(`node not found: ${id}`);
	const updated = getNode(db, id);
	if (!updated) throw new Error(`updated node could not be read: ${id}`);
	return updated;
}

export function heartbeatNode(
	db: DatabaseSync,
	id: string,
	now: () => number = () => Date.now(),
): LegionNode {
	return updateNode(db, id, {}, now);
}

export function listNodesByStatus(
	db: DatabaseSync,
	statuses: NodeStatus | readonly NodeStatus[],
): LegionNode[] {
	const values = typeof statuses === "string" ? [statuses] : [...statuses];
	validateStatuses(values);
	return db
		.prepare("SELECT * FROM nodes WHERE status IN (?, ?, ?, ?, ?, ?) ORDER BY updated_at, id")
		.all(...padStatuses(values))
		.map(mapNode);
}

export function listStaleNodes(
	db: DatabaseSync,
	updatedBefore: number,
	statuses: readonly NodeStatus[] = NON_TERMINAL_NODE_STATUSES,
): LegionNode[] {
	assertTimestamp(updatedBefore, "updatedBefore");
	validateStatuses(statuses);
	return db
		.prepare(
			"SELECT * FROM nodes WHERE status IN (?, ?, ?, ?, ?, ?) AND updated_at < ? ORDER BY updated_at, id",
		)
		.all(...padStatuses(statuses), updatedBefore)
		.map(mapNode);
}

export function listNodesNamed(db: DatabaseSync, name: string): LegionNode[] {
	return db
		.prepare("SELECT * FROM nodes WHERE name = ? ORDER BY depth, id")
		.all(sanitizeNodeSlug(name))
		.map(mapNode);
}

function padStatuses(statuses: readonly NodeStatus[]): Array<NodeStatus | null> {
	return [
		...statuses,
		...Array.from({ length: NODE_STATUSES.length - statuses.length }, () => null),
	];
}

function validateStatuses(statuses: readonly NodeStatus[]): void {
	if (
		statuses.length === 0 ||
		statuses.length > NODE_STATUSES.length ||
		statuses.some((status) => !isNodeStatus(status))
	) {
		throw new TypeError("one to six valid node statuses are required");
	}
}

function mapNode(row: SqliteRow): LegionNode {
	return {
		id: String(row.id),
		parentId: nullableString(row.parent_id),
		name: String(row.name),
		role: String(row.role),
		kind: String(row.kind),
		depth: Number(row.depth),
		runId: nullableString(row.run_id),
		sessionFile: nullableString(row.session_file),
		worktreePath: nullableString(row.worktree_path),
		model: nullableString(row.model),
		team: nullableString(row.team),
		status: String(row.status) as NodeStatus,
		phase: nullableString(row.phase),
		phaseSince: nullableNumber(row.phase_since),
		reworkCount: Number(row.rework_count),
		contractPath: nullableString(row.contract_path),
		taskSummary: nullableString(row.task_summary),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function isNodeStatus(value: unknown): value is NodeStatus {
	return typeof value === "string" && (NODE_STATUSES as readonly string[]).includes(value);
}

function nullableString(value: unknown): string | null {
	return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
	return value === null || value === undefined ? null : Number(value);
}

function assertTimestamp(value: number, field: string): void {
	if (!Number.isFinite(value)) {
		throw new TypeError(`${field} must be a finite millisecond timestamp`);
	}
}
