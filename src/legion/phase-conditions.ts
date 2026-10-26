/**
 * Condition vocabulary for a declarative phase machine (#298).
 *
 * The old state machine keyed its rules on ROLE NAMES: leaving `implementing`
 * required every `role === "worker"` to be settled, leaving `reviewing` required
 * a settled `role === "reviewer"` with `ok: true`. That made a role's mere
 * existence load-bearing — "worker" stopped meaning "a worker" and became "the
 * specific slot in a fixed pipeline".
 *
 * A condition asks the same question without naming anyone: "are the children
 * settled", "did any settled child return ok", "did verification pass". That is
 * the property that lets `worker` generalise into a plain worker, and it is what
 * makes a custom phase list possible at all.
 *
 * The vocabulary is CLOSED on purpose. A machine that can express arbitrary code
 * cannot be validated at load time, and an invalid machine would only surface
 * mid-run — after a team has already spent tokens.
 */

/** A child of the node being evaluated, as the machine sees it. */
export interface PhaseChildSnapshot {
	id: string;
	/** Kept for reporting only. No condition may branch on it (#298). */
	role: string;
	status: string;
}

/** Everything a condition may inspect. Pure data: no I/O, no clock. */
export interface PhaseConditionInput {
	children: readonly PhaseChildSnapshot[];
	/** Child ids whose failure has already been accounted for. */
	handledIds?: readonly string[];
	/** Contract file path recorded on the node, if any. */
	contractPath?: string | null;
	/** Whether the contract file exists and is non-empty. Resolved by the caller. */
	contractPresent?: boolean;
	/** Parsed `ok` from the most recent settled child verdict, when there is one. */
	verdictOk?: boolean;
	/** Stored verification result for this node. */
	verificationPassed?: boolean;
	reworkCount?: number;
	maxRework?: number;
}

/** The closed condition vocabulary. */
export const PHASE_CONDITIONS = [
	"always",
	"contract_file",
	"children_settled",
	"children_none_failed",
	"verdict_ok",
	"verdict_not_ok",
	"verification_passed",
	"verification_failed",
	"rework_available",
	"children_all_failed",
] as const;

export type PhaseCondition = (typeof PHASE_CONDITIONS)[number];

export function isPhaseCondition(value: unknown): value is PhaseCondition {
	return typeof value === "string" && (PHASE_CONDITIONS as readonly string[]).includes(value);
}

function isActive(status: string): boolean {
	return status === "starting" || status === "running" || status === "blocked";
}

/**
 * Evaluate one condition. Throws on an unknown name so a machine that slipped
 * past load-time validation fails loudly instead of silently allowing a
 * transition (which would advance a team that has not met its own criteria).
 */
export function checkPhaseCondition(
	condition: PhaseCondition,
	input: PhaseConditionInput,
): boolean {
	switch (condition) {
		case "always":
			return true;
		case "contract_file":
			return Boolean(input.contractPath?.trim()) && input.contractPresent === true;
		case "children_settled":
			return input.children.every((child) => !isActive(child.status));
		case "children_none_failed": {
			const handled = new Set(input.handledIds ?? []);
			return !input.children.some((child) => child.status === "failed" && !handled.has(child.id));
		}
		case "verdict_ok":
			return input.verdictOk === true;
		case "verdict_not_ok":
			return input.verdictOk === false;
		case "verification_passed":
			return input.verificationPassed === true;
		case "verification_failed":
			return input.verificationPassed === false;
		case "rework_available":
			return (input.reworkCount ?? 0) < (input.maxRework ?? 2);
		case "children_all_failed":
			return input.children.length > 0 && input.children.every((child) => child.status === "failed");
		default: {
			const unknown: never = condition;
			throw new TypeError(`unknown phase condition: ${String(unknown)}`);
		}
	}
}

/** Every condition in `require` holds. An empty list is vacuously true. */
export function checkPhaseRequirements(
	require: readonly PhaseCondition[],
	input: PhaseConditionInput,
): { ok: true } | { ok: false; failed: PhaseCondition } {
	for (const condition of require) {
		if (!checkPhaseCondition(condition, input)) return { ok: false, failed: condition };
	}
	return { ok: true };
}
