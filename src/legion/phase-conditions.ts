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
	"children_present",
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
			// A recorded path is the contract; `contractPresent` is an OPTIONAL
			// strengthening for callers that actually read the file. Defaulting it to
			// "must be explicit" would silently refuse every caller that has a path
			// but does not stat it — including the pre-#298 tests and the rpc path.
			return Boolean(input.contractPath?.trim()) && input.contractPresent !== false;
		case "children_settled":
			return input.children.every((child) => !isActive(child.status));
		case "children_present":
			// Distinguishes "every child finished" from "there were no children".
			// Without it, `children_settled` on an empty list is vacuously true, so a
			// team that dispatched nobody could satisfy a requirement meant to check
			// that its workers (or reviewers) had actually run.
			return input.children.length > 0;
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

/**
 * A human-readable explanation of a failed condition.
 *
 * The condition id is precise but not readable, and this text reaches operators
 * and models. Naming the CONDITION rather than a role is the point (#298): the
 * message says what is missing, not who was supposed to provide it.
 */
export function describeFailedCondition(condition: PhaseCondition): string {
	switch (condition) {
		case "contract_file":
			return "a frozen contract file is required";
		case "children_present":
			return "no child has been dispatched yet";
		case "children_settled":
			return "child agents are still running; wait for them to settle";
		case "children_none_failed":
			return "a child failed and must be reworked or the team must fail";
		case "verdict_ok":
			return "no settled child reported a passing verdict";
		case "verdict_not_ok":
			return "the latest verdict was not a rejection, so there is nothing to rework";
		case "verification_passed":
			return "verification has not passed";
		case "verification_failed":
			return "verification did not fail, so there is nothing to rework";
		case "rework_available":
			return "the rework budget is exhausted";
		case "children_all_failed":
			return "not every child failed";
		case "always":
			return "the condition is always true";
		default:
			return `condition '${String(condition)}' is not met`;
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
