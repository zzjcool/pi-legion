/**
 * The `subagent` action surface — the ONE written-down copy of it.
 *
 * Before this file the same action set existed in four places that drifted apart
 * independently: the schema union, the README table, the `docs/design.md` §9.3
 * table, and the model-facing `Actions:` line (two actions short). Here the code
 * side DERIVES: `index.ts` builds the `SubagentParams.action` union from
 * {@link ACTION_NAMES} and `playbook.ts` builds the `Actions:` line from it, so
 * neither can be a second list. The Markdown side is ASSERTED, not generated —
 * `test/unit/action-surface-drift.test.ts` fails the moment either table (or the
 * `N 个动作` count next to it) disagrees with this list, and the same file anchors
 * every `params` entry to a real schema property.
 *
 * Contract: `docs/contracts/tool-surface-dedup-v1.md` (D1, D3 + 附录 B).
 *
 * What this file deliberately does NOT carry (附录 B2): a prose `summary` of each
 * action, a `required` list, or a `modelFacing` flag. The first is a verbatim copy
 * of the README's second column (it drifted on day one), the second cannot express
 * the real rules (`wait` and `launch` are "one of two"), and the third was `true`
 * fourteen times over. Prose belongs to `README.md`; the machine rule belongs to
 * {@link ActionSpec.params}.
 */

export const ACTION_NAMES = [
	// Lifecycle order, not alphabetical and not "the order it was written": this
	// list IS the order the model reads — it drives the schema union and the
	// `Actions:` line — so it follows a dispatch's life (launch → control →
	// observation → recovery). The drift test pins the order as well as the set.
	"launch",
	"continue",
	"steer",
	"abort",
	"resume",
	"retire",
	"status",
	"collect",
	"wait",
	"stop",
	"diagnose",
	"extend",
	"recover",
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

export interface ActionSpec {
	/**
	 * The schema fields this action's OWN implementation reads.
	 *
	 * Two groups are deliberately absent: `action` itself, and the resolution
	 * fields `cwd` / `hostCwd` / `host` / `agentScope` — `execute` reads all of
	 * them for EVERY action before dispatch (`cwdIsRemote`, the store, the
	 * catalog), so repeating them thirteen times would say nothing and, worse,
	 * would make them look single-consumer. `name` / `all` / `runId` / `message` /
	 * `model` are genuinely read by several actions and ARE listed per action —
	 * which is exactly how {@link PARAM_OWNER_ACTIONS} tells a single consumer
	 * from a shared one.
	 */
	readonly params: readonly string[];
}

/**
 * The facts per action. One field, one consumer: `params` is what
 * {@link PARAM_OWNER_ACTIONS} inverts into the D3 refusal table and what the
 * drift test anchors against `SubagentParams.properties`.
 */
export const ACTION_SPECS: Readonly<Record<ActionName, ActionSpec>> = {
	launch: {
		params: ["agent", "task", "tasks", "async", "preset", "model", "worktree", "verify", "phases", "start", "team", "name"],
	},
	continue: {
		params: ["name", "message", "model", "runId"],
	},
	steer: {
		params: ["name", "message", "runId"],
	},
	abort: {
		params: ["name", "clearQueued", "runId"],
	},
	resume: {
		params: ["name", "message", "model", "runId"],
	},
	retire: {
		params: ["name", "runId"],
	},
	status: {
		params: ["name", "all", "runId"],
	},
	collect: {
		params: ["name", "runId"],
	},
	wait: {
		params: ["name", "all", "timeoutMs"],
	},
	stop: {
		params: ["name", "all", "force", "runId"],
	},
	diagnose: {
		params: ["section"],
	},
	// `runId` is listed because `extend` really reads it: the name is resolved
	// through the same run scope as every other control action BEFORE the extend
	// branch runs (`index.ts`, `scopeRunIdFor`/`resolveScopedChild`). The contract's
	// "don't touch `runId`" rule is about behaviour, not about writing a false doc.
	extend: {
		params: ["name", "ms", "runId"],
	},
	recover: {
		params: ["name"],
	},
};

/**
 * The single-consumer fields, DERIVED by inverting {@link ACTION_SPECS}.
 *
 * A field that exactly one action lists is a field only that action can honour —
 * the only kind D3 may hard-refuse. `name` / `all` / `runId` / `message` / `model`
 * fall out automatically (several owners each), and so does every field that is
 * absent from the specs entirely (the resolution fields).
 *
 * The governance anchor is the hand-written contract table in
 * `test/unit/inert-params.test.ts`; the two must agree, which is what stops a
 * quiet tweak here from changing the refusal surface.
 */
function singleConsumerParams(
	specs: Readonly<Record<ActionName, ActionSpec>>,
): Readonly<Record<string, ActionName>> {
	const owners = new Map<string, ActionName[]>();
	for (const action of ACTION_NAMES) {
		for (const field of specs[action].params) {
			const seen = owners.get(field);
			if (seen) seen.push(action);
			else owners.set(field, [action]);
		}
	}
	const single: Record<string, ActionName> = {};
	for (const [field, seen] of owners) {
		if (seen.length === 1) single[field] = seen[0] as ActionName;
	}
	return single;
}

export const PARAM_OWNER_ACTIONS = singleConsumerParams(ACTION_SPECS);

/**
 * The fields this call carries that the chosen action does not read at all.
 *
 * "Carried" means explicitly provided and not `undefined` — `{ force: undefined }`
 * is what a typed caller who spread a config looks like, and refusing that would
 * punish the caller for the serializer. The result is SORTED, so the message reads
 * the same way no matter which order the specs happen to list their fields in.
 *
 * Deliberately NOT here (contract exclusions, behaviour unchanged): `runId` on
 * `wait` (the wait path returns before scope resolution) and `timeoutMs` value
 * validation (negative / NaN still reach `setTimeout`).
 */
export function inertParamsFor(action: ActionName, params: Record<string, unknown>): string[] {
	return Object.entries(PARAM_OWNER_ACTIONS)
		.filter(([field, owner]) => owner !== action && params[field] !== undefined)
		.map(([field]) => field)
		.sort();
}

/**
 * The refusal text for {@link inertParamsFor}, built to be actionable: it names
 * each offending field, the ONE action that reads it, the action actually called,
 * and the way out.
 *
 * For a single control-owned field this reads exactly:
 * `force is only read by action "stop" (got action "collect"). Drop it or call action:"stop".`
 *
 * The "call action:X" half is offered only when the owner is a CONTROL action.
 * When the owner is `launch` it is withheld: the description tells the model to
 * `wait`/`collect` in the same turn, so answering `call action:"launch"` would
 * argue against the paragraph the model just read. Those calls get `Drop it.`
 */
export function inertParamsMessage(inert: readonly string[], action: ActionName): string {
	const owner = (field: string): ActionName => PARAM_OWNER_ACTIONS[field] as ActionName;
	const clauses = inert.map((field) => `${field} is only read by action "${owner(field)}"`);
	const drop = inert.length === 1 ? "Drop it" : "Drop them";
	// `launch`-owned fields cannot be "called instead" without changing the intent of
	// the call, so they contribute a clause but never a suggestion.
	const callable = inert.filter((field) => owner(field) !== "launch");
	let tail = `${drop}.`;
	if (callable.length === 1) {
		tail = `${drop} or call action:"${owner(callable[0] as string)}".`;
	} else if (callable.length > 1) {
		const fixes = callable.map((field) => `${field} → action:"${owner(field)}"`).join(", ");
		tail = `${drop} or call the action that reads each (${fixes}).`;
	}
	return `${clauses.join("; ")} (got action "${action}"). ${tail}`;
}
