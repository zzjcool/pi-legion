/**
 * The `subagent` action surface — the ONE written-down copy of it.
 *
 * Before this file the same action set existed in four places that drifted apart
 * independently: the schema union, the README table, the `docs/design.md` §9.3
 * table, and the model-facing `Actions:` line (two actions short). Here the code
 * side DERIVES: `index.ts` builds the `SubagentParams.action` union from
 * {@link ACTION_NAMES} and `playbook.ts` builds the `Actions:` line from it, so
 * neither can be a second list. The Markdown side is ASSERTED, not generated —
 * `test/unit/action-surface-drift.test.ts` fails the moment either table
 * disagrees with this list (docs stay hand-readable on purpose).
 *
 * Contract: `docs/contracts/tool-surface-dedup-v1.md` (D1, D3).
 */

export const ACTION_NAMES = [
	"launch",
	"continue",
	"steer",
	"abort",
	"resume",
	"retire",
	"status",
	"collect",
	"list",
	"wait",
	"stop",
	"diagnose",
	"extend",
	"recover",
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

export interface ActionSpec {
	/** README / design.md 表里的 "What it does" 一句话（英文，与 README 现有措辞同风格） */
	readonly summary: string;
	/** 该 action 真实读取的参数字段 */
	readonly params: readonly string[];
	/** 其中必须提供的 */
	readonly required: readonly string[];
	/** 是否属于模型面（本契约全部 true；Step 2 会用它把运维动词标 false） */
	readonly modelFacing: boolean;
}

/**
 * Per-action facts. `summary` is the same sentence the README table carries, so
 * the two surfaces describe an action the same way.
 *
 * `params` lists the fields the action's OWN implementation reads. Two
 * exemptions, both deliberate:
 *   - `action` is the selector itself;
 *   - the catalog/store resolution fields (`cwd`, `hostCwd`, `agentScope`) are
 *     read for EVERY action before dispatch (`execute` resolves the store and
 *     the catalog first), so repeating them fourteen times would say nothing.
 * `name` / `all` / `runId` / `message` / `model` are genuinely read by several
 * actions and therefore ARE listed per action.
 *
 * `required` lists only what a single value can satisfy. Where the rule is
 * "one of two" (`wait`: `name` or `all`; `launch`: `agent`+`task` or `tasks[]`)
 * it stays empty: a flat list cannot express an alternative, and claiming
 * `required: ["name"]` on `wait` would simply be false.
 */
export const ACTION_SPECS: Readonly<Record<ActionName, ActionSpec>> = {
	launch: {
		summary: "Start a child from a role card (`agent` + `task`, or `tasks[]`).",
		params: ["agent", "task", "tasks", "async", "preset", "model", "worktree", "verify", "phases", "start", "host", "team", "name"],
		required: [],
		modelFacing: true,
	},
	continue: {
		summary:
			"Act on the child with `message`: a live child is steered in place, an exited one is relaunched from its persisted session so its context survives.",
		params: ["name", "message", "model", "runId"],
		required: ["name", "message"],
		modelFacing: true,
	},
	steer: {
		summary:
			"Send `message` to a running child without waiting for its reply. Not an interrupt: the text queues at the child's next turn boundary.",
		params: ["name", "message", "runId"],
		required: ["name", "message"],
		modelFacing: true,
	},
	abort: {
		summary:
			"Interrupt the child's current turn and keep its session, so it stays continuable. The child is not torn down — that is `stop`.",
		params: ["name", "clearQueued", "runId"],
		required: ["name"],
		modelFacing: true,
	},
	resume: {
		summary:
			"The same revive path as `continue`, used to pick a saved child back up (receipt says `Resumed`).",
		params: ["name", "message", "model", "runId"],
		required: ["name", "message"],
		modelFacing: true,
	},
	retire: {
		summary: "Retire the child while preserving its outcome and session for a later resume.",
		params: ["name", "runId"],
		required: ["name"],
		modelFacing: true,
	},
	status: {
		summary: "One child's snapshot with `name`; without `name`, the live-children overview.",
		params: ["name", "all", "runId"],
		required: [],
		modelFacing: true,
	},
	collect: {
		summary: "Wait for the child's current turn and derive its outcome from its session.",
		params: ["name", "runId"],
		required: ["name"],
		modelFacing: true,
	},
	list: {
		summary:
			"List the loaded roles, with the active team and any team warnings on top when they are not the default.",
		params: [],
		required: [],
		modelFacing: true,
	},
	wait: {
		summary: "Event-driven wait for `name` or `all: true`; a timeout retires nothing.",
		params: ["name", "all", "timeoutMs"],
		required: [],
		modelFacing: true,
	},
	stop: {
		summary: "Graceful stop of one child or of every live child; `force: true` hard-retires.",
		params: ["name", "all", "force", "runId"],
		required: [],
		modelFacing: true,
	},
	diagnose: {
		summary:
			"The `/legion doctor` self-check returned as tool output, with an optional `section`.",
		params: ["section"],
		required: [],
		modelFacing: true,
	},
	extend: {
		summary:
			'Defer the "may be looping" reminder for one direct child by `ms`. It never restarts or revives the child.',
		params: ["name", "ms"],
		required: ["name"],
		modelFacing: true,
	},
	recover: {
		summary:
			"Collect a cross-machine child a PREVIOUS session launched: read its transcript from that machine, grade it with the collect rules, settle the ledger row and return the collect text.",
		params: ["name"],
		required: ["name"],
		modelFacing: true,
	},
};

/**
 * D3: the params whose ONE consumer is proven, and which action that is.
 *
 * Only these may be hard-refused; everything else (`name`, `all`, `runId`,
 * `message`, `model`, `cwd`, `hostCwd`, `agentScope`) is read by several actions
 * and stays silently permissive for now. Deliberately NOT here, per the
 * contract's exclusions: `runId` on `wait` (the wait path returns before scope
 * resolution), `timeoutMs` value validation, and any root-level `anyOf`.
 *
 * `test/unit/inert-params.test.ts` pins this table against {@link ACTION_SPECS}
 * (each field must be listed by exactly its owner), so the two cannot drift.
 */
export const PARAM_OWNER_ACTIONS = {
	timeoutMs: "wait",
	ms: "extend",
	force: "stop",
	clearQueued: "abort",
	section: "diagnose",
	team: "launch",
	agent: "launch",
	task: "launch",
	tasks: "launch",
	async: "launch",
	preset: "launch",
	worktree: "launch",
	verify: "launch",
	phases: "launch",
	start: "launch",
	host: "launch",
} as const satisfies Readonly<Record<string, ActionName>>;

/**
 * The fields this call carries that the chosen action does not read at all.
 *
 * "Carried" means explicitly provided and not `undefined` — `{ force: undefined }`
 * is what a typed caller who spread a config looks like, and refusing that would
 * punish the caller for the serializer. Declaration order is the table's order,
 * so the message lists fields the same way every time.
 */
export function inertParamsFor(action: ActionName, params: Record<string, unknown>): string[] {
	return Object.entries(PARAM_OWNER_ACTIONS)
		.filter(([field, owner]) => owner !== action && params[field] !== undefined)
		.map(([field]) => field);
}

/**
 * The refusal text for {@link inertParamsFor}, built to be actionable: it names
 * each offending field, the ONE action that reads it, the action actually called,
 * and both ways out.
 *
 * For a single field this reads exactly:
 * `force is only read by action "stop" (got action "collect"). Drop it or call action:"stop".`
 */
export function inertParamsMessage(inert: readonly string[], action: ActionName): string {
	const owners = PARAM_OWNER_ACTIONS as Readonly<Record<string, ActionName>>;
	const owner = (field: string): ActionName => owners[field] as ActionName;
	const clauses = inert.map((field) => `${field} is only read by action "${owner(field)}"`);
	const fixes = inert.map((field) => `${field} → action:"${owner(field)}"`).join(", ");
	const hint =
		inert.length === 1
			? `call action:"${owner(inert[0] as string)}"`
			: `call the action that reads each (${fixes})`;
	return `${clauses.join("; ")} (got action "${action}"). Drop ${inert.length === 1 ? "it" : "them"} or ${hint}.`;
}
