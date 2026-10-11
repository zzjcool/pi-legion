/** M2 legion tools and the host-side mailbox/maintenance loop. */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LegionSettings } from "../shared/types.ts";
import { extractVerdict, parseSessionFile } from "../shared/session.ts";
import type { LegionSupervisor } from "../supervisor/types.ts";
import type { DatabaseSync } from "../legion/db.ts";
import { appendEvent } from "../legion/events.ts";
import {
	MAIL_BODY_HARD_LIMIT_BYTES,
	MAIL_BODY_SOFT_LIMIT_BYTES,
	MAIL_DELIVERY,
	pendingInbox,
	sendMail,
	transitionDelivery,
} from "../legion/mail.ts";
import {
	getChildren,
	getNode,
	getSubtree,
	heartbeatNode,
	listStaleNodes,
	updateNode,
	type LegionNode,
} from "../legion/nodes.ts";
import {
	checkPhaseTimeout,
	evaluatePhaseTransition,
	isTerminalPhase,
	type LegionPhase,
} from "../legion/state-machine.ts";
import { upsertUsage } from "../legion/usage.ts";
import type { LegionEventBus } from "./event-bus.ts";

const POSTMAN_INTERVAL_MS = 2_000;
const ORPHAN_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_ORPHAN_STALE_MS = 90_000;
const SUBJECT_LIMIT_BYTES = 256;
const PHASES = ["planning", "implementing", "reviewing", "verifying", "done", "failed", "aborted"] as const;
const MAIL_KINDS = ["question", "report", "handoff", "notice"] as const;
const MAIL_URGENCIES = ["info", "action-needed"] as const;
const TREE_SCOPES = ["children", "squad", "subtree", "tree"] as const;

export interface LegionMailCommand {
	name: string;
	text: string;
}

export interface LegionPostmanOptions {
	db: DatabaseSync;
	nodeId: string;
	supervisor: LegionSupervisor;
	settings?: LegionSettings;
	eventBus?: Pick<LegionEventBus, "emit">;
	sendRootMessage?: (text: string) => void;
	resumeChild?: (node: LegionNode, mail: LegionMailCommand) => Promise<void>;
	now?: () => number;
	intervalMs?: number;
}

/** A process-local supervisor's mail and health loop. */
export class LegionPostman {
	private readonly db: DatabaseSync;
	private readonly nodeId: string;
	private readonly supervisor: LegionSupervisor;
	private readonly settings: LegionSettings;
	private readonly eventBus?: Pick<LegionEventBus, "emit">;
	private readonly sendRootMessage: (text: string) => void;
	private readonly resumeChild?: LegionPostmanOptions["resumeChild"];
	private readonly now: () => number;
	private readonly intervalMs: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private ticking = false;
	private lastUsagePoll = Number.NEGATIVE_INFINITY;
	private lastOrphanScan = Number.NEGATIVE_INFINITY;

	constructor(options: LegionPostmanOptions) {
		this.db = options.db;
		this.nodeId = options.nodeId;
		this.supervisor = options.supervisor;
		this.settings = options.settings ?? {};
		this.eventBus = options.eventBus;
		this.sendRootMessage = options.sendRootMessage ?? (() => {});
		this.resumeChild = options.resumeChild;
		this.now = options.now ?? Date.now;
		this.intervalMs = options.intervalMs ?? POSTMAN_INTERVAL_MS;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.intervalMs);
		this.timer.unref?.();
		void this.tick().catch(() => {});
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const timestamp = this.now();
			const children = getChildren(this.db, this.nodeId);
			this.refreshHeartbeats(children);
			await this.deliverChildren(children);
			if (this.nodeId === "root") await this.deliverRootInbox();
			if (timestamp - this.lastUsagePoll >= (this.settings.usagePollMs ?? 30_000)) {
				this.lastUsagePoll = timestamp;
				await this.pollUsage(children);
			}
			if (this.nodeId === "root" && timestamp - this.lastOrphanScan >= ORPHAN_SCAN_INTERVAL_MS) {
				this.lastOrphanScan = timestamp;
				this.scanOrphans(timestamp);
			}
			this.checkOwnPhaseTimeout(timestamp);
		} finally {
			this.ticking = false;
		}
	}

	private refreshHeartbeats(children: readonly LegionNode[]): void {
		for (const child of children) {
			if (this.supervisor.isAlive(child.name)) heartbeatNode(this.db, child.id, this.now);
		}
	}

	private async deliverChildren(children: readonly LegionNode[]): Promise<void> {
		for (const child of children) {
			for (const message of pendingInbox(this.db, child.id)) await this.deliverToChild(child, message);
		}
	}

	private async deliverRootInbox(): Promise<void> {
		for (const message of pendingInbox(this.db, "root")) {
			try {
				this.sendRootMessage(formatMail(message));
				transitionDelivery(this.db, message.id, MAIL_DELIVERY.INJECTED, this.now);
				this.emitLatestMailEvent(message.id, "root", "mail_delivered");
			} catch {
				// Keep pending; retry at least once rather than silently losing it.
			}
		}
	}

	private async deliverToChild(node: LegionNode, message: ReturnType<typeof pendingInbox>[number]): Promise<void> {
		const text = formatMail(message);
		try {
			if (isTerminalNode(node) || (node.status === "settled" && !this.supervisor.isAlive(node.name))) {
				transitionDelivery(this.db, message.id, MAIL_DELIVERY.BOUNCED, this.now);
				this.emitLatestMailEvent(message.id, node.id, "mail_bounced");
				return;
			}
			if (!this.supervisor.isAlive(node.name)) {
				if (!this.resumeChild) return;
				await this.resumeChild(node, { name: node.name, text });
			} else if (node.status === "running" || node.status === "starting" || node.status === "blocked") {
				if (message.urgency === "action-needed") {
					await this.supervisor.steer(node.name, text);
					this.emitProcess("node_steered", node.id, { name: node.name, messageId: message.id });
				} else {
					await this.supervisor.followUp(node.name, text);
				}
			} else {
				await this.supervisor.prompt(node.name, text);
			}
			transitionDelivery(this.db, message.id, MAIL_DELIVERY.INJECTED, this.now);
			this.emitLatestMailEvent(message.id, node.id, "mail_delivered");
		} catch {
			// RPC failure leaves delivered=0 for retry on the next mailbox tick.
		}
	}

	private async pollUsage(children: readonly LegionNode[]): Promise<void> {
		for (const child of children) {
			if (child.status !== "running" || !this.supervisor.isAlive(child.name)) continue;
			const usage = await this.supervisor.stats(child.name).catch(() => null);
			if (!usage) continue;
			try {
				upsertUsage(this.db, { nodeId: child.id, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usage.costUsd }, this.now);
			} catch {
				// The node might have been rebuilt or retired during stats().
			}
		}
	}

	private emitLatestMailEvent(messageId: number, nodeId: string, type: "mail_delivered" | "mail_bounced"): void {
		if (!this.eventBus) return;
		const rows = this.db.prepare("SELECT id, node_id, type, data, ts FROM events WHERE node_id = ? AND type = ? ORDER BY id DESC LIMIT 20").all(nodeId, type);
		const row = rows.find((candidate) => typeof candidate.data === "string" && safeJson(candidate.data)?.messageId === messageId);
		if (row && typeof row.data === "string") this.eventBus.emit({ id: Number(row.id), nodeId: String(row.node_id), type, data: JSON.parse(row.data) as Record<string, unknown>, ts: Number(row.ts) });
	}

	private emitProcess(type: "node_steered" | "node_aborted" | "ui_request", nodeId: string, data: unknown): void {
		this.eventBus?.emit({ nodeId, type, data: data as Record<string, unknown> | null, ts: this.now() });
	}

	private scanOrphans(timestamp: number): void {
		const staleMs = this.settings.orphanStaleMs ?? DEFAULT_ORPHAN_STALE_MS;
		const staleNodes = listStaleNodes(this.db, timestamp - staleMs).filter((node) => !isTerminalNode(node)).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
		const reported = new Set<string>();
		for (const node of staleNodes) {
			if (this.hasOrphanAncestor(node, reported)) continue;
			const rootChild = this.rootChild(node);
			if (rootChild && this.supervisor.isAlive(rootChild.name)) continue;
			if (hasEvent(this.db, node.id, "orphan_detected")) continue;
			const event = appendEvent(this.db, node.id, "orphan_detected", { parentId: node.parentId, updatedAt: node.updatedAt, staleMs, noActiveSupervisor: true }, { now: () => timestamp });
			this.eventBus?.emit(event);
			reported.add(node.id);
			this.sendRootMessage(`Legion orphan detected: ${node.id} (${node.role}, status=${node.status}) has no active supervisor and no heartbeat for ${Math.max(0, timestamp - node.updatedAt)}ms. Resume requires CEO approval.`);
		}
	}

	private rootChild(node: LegionNode): LegionNode | null {
		const first = node.id.split(".")[1];
		return first ? getNode(this.db, `root.${first}`) : null;
	}

	private hasOrphanAncestor(node: LegionNode, reported: ReadonlySet<string>): boolean {
		let parentId = node.parentId;
		while (parentId) {
			if (reported.has(parentId) || hasEvent(this.db, parentId, "orphan_detected")) return true;
			parentId = getNode(this.db, parentId)?.parentId ?? null;
		}
		return false;
	}

	private checkOwnPhaseTimeout(timestamp: number): void {
		const node = getNode(this.db, this.nodeId);
		if (!node?.phase || !isPhase(node.phase) || isTerminalPhase(node.phase)) return;
		const timeout = checkPhaseTimeout({ phase: node.phase, phaseSince: node.phaseSince, now: timestamp, timeouts: this.settings.phaseTimeouts });
		if (!timeout.timedOut || hasPhaseTimeoutForSince(this.db, node.id, node.phaseSince)) return;
		const event = appendEvent(this.db, node.id, "phase_timeout", { phase: node.phase, phaseSince: node.phaseSince, elapsedMs: timeout.elapsedMs, timeoutMs: timeout.timeoutMs }, { now: () => timestamp });
		this.eventBus?.emit(event);
		const notice = `Legion phase timeout: ${node.id} has been in ${node.phase} for ${timeout.elapsedMs}ms (limit ${timeout.timeoutMs}ms). Work was not killed; decide whether to extend or abort.`;
		if (node.parentId) {
			const sent = sendMail(this.db, { fromNode: node.id, to: "parent", subject: `Phase timeout: ${node.name}`, body: notice, kind: "notice", urgency: "action-needed" }, { now: () => timestamp, ratePer5Min: this.settings.mailRatePer5Min });
			if (!sent.ok) this.sendRootMessage(notice);
		} else {
			this.sendRootMessage(notice);
		}
	}
}

export interface RegisterLegionToolsOptions {
	db: DatabaseSync;
	nodeId: string;
	role?: string;
	settings?: LegionSettings;
	eventBus?: Pick<LegionEventBus, "emit">;
	cwd?: string;
	sendSelfMessage?: (text: string) => void;
	now?: () => number;
	runCommand?: LegionCommandRunner;
}

export interface LegionCommandResult { code: number; stdout: string; stderr: string; timedOut?: boolean }
export type LegionCommandRunner = (command: string, cwd: string, timeoutMs: number) => Promise<LegionCommandResult>;

function emitStoredMailEvent(db: DatabaseSync, eventBus: Pick<LegionEventBus, "emit"> | undefined, nodeId: string, type: "mail_sent" | "mail_delivered" | "mail_bounced", messageId: number): void {
	if (!eventBus) return;
	const rows = db.prepare("SELECT id, node_id, type, data, ts FROM events WHERE node_id = ? AND type = ? ORDER BY id DESC LIMIT 20").all(nodeId, type);
	for (const row of rows) {
		if (typeof row.data !== "string" || safeJson(row.data)?.messageId !== messageId) continue;
		eventBus.emit({ id: Number(row.id), nodeId: String(row.node_id), type, data: safeJson(row.data) as Record<string, unknown>, ts: Number(row.ts) });
		return;
	}
}

function safeJson(value: string): Record<string, unknown> | null { try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; } }

export function registerLegionTools(pi: ExtensionAPI, options: RegisterLegionToolsOptions): void {
	const { db, nodeId } = options;
	const settings = options.settings ?? {};
	pi.registerTool({
		name: "legion_mail", label: "Legion mail",
		description: "Send asynchronous mail to your parent, direct children, or siblings in the legion tree.",
		parameters: Type.Object({
			to: Type.Union([Type.String(), Type.Array(Type.String())]),
			subject: Type.String(), body: Type.String(),
			kind: Type.Optional(Type.Union(MAIL_KINDS.map((v) => Type.Literal(v)))),
			urgency: Type.Optional(Type.Union(MAIL_URGENCIES.map((v) => Type.Literal(v)))),
		}),
		async execute(_id, params) {
			if (Buffer.byteLength(params.subject, "utf8") > SUBJECT_LIMIT_BYTES) return toolError(`subject exceeds ${SUBJECT_LIMIT_BYTES} byte limit`, "INVALID_PARAMS");
			const result = sendMail(db, { fromNode: nodeId, to: params.to, subject: params.subject, body: params.body, ...(params.kind ? { kind: params.kind } : {}), ...(params.urgency ? { urgency: params.urgency } : {}) }, { ratePer5Min: settings.mailRatePer5Min, now: options.now });
			if (!result.ok) return toolError(`${result.message}${result.routingHint ? `; routing: ${result.routingHint}` : ""}`, result.code.toUpperCase());
			for (const message of result.messages) emitStoredMailEvent(db, options.eventBus, nodeId, "mail_sent", message.id);
			return toolOk(`Queued ${result.messages.length} legion message(s) to ${result.recipients.join(", ")}; delivery is asynchronous.${result.warning ? ` Warning: ${result.warning} (soft ${MAIL_BODY_SOFT_LIMIT_BYTES} bytes, hard ${MAIL_BODY_HARD_LIMIT_BYTES} bytes).` : ""}`);
		},
	});

	pi.registerTool({
		name: "legion_tree", label: "Legion tree", description: "Read-only node facts from the legion ledger.",
		parameters: Type.Object({ scope: Type.Optional(Type.Union(TREE_SCOPES.map((v) => Type.Literal(v)))), depth: Type.Optional(Type.Integer({ minimum: 0 })) }),
		async execute(_id, params) {
			try { return toolOk(formatTree(readTree(db, nodeId, params.scope ?? "children", params.depth))); }
			catch (error) { return toolError(messageOf(error), "INVALID_PARAMS"); }
		},
	});

	const own = getNode(db, nodeId);
	if (options.role === "centurion" || own?.role === "centurion") {
		pi.registerTool({
			name: "legion_phase", label: "Legion phase",
			description: "Request a validated centurion phase transition. Verification and verifying-to-done are supervisor-controlled.",
			parameters: Type.Object({ to: Type.Union(PHASES.map((v) => Type.Literal(v))), note: Type.Optional(Type.String()), evidence: Type.Optional(Type.String()) }),
			async execute(_id, params) {
				const result = await requestLegionPhase(db, nodeId, params.to, { note: params.note, evidence: params.evidence, cwd: options.cwd ?? process.cwd(), settings, eventBus: options.eventBus, now: options.now, runCommand: options.runCommand, sendSelfMessage: options.sendSelfMessage });
				return result.ok ? toolOk(result.message) : toolError(result.message, result.code ?? "INVALID_PARAMS");
			},
		});
	}
}

export type TreeScope = (typeof TREE_SCOPES)[number];

export function readTree(db: DatabaseSync, nodeId: string, scope: TreeScope = "children", depth?: number): LegionNode[] {
	if (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 0)) throw new TypeError("depth must be a non-negative integer");
	const own = getNode(db, nodeId);
	if (!own) throw new Error(`legion node not found: ${nodeId}`);
	const maxDepth = depth ?? Number.MAX_SAFE_INTEGER;
	if (scope === "children") return getChildren(db, nodeId).filter((node) => node.depth <= own.depth + (depth ?? 1));
	if (scope === "subtree") return getSubtree(db, nodeId, { maxDepth });
	if (scope === "tree") return getSubtree(db, "root", { maxDepth });
	if (own.role === "centurion" || own.parentId === null) return [own, ...getSubtree(db, own.id, { maxDepth: depth ?? 1, includeRoot: false })];
	const parent = getNode(db, own.parentId!);
	return parent ? [parent, ...getChildren(db, parent.id)].filter((node) => node.depth <= own.depth + (depth ?? 0)) : [own];
}

export function formatTree(nodes: readonly LegionNode[]): string {
	if (!nodes.length) return "No legion nodes in scope.";
	return nodes.map((node) => [node.id, `role=${node.role}`, `status=${node.status}`, ...(node.phase ? [`phase=${node.phase}`] : []), ...(node.model ? [`model=${node.model}`] : []), `depth=${node.depth}`].join(" ")).join("\n");
}

export interface PhaseRequestOptions { note?: string; evidence?: string; cwd: string; settings?: LegionSettings; eventBus?: Pick<LegionEventBus, "emit">; now?: () => number; runCommand?: LegionCommandRunner; sendSelfMessage?: (text: string) => void }
export type PhaseRequestResult = { ok: true; phase: LegionPhase; message: string } | { ok: false; message: string; code?: string };

export async function requestLegionPhase(db: DatabaseSync, nodeId: string, to: LegionPhase, options: PhaseRequestOptions): Promise<PhaseRequestResult> {
	const now = options.now ?? Date.now;
	const centurion = getNode(db, nodeId);
	if (!centurion || centurion.role !== "centurion") return { ok: false, code: "INVALID_PARAMS", message: "legion_phase is available only to a centurion node" };
	if (to === "done") return { ok: false, code: "INVALID_PARAMS", message: "done is supervisor-controlled and cannot be requested directly" };
	const children = getChildren(db, nodeId);
	let contractPath: string | undefined;
	let contractText: string | undefined;
	if (centurion.phase === "planning" && to === "implementing") {
		contractPath = path.resolve(centurion.worktreePath ?? options.cwd, ".pi-legion", "contract.md");
		try { contractText = fs.readFileSync(contractPath, "utf8"); } catch { contractText = undefined; }
	}
	const reviewerVerdicts = children.filter((child) => child.role === "reviewer" && child.status === "settled" && child.sessionFile).map((child) => extractVerdict(parseSessionFile(child.sessionFile!).lastTurnOutput ?? "")).filter((v): v is { ok: boolean; reason?: string } => v !== null);
	const verificationPassed = centurion.phase === "verifying" ? readVerificationResult(db, centurion) : undefined;
	const decision = evaluatePhaseTransition({ from: isPhase(centurion.phase) ? centurion.phase : null, to, reworkCount: centurion.reworkCount, contractPath: contractText?.trim() ? contractPath : centurion.contractPath, children: children.map((child) => ({ id: child.id, role: child.role, status: child.status })), reviewerVerdictOk: reviewerVerdicts.some((v) => v.ok) ? true : reviewerVerdicts.some((v) => !v.ok) ? false : undefined, verificationPassed, actorRole: centurion.role, ...(to === "failed" ? { terminalReason: "parent_decision" as const } : {}) }, now);
	if (!decision.allowed) {
		if (decision.forcedTransition) {
			updateNode(db, nodeId, { phase: "failed", phaseSince: now(), reworkCount: decision.forcedTransition.reworkCount }, now);
			const event = appendEvent(db, nodeId, "phase_change", { from: decision.from, to: "failed", reworkCount: decision.forcedTransition.reworkCount, forced: true, reason: decision.forcedTransition.reason, message: decision.message }, { now });
			options.eventBus?.emit(event);
			await notifyParent(db, centurion, `Centurion ${centurion.id} failed: ${decision.message}`, options.settings, now);
			return { ok: false, code: "BUDGET_EXCEEDED", message: decision.message };
		}
		return { ok: false, code: "INVALID_PARAMS", message: `phase transition ${centurion.phase ?? "<unset>"} → ${to} refused: ${decision.message}` };
	}
	updateNode(db, nodeId, { phase: decision.to, phaseSince: decision.phaseSince, reworkCount: decision.reworkCount, ...(centurion.phase === "planning" && to === "implementing" ? { contractPath } : {}) }, now);
	const phaseEvent = appendEvent(db, nodeId, "phase_change", { ...decision.event.data, ...(options.note ? { note: options.note.slice(0, 2_000) } : {}), ...(options.evidence ? { evidence: options.evidence.slice(0, 2_000) } : {}) }, { now });
	options.eventBus?.emit(phaseEvent);
	if (decision.notifyParent) await notifyParent(db, centurion, `Centurion ${nodeId} returned to planning: ${options.note ?? "plan needs revision"}`, options.settings, now);
	if (to !== "verifying") return { ok: true, phase: decision.to, message: `Phase changed ${decision.from ?? "<new>"} → ${decision.to}.` };
	const verification = await runVerification(db, centurion, contractTextAt(centurion, contractPath, options.cwd), options);
	if (!verification.passed) {
		options.sendSelfMessage?.(`Legion verification failed. Read ${verification.outputFile}, fix the commands, then request implementing to consume a rework.`);
		return { ok: true, phase: "verifying", message: `Verification failed; output: ${verification.outputFile}` };
	}
	const current = getNode(db, nodeId)!;
	const done = evaluatePhaseTransition({ from: "verifying", to: "done", reworkCount: current.reworkCount, children: getChildren(db, nodeId).map((child) => ({ id: child.id, role: child.role, status: child.status })), verificationPassed: true, actorRole: "centurion" }, now);
	if (!done.allowed) return { ok: true, phase: "verifying", message: `Verification passed but DONE is waiting: ${done.message}` };
	updateNode(db, nodeId, { phase: "done", phaseSince: done.phaseSince }, now);
	const doneEvent = appendEvent(db, nodeId, "phase_change", done.event.data, { now });
	options.eventBus?.emit(doneEvent);
	options.sendSelfMessage?.("All legion-verify commands passed. Collect every child result, squash the subtree changes into one MR/PR, open it for the parent, and return the final verdict with its URL. Do not merge.");
	return { ok: true, phase: "done", message: `Verification passed (${verification.commandCount} command(s)); phase automatically advanced to done. ${verification.outputFile}` };
}

export interface LegionCommandResult { code: number; stdout: string; stderr: string; timedOut?: boolean }
export type LegionCommandRunner = (command: string, cwd: string, timeoutMs: number) => Promise<LegionCommandResult>;

export async function runVerification(db: DatabaseSync, node: LegionNode, contractText: string, options: Pick<PhaseRequestOptions, "cwd" | "settings" | "now" | "runCommand" | "eventBus">): Promise<{ passed: boolean; commandCount: number; outputFile: string; message: string }> {
	const commands = parseLegionVerifyCommands(contractText);
	const timeoutMs = options.settings?.verifyCommandTimeoutMs ?? 600_000;
	const cwd = node.worktreePath ?? options.cwd;
	const runDir = node.sessionFile ? path.dirname(node.sessionFile) : path.join(options.cwd, ".pi-subagents", "runs");
	fs.mkdirSync(runDir, { recursive: true });
	const outputFile = path.join(runDir, `${node.name}.legion-verify.log`);
	const output: string[] = [];
	let passed = true;
	for (const command of commands) {
		const result = await (options.runCommand ?? runLegionCommand)(command, cwd, timeoutMs);
		output.push([`$ ${command}`, `exit: ${result.code}${result.timedOut ? " (timeout)" : ""}`, result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n"));
		if (result.code !== 0) { passed = false; break; }
	}
	if (!commands.length) output.push("No legion-verify block; verification passes by contract.");
	fs.writeFileSync(outputFile, `${output.join("\n\n")}\n`, { mode: 0o600 });
	const timestamp = (options.now ?? Date.now)();
	updateNode(db, node.id, { taskSummary: JSON.stringify({ verificationPassed: passed, outputFile, commandCount: commands.length, checkedAt: timestamp }) }, options.now ?? Date.now);
	return { passed, commandCount: commands.length, outputFile, message: passed ? `all ${commands.length} verification command(s) passed` : "verification failed" };
}

export function parseLegionVerifyCommands(text: string): string[] {
	const commands: string[] = [];
	for (const match of text.matchAll(/```legion-verify\s*\n([\s\S]*?)```/g)) {
		for (const line of (match[1] ?? "").split("\n")) { const command = line.trim(); if (command && !command.startsWith("#")) commands.push(command); }
	}
	return commands;
}

export function runLegionCommand(command: string, cwd: string, timeoutMs: number): Promise<LegionCommandResult> {
	const limit = timeoutMs > 0 ? timeoutMs : 600_000;
	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const child = spawn("timeout", ["--signal=TERM", `${Math.max(1, Math.ceil(limit / 1_000))}s`, "bash", "-lc", command], { cwd, env: process.env });
		const finish = (code: number) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) }); };
		child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
		child.on("error", (error) => { stderr += String(error); finish(1); });
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); stderr += `\nverification timed out after ${limit}ms`; finish(1); }, limit + 1_000);
		child.on("close", (code) => finish(code ?? 1));
	});
}

function contractTextAt(node: LegionNode, contractPath: string | undefined, cwd: string): string {
	try { return fs.readFileSync(node.contractPath ?? contractPath ?? path.resolve(node.worktreePath ?? cwd, ".pi-legion", "contract.md"), "utf8"); }
	catch { return ""; }
}
function readVerificationResult(_db: DatabaseSync, node: LegionNode): boolean | undefined {
	if (node.phase !== "verifying" || !node.taskSummary) return undefined;
	try { const data = JSON.parse(node.taskSummary) as { verificationPassed?: unknown }; return typeof data.verificationPassed === "boolean" ? data.verificationPassed : undefined; }
	catch { return undefined; }
}
function isTerminalNode(node: LegionNode): boolean { return node.status === "failed" || ["done", "failed", "aborted"].includes(node.phase ?? ""); }
function isPhase(value: unknown): value is LegionPhase { return typeof value === "string" && (PHASES as readonly string[]).includes(value); }
function safeJson(value: string): Record<string, unknown> | null { try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; } }
function hasEvent(db: DatabaseSync, nodeId: string, type: string): boolean { return db.prepare("SELECT 1 AS found FROM events WHERE node_id = ? AND type = ? LIMIT 1").get(nodeId, type) !== undefined; }
function hasPhaseTimeoutForSince(db: DatabaseSync, nodeId: string, since: number | null): boolean {
	return db.prepare("SELECT data FROM events WHERE node_id = ? AND type = 'phase_timeout'").all(nodeId).some((row) => typeof row.data === "string" && safeJson(row.data)?.phaseSince === since);
}
async function notifyParent(db: DatabaseSync, node: LegionNode, text: string, settings: LegionSettings | undefined, now: () => number): Promise<void> {
	if (!node.parentId) return;
	const result = sendMail(db, { fromNode: node.id, to: "parent", subject: `Legion update: ${node.name}`, body: text, kind: "notice", urgency: "action-needed" }, { now, ratePer5Min: settings?.mailRatePer5Min });
	if (!result.ok) appendEvent(db, node.id, "phase_timeout", { mailFailure: result.message, notice: text }, { now });
}
function formatMail(message: ReturnType<typeof pendingInbox>[number]): string {
	return [`[legion mail #${message.id}]`, `From: ${message.fromNode}`, `Subject: ${message.subject}`, `Urgency: ${message.urgency}`, "", message.body].join("\n");
}
function toolOk(text: string): AgentToolResult<unknown> { return { content: [{ type: "text", text }], details: {} }; }
function toolError(text: string, code: string): AgentToolResult<unknown> { return { content: [{ type: "text", text }], details: { error: code } }; }
