/**
 * A declarative phase machine (#298).
 *
 * The machine used to be a hard-coded switch. It is now data: a list of phases,
 * each naming its allowed successors and the conditions for taking each one. An
 * undeclared team falls back to {@link DEFAULT_PHASE_MACHINE}, which reproduces
 * the old table exactly — so this is behaviour-preserving until a card opts in.
 *
 * Why transitions carry the conditions rather than the phase:
 *
 *   planning → implementing   needs a contract file
 *   planning → failed         must NOT need one
 *
 * A phase-level `require` therefore would have to hold for every exit, including
 * the failure exits, which would make a team unable to fail before it had a
 * contract. Conditions live on the edge; a phase-level `require` is sugar that
 * ANDs into every edge leaving that phase.
 */

import {
	type PhaseCondition,
	isPhaseCondition,
} from "./phase-conditions.ts";

/** One allowed exit from a phase. */
export interface PhaseTransitionRule {
	/** Target phase id. */
	to: string;
	/** Conditions that must all hold. Empty/absent means unconditional. */
	require?: PhaseCondition[];
	/** When set, only this actor role may take the transition. */
	actorRole?: string;
	/** Counts as a rework step: increments `rework_count`, capped by `maxRework`. */
	rework?: boolean;
	/** Notify the parent when taken. */
	notifyParent?: boolean;
}

export interface PhaseDefinition {
	id: string;
	/** ANDed into every rule that leaves this phase. */
	require?: PhaseCondition[];
	/** Allowed exits. A transition to anything else is refused. */
	next: PhaseTransitionRule[];
	/** Advisory clock only; never kills work. */
	timeoutMs?: number;
	/** Terminal phases may not transition out. */
	terminal?: boolean;
}

export interface PhaseMachine {
	phases: PhaseDefinition[];
	/** Rework cap for the whole machine. */
	maxRework?: number;
	/** Which phase a brand-new team enters. Defaults to the first phase. */
	start?: string;
}

/** Phases that are terminal in the built-in machine. */
export const DEFAULT_TERMINAL_PHASES = ["done", "failed", "aborted"] as const;

export const DEFAULT_MAX_REWORK_COUNT = 2;

/**
 * The built-in machine: the four-phase pipeline legion has always used.
 *
 * Deliberately expressed with the SAME conditions the old code checked inline,
 * so that removing a role name from a rule changes nothing about when a
 * transition is allowed.
 */
export const DEFAULT_PHASE_MACHINE: PhaseMachine = {
	start: "planning",
	maxRework: DEFAULT_MAX_REWORK_COUNT,
	phases: [
		{
			id: "planning",
			timeoutMs: 15 * 60_000,
			next: [
				{ to: "implementing", require: ["contract_file"] },
				{ to: "failed" },
				{ to: "aborted" },
			],
		},
		{
			id: "implementing",
			timeoutMs: 60 * 60_000,
			// Entering implementation means planning is over, so no planning child may
			// still be running. Expressed as a phase-level requirement (ANDed into every
			// exit, including `aborted`) rather than a role check: the old rule named
			// `planner`, which stopped working the moment that card was removed.
			// Phase-level: leaving implementation (in any direction, including a failure)
			// requires that no child is still running. The old rule named `planner`
			// specifically, but the intent was "planning is over, nothing is in flight";
			// naming nobody also means the rule survives the planner card's removal.
			require: ["children_settled"],
			next: [
				{ to: "reviewing", require: ["children_present", "children_none_failed"] },
				// Every child failed: the team cannot succeed, so fail it.
				{ to: "failed", require: ["children_all_failed"] },
				{ to: "aborted" },
			],
		},
		{
			id: "reviewing",
			timeoutMs: 30 * 60_000,
			next: [
				// `verdict_ok` alone would let a team that produced NO review at all walk
				// straight through (the caller passes `verdictOk: undefined`, and an
				// undefined verdict is not `false`). Pair it with `children_settled` so a
				// review actually happened — the old rule required a settled reviewer.
				{ to: "verifying", require: ["children_present", "children_settled", "verdict_ok"] },
				{ to: "implementing", require: ["verdict_not_ok"], rework: true },
				// A bad plan may be sent back by the team lead only.
				{ to: "planning", actorRole: "centurion", notifyParent: true },
				{ to: "failed" },
				{ to: "aborted" },
			],
		},
		{
			id: "verifying",
			timeoutMs: 15 * 60_000,
			next: [
				{ to: "done", require: ["verification_passed", "children_settled"] },
				{ to: "implementing", require: ["verification_failed"], rework: true },
				{ to: "failed" },
				{ to: "aborted" },
			],
		},
		{ id: "done", terminal: true, next: [] },
		{ id: "failed", terminal: true, next: [] },
		{ id: "aborted", terminal: true, next: [] },
	],
};

/**
 * The phase a brand-new team enters (#350).
 *
 * Derived the same way the state machine derives it, and exported so the BIRTH
 * site (`Orchestrator.reserveNode`, which writes the team's first phase into the
 * ledger) cannot drift from the decision function: a team born in a phase its own
 * machine never declared is stranded, because `evaluatePhaseTransition` refuses
 * every transition whose `from` is not a phase of the machine as `invalid_phase`
 * — before the target, the outgoing edge and the `failed` escape hatch (#309) are
 * consulted. One team, one start.
 *
 * `start` wins over the first declared phase: a machine may name an entry point
 * that is not first (`validatePhaseMachine` rejects a start that is not a declared
 * phase, so this never invents one).
 *
 * The last leg covers a machine with no phases at all. Such a machine cannot be
 * declared — `validatePhaseMachine` rejects it ("a phase machine needs at least
 * one phase") and the loader (`parseAgentDocument`) rejects the card — so it only
 * keeps this function total, and lands on the built-in machine's start: the phase
 * an UNDECLARED team is born in.
 */
export function phaseStart(machine: PhaseMachine): string {
	return machine.start ?? machine.phases[0]?.id ?? DEFAULT_PHASE_MACHINE.start ?? "planning";
}

/** Look up a phase by id. */
export function findPhase(
	machine: PhaseMachine,
	id: string,
): PhaseDefinition | undefined {
	return machine.phases.find((phase) => phase.id === id);
}

export function isTerminalIn(machine: PhaseMachine, id: string): boolean {
	const phase = findPhase(machine, id);
	if (!phase) return false;
	return phase.terminal === true || phase.next.length === 0;
}

export function machineTimeout(
	machine: PhaseMachine,
	id: string,
): number | undefined {
	return findPhase(machine, id)?.timeoutMs;
}

/**
 * Ensure the three universal terminals exist (#298).
 *
 * A declared machine names its own workflow phases, but three things must never
 * be impossible:
 *
 *   - the parent must be able to ABORT a team (an emergency stop that a card
 *     could accidentally remove is a safety hole)
 *   - rework exhaustion and all-children-failed must be able to reach `failed`
 *   - the supervisor's verified-completion path targets `done`
 *
 * Rather than reject a machine that omits them (which would punish a card for
 * something it had no reason to think about), they are injected as terminal
 * phases with an unconditional edge from every non-terminal phase. Taking those
 * edges is still gated: `failed` requires a terminal reason and `aborted`
 * requires a parent retire, checked before any edge lookup, and `done` is
 * refused outright for a centurion (only the supervisor may complete a
 * team). So injection adds no new capability — it only removes the possibility of
 * a stranded team.
 */
export function normalizePhaseMachine(machine: PhaseMachine): PhaseMachine {
	const declared = new Set(machine.phases.map((phase) => phase.id));
	const missing = (["done", "failed", "aborted"] as const).filter((id) => !declared.has(id));
	if (missing.length === 0) return machine;
	const injected: PhaseDefinition[] = missing.map((id) => ({ id, terminal: true, next: [] }));
	const phases = machine.phases.map((phase) => {
		if (phase.terminal === true || phase.next.length === 0) return phase;
		const existing = new Set(phase.next.map((rule) => rule.to));
		const extra = missing.filter((id) => !existing.has(id)).map((to) => ({ to }));
		return extra.length > 0 ? { ...phase, next: [...phase.next, ...extra] } : phase;
	});
	return { ...machine, phases: [...phases, ...injected] };
}

/** A load-time problem: reported with the card path, never swallowed. */
export interface PhaseMachineError {
	path: string;
	message: string;
}

/**
 * Validate a machine. Returns every problem found rather than the first, so a
 * card author fixes one round of issues instead of one at a time.
 *
 * A machine that is invalid must be REJECTED at load. Accepting it and failing
 * mid-run would waste a team's tokens before surfacing a typo.
 */
export function validatePhaseMachine(machine: PhaseMachine): PhaseMachineError[] {
	const errors: PhaseMachineError[] = [];
	const ids = new Map<string, PhaseDefinition>();

	if (machine.phases.length === 0) {
		errors.push({ path: "phases", message: "a phase machine needs at least one phase" });
		return errors;
	}

	for (const [index, phase] of machine.phases.entries()) {
		const path = `phases[${index}]`;
		if (typeof phase.id !== "string" || !phase.id.trim()) {
			errors.push({ path: `${path}.id`, message: "phase id must be a non-empty string" });
			continue;
		}
		if (ids.has(phase.id)) {
			errors.push({ path: `${path}.id`, message: `duplicate phase id '${phase.id}'` });
			continue;
		}
		ids.set(phase.id, phase);
		for (const condition of phase.require ?? []) {
			if (!isPhaseCondition(condition)) {
				errors.push({
					path: `${path}.require`,
					message: `unknown condition '${String(condition)}'`,
				});
			}
		}
		if (!Array.isArray(phase.next)) {
			errors.push({ path: `${path}.next`, message: "next must be an array" });
		}
	}

	// Second pass: edges need every id resolved, and the terminal set known.
	for (const [index, phase] of machine.phases.entries()) {
		const path = `phases[${index}]`;
		const selfTerminal = phase.terminal === true;
		if (selfTerminal && (phase.next ?? []).length > 0) {
			errors.push({
				path: `${path}.next`,
				message: `terminal phase '${phase.id}' must not declare transitions`,
			});
		}
		if (!selfTerminal && (phase.next ?? []).length === 0) {
			errors.push({
				path: `${path}.next`,
				message: `phase '${phase.id}' has no transitions and is not marked terminal (unreachable dead end)`,
			});
		}
		for (const [ruleIndex, rule] of (phase.next ?? []).entries()) {
			const rulePath = `${path}.next[${ruleIndex}]`;
			if (!ids.has(rule.to)) {
				errors.push({
					path: `${rulePath}.to`,
					message: `unknown target phase '${String(rule.to)}'`,
				});
			}
			if (rule.to === phase.id) {
				errors.push({
					path: `${rulePath}.to`,
					message: `phase '${phase.id}' lists itself as a successor`,
				});
			}
			for (const condition of rule.require ?? []) {
				if (!isPhaseCondition(condition)) {
					errors.push({
						path: `${rulePath}.require`,
						message: `unknown condition '${String(condition)}'`,
					});
				}
			}
			if (rule.actorRole !== undefined && typeof rule.actorRole !== "string") {
				errors.push({ path: `${rulePath}.actorRole`, message: "actorRole must be a string" });
			}
		}
	}

	// #350 review (minor 3): ONE derivation of where a team starts. This validation used
	// to keep a third copy of `start ?? phases[0]?.id`, which is how the birth site and
	// the state machine drifted apart in the first place. The empty-machine case already
	// returned above, so `phaseStart` is only asked when there is a phase to name — it
	// can therefore never fall through to the built-in start here.
	const start = machine.phases.length > 0 ? phaseStart(machine) : undefined;
	if (start === undefined || !ids.has(start)) {
		errors.push({
			path: "start",
			message: `start phase '${String(start)}' is not a declared phase`,
		});
	} else if (isTerminalIn(machine, start)) {
		errors.push({
			path: "start",
			message: `start phase '${start}' is terminal, so the team could never progress`,
		});
	}

	if (machine.maxRework !== undefined) {
		if (!Number.isInteger(machine.maxRework) || machine.maxRework < 0) {
			errors.push({
				path: "maxRework",
				message: "maxRework must be a non-negative integer",
			});
		}
	}

	// Reachability: a phase nobody can enter is dead config, and usually a typo.
	if (start !== undefined) {
		const reachable = new Set<string>([start]);
		const queue = [start];
		while (queue.length > 0) {
			const current = queue.shift()!;
			const phase = ids.get(current);
			for (const rule of phase?.next ?? []) {
				if (!reachable.has(rule.to)) {
					reachable.add(rule.to);
					queue.push(rule.to);
				}
			}
		}
		for (const id of ids.keys()) {
			if (!reachable.has(id)) {
				errors.push({
					path: `phases.${id}`,
					message: `phase '${id}' is unreachable from the start phase '${start}'`,
				});
			}
		}
	}

	return errors;
}

/**
 * Why a declarative transition was refused.
 *
 * The legacy reason codes are preserved verbatim, because they are asserted in
 * tests and surface in operator-facing messages. New machines reuse the same
 * vocabulary: a condition failure reports the condition name.
 */
export type PhaseRefusalReason =
	// structural (unchanged)
	| "invalid_phase"
	| "same_phase"
	| "terminal_phase"
	| "invalid_transition"
	| "rework_limit_exceeded"
	| "terminal_reason_required"
	| "all_children_not_failed"
	// legacy names for the default machine's condition failures
	| "contract_path_required"
	| "children_not_terminal"
	| "failed_worker_unhandled"
	| "all_workers_failed"
	| "reviewer_not_settled"
	| "review_verdict_not_accepted"
	| "review_verdict_not_rejected"
	| "verification_not_failed"
	| "verification_not_passed"
	| "centurion_required"
	| "planner_still_active"
	| "worker_still_active"
	// a declared condition failed
	| "condition_not_met"
	| "actor_not_permitted";

/**
 * Map a failed condition to the legacy reason code the default machine used.
 *
 * A custom machine reports `condition_not_met` with the condition name, because
 * inventing a legacy-sounding code for a condition the built-in machine never
 * had would be worse than saying what actually failed.
 */
export function legacyReasonForCondition(
	condition: PhaseCondition,
	edge: { to: string },
): PhaseRefusalReason {
	switch (condition) {
		case "contract_file":
			return "contract_path_required";
		case "children_settled":
			// The default machine uses this condition on two different edges with
			// distinct historical messages.
			return edge.to === "reviewing" ? "worker_still_active" : "children_not_terminal";
		case "children_present":
			// Nothing ran, so there is no verdict to accept. The historical name for
			// "you need an actual review before verifying" is reviewer_not_settled.
			return edge.to === "verifying" ? "reviewer_not_settled" : "condition_not_met";
		case "children_none_failed":
			return "failed_worker_unhandled";
		case "children_all_failed":
			return "all_workers_failed";
		case "verdict_ok":
			// Distinguish "no review happened" from "the review said no". The old
			// switch reported `reviewer_not_settled` for the first and
			// `review_verdict_not_accepted` for the second, and callers rely on the
			// difference: one means dispatch a reviewer, the other means rework.
			return edge.to === "verifying" ? "review_verdict_not_accepted" : "condition_not_met";
		case "verdict_not_ok":
			return "review_verdict_not_rejected";
		case "verification_passed":
			return "verification_not_passed";
		case "verification_failed":
			return "verification_not_failed";
		default:
			return "condition_not_met";
	}
}
