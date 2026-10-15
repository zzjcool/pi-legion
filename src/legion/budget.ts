import type { DatabaseSync } from "./db.ts";
import { LIVE_CHILD_STATUSES } from "./nodes.ts";
import { withTransaction } from "./db.ts";
import { appendEvent } from "./events.ts";

export const DEFAULT_LEGION_BUDGETS = {
	maxDepth: 4,
	maxChildrenPerNode: 8,
	maxActiveNodes: 30,
} as const;

export type LegionBudgetLimits = {
	maxDepth?: number;
	maxChildrenPerNode?: number;
	maxActiveNodes?: number;
};

export interface NormalizedBudgetLimits {
	maxDepth: number;
	maxChildrenPerNode: number;
	maxActiveNodes: number;
}

export type BudgetRefusalReason =
	| "max_depth"
	| "max_children_per_node"
	| "max_active_nodes"
	| "parent_not_found";

export interface LaunchBudgetRequest {
	parentId: string | null;
	depth: number;
	nodeId?: string;
}

export type BudgetDecision =
	| { allowed: true; depth: number; activeNodes: number; children: number; limits: NormalizedBudgetLimits }
	| {
			allowed: false;
			reason: BudgetRefusalReason;
			message: string;
			depth: number;
			activeNodes: number;
			children: number;
			limits: NormalizedBudgetLimits;
		};

export interface BudgetCheckOptions {
	limits?: LegionBudgetLimits;
}

export interface BudgetGateOptions extends BudgetCheckOptions {
	now?: () => number;
}

export type BudgetGateResult<T> =
	| { allowed: true; decision: Extract<BudgetDecision, { allowed: true }>; value: T }
	| { allowed: false; decision: Extract<BudgetDecision, { allowed: false }> };

/** Read-only check of all three governance gates with one SELECT. */
export function checkLaunchBudget(
	db: DatabaseSync,
	request: LaunchBudgetRequest,
	options: BudgetCheckOptions = {},
): BudgetDecision {
	validateRequest(request);
	const limits = normalizeLimits(options.limits);
	const liveStatuses = LIVE_CHILD_STATUSES.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM nodes WHERE parent_id IS ? AND status IN (${liveStatuses})) AS child_count,
				(SELECT COUNT(*) FROM nodes WHERE status IN ('running', 'starting')) AS active_count,
				CASE WHEN ? IS NULL THEN 1 ELSE EXISTS(SELECT 1 FROM nodes WHERE id = ?) END AS parent_exists`,
		)
		.get(request.parentId, ...LIVE_CHILD_STATUSES, request.parentId, request.parentId);
	const counts = {
		children: Number(row?.child_count ?? 0),
		activeNodes: Number(row?.active_count ?? 0),
	};
	const base = { depth: request.depth, ...counts, limits };
	if (Number(row?.parent_exists ?? 0) !== 1) {
		return denied("parent_not_found", `parent node does not exist: ${request.parentId}`, base);
	}
	if (request.depth > limits.maxDepth) {
		return denied("max_depth", `node depth ${request.depth} exceeds maxDepth ${limits.maxDepth}`, base);
	}
	if (counts.children >= limits.maxChildrenPerNode) {
		return denied(
			"max_children_per_node",
			`parent already has ${counts.children} live children; maxChildrenPerNode is ${limits.maxChildrenPerNode}`,
			base,
		);
	}
	if (counts.activeNodes >= limits.maxActiveNodes) {
		return denied(
			"max_active_nodes",
			`tree already has ${counts.activeNodes} active nodes; maxActiveNodes is ${limits.maxActiveNodes}`,
			base,
		);
	}
	return { allowed: true, ...base };
}

/** Hold a write reservation over check+insert to prevent concurrent over-allocation. */
export function withLaunchBudget<T>(
	db: DatabaseSync,
	request: LaunchBudgetRequest,
	createNode: (decision: Extract<BudgetDecision, { allowed: true }>) => T,
	options: BudgetGateOptions = {},
): BudgetGateResult<T> {
	const clock = options.now ?? (() => Date.now());
	const timestamp = clock();
	if (!Number.isFinite(timestamp)) throw new TypeError("budget clock must return a finite timestamp");
	return withTransaction(db, () => {
		const decision = checkLaunchBudget(db, request, options);
		if (!decision.allowed) {
			appendEvent(
				db,
				request.nodeId ?? request.parentId ?? "root",
				"budget_refused",
				{
					reason: decision.reason,
					message: decision.message,
					depth: decision.depth,
					activeNodes: decision.activeNodes,
					children: decision.children,
					limits: decision.limits,
				},
				{ now: () => timestamp },
			);
			return { allowed: false, decision };
		}
		return { allowed: true, decision, value: createNode(decision) };
	});
}

function denied(
	reason: BudgetRefusalReason,
	message: string,
	base: Omit<Extract<BudgetDecision, { allowed: true }>, "allowed">,
): Extract<BudgetDecision, { allowed: false }> {
	return { allowed: false, reason, message, ...base };
}

function normalizeLimits(limits: LegionBudgetLimits | undefined): NormalizedBudgetLimits {
	const normalized = {
		maxDepth: limits?.maxDepth ?? DEFAULT_LEGION_BUDGETS.maxDepth,
		maxChildrenPerNode: limits?.maxChildrenPerNode ?? DEFAULT_LEGION_BUDGETS.maxChildrenPerNode,
		maxActiveNodes: limits?.maxActiveNodes ?? DEFAULT_LEGION_BUDGETS.maxActiveNodes,
	};
	for (const [name, value] of Object.entries(normalized)) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new TypeError(`${name} must be a non-negative safe integer`);
		}
	}
	return normalized;
}

function validateRequest(request: LaunchBudgetRequest): void {
	if (request.parentId !== null && (typeof request.parentId !== "string" || !request.parentId)) {
		throw new TypeError("parentId must be null or a non-empty string");
	}
	if (!Number.isSafeInteger(request.depth) || request.depth < 0) {
		throw new TypeError("depth must be a non-negative safe integer");
	}
}
