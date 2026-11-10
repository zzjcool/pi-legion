/**
 * Child-process budgets: tool calls, turns, and per-bash timeouts.
 *
 * The parent injects these into the RPC child environment; `registerChildGuard`
 * reads them and blocks or wraps tool calls. 0 means "none allowed", not "unlimited".
 */

export const MAX_TOOL_CALLS_ENV = "PI_SUBAGENT_MAX_TOOL_CALLS";
export const MAX_TURNS_ENV = "PI_SUBAGENT_MAX_TURNS";
export const TOOL_TIMEOUT_MS_ENV = "PI_SUBAGENT_TOOL_TIMEOUT_MS";
export const ALLOW_NESTED_ENV = "PI_SUBAGENT_ALLOW_NESTED";

/** Parse a non-negative integer env value. Empty / garbage → undefined. */
export function parseBudgetInt(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined;
	return n;
}

export function budgetExceededReason(
	kind: "tool" | "turn",
	limit: number,
): string {
	return kind === "tool"
		? `tool budget exceeded (${limit} calls)`
		: `turn budget exceeded (${limit} turns)`;
}

/**
 * Wrap a bash command so the OS kills it after `timeoutMs`.
 *
 * Mutate `event.input.command` with this — the tool_call hook cannot otherwise
 * abort an in-flight bash. Already-wrapped commands are left alone.
 */
export function wrapBashWithTimeout(
	command: string,
	timeoutMs: number,
): string {
	if (!(timeoutMs > 0)) return command;
	if (/^\s*timeout(\s|$)/.test(command)) return command;
	const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
	return `timeout --kill-after=2s ${secs}s bash -lc ${JSON.stringify(command)}`;
}

export interface ChildBudget {
	maxToolCalls?: number;
	maxTurns?: number;
	toolTimeoutMs?: number;
}

/** The three budget fields a role card can declare, structurally typed. */
export interface AgentBudgetSource {
	toolBudget?: { maxToolCalls?: number };
	turnBudget?: { maxTurns?: number };
	toolTimeoutMs?: number;
}

/**
 * The budget a role card declares for its children (R6 / #295).
 *
 * ONE producer, TWO channels: `Orchestrator.lineageEnv` turns this object into
 * the `PI_SUBAGENT_MAX_*` env keys an rpc child receives as its real environment,
 * and the in-process `ChildLaunchContext.budget` carries the same object over ALS
 * (the child shares the HOST's `process.env`). Computing it twice let the two
 * channels drift silently — a fix to one would leave the other on the old
 * numbers, with nothing failing. Same values as before, still only for DEFINED
 * fields: an omitted limit stays "no limit" on both channels, and `0` is a real
 * limit ("none allowed"), never "unset".
 */
export function childBudgetFromAgent(agent: AgentBudgetSource): ChildBudget {
	return {
		...(agent.toolBudget?.maxToolCalls !== undefined
			? { maxToolCalls: agent.toolBudget.maxToolCalls }
			: {}),
		...(agent.turnBudget?.maxTurns !== undefined
			? { maxTurns: agent.turnBudget.maxTurns }
			: {}),
		...(agent.toolTimeoutMs !== undefined ? { toolTimeoutMs: agent.toolTimeoutMs } : {}),
	};
}

export function childBudgetFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): ChildBudget {
	const maxToolCalls = parseBudgetInt(env[MAX_TOOL_CALLS_ENV]);
	const maxTurns = parseBudgetInt(env[MAX_TURNS_ENV]);
	const toolTimeoutMs = parseBudgetInt(env[TOOL_TIMEOUT_MS_ENV]);
	return {
		...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
		...(maxTurns !== undefined ? { maxTurns } : {}),
		...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
	};
}
