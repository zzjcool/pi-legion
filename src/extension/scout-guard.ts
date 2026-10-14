/**
 * Main-session scout guard (issue #17).
 *
 * Counts consecutive read-like tool calls in the parent session. When the
 * streak reaches N with no subagent/vexillatio dispatch in between, inject
 * one follow-up reminder. The tool_call hook only updates state; the
 * reminder is scheduled so it cannot block the current tool call.
 *
 * Children carry PI_SUBAGENT_ROLE and must not run this logic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ScoutGuardSettings } from "../shared/types.ts";
import { CHILD_ROLE_ENV } from "./child-guard.ts";
import { sendSlashText } from "./slash.ts";

export const SCOUT_GUARD_NOTIFY_TYPE = "scout-guard-notify";
export const DEFAULT_SCOUT_GUARD_THRESHOLD = 8;
export const DEFAULT_SCOUT_GUARD_COOLDOWN_MS = 120_000;

export type ScoutToolKind = "read" | "write" | "dispatch" | "ignore";

export interface ScoutGuardState {
	streak: number;
	/** Epoch ms. Null means not cooling down. A past timestamp has expired. */
	cooldownUntil: number | null;
}

export interface ResolvedScoutGuardConfig {
	enabled: boolean;
	threshold: number;
	cooldownMs: number;
}

export interface ScoutGuardStep {
	state: ScoutGuardState;
	notify: boolean;
}

export interface ScoutGuardDeps {
	loadSettings?: (cwd: string) => { scoutGuard?: ScoutGuardSettings };
	now?: () => number;
	/**
	 * Defers the follow-up until after tool_call returns.
	 * Default is a zero-delay timer so the current tool call is not blocked.
	 */
	schedule?: (run: () => void) => void;
	env?: NodeJS.ProcessEnv;
}

const READ_HEADS = new Set([
	"cat", "head", "tail", "less", "rg", "grep", "find", "ls", "stat", "wc", "file", "jq",
]);

/** Mutating commands. A hit resets the streak and does not start cooldown. */
const WRITE_HEADS = new Set([
	"rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown",
	"ln", "install", "tee", "dd", "truncate",
]);

const GIT_READ = new Set(["show", "log", "diff", "status", "blame"]);
const GIT_WRITE = new Set([
	"add", "commit", "push", "checkout", "switch", "reset", "rebase", "merge",
	"stash", "tag", "cherry-pick", "clean", "restore", "mv", "rm", "pull",
]);

const FIND_WRITE = new Set([
	"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls",
]);

const PACKAGE_MANAGERS = new Set(["npm", "npx", "pnpm", "yarn", "bun"]);
const PACKAGE_WRITE = new Set([
	"install", "uninstall", "ci", "publish", "link", "add", "remove", "update", "i",
]);

const DISPATCH_TOOLS = new Set(["subagent", "vexillatio"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

export function initialScoutGuardState(): ScoutGuardState {
	return { streak: 0, cooldownUntil: null };
}

/** Exact reminder copy. N is the configured threshold. */
export function scoutGuardReminder(threshold: number): string {
	return `连续 ${threshold} 次文件类调用且未派发 subagent——若这是侦察工作，请停下来拆 scout（规则：侦察必须并行）。`;
}

export function resolveScoutGuardConfig(
	settings: ScoutGuardSettings | undefined,
	sessionEnabled: boolean | undefined,
): ResolvedScoutGuardConfig {
	return {
		enabled: sessionEnabled ?? settings?.enabled ?? true,
		threshold: settings?.threshold ?? DEFAULT_SCOUT_GUARD_THRESHOLD,
		cooldownMs: settings?.cooldownMs ?? DEFAULT_SCOUT_GUARD_COOLDOWN_MS,
	};
}

/**
 * Advance the streak. Dispatch clears it and ends cooldown. A write clears
 * it without entering cooldown. Reads increment only outside cooldown, and
 * the Nth read fires once then starts cooldown. Ambiguous calls do nothing.
 */
export function stepScoutGuard(
	state: ScoutGuardState,
	kind: ScoutToolKind,
	config: Pick<ResolvedScoutGuardConfig, "threshold" | "cooldownMs">,
	now: number,
): ScoutGuardStep {
	if (kind === "dispatch") {
		return { state: { streak: 0, cooldownUntil: null }, notify: false };
	}
	if (kind === "write") {
		return { state: { streak: 0, cooldownUntil: state.cooldownUntil }, notify: false };
	}
	const cooling = state.cooldownUntil !== null && now < state.cooldownUntil;
	if (cooling || kind !== "read") return { state, notify: false };
	const streak = state.streak + 1;
	if (streak >= config.threshold) {
		return {
			state: { streak: 0, cooldownUntil: now + config.cooldownMs },
			notify: true,
		};
	}
	return {
		state: { streak, cooldownUntil: state.cooldownUntil },
		notify: false,
	};
}

export function classifyScoutToolCall(toolName: string, input: unknown): ScoutToolKind {
	if (DISPATCH_TOOLS.has(toolName)) {
		return isDispatchCall(toolName, input) ? "dispatch" : "ignore";
	}
	if (toolName === "read") return "read";
	if (WRITE_TOOLS.has(toolName)) return "write";
	if (toolName !== "bash") return "ignore";
	const command = record(input)?.command;
	if (typeof command !== "string" || !command.trim()) return "ignore";
	return classifyBash(command);
}

/**
 * Read-only bash counts. Write-like bash (including `sed -i` and file
 * redirects) resets. Anything we cannot prove is one of those is ignored:
 * it neither increments nor clears the streak.
 */
export function classifyBash(command: string): "read" | "write" | "ignore" {
	if (!command.trim()) return "ignore";
	if (hasFilesystemWriteRedirect(command)) return "write";
	if (hasCommandSubstitution(command)) return "ignore";
	let sawRead = false;
	let sawIgnore = false;
	for (const segment of shellSegments(command)) {
		const kind = classifySegment(segment);
		if (kind === "write") return "write";
		if (kind === "ignore") sawIgnore = true;
		else sawRead = true;
	}
	if (sawIgnore || !sawRead) return "ignore";
	return "read";
}

function deferScoutReminder(run: () => void): void {
	const timer = setTimeout(run, 0);
	timer.unref?.();
}

/**
 * Register the guard on a parent extension. No-op when PI_SUBAGENT_ROLE is
 * set, so a child process cannot count or inject even if it is wired by mistake.
 */
export function registerScoutGuard(pi: ExtensionAPI, deps: ScoutGuardDeps = {}): void {
	const env = deps.env ?? process.env;
	if (env[CHILD_ROLE_ENV]) return;

	const now = deps.now ?? Date.now;
	const schedule = deps.schedule ?? deferScoutReminder;
	let sessionEnabled: boolean | undefined;
	let state = initialScoutGuardState();

	const readConfig = (cwd: string): ResolvedScoutGuardConfig => {
		try {
			return resolveScoutGuardConfig(deps.loadSettings?.(cwd)?.scoutGuard, sessionEnabled);
		} catch (error) {
			console.warn(
				"[pi-legion] scout guard settings unreadable; using defaults.",
				error,
			);
			return resolveScoutGuardConfig(undefined, sessionEnabled);
		}
	};

	pi.registerCommand("scout-guard", {
		description: "Enable the main-session scout guard for this session",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /scout-guard", "error");
				return;
			}
			sessionEnabled = true;
			sendSlashText(pi, "Scout guard is on for this session (settings unchanged).");
		},
	});
	pi.registerCommand("no-scout-guard", {
		description: "Disable the main-session scout guard for this session",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /no-scout-guard", "error");
				return;
			}
			sessionEnabled = false;
			sendSlashText(pi, "Scout guard is off for this session (settings unchanged).");
		},
	});

	pi.on("tool_call", (event, ctx) => {
		const config = readConfig(ctx?.cwd || process.cwd());
		// Disabled is a full bypass: do not count, reset, cool down, or notify.
		if (!config.enabled) return;
		const kind = classifyScoutToolCall(event.toolName, event.input);
		const next = stepScoutGuard(state, kind, config, now());
		state = next.state;
		if (!next.notify) return;
		const content = scoutGuardReminder(config.threshold);
		schedule(() => {
			try {
				pi.sendMessage(
					{ customType: SCOUT_GUARD_NOTIFY_TYPE, content, display: true },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} catch {
				// Parent session may already be gone.
			}
		});
	});
}

function isDispatchCall(toolName: string, input: unknown): boolean {
	// vexillatio only launches utility agents. subagent defaults to launch;
	// status/collect/wait/stop and the other control actions are not dispatches.
	// tool_call cannot see the tool result, so the launch call itself is the
	// dispatch signal — waiting would block this tool_call.
	if (toolName === "vexillatio") return true;
	const action = record(input)?.action;
	return action === undefined || action === "launch";
}

function record(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function classifySegment(segment: string): "read" | "write" | "ignore" {
	const parsed = commandHead(shellWords(segment));
	if (!parsed) return "ignore";
	const { head, args } = parsed;
	if (head === "git") return gitKind(args);
	if (head === "sed") return sedWrites(args) ? "write" : "read";
	if (head === "find") return findWrites(args) ? "write" : "read";
	if (PACKAGE_MANAGERS.has(head)) return packageKind(args);
	if (WRITE_HEADS.has(head)) return "write";
	if (READ_HEADS.has(head)) return "read";
	return "ignore";
}

function packageKind(args: string[]): "write" | "ignore" {
	const sub = args.find((arg) => !arg.startsWith("-"));
	if (sub && PACKAGE_WRITE.has(sub)) return "write";
	return "ignore";
}

function gitKind(args: string[]): "read" | "write" | "ignore" {
	let index = 0;
	while (index < args.length) {
		const arg = args[index] ?? "";
		if (arg === "--") {
			index += 1;
			break;
		}
		if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
			index += 2;
			continue;
		}
		if (
			arg.startsWith("--git-dir=")
			|| arg.startsWith("--work-tree=")
			|| arg.startsWith("--namespace=")
		) {
			index += 1;
			continue;
		}
		if (arg.startsWith("-")) {
			index += 1;
			continue;
		}
		break;
	}
	const sub = args[index];
	if (!sub) return "ignore";
	if (GIT_READ.has(sub)) return "read";
	if (GIT_WRITE.has(sub)) return "write";
	return "ignore";
}

function sedWrites(args: string[]): boolean {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--") break;
		if (arg === "--in-place" || arg.startsWith("--in-place=")) return true;
		if (arg === "-e" || arg === "-f" || arg === "--expression" || arg === "--file") {
			index += 1;
			continue;
		}
		if (arg.startsWith("--expression=") || arg.startsWith("--file=")) continue;
		if (arg.startsWith("--")) continue;
		if (arg.startsWith("-")) {
			const cluster = arg.slice(1);
			for (let flag = 0; flag < cluster.length; flag += 1) {
				const character = cluster[flag];
				if (character === "i") return true;
				// -e/-f consume the rest of the cluster as the script/file.
				if (character === "e" || character === "f") break;
			}
			continue;
		}
		break;
	}
	return false;
}

function findWrites(args: string[]): boolean {
	return args.some((arg) => FIND_WRITE.has(arg));
}

function commandHead(words: string[]): { head: string; args: string[] } | undefined {
	let index = 0;
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) {
		index += 1;
	}
	const raw = words[index];
	if (!raw) return undefined;
	const head = raw.split("/").pop()?.replace(/^\\/, "") || raw;
	return { head, args: words.slice(index + 1) };
}

function shellWords(segment: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	const flush = () => {
		if (word) words.push(word);
		word = "";
	};
	for (let index = 0; index < segment.length; index += 1) {
		const character = segment[index] ?? "";
		if (quote) {
			if (character === quote) quote = undefined;
			else word += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			flush();
			continue;
		}
		word += character;
	}
	flush();
	return words;
}

function shellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	const push = () => {
		const trimmed = current.trim();
		if (trimmed) segments.push(trimmed);
		current = "";
	};
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index] ?? "";
		if (character === "'" && !inDouble) {
			inSingle = !inSingle;
			current += character;
			continue;
		}
		if (character === '"' && !inSingle) {
			inDouble = !inDouble;
			current += character;
			continue;
		}
		if (!inSingle && !inDouble) {
			const next = command[index + 1] ?? "";
			if (character === "\n" || character === ";") {
				push();
				continue;
			}
			if ((character === "&" && next === "&") || (character === "|" && next === "|")) {
				push();
				index += 1;
				continue;
			}
			if (character === "|") {
				push();
				continue;
			}
			// Background `&`, but not `&>` (redirect) or `>&` (descriptor copy).
			if (character === "&" && next !== ">" && command[index - 1] !== ">") {
				push();
				continue;
			}
		}
		current += character;
	}
	push();
	return segments;
}

function hasCommandSubstitution(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index] ?? "";
		if (character === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (character === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle) continue;
		if (character === "`") return true;
		if (character === "$" && command[index + 1] === "(") return true;
		if ((character === "<" || character === ">") && command[index + 1] === "(") return true;
	}
	return false;
}

function redirectsToDevNull(command: string, destStart: number): boolean {
	const rest = command.slice(destStart).trimStart();
	return /^\/dev\/null(\s|$|[;&|<>])/.test(rest);
}

/** `>`, `>>`, `&>`, `&>>`, and `>|` onto a real file. `/dev/null` and `>&` fd copies are not writes. */
function hasFilesystemWriteRedirect(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index] ?? "";
		if (character === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (character === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble) continue;
		if (character === "&" && command[index + 1] === ">") {
			const width = command[index + 2] === ">" ? 3 : 2;
			if (redirectsToDevNull(command, index + width)) continue;
			return true;
		}
		if (character !== ">") continue;
		const previous = command[index - 1] ?? "";
		const next = command[index + 1] ?? "";
		// `=>`, `->`, `>=` are not redirects. `>&` duplicates a descriptor.
		if (previous === "=" || previous === "-" || previous === "!" || next === "=" || next === "&") {
			continue;
		}
		const destStart = index + (next === ">" || next === "|" ? 2 : 1);
		if (redirectsToDevNull(command, destStart)) continue;
		return true;
	}
	return false;
}
