import {
	type PhaseMachine,
	DEFAULT_PHASE_MACHINE,
	DEFAULT_MAX_REWORK_COUNT,
	findPhase,
	normalizePhaseMachine,
	isTerminalIn,
	legacyReasonForCondition,
	phaseStart,
} from "./phase-machine.ts";
import {
	checkPhaseCondition,
	checkPhaseRequirements,
	describeFailedCondition,
	type PhaseCondition,
	type PhaseConditionInput,
} from "./phase-conditions.ts";

export const LEGION_PHASES = [
	"planning",
	"implementing",
	"reviewing",
	"verifying",
	"done",
	"failed",
	"aborted",
] as const;
export type LegionPhase = (typeof LEGION_PHASES)[number];

export const MAX_REWORK_COUNT = 2;
export const DEFAULT_PHASE_TIMEOUTS: Readonly<Record<LegionPhase, number>> = {
	planning: 15 * 60_000,
	implementing: 60 * 60_000,
	reviewing: 30 * 60_000,
	verifying: 15 * 60_000,
	done: 0,
	failed: 0,
	aborted: 0,
};

export type PhaseTransitionReason =
	| "invalid_phase"
	| "same_phase"
	| "terminal_phase"
	| "invalid_transition"
	| "contract_path_required"
	| "planner_still_active"
	| "worker_still_active"
	| "failed_worker_unhandled"
	| "all_workers_failed"
	| "reviewer_not_settled"
	| "review_verdict_not_accepted"
	| "review_verdict_not_rejected"
	| "verification_not_failed"
	| "verification_not_passed"
	| "rework_limit_exceeded"
	| "centurion_required"
	| "children_not_terminal"
	| "terminal_reason_required"
	| "all_children_not_failed"
	// #298: a declared machine can refuse for reasons the built-in table had no
	// name for — an unmet custom condition, or an edge reserved to another actor.
	| "condition_not_met"
	| "actor_not_permitted";

export interface PhaseChild {
	id: string;
	role: string;
	status: string;
}

export interface EvaluatePhaseTransitionInput {
	/** Phase id. Free-form when a declared machine is supplied (#298). */
	from: string | null;
	to: string;
	reworkCount?: number;
	contractPath?: string | null;
	children?: readonly PhaseChild[];
	failedWorkerHandledIds?: readonly string[];
	reviewerVerdictOk?: boolean;
	verificationPassed?: boolean;
	actorRole?: string;
	terminalReason?: "parent_decision" | "all_children_failed" | "rework_exhausted" | "parent_retire";
	/**
	 * #298: a declared machine. When present, transitions are evaluated from it
	 * instead of the built-in table, so a team can define its own workflow.
	 * Absent means DEFAULT_PHASE_MACHINE — identical to the old behaviour.
	 */
	machine?: PhaseMachine;
	/** Whether the contract file exists and is non-empty (resolved by the caller). */
	contractPresent?: boolean;
}

export type PhaseTransitionDecision =
	| {
		allowed: true;
		from: string | null;
		to: string;
		reworkCount: number;
		phaseSince: number;
		notifyParent: boolean;
		event: { type: "phase_change"; data: Record<string, unknown> };
	}
	| {
		allowed: false;
		from: string | null;
		to: string;
		reason: PhaseTransitionReason;
		message: string;
		forcedTransition?: {
			to: "failed";
			reworkCount: number;
			reason: "rework_exhausted" | "all_children_failed";
		};
		alarm: true;
	};

/**
 * Evaluate a transition against a declared machine (#298).
 *
 * Structural invariants are the same ones the built-in path enforces, applied
 * from data instead of a switch:
 *
 *   - a new team enters the machine's start phase
 *   - terminal phases cannot transition
 *   - `to` must be declared in the current phase's `next`
 *   - rework edges increment past `maxRework` → forced failure
 *   - `failed` still needs a reason, `aborted` still needs a parent retire
 *
 * Everything else — which edge is legal when — comes from the declaration.
 */
function evaluateDeclarative(
	input: EvaluatePhaseTransitionInput,
	machine: PhaseMachine,
	now: () => number,
): PhaseTransitionDecision {
	const { from, to } = input;
	const children = input.children ?? [];
	const reworkCount = input.reworkCount ?? 0;
	// #350: ONE derivation of "where a new team starts", shared with the birth site
	// (`Orchestrator.reserveNode`). Two copies of `start ?? phases[0]` is exactly how
	// a team ends up born in a phase its own machine never declared.
	const start = phaseStart(machine);
	const maxRework = machine.maxRework ?? DEFAULT_MAX_REWORK_COUNT;

	if (from !== null && !findPhase(machine, from)) {
		return denied(input, "invalid_phase", `phase '${from}' is not part of this team's machine`);
	}
	if (!findPhase(machine, to)) {
		return denied(input, "invalid_phase", `phase '${to}' is not part of this team's machine`);
	}
	if (!Number.isInteger(reworkCount) || reworkCount < 0) {
		return denied(input, "invalid_phase", "reworkCount must be a non-negative integer");
	}
	if (from === to) return denied(input, "same_phase", "phase is already current");
	if (from !== null && isTerminalIn(machine, from)) {
		return denied(input, "terminal_phase", `terminal phase ${from} cannot transition`);
	}
	if (from === null) {
		if (to !== start) {
			return denied(input, "invalid_transition", `a new team must start in ${String(start)}`);
		}
		return allowed(input, reworkCount, now(), false);
	}

	// A phase-level `require` still binds a FAILURE exit: leaving `implementing`
	// for `failed` while a child is mid-run would strand that child, so the
	// requirement is checked before the terminal shortcut.
	//
	// `aborted` is deliberately exempt. It is the emergency stop — the parent
	// retire path — and gating it on "everything is settled" would mean a team
	// with a wedged child could never be stopped. Availability of the stop button
	// outranks tidiness.
	const fromPhase = findPhase(machine, from);
	const entryRequirement = to === "aborted"
		? ({ ok: true } as const)
		: checkPhaseRequirements(fromPhase?.require ?? [], conditionInput(input));
	if (!entryRequirement.ok) {
		const legacy = legacyReasonForCondition(entryRequirement.failed, { to });
		return denied(
			input,
			legacy,
			describeFailedCondition(entryRequirement.failed),
		);
	}
	if (to === "aborted") {
		if (input.terminalReason !== "parent_retire") {
			return denied(input, "terminal_reason_required", "aborted requires a parent retire decision");
		}
		return allowed(input, reworkCount, now(), false);
	}
	if (to === "failed") {
		const failure = evaluateDeclaredFailure(input, children, reworkCount, maxRework, now);
		if (failure) return failure;
	}

	const phase = findPhase(machine, from);
	const rule = phase?.next.find((candidate) => candidate.to === to);
	if (!rule) {
		// Name the legal exits. Without them a model invents plausible ones (measured:
		// a custom `recon -> build` machine was described as offering `recon -> check`
		// and `recon -> done`, neither of which existed), then wastes a turn being
		// refused. The machine already knows the answer; say it.
		const allowed = (phase?.next ?? []).map((candidate) => candidate.to);
		const hint = allowed.length > 0 ? `legal next phases from '${from}': ${allowed.join(", ")}` : `phase '${from}' has no exits`;
		return denied(
			input,
			"invalid_transition",
			`transition ${from} → ${to} is not allowed by this team's machine (${hint})`,
		);
	}
	if (rule.actorRole !== undefined && input.actorRole !== rule.actorRole) {
		// Preserve the historical code for the centurion-only edge so existing
		// callers and tests keep their meaning; other reserved edges get the
		// general name.
		return denied(
			input,
			rule.actorRole === "centurion" ? "centurion_required" : "actor_not_permitted",
			`only ${rule.actorRole} may transition ${from} → ${to}`,
		);
	}

	// Phase-level requirements AND into this edge.
	const requirement = checkPhaseRequirements(
		[...(phase?.require ?? []), ...(rule.require ?? [])],
		conditionInput(input),
	);
	if (!requirement.ok) {
		// A team whose children ALL failed cannot succeed, so refusing the move it
		// asked for while leaving it "running" strands it: nobody will ever satisfy
		// the requirement it just failed. Force the terminal transition instead.
		// The old code special-cased this for workers; the condition is structural,
		// so it now covers any team whose dispatched children all failed.
		if (
			requirement.failed === "children_none_failed" &&
			checkPhaseCondition("children_all_failed", conditionInput(input))
		) {
			return {
				...denied(
					input,
					"all_workers_failed",
					`all children failed; the team cannot reach ${to} and must fail`,
				),
				forcedTransition: { to: "failed", reworkCount, reason: "all_children_failed" },
			};
		}
		const legacy = legacyReasonForCondition(requirement.failed, rule);
		return denied(
			input,
			legacy,
			describeFailedCondition(requirement.failed),
		);
	}

	if (rule.rework === true) {
		const next = reworkCount + 1;
		if (next > maxRework) {
			return {
				...denied(input, "rework_limit_exceeded", `rework count ${next} exceeds limit ${maxRework}`),
				forcedTransition: { to: "failed", reworkCount: next, reason: "rework_exhausted" },
			};
		}
		return allowed(input, next, now(), rule.notifyParent === true);
	}
	return allowed(input, reworkCount, now(), rule.notifyParent === true);
}

/** `failed` is only reachable for a declared reason; returns undefined to continue. */
function evaluateDeclaredFailure(
	input: EvaluatePhaseTransitionInput,
	children: readonly PhaseChild[],
	reworkCount: number,
	maxRework: number,
	now: () => number,
): PhaseTransitionDecision | undefined {
	if (input.terminalReason === "parent_decision") return allowed(input, reworkCount, now(), false);
	if (input.terminalReason === "rework_exhausted") {
		if (reworkCount <= maxRework) {
			return denied(input, "rework_limit_exceeded", `rework_count must exceed ${maxRework} for rework_exhausted`);
		}
		return allowed(input, reworkCount, now(), false);
	}
	if (input.terminalReason === "all_children_failed") {
		if (children.length === 0 || children.some((child) => child.status !== "failed")) {
			return denied(input, "all_children_not_failed", "all_children_failed requires every child to have failed");
		}
		return allowed(input, reworkCount, now(), false);
	}
	return denied(input, "terminal_reason_required", "failed requires parent decision, all children failed, or exhausted rework");
}

function conditionInput(input: EvaluatePhaseTransitionInput): PhaseConditionInput {
	return {
		children: input.children ?? [],
		...(input.failedWorkerHandledIds ? { handledIds: input.failedWorkerHandledIds } : {}),
		...(input.contractPath !== undefined ? { contractPath: input.contractPath } : {}),
		...(input.contractPresent !== undefined ? { contractPresent: input.contractPresent } : {}),
		...(input.reviewerVerdictOk !== undefined ? { verdictOk: input.reviewerVerdictOk } : {}),
		...(input.verificationPassed !== undefined ? { verificationPassed: input.verificationPassed } : {}),
		reworkCount: input.reworkCount ?? 0,
		...(input.machine?.maxRework !== undefined ? { maxRework: input.machine.maxRework } : {}),
	};
}

/** Pure decision function for the §7.1 transition table and entry invariants. */
export function evaluatePhaseTransition(
	input: EvaluatePhaseTransitionInput,
	now: () => number = () => Date.now(),
): PhaseTransitionDecision {
	// #298: the declarative path is the ONLY path, with the built-in machine as the
	// default. The old switch was removed rather than kept as a fallback: it gated
	// `reviewing -> verifying` on a settled `role === "reviewer"`, so once the
	// bundled reviewer card is gone a team could never leave review. Conditions
	// express the same intent without naming a role.
	//
	// Normalization happens here, not only at parse time: the universal terminals
	// (`done`/`failed`/`aborted`) must exist for ANY machine reaching this point —
	// including one built in code — because a team that cannot be aborted is a
	// safety hole. Normalization only ADDS those terminals; taking them stays gated.
	return evaluateDeclarative(input, normalizePhaseMachine(input.machine ?? DEFAULT_PHASE_MACHINE), now);
}


export interface PhaseTimeoutInput {
	/** Phase id; free-form under a declared machine (#298). */
	phase: string;
	phaseSince: number | null;
	now?: number;
	/** Per-phase overrides. Free-form ids when a declared machine is in play. */
	timeouts?: Partial<Record<string, number>>;
}

export interface PhaseTimeoutResult {
	phase: string;
	timedOut: boolean;
	phaseSince: number | null;
	now: number;
	elapsedMs: number | null;
	timeoutMs: number;
}

/** Check an independent phase clock; timeout never kills work. */
export function checkPhaseTimeout(
	input: PhaseTimeoutInput,
	clock: () => number = () => Date.now(),
): PhaseTimeoutResult {
	// A declared machine defines its own phase names, so this no longer rejects an
	// unknown id outright — the caller resolves a timeout first and only asks here
	// for a declared phase.
	if (typeof input.phase !== "string" || !input.phase) {
		throw new TypeError(`invalid legion phase: ${String(input.phase)}`);
	}
	const now = input.now ?? clock();
	if (!Number.isFinite(now)) throw new TypeError("now must be a finite millisecond timestamp");
	if (input.phaseSince !== null && !Number.isFinite(input.phaseSince)) {
		throw new TypeError("phaseSince must be null or a finite millisecond timestamp");
	}
	const override = input.timeouts?.[input.phase];
	const timeoutMs = override ?? DEFAULT_PHASE_TIMEOUTS[input.phase as LegionPhase] ?? 0;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new TypeError("phase timeout must be a finite non-negative duration");
	}
	const elapsedMs = input.phaseSince === null ? null : Math.max(0, now - input.phaseSince);
	return {
		phase: input.phase,
		timedOut: elapsedMs !== null && !isTerminalPhase(input.phase) && timeoutMs > 0 && elapsedMs >= timeoutMs,
		phaseSince: input.phaseSince,
		now,
		elapsedMs,
		timeoutMs,
	};
}

export function isTerminalPhase(phase: string): boolean {
	return phase === "done" || phase === "failed" || phase === "aborted";
}

export function isTerminalChild(status: string): boolean {
	return status === "settled" || status === "failed" || status === "retired";
}

export function isLegionPhase(value: unknown): value is LegionPhase {
	return typeof value === "string" && (LEGION_PHASES as readonly string[]).includes(value);
}



function allowed(
	input: EvaluatePhaseTransitionInput,
	reworkCount: number,
	phaseSince: number,
	notifyParent: boolean,
): PhaseTransitionDecision {
	if (!Number.isFinite(phaseSince)) throw new TypeError("phase clock must return a finite timestamp");
	return {
		allowed: true,
		from: input.from,
		to: input.to,
		reworkCount,
		phaseSince,
		notifyParent,
		event: {
			type: "phase_change",
			data: {
				from: input.from,
				to: input.to,
				reworkCount,
				...(notifyParent ? { notifyParent: true } : {}),
			},
		},
	};
}

function denied(
	input: Pick<EvaluatePhaseTransitionInput, "from" | "to">,
	reason: PhaseTransitionReason,
	message: string,
): Extract<PhaseTransitionDecision, { allowed: false }> {
	return { allowed: false, from: input.from, to: input.to, reason, message, alarm: true };
}

