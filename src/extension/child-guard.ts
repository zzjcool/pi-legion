/**
 * Guards that run inside an RPC child Pi process.
 *
 * The child extension enforces budgets and read-only role protections. A
 * nested dispatch can only use the subagent tool; bash must never access the
 * tree ledger directly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	budgetExceededReason,
	childBudgetFromEnv,
	wrapBashWithTimeout,
} from "./budget.ts";
import { shellChunks } from "./playbook.ts";

export const CHILD_ROLE_ENV = "PI_SUBAGENT_ROLE";
export const CHILD_ACCEPTANCE_ROLE_ENV = "PI_SUBAGENT_ACCEPTANCE_ROLE";

export function childTaskAppendix(opts?: {
	allowNested?: boolean;
	worktreeBranch?: string;
}): string {
	const nested = opts?.allowNested
		? "- Nested subagents via `subagent` tool only."
		: "- Do not spawn nested agents.";
	const worktree = opts?.worktreeBranch
		? [
				`- You are in an isolated git worktree on branch \`${opts.worktreeBranch}\`. Do not write the parent checkout.`,
				"- Commit on this branch and open a merge request / pull request into the repository default branch. Do not merge locally. Do not push to main or master. Put the MR/PR URL in your verdict reason.",
			]
		: [];
	return [
		"## Frozen child constraints (injected by pi-legion)",
		nested,
		...worktree,
		'- End with machine-readable JSON on its own: {"ok": true|false, "reason": "..."}.',
	].join("\n");
}

export const CHILD_TASK_APPENDIX = childTaskAppendix();

export function formatChildTask(
	task: string,
	opts?: { allowNested?: boolean; worktreeBranch?: string },
): string {
	return `Task: ${task}\n\n${childTaskAppendix(opts)}\n`;
}

export function blockChildMessage(reason: string): string {
	return `${reason}\n\n${CHILD_TASK_APPENDIX}`;
}

export function isReadOnlyRole(role: string | undefined): boolean {
	// #172: tolerate case/spacing from env-supplied PI_SUBAGENT_ACCEPTANCE_ROLE.
	return role?.trim().toLowerCase() === "read-only";
}

export interface ChildGuardEnv {
	acceptanceRole?: string;
}

const WRITE_HEADS = new Set([
	"rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown",
	"ln", "install", "tee", "dd", "truncate",
]);
const WRITE_GIT = new Set([
	"add", "commit", "push", "checkout", "reset", "rebase", "merge",
	"stash", "tag", "cherry-pick", "clean", "restore", "mv", "rm",
]);
const WRITE_NPM = new Set(["install", "uninstall", "ci", "publish", "link"]);

function firstToken(chunk: string): string {
	return chunk.trim().match(/^(\S+)/)?.[1] ?? "";
}

/** Does this command write to the filesystem via an output redirection? */
function hasFilesystemRedirect(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (character === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (character === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble || character !== ">") continue;
		const previous = command[index - 1] ?? "";
		const next = command[index + 1] ?? "";
		if (previous === "=" || previous === "-" || previous === "<" || previous === "!" || next === "=") continue;
		if (next === "&" || previous === ">") continue;
		const rest = command.slice(index + (next === ">" ? 2 : 1)).trimStart();
		if (/^\/dev\/null(\s|$)/.test(rest)) continue;
		return true;
	}
	return false;
}

function classifyReadonlyBash(command: string): string | undefined {
	if (hasFilesystemRedirect(command)) {
		return "read-only child must not redirect output onto the filesystem.";
	}
	for (const chunk of shellChunks(command)) {
		const head = firstToken(chunk).replace(/^\\/, "");
		if (WRITE_HEADS.has(head)) return `read-only child must not run \`${head}\`.`;
		if (head === "git") {
			const subcommand = chunk.trim().split(/\s+/)[1] ?? "";
			if (WRITE_GIT.has(subcommand)) return `read-only child must not run \`git ${subcommand}\`.`;
		}
		if (["npm", "npx", "pnpm", "yarn"].includes(head)) {
			const subcommand = chunk.trim().split(/\s+/)[1] ?? "";
			if (WRITE_NPM.has(subcommand) || head !== "npm") {
				return `read-only child must not run package-manager writes (\`${head} ${subcommand}\`).`;
			}
			if (subcommand === "i") return "read-only child must not run npm install.";
		}
		if (head === "sed" && /(^|\s)-i(\s|$)/.test(chunk)) {
			return "read-only child must not run `sed -i`.";
		}
	}
	return undefined;
}

interface ShellToken {
	kind: "word" | "operator";
	value: string;
}

/** Split the small shell surface the guard needs, retaining quotes as data. */
function shellTokens(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	const flush = () => {
		if (word) tokens.push({ kind: "word", value: word });
		word = "";
	};
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index] ?? "";
		if (quote) {
			if (character === quote) quote = undefined;
			else if (character === "\\" && quote === '"' && index + 1 < command.length) word += command[++index];
			else word += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === "\\" && index + 1 < command.length) {
			word += command[++index];
			continue;
		}
		if (/\s/.test(character)) {
			flush();
			continue;
		}
		if (character === "&" && command[index + 1] === ">") {
			flush();
			tokens.push({ kind: "operator", value: "&>" });
			index += 1;
			continue;
		}
		if (character === ">" || character === "<") {
			flush();
			let operator = character;
			if (command[index + 1] === character) {
				operator += character;
				index += 1;
				if (character === "<" && command[index + 1] === "<") {
					operator += "<";
					index += 1;
				}
			} else if (command[index + 1] === "&" || command[index + 1] === "|") {
				operator += command[++index];
			}
			tokens.push({ kind: "operator", value: operator });
			continue;
		}
		if (character === ";" || character === "&" || character === "|") {
			flush();
			let operator = character;
			if (command[index + 1] === character && (character === "&" || character === "|")) {
				operator += character;
				index += 1;
			}
			tokens.push({ kind: "operator", value: operator });
			continue;
		}
		word += character;
	}
	flush();
	return tokens;
}

function isLegionDbPath(value: string): boolean {
	return /^(?:\$PI_LEGION_DB|\$\{PI_LEGION_DB\})(?:-(?:wal|shm))?$/i.test(value) ||
		/(?:^|[\\/])legion\.db(?:-(?:wal|shm))?$/i.test(value);
}

const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep"]);
const PRINT_ONLY_COMMANDS = new Set(["echo", "printf"]);
const SEARCH_PATTERN_OPTIONS = new Set(["-e", "--regexp"]);
const SEARCH_VALUE_OPTIONS = new Set([
	"-A", "-B", "-C", "-m", "--max-count", "--max-columns",
	"--max-columns-preview", "--context", "--after-context", "--before-context",
	"--type", "-t", "--type-add", "-T", "--glob", "-g", "--iglob",
	"--encoding", "--engine", "--sort", "--threads", "--color", "--colors",
]);

function searchPatternIndexes(words: string[]): Set<number> {
	const ignored = new Set<number>();
	let hasExplicitPattern = false;
	for (let index = 0; index < words.length; index += 1) {
		const value = words[index] ?? "";
		if (SEARCH_PATTERN_OPTIONS.has(value)) {
			if (index + 1 < words.length) ignored.add(++index);
			hasExplicitPattern = true;
		} else if (/^--regexp=/.test(value) || /^-e.+/.test(value)) {
			ignored.add(index);
			hasExplicitPattern = true;
		} else if (SEARCH_VALUE_OPTIONS.has(value)) {
			if (index + 1 < words.length) ignored.add(++index);
		}
	}
	if (!hasExplicitPattern) {
		for (let index = 0; index < words.length; index += 1) {
			const value = words[index] ?? "";
			if (value === "--") continue;
			if (value.startsWith("-") && value !== "-") continue;
			ignored.add(index);
			break;
		}
	}
	return ignored;
}

function segmentHasDirectLegionDbAccess(tokens: ShellToken[]): boolean {
	const commandIndex = tokens.findIndex((token) => token.kind === "word");
	if (commandIndex < 0) return false;
	const command = tokens[commandIndex]?.value.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
	const isGitGrep = command === "git" && tokens[commandIndex + 1]?.value === "grep";
	const isSearch = SEARCH_COMMANDS.has(command) || isGitGrep;
	const argumentsStart = commandIndex + (isGitGrep ? 2 : 1);
	// Pattern files are input files even though a plain grep pattern is excluded
	// below. Check their value slots before classifying positional arguments.
	if (isSearch) {
		for (let index = argumentsStart; index < tokens.length; index += 1) {
			const token = tokens[index];
			if (token?.kind !== "word") continue;
			if ((token.value === "-f" || token.value === "--file") && tokens[index + 1]?.kind === "word") {
				if (isLegionDbPath(tokens[index + 1]?.value ?? "")) return true;
				index += 1;
			} else if (token.value.startsWith("--file=") && isLegionDbPath(token.value.slice("--file=".length))) {
				return true;
			}
		}
	}
	// Shell redirection targets are file access even for echo/printf. Here-doc
	// delimiters and descriptor duplication do not name a ledger file.
	for (let index = commandIndex + 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token || token.kind !== "operator") continue;
		if (["<<", "<<<", "<&", ">&"].includes(token.value)) continue;
		const target = tokens[index + 1];
		if (target?.kind === "word" && isLegionDbPath(target.value)) return true;
	}
	if (PRINT_ONLY_COMMANDS.has(command)) return false;
	const words = tokens.slice(argumentsStart).filter((token) => token.kind === "word").map((token) => token.value);
	const ignoredPatterns = isSearch ? searchPatternIndexes(words) : new Set<number>();
	let wordIndex = -1;
	for (const token of tokens.slice(argumentsStart)) {
		if (token.kind !== "word") continue;
		wordIndex += 1;
		if (!ignoredPatterns.has(wordIndex) && isLegionDbPath(token.value)) return true;
	}
	return false;
}

function directLegionDbAccess(command: string): boolean {
	let segment: ShellToken[] = [];
	for (const token of shellTokens(command)) {
		if (token.kind === "operator" && ["|", "||", "&", "&&", ";"].includes(token.value)) {
			if (segmentHasDirectLegionDbAccess(segment)) return true;
			segment = [];
		} else {
			segment.push(token);
		}
	}
	return segmentHasDirectLegionDbAccess(segment);
}

export function forbiddenChildReason(
	command: string,
	env: ChildGuardEnv = {},
): string | undefined {
	if (directLegionDbAccess(command)) {
		return "do not read or write legion.db directly from bash; use the legion tools.";
	}
	if (isReadOnlyRole(env.acceptanceRole)) return classifyReadonlyBash(command);
	return undefined;
}

export function childGuardEnvFromProcess(env: NodeJS.ProcessEnv = process.env): ChildGuardEnv {
	return env[CHILD_ACCEPTANCE_ROLE_ENV]
		? { acceptanceRole: env[CHILD_ACCEPTANCE_ROLE_ENV] }
		: {};
}

/** Child-only extension: intercept tools; do not register the parent tool. */
export function registerChildGuard(pi: ExtensionAPI): void {
	const budget = childBudgetFromEnv();
	let toolCalls = 0;
	let turns = 0;
	pi.on("turn_start", () => { turns += 1; });
	pi.on("tool_call", (event) => {
		toolCalls += 1;
		if (budget.maxToolCalls !== undefined && toolCalls > budget.maxToolCalls) {
			return { block: true, reason: blockChildMessage(budgetExceededReason("tool", budget.maxToolCalls)) };
		}
		if (budget.maxTurns !== undefined && turns > budget.maxTurns) {
			return { block: true, reason: blockChildMessage(budgetExceededReason("turn", budget.maxTurns)) };
		}
		if (event.toolName !== "bash") return;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		const reason = forbiddenChildReason(command, childGuardEnvFromProcess());
		if (reason) return { block: true, reason: blockChildMessage(reason) };
		if (budget.toolTimeoutMs && budget.toolTimeoutMs > 0) {
			event.input.command = wrapBashWithTimeout(command, budget.toolTimeoutMs);
		}
		return undefined;
	});
}
