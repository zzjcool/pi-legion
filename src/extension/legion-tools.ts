/** Legion mail/tree/phase tools and the host-side postman loop. */

import { spawn } from "node:child_process";
import { createCappedOutput, resolveMaxOutputBytes } from "../shared/output-cap.ts";
import { acquireVerifySlot, queueNote, resolveVerifyQueueConfig } from "../runs/verify-queue.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LegionSettings } from "../shared/types.ts";
import { extractVerdict, parseSessionFile } from "../shared/session.ts";
import type { LegionSupervisor } from "../supervisor/types.ts";
import { sqliteHasRow, withTransaction, type DatabaseSync } from "../legion/db.ts";
import type { LegionEventBus } from "./event-bus.ts";
import { appendEvent } from "../legion/events.ts";
import {
	MAIL_BODY_HARD_LIMIT_BYTES,
	MAIL_BODY_SOFT_LIMIT_BYTES,
	MAIL_DELIVERY,
	pendingInbox,
	sendMail,
	transitionDelivery,
	type LegionMessage,
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

const POSTMAN_INTERVAL_MS = 2_000;
const ORPHAN_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_ORPHAN_STALE_MS = 90_000;
const ORPHAN_REPORT_WINDOW_MS = 10 * 60_000;
const PHASES = ["planning", "implementing", "reviewing", "verifying", "done", "failed", "aborted"] as const;
const MAIL_KINDS = ["question", "report", "handoff", "notice"] as const;
const MAIL_URGENCIES = ["info", "action-needed"] as const;
const TREE_SCOPES = ["children", "squad", "subtree", "tree"] as const;
const TASK_SUMMARY_METADATA_KEY = "__piLegion";

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
	sendSelfMessage?: (text: string) => void;
	resumeChild?: (node: LegionNode, mail: LegionMailCommand) => Promise<void>;
	now?: () => number;
	intervalMs?: number;
}

/** Poll and deliver mail only for children hosted by this process. */
export class LegionPostman {
	private readonly db: DatabaseSync;
	private readonly nodeId: string;
	private readonly supervisor: LegionSupervisor;
	private readonly settings: LegionSettings;
	private readonly eventBus?: Pick<LegionEventBus, "emit">;
	private readonly sendRootMessage: (text: string) => void;
	private readonly sendSelfMessage: (text: string) => void;
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
		this.sendSelfMessage = options.sendSelfMessage ?? (() => {});
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
			this.finalizeVerifiedTeamIfReady(timestamp);
			this.failTeamIfAllChildrenFailed(timestamp);
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
		const alive = children.filter((child) => this.supervisor.isAlive(child.name));
		if (alive.length === 0) return;
		// One transaction for the whole tick: avoids per-child implicit
		// autocommit fsync under PRAGMA synchronous=FULL (#236 P1).
		withTransaction(this.db, () => {
			for (const child of alive) heartbeatNode(this.db, child.id, this.now);
		});
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
				this.emitMail(message.id, message.fromNode, "mail_delivered");
			} catch {
				// Leave pending for a later tick instead of silently losing mail.
			}
		}
	}

	private async deliverToChild(node: LegionNode, message: LegionMessage): Promise<void> {
		const current = getNode(this.db, node.id) ?? node;
		const text = formatMail(message);
		const wasAlive = this.supervisor.isAlive(current.name);
		try {
			if (isTerminalNode(current)) {
				transitionDelivery(this.db, message.id, MAIL_DELIVERY.BOUNCED, this.now);
				this.emitMail(message.id, message.fromNode, "mail_bounced");
				return;
			}
			if (!wasAlive) {
				if (!this.resumeChild) return;
				await this.resumeChild(current, { name: current.name, text });
			} else if (current.status === "running" || current.status === "starting" || current.status === "blocked") {
				if (message.urgency === "action-needed") {
					await this.supervisor.steer(current.name, text);
					this.emitProcess("node_steered", current.id, { name: current.name, messageId: message.id });
				} else {
					await this.supervisor.followUp(current.name, text);
				}
			} else {
				await this.supervisor.prompt(current.name, text);
			}
			if (wasAlive && message.urgency === "action-needed" && current.status === "blocked") updateNode(this.db, current.id, { status: "running" }, this.now);
			transitionDelivery(this.db, message.id, MAIL_DELIVERY.INJECTED, this.now);
			this.emitMail(message.id, message.fromNode, "mail_delivered");
		} catch {
			// RPC failures leave delivered=0 so the next mailbox tick can retry.
		}
	}

	private async pollUsage(children: readonly LegionNode[]): Promise<void> {
		for (const child of children) {
			if (child.status !== "running" || !this.supervisor.isAlive(child.name)) continue;
			const usage = await this.supervisor.stats(child.name).catch(() => null);
			if (!usage) continue;
			try {
				upsertUsage(this.db, {
					nodeId: child.id,
					tokensIn: usage.tokensIn,
					tokensOut: usage.tokensOut,
					costUsd: usage.costUsd,
				}, this.now);
			} catch {
				// The node may be rebuilt or retired while stats() is pending.
			}
		}
	}

	private emitMail(messageId: number, nodeId: string, type: "mail_sent" | "mail_delivered" | "mail_bounced"): void {
		if (!this.eventBus) return;
		const rows = this.db
			.prepare("SELECT id, node_id, type, data, ts FROM events WHERE node_id = ? AND type = ? ORDER BY id DESC LIMIT 100")
			.all(nodeId, type);
		for (const row of rows) {
			if (typeof row.data !== "string" || safeJson(row.data)?.messageId !== messageId) continue;
			this.eventBus.emit({
				id: Number(row.id),
				nodeId: String(row.node_id),
				type,
				data: safeJson(row.data),
				ts: Number(row.ts),
			});
			return;
		}
	}

	private emitProcess(type: "node_steered" | "node_aborted" | "ui_request", nodeId: string, data: unknown): void {
		this.eventBus?.emit({ nodeId, type, data: data as Record<string, unknown> | null, ts: this.now() });
	}

	private scanOrphans(timestamp: number): void {
		const staleMs = this.settings.orphanStaleMs ?? DEFAULT_ORPHAN_STALE_MS;
		const nodes = listStaleNodes(this.db, timestamp - staleMs)
			.filter((node) => !isTerminalNode(node) && (node.status === "starting" || node.status === "running" || node.status === "blocked"))
			.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
		const reported = new Set<string>();
		for (const node of nodes) {
			if (node.id === "root" || this.hasOrphanAncestor(node, reported)) continue;
			// Direct children have an explicit process check; nested children are
			// considered inactive when their hosting parent's heartbeat is stale.
			const firstRootChild = this.firstRootChild(node);
			if (firstRootChild && this.supervisor.isAlive(firstRootChild.name)) continue;
			if (wasOrphanReportedRecently(this.db, node.id, timestamp - ORPHAN_REPORT_WINDOW_MS)) continue;
			const event = appendEvent(this.db, node.id, "orphan_detected", {
				parentId: node.parentId,
				updatedAt: node.updatedAt,
				staleMs,
				noActiveSupervisor: true,
			}, { now: () => timestamp });
			this.eventBus?.emit(event);
			reported.add(node.id);
			this.sendRootMessage(
				// The notice can be delivered long after detection: it is queued through
				// `subagent-notify` and the outbox flushes at `MAX_PENDING_AGE_MS` or at
				// `agent_settled`. A stale `staleMs` alone therefore reads as "detected
				// just now" when the value can be tens of minutes old, which makes a
				// replayed notice look like a fresh detection. Stamp the detection time
				// so a late delivery is self-evident.
				`Legion orphan detected at ${new Date(timestamp).toISOString()}: ${node.id} (${node.role}, status=${node.status}) has no active supervisor and no heartbeat for ${Math.max(0, timestamp - node.updatedAt)}ms. Resume requires CEO approval.`,
			);
		}
	}

	private firstRootChild(node: LegionNode): LegionNode | null {
		const firstChildName = node.id.split(".")[1];
		return firstChildName ? getNode(this.db, `root.${firstChildName}`) : null;
	}

	private hasOrphanAncestor(node: LegionNode, reported: ReadonlySet<string>): boolean {
		let parentId = node.parentId;
		while (parentId) {
			if (reported.has(parentId) || hasEvent(this.db, parentId, "orphan_detected")) return true;
			parentId = getNode(this.db, parentId)?.parentId ?? null;
		}
		return false;
	}

	private failTeamIfAllChildrenFailed(timestamp: number): void {
		const node = getNode(this.db, this.nodeId);
		if (!node?.phase || !isPhase(node.phase) || isTerminalPhase(node.phase)) return;
		const children = getChildren(this.db, node.id);
		if (!children.length || children.some((child) => child.status !== "failed")) return;
		const decision = evaluatePhaseTransition({
			from: node.phase,
			to: "failed",
			reworkCount: node.reworkCount,
			children: children.map(({ id, role, status }) => ({ id, role, status })),
			terminalReason: "all_children_failed",
			actorRole: "supervisor",
		}, () => timestamp);
		if (!decision.allowed) return;
		updateNode(this.db, node.id, { phase: "failed", phaseSince: decision.phaseSince }, () => timestamp);
		this.eventBus?.emit(appendEvent(this.db, node.id, "phase_change", decision.event.data, { now: () => timestamp }));
		const failureNotice = `Legion team ${node.id} failed because all direct children failed.`;
		this.sendSelfMessage(failureNotice);
		if (node.parentId) {
			const mail = sendMail(this.db, { fromNode: node.id, to: "parent", subject: `Team failed: ${node.name}`, body: failureNotice, kind: "notice", urgency: "action-needed" }, { now: () => timestamp, ratePer5Min: this.settings.mailRatePer5Min });
			if (mail.ok) for (const message of mail.messages) this.emitMail(message.id, node.id, "mail_sent");
		} else this.sendRootMessage(failureNotice);
	}

	private finalizeVerifiedTeamIfReady(timestamp: number): void {
		const node = getNode(this.db, this.nodeId);
		if (!node || node.phase !== "verifying" || verificationPassed(node) !== true) return;
		const children = getChildren(this.db, node.id);
		if (children.some((child) => !isPhaseTerminalChild(child.status))) return;
		const decision = evaluatePhaseTransition({
			from: "verifying",
			to: "done",
			reworkCount: node.reworkCount,
			children: children.map(({ id, role, status }) => ({ id, role, status })),
			verificationPassed: true,
			actorRole: "supervisor",
		}, () => timestamp);
		if (!decision.allowed) return;
		updateNode(this.db, node.id, { phase: "done", phaseSince: decision.phaseSince }, () => timestamp);
		this.eventBus?.emit(appendEvent(this.db, node.id, "phase_change", decision.event.data, { now: () => timestamp }));
		this.sendSelfMessage("All contract verification passed. Collect every child result, squash the subtree work, open an MR/PR for your parent, and report the URL. Do not merge.");
	}

	private checkOwnPhaseTimeout(timestamp: number): void {
		const node = getNode(this.db, this.nodeId);
		if (!node?.phase || !isPhase(node.phase) || isTerminalPhase(node.phase)) return;
		const timeout = checkPhaseTimeout({
			phase: node.phase,
			phaseSince: node.phaseSince,
			now: timestamp,
			timeouts: this.settings.phaseTimeouts,
		});
		if (!timeout.timedOut || hasPhaseTimeoutForSince(this.db, node.id, node.phaseSince)) return;
		const event = appendEvent(this.db, node.id, "phase_timeout", {
			phase: node.phase,
			phaseSince: node.phaseSince,
			elapsedMs: timeout.elapsedMs,
			timeoutMs: timeout.timeoutMs,
		}, { now: () => timestamp });
		this.eventBus?.emit(event);
		const notice = `Legion phase timeout: ${node.id} has been in ${node.phase} for ${timeout.elapsedMs}ms (limit ${timeout.timeoutMs}ms). Work was not killed; decide whether to extend or abort.`;
		if (!node.parentId) {
			this.sendRootMessage(notice);
			return;
		}
		const result = sendMail(this.db, {
			fromNode: node.id,
			to: "parent",
			subject: `Phase timeout: ${node.name}`,
			body: notice,
			kind: "notice",
			urgency: "action-needed",
		}, { now: () => timestamp, ratePer5Min: this.settings.mailRatePer5Min });
		if (result.ok) for (const message of result.messages) this.emitMail(message.id, node.id, "mail_sent");
		else this.sendRootMessage(notice);
	}
}

export interface RegisterLegionToolsOptions {
	db: DatabaseSync;
	nodeId: string;
	role?: string;
	settings?: LegionSettings;
	eventBus?: Pick<LegionEventBus, "emit">;
	cwd?: string;
	runDir?: string;
	sendSelfMessage?: (text: string) => void;
	now?: () => number;
	runCommand?: LegionCommandRunner;
}

export interface LegionCommandResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
}
export type LegionCommandRunner = (command: string, cwd: string, timeoutMs: number) => Promise<LegionCommandResult>;

function safeJson(value: string): Record<string, unknown> | null {
	try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
}

function emitStoredMailEvent(
	db: DatabaseSync,
	bus: Pick<LegionEventBus, "emit"> | undefined,
	nodeId: string,
	type: "mail_sent" | "mail_delivered" | "mail_bounced",
	messageId: number,
): void {
	if (!bus) return;
	const rows = db.prepare("SELECT id, node_id, type, data, ts FROM events WHERE node_id = ? AND type = ? ORDER BY id DESC LIMIT 100").all(nodeId, type);
	for (const row of rows) {
		if (typeof row.data !== "string" || safeJson(row.data)?.messageId !== messageId) continue;
		bus.emit({ id: Number(row.id), nodeId: String(row.node_id), type, data: safeJson(row.data), ts: Number(row.ts) });
		return;
	}
}

export function registerLegionTools(pi: ExtensionAPI, options: RegisterLegionToolsOptions): void {
	const { db, nodeId } = options;
	const settings = options.settings ?? {};
	pi.registerTool({
		name: "legion_mail",
		label: "Legion mail",
		description: "Send asynchronous mail to a permitted node in the legion tree.",
		parameters: Type.Object({
			to: Type.Union([Type.String(), Type.Array(Type.String())]),
			subject: Type.String(),
			body: Type.String(),
			kind: Type.Optional(Type.Union(MAIL_KINDS.map((value) => Type.Literal(value)))),
			urgency: Type.Optional(Type.Union(MAIL_URGENCIES.map((value) => Type.Literal(value)))),
		}),
		async execute(_id, params) {
			const result = sendMail(db, {
				fromNode: nodeId,
				to: params.to,
				subject: params.subject,
				body: params.body,
				...(params.kind ? { kind: params.kind } : {}),
				...(params.urgency ? { urgency: params.urgency } : {}),
			}, { ratePer5Min: settings.mailRatePer5Min, now: options.now });
			if (!result.ok) return toolError(`${result.message}${result.routingHint ? `; routing: ${result.routingHint}` : ""}`, result.code.toUpperCase());
			for (const message of result.messages) emitStoredMailEvent(db, options.eventBus, nodeId, "mail_sent", message.id);
			return toolOk(
				`Queued ${result.messages.length} legion mail message(s) to ${result.recipients.join(", ")}; delivery is asynchronous.${result.warning ? ` Warning: ${result.warning} (soft ${MAIL_BODY_SOFT_LIMIT_BYTES} bytes, hard ${MAIL_BODY_HARD_LIMIT_BYTES} bytes).` : ""}`,
			);
		},
	});
	pi.registerTool({
		name: "legion_tree",
		label: "Legion tree",
		description: "Read-only node facts from legion.db.",
		parameters: Type.Object({
			scope: Type.Optional(Type.Union(TREE_SCOPES.map((value) => Type.Literal(value)))),
			depth: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		async execute(_id, params) {
			try {
				return toolOk(formatTree(readTree(db, nodeId, params.scope ?? "children", params.depth)));
			} catch (error) {
				return toolError(messageOf(error), "INVALID_PARAMS");
			}
		},
	});

	const self = getNode(db, nodeId);
	if (options.role === "centurion" || self?.role === "centurion") {
		pi.registerTool({
			name: "legion_phase",
			label: "Legion phase",
			description: "Request a validated centurion phase transition.",
			parameters: Type.Object({
				to: Type.Union(PHASES.map((value) => Type.Literal(value))),
				note: Type.Optional(Type.String()),
				evidence: Type.Optional(Type.String()),
			}),
			async execute(_id, params) {
				const result = await requestLegionPhase(db, nodeId, params.to, {
					note: params.note,
					evidence: params.evidence,
					cwd: options.cwd ?? process.cwd(),
					runDir: options.runDir,
					settings,
					eventBus: options.eventBus,
					now: options.now,
					runCommand: options.runCommand,
					sendSelfMessage: options.sendSelfMessage,
				});
				return result.ok ? toolOk(result.message) : toolError(result.message, result.code ?? "INVALID_PARAMS");
			},
		});
	}
}

export type TreeScope = (typeof TREE_SCOPES)[number];

export function readTree(db: DatabaseSync, nodeId: string, scope: TreeScope = "children", depth?: number): LegionNode[] {
	if (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 0)) throw new TypeError("depth must be a non-negative integer");
	const self = getNode(db, nodeId);
	if (!self) throw new Error(`legion node not found: ${nodeId}`);
	if (scope === "children") {
		return getSubtree(db, nodeId, { maxDepth: depth ?? 1, includeRoot: false });
	}
	if (scope === "subtree") return getSubtree(db, nodeId, { maxDepth: depth });
	if (scope === "tree") return getSubtree(db, "root", { maxDepth: depth });
	if (self.role === "centurion" || self.parentId === null) {
		return [self, ...getSubtree(db, self.id, { maxDepth: depth ?? 1, includeRoot: false })];
	}
	const parent = getNode(db, self.parentId);
	return parent ? [parent, ...getChildren(db, parent.id)] : [self];
}

export function formatTree(nodes: readonly LegionNode[]): string {
	if (!nodes.length) return "No legion nodes in scope.";
	return nodes.map((node) => [
		node.id,
		`role=${node.role}`,
		`status=${node.status}`,
		...(node.phase ? [`phase=${node.phase}`] : []),
		...(node.model ? [`model=${node.model}`] : []),
		`depth=${node.depth}`,
	].join(" ")).join("\n");
}

export interface PhaseRequestOptions {
	note?: string;
	evidence?: string;
	cwd: string;
	runDir?: string;
	settings?: LegionSettings;
	eventBus?: Pick<LegionEventBus, "emit">;
	now?: () => number;
	runCommand?: LegionCommandRunner;
	sendSelfMessage?: (text: string) => void;
}

export type PhaseRequestResult =
	| { ok: true; phase: LegionPhase; message: string }
	| { ok: false; message: string; code?: string };

export async function requestLegionPhase(
	db: DatabaseSync,
	nodeId: string,
	to: LegionPhase,
	options: PhaseRequestOptions,
): Promise<PhaseRequestResult> {
	const now = options.now ?? Date.now;
	const self = getNode(db, nodeId);
	if (!self || self.role !== "centurion") return { ok: false, code: "INVALID_PARAMS", message: "legion_phase is centurion-only" };
	if (to === "done" || to === "failed" || to === "aborted") {
		return { ok: false, code: "INVALID_PARAMS", message: `${to} is controlled by the parent or supervisor` };
	}

	const children = getChildren(db, nodeId);
	const proposedContractPath = path.resolve(self.worktreePath ?? options.cwd, ".pi-legion", "contract.md");
	let contractText: string | undefined;
	if (self.phase === "planning" && to === "implementing") {
		try { contractText = fs.readFileSync(proposedContractPath, "utf8"); } catch { contractText = undefined; }
	}
	const latestReviewer = children
		.filter((child) => child.role === "reviewer" && child.status === "settled" && child.sessionFile)
		.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
		.at(-1);
	const reviewerVerdict = latestReviewer?.sessionFile
		? extractVerdict(parseSessionFile(latestReviewer.sessionFile).lastTurnOutput ?? "")
		: null;
	const reviewerVerdictOk = reviewerVerdict?.ok;
	const failedWorkerHandledIds = self.phase === "implementing" && self.reworkCount > 0 && self.phaseSince !== null
		? children.filter((child) => child.role === "worker" && child.status === "failed" && child.updatedAt < self.phaseSince!).map((child) => child.id)
		: [];
	const decision = evaluatePhaseTransition({
		from: isPhase(self.phase) ? self.phase : null,
		to,
		reworkCount: self.reworkCount,
		contractPath: contractText?.trim() ? proposedContractPath : self.contractPath,
		children: children.map(({ id, role, status }) => ({ id, role, status })),
		failedWorkerHandledIds,
		reviewerVerdictOk,
		verificationPassed: readVerificationResult(self),
		actorRole: self.role,
	}, now);

	if (!decision.allowed) {
		if (decision.forcedTransition) {
			updateNode(db, nodeId, { phase: "failed", phaseSince: now(), reworkCount: decision.forcedTransition.reworkCount }, now);
			const forcedEvent = appendEvent(db, nodeId, "phase_change", {
				from: decision.from,
				to: "failed",
				reworkCount: decision.forcedTransition.reworkCount,
				forced: true,
				reason: decision.forcedTransition.reason,
			}, { now });
			options.eventBus?.emit(forcedEvent);
			await notifyParent(db, self, decision.message, options.settings, now, options.eventBus);
			return { ok: false, code: "BUDGET_EXCEEDED", message: decision.message };
		}
		return { ok: false, code: "INVALID_PARAMS", message: `phase transition ${self.phase ?? "<unset>"} → ${to} refused: ${decision.message}` };
	}

	updateNode(db, nodeId, {
		phase: decision.to,
		phaseSince: decision.phaseSince,
		reworkCount: decision.reworkCount,
		...(self.phase === "planning" && to === "implementing" ? { contractPath: proposedContractPath } : {}),
	}, now);
	const phaseEvent = appendEvent(db, nodeId, "phase_change", {
		...decision.event.data,
		...(options.note ? { note: options.note.slice(0, 2_000) } : {}),
		...(options.evidence ? { evidence: options.evidence.slice(0, 2_000) } : {}),
	}, { now });
	options.eventBus?.emit(phaseEvent);
	if (decision.notifyParent) await notifyParent(db, self, options.note ?? "centurion returned to planning", options.settings, now, options.eventBus);
	if (to !== "verifying") return { ok: true, phase: decision.to, message: `Phase changed to ${decision.to}.` };

	const current = getNode(db, nodeId) ?? self;
	const contract = readContract(current, proposedContractPath);
	const verification = await runVerification(db, current, contract, options);
	if (!verification.passed) {
		options.sendSelfMessage?.(`Verification failed. Read ${verification.outputFile} and fix the commands, then request implementing.`);
		return { ok: true, phase: "verifying", message: `Verification failed: ${verification.outputFile}` };
	}
	const done = evaluatePhaseTransition({
		from: "verifying",
		to: "done",
		reworkCount: getNode(db, nodeId)?.reworkCount ?? current.reworkCount,
		children: getChildren(db, nodeId).map(({ id, role, status }) => ({ id, role, status })),
		verificationPassed: true,
		actorRole: "supervisor",
	}, now);
	if (!done.allowed) return { ok: true, phase: "verifying", message: `Verification passed; waiting for team to settle: ${done.message}` };
	updateNode(db, nodeId, { phase: "done", phaseSince: done.phaseSince }, now);
	options.eventBus?.emit(appendEvent(db, nodeId, "phase_change", done.event.data, { now }));
	options.sendSelfMessage?.("All verification passed. Collect every child result, squash the subtree work, open an MR/PR for the parent, and report its URL. Do not merge.");
	return { ok: true, phase: "done", message: `Verification passed (${verification.commandCount} command(s)); phase automatically advanced to done.` };
}

interface VerificationResult {
	passed: boolean;
	outputFile: string;
	commandCount: number;
	checkedAt: number;
}

interface TaskSummaryMetadata {
	version: 1;
	taskSummary: string | null;
	verification?: VerificationResult;
}

function taskMetadata(raw: string | null): TaskSummaryMetadata {
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const value = parsed[TASK_SUMMARY_METADATA_KEY];
			if (value && typeof value === "object") {
				const metadata = value as Record<string, unknown>;
				if (metadata.version === 1) {
					let verification: VerificationResult | undefined;
					if (metadata.verification && typeof metadata.verification === "object") {
						const stored = metadata.verification as Record<string, unknown>;
						if (typeof stored.passed === "boolean" && typeof stored.outputFile === "string" && typeof stored.commandCount === "number" && typeof stored.checkedAt === "number") {
							verification = { passed: stored.passed, outputFile: stored.outputFile, commandCount: stored.commandCount, checkedAt: stored.checkedAt };
						}
					}
					return { version: 1, taskSummary: typeof metadata.taskSummary === "string" || metadata.taskSummary === null ? metadata.taskSummary : null, ...(verification ? { verification } : {}) };
				}
			}
		} catch { /* a regular task summary is not metadata */ }
	}
	return { version: 1, taskSummary: raw };
}

function readVerificationResult(node: LegionNode): boolean | undefined {
	const result = taskMetadata(node.taskSummary).verification;
	return typeof result?.passed === "boolean" ? result.passed : undefined;
}

function writeVerificationResult(db: DatabaseSync, node: LegionNode, result: VerificationResult, now: () => number): void {
	const metadata = { ...taskMetadata(node.taskSummary), verification: result };
	updateNode(db, node.id, { taskSummary: JSON.stringify({ [TASK_SUMMARY_METADATA_KEY]: metadata }) }, now);
}

export function parseLegionVerifyCommands(text: string): string[] {
	const commands: string[] = [];
	for (const block of text.matchAll(/```legion-verify\s*\n([\s\S]*?)```/g)) {
		for (const raw of (block[1] ?? "").split("\n")) {
			const command = raw.trim();
			if (command && !command.startsWith("#")) commands.push(command);
		}
	}
	return commands;
}

export async function runVerification(
	db: DatabaseSync,
	node: LegionNode,
	contractText: string,
	options: Pick<PhaseRequestOptions, "cwd" | "runDir" | "settings" | "now" | "runCommand">,
): Promise<{ passed: boolean; commandCount: number; outputFile: string; message: string }> {
	const commands = parseLegionVerifyCommands(contractText);
	const timeoutMs = options.settings?.verifyCommandTimeoutMs ?? 600_000;
	const cwd = node.worktreePath ?? options.cwd;
	const runDir = options.runDir ?? (node.sessionFile ? path.dirname(node.sessionFile) : path.join(options.cwd, ".pi-subagents", "runs"));
	fs.mkdirSync(runDir, { recursive: true });
	const outputFile = path.join(runDir, `${node.name}.legion-verify.log`);
	const output: string[] = [];
	let passed = true;
	for (const command of commands) {
		const result = await (options.runCommand ?? runLegionCommand)(command, cwd, timeoutMs);
		output.push([
			`$ ${command}`,
			`exit: ${result.code}${result.timedOut ? " (timeout)" : ""}`,
			result.stdout.trimEnd(),
			result.stderr.trimEnd(),
		].filter(Boolean).join("\n"));
		if (result.code !== 0) {
			passed = false;
			break;
		}
	}
	if (!commands.length) output.push("No legion-verify block; verification passes by contract.");
	fs.writeFileSync(outputFile, `${output.join("\n\n")}\n`, { mode: 0o600 });
	const now = options.now ?? Date.now;
	const result = { passed, outputFile, commandCount: commands.length, checkedAt: now() };
	writeVerificationResult(db, node, result, now);
	return { passed, commandCount: commands.length, outputFile, message: passed ? "verification passed" : "verification failed" };
}

/** legion-verify command behind the tree-wide verify queue (wait not charged to timeout). */
export async function runLegionCommand(command: string, cwd: string, timeoutMs: number): Promise<LegionCommandResult> {
	const config = resolveVerifyQueueConfig();
	const slot = await acquireVerifySlot(command, config);
	try {
		const result = await runLegionCommandNow(command, cwd, timeoutMs);
		const note = queueNote(slot, config.limit);
		return note ? { ...result, stderr: `${note}${result.stderr}` } : result;
	} finally {
		slot.release();
	}
}

export function runLegionCommandNow(command: string, cwd: string, timeoutMs: number): Promise<LegionCommandResult> {
	const limit = timeoutMs > 0 ? timeoutMs : 600_000;
	return new Promise((resolve) => {
		let timedOut = false;
		let settled = false;
		const child = spawn("timeout", ["--signal=TERM", `${Math.max(1, Math.ceil(limit / 1_000))}s`, "bash", "-lc", command], { cwd, env: process.env });
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const overflowed = out.truncated || err.truncated;
			resolve({ code: overflowed ? 1 : code, stdout: out.text(), stderr: `${err.text()}${extraStderr}`, ...(timedOut ? { timedOut: true } : {}) });
		};
		let extraStderr = "";
		const cap = resolveMaxOutputBytes();
		const killOnOverflow = () => {
			// Destroy pipes so a grandchild writer dies of SIGPIPE, then settle now.
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.kill("SIGKILL");
			finish(1);
		};
		const out = createCappedOutput(cap, killOnOverflow);
		const err = createCappedOutput(cap, killOnOverflow);
		child.stdout?.on("data", (chunk) => out.push(chunk));
		child.stderr?.on("data", (chunk) => err.push(chunk));
		child.on("error", (error) => { extraStderr += String(error); finish(1); });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			extraStderr += `\nverification timed out after ${limit}ms`;
			finish(1);
		}, limit + 1_000);
		child.on("close", (code) => finish(code ?? 1));
	});
}

function readContract(node: LegionNode, fallbackPath: string): string {
	try { return fs.readFileSync(node.contractPath ?? fallbackPath, "utf8"); } catch { return ""; }
}

function verificationPassed(node: LegionNode): boolean | undefined {
	return readVerificationResult(node);
}

function isTerminalNode(node: LegionNode): boolean {
	return node.status === "failed" || ["done", "failed", "aborted"].includes(node.phase ?? "");
}

function isPhase(value: unknown): value is LegionPhase {
	return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

function hasEvent(db: DatabaseSync, nodeId: string, type: string): boolean {
	return sqliteHasRow(db.prepare("SELECT 1 FROM events WHERE node_id = ? AND type = ? LIMIT 1").get(nodeId, type));
}

function wasOrphanReportedRecently(db: DatabaseSync, nodeId: string, after: number): boolean {
	return sqliteHasRow(db.prepare("SELECT 1 FROM events WHERE node_id = ? AND type = 'orphan_detected' AND ts >= ? LIMIT 1").get(nodeId, after));
}

function isPhaseTerminalChild(status: string): boolean {
	return status === "settled" || status === "failed" || status === "retired";
}

function hasPhaseTimeoutForSince(db: DatabaseSync, nodeId: string, since: number | null): boolean {
	return db.prepare("SELECT data FROM events WHERE node_id = ? AND type = 'phase_timeout'").all(nodeId)
		.some((row) => typeof row.data === "string" && safeJson(row.data)?.phaseSince === since);
}

async function notifyParent(db: DatabaseSync, node: LegionNode, text: string, settings: LegionSettings | undefined, now: () => number, eventBus?: Pick<LegionEventBus, "emit">): Promise<void> {
	if (!node.parentId) return;
	// Phase/timeout events are already durable facts. If mail is rate-limited,
	// do not mislabel the failed notification as another phase timeout.
	const result = sendMail(db, {
		fromNode: node.id,
		to: "parent",
		subject: `Legion update: ${node.name}`,
		body: text,
		kind: "notice",
		urgency: "action-needed",
	}, { now, ratePer5Min: settings?.mailRatePer5Min });
	if (result.ok) for (const message of result.messages) emitStoredMailEvent(db, eventBus, node.id, "mail_sent", message.id);
}

function formatMail(message: LegionMessage): string {
	return [`[legion mail #${message.id}]`, `From: ${message.fromNode}`, `Subject: ${message.subject}`, `Urgency: ${message.urgency}`, "", message.body].join("\n");
}

function toolOk(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} };
}

function toolError(text: string, code: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: { error: code } };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
