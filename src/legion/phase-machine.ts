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
	PHASE_CONDITIONS,
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
	/**
	 * This edge was ADDED BY THE NORMALIZER, not written by the author (#371).
	 *
	 * The distinction is load-bearing for `done`: an injected `→ done` exists so a
	 * team can never be stranded, and it is the SUPERVISOR's way out (the verified
	 * completion path). It must never become the team's own way to skip a
	 * verification phase its author DID declare — `evaluatePhaseTransition` refuses
	 * it for every other actor, and no author-facing gate (`maySelfComplete`) may
	 * count it as a declared exit.
	 */
	injected?: boolean;
}

export interface PhaseDefinition {
	id: string;
	/** ANDed into every rule that leaves this phase. */
	require?: PhaseCondition[];
	/**
	 * Allowed exits. A transition to anything else is refused.
	 *
	 * A TERMINAL phase may omit it: `{ id: "done", terminal: true }` and
	 * `{ id: "done", terminal: true, next: [] }` are the same declaration (#坑1).
	 * Every reader therefore goes through {@link declaredEdges} instead of touching
	 * `.length` — a machine is data from a card or a model, and a missing field must
	 * never be a TypeError in the validator.
	 */
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
	const first = Array.isArray(machine?.phases) ? machine.phases[0]?.id : undefined;
	return machine?.start ?? first ?? DEFAULT_PHASE_MACHINE.start ?? "planning";
}

/**
 * Can the machine END at all (#371)?
 *
 * `validatePhaseMachine` answers "is this machine well formed", never "can this
 * team finish". A declared graph may therefore be perfectly valid and still be a
 * loop: every phase names a successor, no dead end exists, and nothing is
 * terminal — `evaluatePhaseTransition` would accept the first hop and refuse
 * every exit after it. The reachability check is the missing half, kept OUT of
 * `validatePhaseMachine` on purpose: that function runs while a CARD loads, and
 * its rules are frozen.
 *
 * Deliberately asked of the DECLARED graph, before {@link normalizePhaseMachine}
 * injects the universal terminals. Normalization would answer `true` for any
 * well-formed machine (it appends `done` to every non-terminal phase), which is
 * exactly the answer that hides the loop.
 */
export function canReachTerminal(machine: PhaseMachine): boolean {
	const start = phaseStart(machine);
	const seen = new Set<string>([start]);
	const queue = [start];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const phase = findPhase(machine, current);
		if (phase && isTerminalIn(machine, current)) return true;
		if (!phase) {
			// An edge may name a phase the declaration does not define. For the three
			// universal terminals that is legitimate and common — `ship -> done` is how
			// a card says "end here", and normalization supplies the phase itself. Any
			// OTHER undefined target is already a validation error ("unknown target
			// phase"), so it must not be allowed to certify a machine by being a leaf.
			if ((DEFAULT_TERMINAL_PHASES as readonly string[]).includes(current)) return true;
			continue;
		}
		for (const rule of declaredEdges(phase)) {
			if (seen.has(rule.to)) continue;
			seen.add(rule.to);
			queue.push(rule.to);
		}
	}
	return false;
}

/**
 * Which phase of this machine judges success (#358/#371)?
 *
 * A phase that can reach `done` is where the supervisor's verified-completion
 * path fires. Among those, an edge requiring `verification_passed` is the most
 * precise statement of "the verdict decides here"; otherwise the LAST declared
 * candidate wins (machines list their phases in pipeline order, and the deepest
 * phase that can complete a team is the one that completes it — that rule alone
 * picks `verifying` in the built-in machine).
 *
 * `undefined` means the machine never reaches `done`, which is the caller's cue
 * to keep its historical literal rather than invent a phase name.
 */
export function successPhaseOf(machine: PhaseMachine): string | undefined {
	const phases: PhaseDefinition[] = Array.isArray(machine?.phases) ? machine.phases : [];
	const declared = phases.filter((phase) =>
		declaredEdges(phase).some((rule) => rule.to === "done" && rule.injected !== true),
	);
	const exits =
		declared.length > 0
			? declared
			: phases.filter((phase) => declaredEdges(phase).some((rule) => rule.to === "done"));
	if (exits.length === 0) return undefined;
	const gated = exits.filter((phase) =>
		declaredEdges(phase).some((rule) => rule.to === "done" && (rule.require ?? []).includes("verification_passed")),
	);
	const candidates = gated.length > 0 ? gated : exits;
	if (declared.length > 0) return candidates[candidates.length - 1]!.id;
	// #371 (review r2): every exit is a normalizer injection, so the AUTHOR said
	// nothing about where success is judged. Trusting array order here would let a
	// legal but out-of-order declaration (phases listed ship, spec, impl) complete
	// the team at `impl`, skipping an earlier pipeline stage; the farthest phase from
	// the start is the only order-independent answer.
	return farthestFrom(machine, candidates);
}

/** BFS distance from the start; ties keep the declaration's own order. */
function farthestFrom(machine: PhaseMachine, candidates: PhaseDefinition[]): string {
	const start = phaseStart(machine);
	const distance = new Map<string, number>([[start, 0]]);
	const queue = [start];
	while (queue.length > 0) {
		const id = queue.shift()!;
		const phase = findPhase(machine, id);
		for (const rule of declaredEdges(phase)) {
			if (distance.has(rule.to)) continue;
			distance.set(rule.to, (distance.get(id) ?? 0) + 1);
			queue.push(rule.to);
		}
	}
	let best = candidates[0]!.id;
	let bestDistance = distance.get(best) ?? -1;
	for (const phase of candidates) {
		const current = distance.get(phase.id) ?? -1;
		if (current > bestDistance) {
			best = phase.id;
			bestDistance = current;
		}
	}
	return best;
}

/** Look up a phase by id. */
export function findPhase(
	machine: PhaseMachine,
	id: string,
): PhaseDefinition | undefined {
	// #坑1: a machine is data, and `phases` may be absent, the wrong type, or hold
	// nulls. Every reader goes through here, so this is the one place that must not
	// assume an array — a TypeError in a validator hides the real problem.
	if (!Array.isArray(machine?.phases)) return undefined;
	return machine.phases.find((phase) => phase?.id === id);
}

/**
 * Every exit a phase declares, as a list (#坑1).
 *
 * The single reader for `phase.next`. A machine is DATA — it comes from a card's
 * frontmatter or from a model's tool call — so `next` may be absent (a terminal
 * phase may omit it) or malformed (`next: "done"`). Both must be reported, and
 * neither may be a TypeError halfway through validation.
 */
export function declaredEdges(phase: PhaseDefinition | undefined | null): readonly PhaseTransitionRule[] {
	if (!phase || typeof phase !== "object") return [];
	return Array.isArray(phase.next) ? phase.next : [];
}

/**
 * Is this phase terminal-shaped (#坑1)?
 *
 * `terminal: true` OR "declares no exits", with an OMITTED `next` counted as
 * `next: []`. A MALFORMED `next` (`next: "done"`) is deliberately NOT read as
 * "no exits": that would add a misleading second complaint (".next must not
 * declare transitions" is the truth, and the structure error already says so).
 */
function terminalShaped(phase: PhaseDefinition): boolean {
	if (!phase || typeof phase !== "object") return false;
	if (phase.terminal === true) return true;
	if (phase.next === undefined) return true;
	return Array.isArray(phase.next) && phase.next.length === 0;
}

export function isTerminalIn(machine: PhaseMachine, id: string): boolean {
	const phase = findPhase(machine, id);
	if (!phase) return false;
	return terminalShaped(phase);
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
 * phases with an unconditional edge from every non-terminal phase.
 *
 * INVARIANT (#371): an injected edge is REACHABLE ONLY BY THE SUPERVISOR.
 * Every one of them is marked {@link PhaseTransitionRule.injected}, and
 * `evaluatePhaseTransition` refuses an injected `→ done` for any other actor,
 * while `failed`/`aborted` stay gated exactly as before (a terminal reason, and
 * a parent retire). So injection adds no capability — it only removes the
 * possibility of a stranded team — and it can never be the team's way around a
 * verification phase its author DID declare.
 *
 * That last point is not theoretical: before the marker existed, a machine
 * declaring `ship → done require:["verification_passed"]` let a team complete
 * from ANY non-terminal phase, because `evaluateDeclarative` takes the first
 * matching edge and the injected one carried no conditions at all.
 */
export function normalizePhaseMachine(machine: PhaseMachine): PhaseMachine {
	const declaredPhases: PhaseDefinition[] = Array.isArray(machine?.phases) ? machine.phases : [];
	const declared = new Set(declaredPhases.map((phase) => phase?.id));
	const missing = (["done", "failed", "aborted"] as const).filter((id) => !declared.has(id));
	const phases = declaredPhases.map((phase) => {
		// #坑1: every read of `next` goes through `declaredEdges`/`terminalShaped`. A
		// machine is data from a card or from a model's tool call, so `.length` on a
		// missing or malformed `next` was a TypeError on a path an author could reach.
		if (!phase || typeof phase !== "object") return phase;
		if (phase.next !== undefined && !Array.isArray(phase.next)) {
			// MALFORMED `next` (`next: "done"`): left exactly as written. Injecting the
			// universal terminals over it — or erasing it into `[]` — would turn an invalid
			// declaration into a valid one and hide the author's mistake.
			return phase;
		}
		if (terminalShaped(phase)) {
			// A terminal phase may OMIT `next`; emitting `next: []` keeps the normalized
			// machine uniform, so nothing downstream has to know about the omission.
			return Array.isArray(phase.next) ? phase : { ...phase, next: [] };
		}
		const edges = declaredEdges(phase);
		const existing = new Set(edges.map((rule) => rule?.to));
		const extra = missing.filter((id) => !existing.has(id)).map((to) => ({ to, injected: true as const }));
		return extra.length > 0 ? { ...phase, next: [...edges, ...extra] } : phase;
	});
	// #坑1: even when all three universal terminals are ALREADY declared, the copied
	// list is what gets returned. Returning `machine` itself here left `next` as the
	// author wrote it — absent on a terminal phase — and `state-machine.ts`,
	// `extension/legion-tools.ts` and `tui/tree-view.ts` read `phase.next` directly.
	// The omission is therefore closed for EVERY branch, not only the injecting one.
	if (missing.length === 0) return { ...machine, phases };
	const injected: PhaseDefinition[] = missing.map((id) => ({ id, terminal: true, next: [] }));
	return { ...machine, phases: [...phases, ...injected] };
}

/**
 * How a load-time problem is classified (#坑1 / contract D1).
 *
 * A category is not decoration: it decides the ORDER problems are reported in and
 * the one-line explanation in front of each group, which is what turns "next must
 * be an array" into "fix the shape first, then the routing".
 */
export type PhaseMachineCategory =
	/** shape/value is wrong: empty id, duplicate id, `next` not an array, unknown condition, bad start */
	| "structure"
	/** terminal-shaped: a terminal phase declares edges, or a non-terminal one declares none */
	| "terminal"
	/** an edge points somewhere illegal: at itself, or at a phase nobody declared */
	| "successor"
	/** nothing points at a declared phase, or the declared graph can never end */
	| "unreachable"
	/** `maxRework` is invalid, or it forbids every edge marked `rework` */
	| "rework";

/** Fixed report order: shape first, then routing, then reachability, then caps. */
export const PHASE_MACHINE_CATEGORIES: readonly PhaseMachineCategory[] = [
	"structure",
	"terminal",
	"successor",
	"unreachable",
	"rework",
];

/** One line per category, printed as the group header. */
export const PHASE_MACHINE_CATEGORY_HINTS: Record<PhaseMachineCategory, string> = {
	structure: "the declaration is malformed, so fix its shape before the routing can mean anything",
	terminal: "a terminal phase ends the walk and declares no edges",
	successor: "every edge must point at another declared phase",
	unreachable: "every declared phase must be reachable from the start, and the walk must be able to end",
	rework: "the rework cap and the edges marked rework must agree",
};

/** A load-time problem: reported with the card path, never swallowed. */
export interface PhaseMachineError {
	/** `phases[i]` / `phases[i].next[j].to` / `start` / `maxRework` / `phases`. */
	path: string;
	/** One sentence: what is wrong, naming the phase and the edge it is about. */
	message: string;
	category: PhaseMachineCategory;
	/** One sentence: what to write instead. `terminal`/`successor`/`unreachable` carry a minimal example. */
	fix?: string;
}

/** Render a value the way an error message should: `null`, `a string ("done")`, `an object`. */
function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "a list";
	if (typeof value === "string") return `a string (${JSON.stringify(value)})`;
	if (typeof value === "object") return "an object";
	return `${typeof value} (${JSON.stringify(value)})`;
}

/**
 * ONE reading of a `require` field (#坑1, review M1).
 *
 * `require` is the field an author is most likely to write as a bare value:
 * `require: "children_settled"` iterates CHARACTER BY CHARACTER (sixteen
 * "unknown condition 'c'/'h'/…" lines for one typo), and `require: 5` used to
 * throw `TypeError: number 5 is not iterable` straight out of the validator — the
 * one thing a validator must never do. Both are now one `structure` problem.
 *
 * A non-list is reported by the caller (the path and the phase/edge differ), so
 * this only answers "is it a list" and "what is in it".
 */
function declaredConditions(value: unknown): { list: unknown[]; isList: boolean } {
	if (value === undefined) return { list: [], isList: true };
	if (!Array.isArray(value)) return { list: [], isList: false };
	return { list: value, isList: true };
}

/**
 * The invalid elements of one `require` list, as ONE sentence.
 *
 * Several bad entries still make one problem per field: the author has one typo to
 * find, and repeating the closed vocabulary per element is the noise this report
 * exists to remove. The shape (`unknown condition '<value>'`) is unchanged.
 */
function conditionProblem(invalid: unknown[]): string {
	const extra = invalid.length > 1 ? ` (+${invalid.length - 1} more)` : "";
	return `unknown condition '${String(invalid[0])}'${extra}`;
}

/** The smallest legal machine; the fallback example when no phase-specific one fits. */
const MINIMAL_MACHINE_EXAMPLE =
	'phases: [{ id: "planning", next: [{ to: "done" }] }, { id: "done", terminal: true }]';

/** A minimal legal declaration of ONE phase, naming where it goes. */
function phaseExample(id: string, to = id === "done" ? "failed" : "done"): string {
	return `{ id: ${JSON.stringify(id)}, next: [{ to: ${JSON.stringify(to)} }] }`;
}

/** A minimal legal machine in which `id` is the terminal phase the walk ends in. */
function terminalMachineExample(id: string): string {
	const source = id === "planning" ? "work" : "planning";
	return `phases: [{ id: ${JSON.stringify(source)}, next: [{ to: ${JSON.stringify(id)} }] }, { id: ${JSON.stringify(id)}, terminal: true }]`;
}

/**
 * Validate a machine. Returns every problem found rather than the first, so a
 * card author fixes one round of issues instead of one at a time.
 *
 * A machine that is invalid must be REJECTED at load. Accepting it and failing
 * mid-run would waste a team's tokens before surfacing a typo.
 *
 * Never throws (#坑1): `next` may be absent (a terminal phase may omit it) or the
 * wrong type entirely, and both are reported as `structure` problems instead of a
 * TypeError halfway through the first pass.
 */
export function validatePhaseMachine(machine: PhaseMachine): PhaseMachineError[] {
	const errors: PhaseMachineError[] = [];
	const ids = new Map<string, PhaseDefinition>();

	const declared: unknown = (machine as { phases?: unknown } | null | undefined)?.phases;
	if (!Array.isArray(declared)) {
		errors.push({
			path: "phases",
			message: `phases must be a list of phase objects (got ${describeValue(declared)})`,
			category: "structure",
			fix: `write the phases as a list, e.g. ${MINIMAL_MACHINE_EXAMPLE}`,
		});
		return errors;
	}
	const phases = declared as PhaseDefinition[];
	if (phases.length === 0) {
		errors.push({
			path: "phases",
			message: "a phase machine needs at least one phase",
			category: "structure",
			fix: `declare at least one phase, e.g. ${MINIMAL_MACHINE_EXAMPLE}`,
		});
		return errors;
	}

	const conditions = PHASE_CONDITIONS.join(", ");
	// Is the edge graph itself readable? A `next` that is not a list, or an edge that
	// does not name a target, means every reachability verdict below would be about the
	// malformed field rather than about the author's routing.
	let graphUnreadable = false;

	for (const [index, phase] of phases.entries()) {
		const path = `phases[${index}]`;
		if (typeof phase?.id !== "string" || !phase.id.trim()) {
			errors.push({
				path: `${path}.id`,
				message: `phase id must be a non-empty string (got ${describeValue(phase?.id)})`,
				category: "structure",
				fix: `give the phase a stable name, e.g. ${phaseExample("planning")}`,
			});
			continue;
		}
		if (ids.has(phase.id)) {
			errors.push({
				path: `${path}.id`,
				message: `duplicate phase id '${phase.id}'`,
				category: "structure",
				fix: `rename one of the two phases: an edge can only name its target by id, so ids must be unique (e.g. '${phase.id}-2')`,
			});
			continue;
		}
		ids.set(phase.id, phase);
		// #坑1 / M1: `require` is read through `declaredConditions`, so a bare string or a
		// number is ONE problem naming this phase — never sixteen, and never a TypeError.
		const phaseRequire = declaredConditions(phase.require);
		if (!phaseRequire.isList) {
			errors.push({
				path: `${path}.require`,
				message: `require on phase '${phase.id}' must be a list of conditions (got ${describeValue(phase.require)})`,
				category: "structure",
				fix: `write them as a list, e.g. { id: ${JSON.stringify(phase.id)}, require: ["children_settled"], next: [...] }`,
			});
		} else {
			const invalid = phaseRequire.list.filter((condition) => !isPhaseCondition(condition));
			if (invalid.length > 0) {
				errors.push({
					path: `${path}.require`,
					message: `${conditionProblem(invalid)} on phase '${phase.id}'`,
					category: "structure",
					fix: `use one of the closed vocabulary (${conditions}), e.g. { id: ${JSON.stringify(phase.id)}, require: ["children_settled"], next: [...] }`,
				});
			}
		}
		// #坑1 / D2: `next` ABSENT is legal on a terminal phase (and means `[]`); a
		// `next` that is present but not a list is a STRUCTURE problem, never a crash.
		if (phase.next !== undefined && !Array.isArray(phase.next)) {
			graphUnreadable = true;
			errors.push({
				path: `${path}.next`,
				message: `next must be a list of transition rules (got ${describeValue(phase.next)})`,
				category: "structure",
				fix: `write the exits as a list, e.g. ${phaseExample(phase.id)}, or omit next entirely on a terminal phase`,
			});
		}
	}

	// Second pass: edges need every id resolved, and the terminal set known.
	for (const [index, phase] of phases.entries()) {
		const path = `phases[${index}]`;
		// M1: an entry that is not an object (`null`, a number) already failed the `id`
		// check above. Edge and terminal verdicts about it would be second and third
		// complaints on top of that one problem — and this is the pass that would crash
		// on `.next`/`.terminal` if the readers below were not defensive.
		if (!phase || typeof phase !== "object") continue;
		const name = typeof phase?.id === "string" && phase.id.trim() ? phase.id : `(phase #${index})`;
		const edges = declaredEdges(phase);
		const selfTerminal = phase?.terminal === true;
		const malformedNext = phase?.next !== undefined && !Array.isArray(phase.next);
		if (selfTerminal && edges.length > 0) {
			errors.push({
				path: `${path}.next`,
				message: `terminal phase '${name}' must not declare transitions (it declares ${edges.map((rule) => `'${String(rule?.to)}'`).join(", ")})`,
				category: "terminal",
				fix: `keep \`terminal: true\` and remove \`next\` (a terminal phase may omit it), e.g. ${terminalMachineExample(name)} — or drop \`terminal: true\` if the walk really does continue past '${name}'`,
			});
		}
		if (!selfTerminal && !malformedNext && edges.length === 0) {
			errors.push({
				path: `${path}.next`,
				message: `phase '${name}' is not terminal and declares no transitions, so the walk would stop dead there`,
				category: "terminal",
				fix: `either add a transition (e.g. ${phaseExample(name)}) or mark it \`terminal: true\` when the walk ends here (e.g. { id: ${JSON.stringify(name)}, terminal: true })`,
			});
		}
		for (const [ruleIndex, rule] of edges.entries()) {
			const rulePath = `${path}.next[${ruleIndex}]`;
			if (!rule || typeof rule !== "object") {
				graphUnreadable = true;
				errors.push({
					path: rulePath,
					message: `transition of phase '${name}' must be an object with a 'to' (got ${describeValue(rule)})`,
					category: "structure",
					fix: `write it as { to: "<phase id>" }, e.g. ${phaseExample(name)}`,
				});
				continue;
			}
			const to: unknown = rule.to;
			if (typeof to !== "string" || !to.trim()) {
				graphUnreadable = true;
				errors.push({
					path: `${rulePath}.to`,
					message: `transition of phase '${name}' must name its target phase (got ${describeValue(to)})`,
					category: "structure",
					fix: `name the phase this edge goes to, e.g. ${phaseExample(name)}`,
				});
				continue;
			}
			if (!ids.has(to)) {
				errors.push({
					path: `${rulePath}.to`,
					message: `unknown target phase '${to}' from phase '${name}'`,
					category: "successor",
					fix: `point that edge at a declared phase (declared: ${[...ids.keys()].map((id) => `'${id}'`).join(", ")}) or declare '${to}' as a phase of its own, e.g. { id: ${JSON.stringify(to)}, next: [{ to: "done" }] }`,
				});
			}
			if (to === phase.id) {
				errors.push({
					path: `${rulePath}.to`,
					message: `phase '${name}' lists itself as a successor`,
					category: "successor",
					fix: `point that edge at a different phase, e.g. { id: ${JSON.stringify(name)}, next: [{ to: "done" }] } — a phase cannot be its own successor`,
				});
			}
			// Same reading as the phase-level field: a bare string here used to produce one
			// problem per character, a number a TypeError (M1).
			const edgeRequire = declaredConditions(rule.require);
			if (!edgeRequire.isList) {
				errors.push({
					path: `${rulePath}.require`,
					message: `require on the '${name}' → '${to}' edge must be a list of conditions (got ${describeValue(rule.require)})`,
					category: "structure",
					fix: `write them as a list, e.g. { to: ${JSON.stringify(to)}, require: ["children_settled"] }`,
				});
			} else {
				const invalid = edgeRequire.list.filter((condition) => !isPhaseCondition(condition));
				if (invalid.length > 0) {
					errors.push({
						path: `${rulePath}.require`,
						message: `${conditionProblem(invalid)} on the '${name}' → '${to}' edge`,
						category: "structure",
						fix: `use one of the closed vocabulary (${conditions}), e.g. { to: ${JSON.stringify(to)}, require: ["children_settled"] }`,
					});
				}
			}
			if (rule.actorRole !== undefined && typeof rule.actorRole !== "string") {
				errors.push({
					path: `${rulePath}.actorRole`,
					message: `actorRole on the '${name}' → '${to}' edge must be a role name (got ${describeValue(rule.actorRole)})`,
					category: "structure",
					fix: `use a role name, e.g. { to: ${JSON.stringify(to)}, actorRole: "centurion" }, or drop actorRole to let anyone take the edge`,
				});
			}
		}
	}

	// #350 review (minor 3): ONE derivation of where a team starts. This validation used
	// to keep a third copy of `start ?? phases[0]?.id`, which is how the birth site and
	// the state machine drifted apart in the first place. The empty-machine case already
	// returned above, so `phaseStart` is only asked when there is a phase to name — it
	// can therefore never fall through to the built-in start here.
	const start = phaseStart(machine);
	const startPhase = ids.get(start);
	if (startPhase === undefined) {
		errors.push({
			path: "start",
			message: `start phase '${String(start)}' is not a declared phase`,
			category: "structure",
			fix: `set start to one of the declared phases (declared: ${[...ids.keys()].map((id) => `'${id}'`).join(", ")}), e.g. start: "${[...ids.keys()][0]}"`,
		});
	} else if (startPhase?.terminal === true) {
		// Review m2: only an EXPLICIT `terminal: true` is reported here. A phase that
		// merely declares no edges is terminal-SHAPED, and it is already reported once by
		// the `terminal` category ("is not terminal and declares no transitions"); two
		// lines saying different things about one phase is the confusion #坑1 removed.
		errors.push({
			path: "start",
			message: `start phase '${start}' is terminal, so the team could never progress`,
			category: "structure",
			fix: `start the walk at a phase that declares an exit, e.g. start: "${[...ids.values()].find((phase) => !terminalShaped(phase))?.id ?? "<a non-terminal phase>"}"`,
		});
	}

	if (machine.maxRework !== undefined) {
		if (!Number.isInteger(machine.maxRework) || machine.maxRework < 0) {
			errors.push({
				path: "maxRework",
				message: `maxRework must be a non-negative integer (got ${describeValue(machine.maxRework)})`,
				category: "rework",
				fix: `set the cap to a whole number >= 0, e.g. maxRework: 2 — or omit maxRework to keep the default`,
			});
		}
	}

	// #坑1 / D1 rework clash: a machine that allows NO rework cannot carry an edge
	// that only exists to rework — the cap would refuse it forever, which reads as a
	// mysterious `rework_limit_exceeded` mid-run instead of a load-time mistake.
	if (machine.maxRework === 0) {
		for (const [index, phase] of phases.entries()) {
			const name = typeof phase?.id === "string" && phase.id.trim() ? phase.id : `(phase #${index})`;
			for (const [ruleIndex, rule] of declaredEdges(phase).entries()) {
				if (rule?.rework !== true) continue;
				errors.push({
					path: `phases[${index}].next[${ruleIndex}].rework`,
					message: `phase '${name}' marks its '${String(rule.to)}' edge as rework, but maxRework is 0, so that edge can never be taken`,
					category: "rework",
					fix: `raise the cap (e.g. maxRework: 1) or drop \`rework: true\` from the '${name}' → '${String(rule.to)}' edge — the edge itself is legal, only the cap forbids it`,
				});
			}
		}
	}

	// Reachability: a phase nobody can enter is dead config, and usually a typo.
	// The path uses the SAME `phases[i]` namespace as every other problem (#坑1): an
	// author who is told `phases.orphan` cannot find that line in a list of `phases[i]`.
	//
	// Skipped when the graph itself cannot be read: with a broken `next` every phase
	// would look unreachable, and three lines blaming the author's routing for one
	// malformed field is the confusion this report exists to remove.
	if (!graphUnreadable) {
		const reachable = new Set<string>([start]);
		const queue = [start];
		while (queue.length > 0) {
			const current = queue.shift()!;
			const phase = ids.get(current);
			for (const rule of declaredEdges(phase)) {
				const to = rule?.to;
				if (typeof to !== "string" || reachable.has(to)) continue;
				reachable.add(to);
				queue.push(to);
			}
		}
		const reported = new Set<string>();
		for (const [index, phase] of phases.entries()) {
			const id = phase?.id;
			if (typeof id !== "string" || !id.trim() || reported.has(id)) continue;
			reported.add(id);
			if (reachable.has(id)) continue;
			errors.push({
				path: `phases[${index}]`,
				message: `phase '${id}' is unreachable from the start phase '${start}' because no declared edge leads to it`,
				category: "unreachable",
				// Review m3: a neutral, executable sentence. Normalization injects `failed` and
				// `aborted` into every non-terminal phase, so "add an edge or delete it" told the
				// author to edit a phase THEY never wrote; naming the id and the two real
				// repairs works for a genuine orphan and for an injected terminal alike.
				fix: `declare an edge that reaches '${id}' from a phase the team can be in, or rename '${id}' if it was a typo`,
			});
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
