/** Legion mail/tree/phase tools and the host-side postman loop. */

import { spawn } from "node:child_process";
import { createCappedOutput, resolveMaxOutputBytes } from "../shared/output-cap.ts";
import { commandSummary, survivingDescendants, sweepProcessTree } from "../shared/proc-sweep.ts";
import { acquireVerifySlot, queueNote, resolveVerifyQueueConfig } from "../runs/verify-queue.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LegionSettings, TurnRecord } from "../shared/types.ts";
import { extractVerdict, parseSessionFile } from "../shared/session.ts";
import type { LegionSupervisor } from "../supervisor/types.ts";
import { sqliteHasRow, withTransaction, type DatabaseSync } from "../legion/db.ts";
import type { LegionEventBus } from "./event-bus.ts";
import { appendEvent } from "../legion/events.ts";
import {
	MAIL_BODY_HARD_LIMIT_BYTES,
	MAIL_BODY_SOFT_LIMIT_BYTES,
	MAIL_BOUNCE_REASON,
	MAIL_DELIVERY,
	MailInvalidTextError,
	formatMail,
	inbox,
	isStalePhaseTimeoutNotice,
	mailReachedTurns,
	pendingInbox,
	sendMail,
	transitionDelivery,
	type LegionMessage,
	type SendMailInput,
	type SendMailOptions,
} from "../legion/mail.ts";
import {
	getChildren,
	getNode,
	getSubtree,
	heartbeatNode,
	isTerminalNode,
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
import {
	DEFAULT_PHASE_MACHINE,
	findPhase,
	isTerminalIn,
	machineTimeout,
	normalizePhaseMachine,
	type PhaseMachine,
} from "../legion/phase-machine.ts";
import { upsertUsage } from "../legion/usage.ts";
import { isExplicitPhaseTimeout } from "../agents/settings.ts";

const POSTMAN_INTERVAL_MS = 2_000;
/** Upper bound on ACCEPTED mail one tick may confirm (#322 §3), so a big inbox cannot stall the loop. */
const ACCEPTED_MAIL_CONFIRM_LIMIT = 20;
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
	/** #298: the team root's declared phase machine (absent = built-in). */
	machine?: PhaseMachine;
	/**
	 * Test seam for the DELIVERED evidence scan: read the recipient's turns from a
	 * session file. Defaults to `parseSessionFile(file).turns`, and the postman calls
	 * it **once per seam per tick** (#338 minor 2), so a counter injected here can
	 * prove the whole confirmation pass shares one projection.
	 *
	 * Deliberately NOT `parseSessionFileCached` (#348 review minor 6): this is a
	 * decision path, not a display one — it moves a message to DELIVERED and can
	 * discard a notice as obsolete — so it reads the file it is judging, the same
	 * rule that keeps verdict derivation off the gate. The frozen DELIVERED
	 * criterion (`docs/legion-v2-contract.md`) names `parseSessionFile` for the same
	 * reason. The cost is bounded regardless:
	 * {@link LegionPostman} only reaches this for a seam that actually has ACCEPTED
	 * mail in its page, so a seam with nothing pending parses nothing.
	 */
	parseTurns?: (sessionFile: string) => readonly Pick<TurnRecord, "userText">[];
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
	private readonly machine?: PhaseMachine;
	private readonly parseTurns: (sessionFile: string) => readonly Pick<TurnRecord, "userText">[];
	/** Per-seam confirmation cursor (#338 M3): the last message id this seam scanned. */
	private readonly confirmCursor = new Map<string, number>();
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
		this.machine = options.machine;
		this.parseTurns = options.parseTurns ?? ((sessionFile) => parseSessionFile(sessionFile).turns);
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
			// Confirm before delivering, so a message sent in this very tick stays
			// ACCEPTED for at least one tick instead of flipping to DELIVERED in the
			// same pass that queued it.
			this.confirmAcceptedMail(children);
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
			for (const message of pendingInbox(this.db, child.id)) {
				if (this.discardIfStaleNotice(message)) continue;
				await this.deliverToChild(child, message);
			}
		}
	}

	private async deliverRootInbox(): Promise<void> {
		for (const message of pendingInbox(this.db, "root")) {
			if (this.discardIfStaleNotice(message)) continue;
			try {
				this.sendRootMessage(formatMail(message));
				transitionDelivery(this.db, message.id, MAIL_DELIVERY.ACCEPTED, this.now);
				this.emitMail(message.id, message.fromNode, "mail_sent");
			} catch {
				// Leave pending for a later tick instead of silently losing mail.
			}
		}
	}

	/**
	 * #333: never hand a `Phase timeout:` notice to a recipient whose subject phase
	 * is already over — that is a to-do item that expired before it could be read.
	 * Applies to both inboxes this postman owns (children, and the root inbox when
	 * this node is `root`), because a queued notice would otherwise be injected long
	 * after the team converged.
	 */
	private discardIfStaleNotice(message: LegionMessage): boolean {
		if (!isStalePhaseTimeoutNotice(this.db, message)) return false;
		try {
			transitionDelivery(this.db, message.id, MAIL_DELIVERY.OBSOLETE, this.now);
			this.emitMail(message.id, message.fromNode, "mail_bounced");
		} catch {
			// Leave it for the next tick rather than losing the mail silently.
			return false;
		}
		return true;
	}

	/**
	 * One bounded confirmation pass over ACCEPTED mail (#322 §3).
	 *
	 * DELIVERED comes from evidence only: the recipient's session file shows the
	 * exact injected text (see `mailReachedTurns`). OBSOLETE is the #333 rule. Any
	 * message that cannot be decided stays ACCEPTED and is rescanned later.
	 *
	 * Two bounds keep a 2s loop honest (#338):
	 *
	 * - **Per-seam cursor rotation (M3).** Each seam remembers the id it scanned up
	 *   to and the next tick asks for `id > cursor`, wrapping to the head after the
	 *   tail. Re-reading the oldest `ACCEPTED_MAIL_CONFIRM_LIMIT` rows every tick let
	 *   20 undecidable messages hold the window forever, which stops the confirm *and*
	 *   obsolete paths permanently — a deadlock, not a delay. Rotation guarantees
	 *   every ACCEPTED message is rescanned, worst case
	 *   `ceil(inbox / ACCEPTED_MAIL_CONFIRM_LIMIT)` ticks later.
	 * - **One parse per seam per tick (minor 2).** `parseSessionFile` projects the
	 *   whole session; parsing it per message paid that cost up to 20 times a tick.
	 *   The turns are read once and reused by every message judged for that seam —
	 *   and only for a seam whose page is non-empty, so the #348 stat gate is not
	 *   needed here (see `parseTurns` for why this path stays on the real parse).
	 */
	private confirmAcceptedMail(children: readonly LegionNode[]): void {
		let remaining = ACCEPTED_MAIL_CONFIRM_LIMIT;
		const seams: Array<{ id: string; sessionFile: string | null }> = children.map((child) => ({
			id: child.id,
			sessionFile: child.sessionFile,
		}));
		// #338 M1: the root row records this session's file at creation
		// (`createRootLegion`), so mail addressed to `root` has evidence to compare
		// against instead of sitting at ACCEPTED forever.
		if (this.nodeId === "root") seams.push({ id: "root", sessionFile: getNode(this.db, "root")?.sessionFile ?? null });
		for (const seam of seams) {
			if (remaining <= 0) return;
			let messages: LegionMessage[];
			try {
				messages = this.nextAcceptedPage(seam.id, remaining);
			} catch {
				continue;
			}
			if (messages.length === 0) continue;
			// One projection for the whole seam. `null` means "nothing readable", not
			// "not delivered": an unreadable or rotated session proves nothing.
			const turns = seam.sessionFile === null ? null : this.tryParseTurns(seam.sessionFile);
			for (const message of messages) {
				if (remaining <= 0) return;
				remaining -= 1;
				// Delivered wins over obsolete: a notice the recipient did consume is a
				// fact about the past, not a stale to-do.
				if (turns !== null && mailReachedTurns(turns, message)) {
					try {
						transitionDelivery(this.db, message.id, MAIL_DELIVERY.DELIVERED, this.now);
						this.emitMail(message.id, message.fromNode, "mail_delivered");
					} catch {
						// Unreadable/rotated session: stays ACCEPTED.
					}
					continue;
				}
				this.discardIfStaleNotice(message);
			}
		}
	}

	/**
	 * The next `limit` ACCEPTED messages of one seam, rotating past the tail (#338 M3).
	 *
	 * Cursor state is per seam and in memory: a fresh postman starts at the head,
	 * which costs at most one extra pass and keeps the ledger free of scan bookkeeping.
	 */
	private nextAcceptedPage(seamId: string, limit: number): LegionMessage[] {
		const cursor = this.confirmCursor.get(seamId) ?? 0;
		const page = inbox(this.db, seamId, { delivery: MAIL_DELIVERY.ACCEPTED, limit, afterId: cursor });
		if (page.length > 0) {
			this.confirmCursor.set(seamId, page[page.length - 1]!.id);
			return page;
		}
		if (cursor === 0) return page;
		// Tail reached: wrap to the head so an undecidable message cannot starve the
		// ones behind it.
		const wrapped = inbox(this.db, seamId, { delivery: MAIL_DELIVERY.ACCEPTED, limit });
		this.confirmCursor.set(seamId, wrapped.length > 0 ? wrapped[wrapped.length - 1]!.id : 0);
		return wrapped;
	}

	private tryParseTurns(sessionFile: string): readonly Pick<TurnRecord, "userText">[] | null {
		try {
			return this.parseTurns(sessionFile);
		} catch {
			return null;
		}
	}

	private async deliverToChild(node: LegionNode, message: LegionMessage): Promise<void> {
		// #322: `ACCEPTED` is written below as soon as a send call returns an answer —
		// including `queued`, where the text waits for the child's next turn boundary
		// (after its current tool batch) and a child stuck in a long tool never
		// consumes it. It means "the send call returned", never "the child read it",
		// and it does not promise a retry either: only a thrown send stays pending.
		// `DELIVERED` is a separate, later fact with its own evidence. `intercepted`
		// is NOT accepted: an input handler ate the text, so it bounces.
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
					const disposition = await this.supervisor.steer(current.name, text);
					if (disposition === "intercepted") {
						// The child never saw the text and there is no retry, so the ledger says
						// so: the mail bounced, with a reason the sender can act on (#322).
						// #338 minor 1: this is NOT a steer, so it does not emit `node_steered`
						// (the bus signal for an injected steer) — the observable event is the
						// `mail_bounced` below, carrying `reason: intercepted_by_input_handler`.
						transitionDelivery(this.db, message.id, MAIL_DELIVERY.BOUNCED, this.now, {
							reason: MAIL_BOUNCE_REASON.INTERCEPTED_BY_INPUT_HANDLER,
						});
						this.emitMail(message.id, message.fromNode, "mail_bounced");
						// …and this `return` is why a swallowed send never reaches the unblock below (#323 3).
						return;
					}
					this.emitProcess("node_steered", current.id, { name: current.name, messageId: message.id });
				} else {
					await this.supervisor.followUp(current.name, text);
				}
			} else {
				// In-process backends cannot tell `queued` from `accepted`: `prompt` returns
				// void, so ACCEPTED here is a backend capability limit, not an observation.
				await this.supervisor.prompt(current.name, text);
			}
			if (wasAlive && message.urgency === "action-needed" && current.status === "blocked") updateNode(this.db, current.id, { status: "running" }, this.now);
			transitionDelivery(this.db, message.id, MAIL_DELIVERY.ACCEPTED, this.now);
			this.emitMail(message.id, message.fromNode, "mail_sent");
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

	/**
	 * Re-emit the ledger row a delivery transition already wrote onto the bus.
	 *
	 * The lookup is by `data.messageId` (#338 minor 6), not by scanning "the newest
	 * 100 rows of this node+type": the row behind an `ACCEPTED` send was written by
	 * `sendMail` possibly hundreds of events ago, so a bounded window silently stops
	 * emitting on a long-lived ledger. `json_extract` is what SQLite's JSON1 module
	 * provides; a NULL/malformed `data` simply cannot match a message id.
	 */
	private emitMail(messageId: number, nodeId: string, type: "mail_sent" | "mail_delivered" | "mail_bounced"): void {
		if (!this.eventBus) return;
		const row = this.db
			.prepare(
				"SELECT id, node_id, type, data, ts FROM events WHERE node_id = ? AND type = ? AND json_extract(data, '$.messageId') = ? ORDER BY id DESC LIMIT 1",
			)
			.get(nodeId, type, messageId);
		if (!row || typeof row.data !== "string") return;
		this.eventBus.emit({
			id: Number(row.id),
			nodeId: String(row.node_id),
			type,
			data: safeJson(row.data),
			ts: Number(row.ts),
		});
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
			// D7 (display-liveness v1): converge the ledger, do not merely report.
			// `orphan_detected` alone only described a suspicion, so a dead child stayed
			// `running` forever and every display exit had to special-case it. Commit the
			// fact first and let the event stream describe a state that already exists:
			// `liveness()` then reads a terminal row and answers `dead` on its own. `node`
			// is the pre-convergence snapshot — `updateNode` does not mutate it — so
			// `node.updatedAt` still names the frozen heartbeat this scan judged.
			updateNode(this.db, node.id, { status: "failed" }, () => timestamp);
			appendEvent(this.db, node.id, "node_abandoned", {
				reason: "no_active_supervisor",
				staleMs,
				updatedAt: node.updatedAt,
			}, { now: () => timestamp });
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

	/**
	 * Terminal check that respects the team's own machine (#298).
	 *
	 * The old code asked `isTerminalPhase`, which only knew the three built-in
	 * terminal names. Under a declared machine a phase is terminal because the
	 * DECLARATION says so (`terminal: true` or no exits), so a custom name would
	 * otherwise be treated as non-terminal and the auto-finish paths would act on
	 * a team that had already finished.
	 */
	private isTerminalPhaseOf(phase: string): boolean {
		if (this.machine) return isTerminalIn(this.machine, phase);
		return isTerminalPhase(phase);
	}

	private failTeamIfAllChildrenFailed(timestamp: number): void {
		const node = getNode(this.db, this.nodeId);
		if (!node?.phase || this.isTerminalPhaseOf(node.phase)) return;
		const children = getChildren(this.db, node.id);
		if (!children.length || children.some((child) => child.status !== "failed")) return;
		const decision = evaluatePhaseTransition({
			from: node.phase,
			to: "failed",
			reworkCount: node.reworkCount,
			children: children.map(({ id, role, status }) => ({ id, role, status })),
			terminalReason: "all_children_failed",
			actorRole: "supervisor",
			// #350 review (major 2): the team's OWN machine, or this safety net is inert.
			// Without it `from: "recon"` is not a phase of `DEFAULT_PHASE_MACHINE`, the
			// state machine answers `invalid_phase`, and the `!decision.allowed` guard
			// below drops the verdict in silence — so a squad that lived on a declared
			// phase never reached `failed` and its parent never heard. Silent only since
			// #350 made a declared start reachable (teams used to be born `planning`).
			...(this.machine ? { machine: this.machine } : {}),
		}, () => timestamp);
		if (!decision.allowed) return;
		updateNode(this.db, node.id, { phase: "failed", phaseSince: decision.phaseSince }, () => timestamp);
		this.eventBus?.emit(appendEvent(this.db, node.id, "phase_change", decision.event.data, { now: () => timestamp }));
		const failureNotice = `Legion team ${node.id} failed because all direct children failed.`;
		this.sendSelfMessage(failureNotice);
		if (node.parentId) {
			const { outcome, messages } = sendInternalNotice(this.db, { fromNode: node.id, to: "parent", subject: `Team failed: ${node.name}`, body: failureNotice, kind: "notice", urgency: "action-needed" }, { now: () => timestamp, ratePer5Min: this.settings.mailRatePer5Min }, `all-children-failed notice for ${node.id}`);
			for (const message of messages) this.emitMail(message.id, node.id, "mail_sent");
			// #353 review (major 3): a refused send must not silence the verdict — this
			// call site sits inside `tick()`, where a throw is swallowed by `start()`.
			if (outcome === "refused") this.sendRootMessage(failureNotice);
		} else this.sendRootMessage(failureNotice);
	}

	/**
	 * Which phase of THIS team's machine judges success (#358).
	 *
	 * The old test was `node.phase !== "verifying"`, a name a declared machine need
	 * never use, so a card whose workflow ends in `ship` could never take the
	 * supervisor's verified-completion path. The machine declares the answer: a phase
	 * with an exit to `done` judges success. Among those, an edge that requires
	 * `verification_passed` is the most precise statement of "this is where the
	 * verdict decides", and otherwise the LAST declared candidate wins — machines list
	 * their phases in pipeline order, and the deepest phase that can complete a team is
	 * the one that completes it (that rule alone picks `verifying` in the built-in
	 * machine).
	 *
	 * Fallback: a team with NO declared machine, or a machine with no exit to `done`
	 * at all, keeps the historical literal `verifying` — the behaviour every team had
	 * before this was derived, byte for byte.
	 */
	private successPhase(): string {
		const machine = this.machine;
		if (!machine) return "verifying";
		const exits = machine.phases.filter((phase) => phase.next.some((rule) => rule.to === "done"));
		if (exits.length === 0) return "verifying";
		const gated = exits.filter((phase) =>
			phase.next.some((rule) => rule.to === "done" && (rule.require ?? []).includes("verification_passed")),
		);
		const candidates = gated.length > 0 ? gated : exits;
		return candidates[candidates.length - 1]!.id;
	}

	/**
	 * Complete a team whose contract verification passed (#358).
	 *
	 * Both halves of this path used to speak only the built-in vocabulary: the phase
	 * test hard-coded `verifying`, and `evaluatePhaseTransition` was called without a
	 * `machine` — the same mistake #351 fixed on the abort path, and one that answers
	 * `invalid_phase` for a phase the team's own declaration named. The phase now comes
	 * from {@link successPhase} and the machine is forwarded, so a declared workflow
	 * reaches `done` through exactly the edges its card asked for.
	 */
	private finalizeVerifiedTeamIfReady(timestamp: number): void {
		const node = getNode(this.db, this.nodeId);
		const successPhase = this.successPhase();
		if (!node || node.phase !== successPhase || verificationPassed(node) !== true) return;
		const children = getChildren(this.db, node.id);
		if (children.some((child) => !isPhaseTerminalChild(child.status))) return;
		const decision = evaluatePhaseTransition({
			from: successPhase,
			to: "done",
			reworkCount: node.reworkCount,
			children: children.map(({ id, role, status }) => ({ id, role, status })),
			verificationPassed: true,
			actorRole: "supervisor",
			...(this.machine ? { machine: this.machine } : {}),
		}, () => timestamp);
		if (!decision.allowed) return;
		updateNode(this.db, node.id, { phase: "done", phaseSince: decision.phaseSince }, () => timestamp);
		this.eventBus?.emit(appendEvent(this.db, node.id, "phase_change", decision.event.data, { now: () => timestamp }));
		this.sendSelfMessage("All contract verification passed. Collect every child result, squash the subtree work, open an MR/PR for your parent, and report the URL. Do not merge.");
	}

	/**
	 * Warn the parent when this team has been in one phase too long.
	 *
	 * #358: the advisory clock used to be `settings.phaseTimeouts[phase] ??
	 * DEFAULT_PHASE_TIMEOUTS[phase] ?? 0`, so a phase named by the team's own card had
	 * no clock at all and `PhaseDefinition.timeoutMs` (`machineTimeout`) was dead code.
	 * The clock is resolved in this order:
	 *
	 *   1. `settings.phaseTimeouts[phase]` — an operator override still wins; a card
	 *      must not be able to take the operator's clock away. **Explicit means
	 *      explicit** (#358 review, major 1): `legionSettingsForRun` fills the built-in
	 *      defaults into every settings object, so `phaseTimeouts[phase] !== undefined`
	 *      is true even when nobody set anything. `legionExplicitFields` is the only
	 *      honest answer, and reading the filled value as a choice made the whole
	 *      `setting > machine > default` order below a fiction for the four built-in
	 *      names — the one case a card is most likely to declare.
	 *   2. `machineTimeout(machine, phase)` — the team's own declaration.
	 *   3. `DEFAULT_PHASE_TIMEOUTS[phase]` — the built-in four, through
	 *      `checkPhaseTimeout`'s own fallback.
	 *   4. nothing → 0 → never warns (the pre-existing meaning of 0, unchanged).
	 */
	private checkOwnPhaseTimeout(timestamp: number): void {
		const node = getNode(this.db, this.nodeId);
		if (!node?.phase || this.isTerminalPhaseOf(node.phase)) return;
		const operatorMs = isExplicitPhaseTimeout(this.settings, node.phase)
			? this.settings.phaseTimeouts?.[node.phase]
			: undefined;
		const machineMs = this.machine ? machineTimeout(this.machine, node.phase) : undefined;
		// A phase name the built-in table knows keeps its built-in clock unless either
		// source above says otherwise; a name it does not know had no clock before.
		const declaredMs = operatorMs ?? machineMs;
		const timeout = checkPhaseTimeout({
			phase: node.phase,
			phaseSince: node.phaseSince,
			now: timestamp,
			...(declaredMs === undefined ? {} : { timeouts: { [node.phase]: declaredMs } }),
		});
		if (!timeout.timedOut || hasPhaseTimeoutForSince(this.db, node.id, node.phaseSince)) return;
		const notice = `Legion phase timeout: ${node.id} has been in ${node.phase} for ${timeout.elapsedMs}ms (limit ${timeout.timeoutMs}ms). Work was not killed; decide whether to extend or abort.`;
		// #353 review (major 3): the notice is placed BEFORE the `phase_timeout` row, which
		// is also the de-dup key (`hasPhaseTimeoutForSince`). Written the other way round,
		// a refused send still consumed the stint's single announcement: `start()` swallows
		// the throw (`.catch(() => {})`), so no notice and no event ever appeared again for
		// that `phase_since`. Announcing first makes a refusal retryable — and a duplicate
		// notice (if this process dies between the send and the row) is the failure mode
		// §8.5 already prefers over a lost one.
		if (!node.parentId) this.sendRootMessage(notice);
		else {
			const notified = this.notifyTimeout(node, notice, timestamp);
			// Nothing was placed anywhere: leave the key unwritten so the next tick tries again.
			if (!notified) return;
		}
		const event = appendEvent(this.db, node.id, "phase_timeout", {
			phase: node.phase,
			phaseSince: node.phaseSince,
			elapsedMs: timeout.elapsedMs,
			timeoutMs: timeout.timeoutMs,
		}, { now: () => timestamp });
		this.eventBus?.emit(event);
	}

	/**
	 * Mail this team's timeout notice to its parent, degrading instead of throwing.
	 *
	 * Returns whether the notice reached the ledger's mail (`false` = it did not, and
	 * the caller must not write the de-dup key). A refusal is answered with
	 * `sendRootMessage` + a warning, so the fact is never silently dropped.
	 */
	private notifyTimeout(node: LegionNode, notice: string, timestamp: number): boolean {
		const { outcome, messages } = sendInternalNotice(this.db, {
			fromNode: node.id,
			to: "parent",
			subject: `Phase timeout: ${node.name}`,
			body: notice,
			kind: "notice",
			urgency: "action-needed",
		}, { now: () => timestamp, ratePer5Min: this.settings.mailRatePer5Min }, "Phase timeout notice");
		if (outcome === "refused") {
			this.sendRootMessage(notice);
			return false;
		}
		for (const message of messages) this.emitMail(message.id, node.id, "mail_sent");
		return true;
	}
}

export interface RegisterLegionToolsOptions {
	db: DatabaseSync;
	nodeId: string;
	role?: string;
	/** #298: the team root's declared phase machine (absent = built-in). */
	machine?: PhaseMachine;
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
			// #353 review (minor 1): `MailInvalidTextError` is a REFUSAL the model must be able to
			// see and act on, at the one boundary where the text is the model's own. The
			// framework only surfaces `content`, so the code (`MAIL_INVALID_TEXT`, a member of
			// the same closed vocabulary as the `MailDenied` refusals) rides `details.error`
			// like every other tool refusal here — and the throw never escapes the turn.
			let result: ReturnType<typeof sendMail>;
			try {
				result = sendMail(db, {
					fromNode: nodeId,
					to: params.to,
					subject: params.subject,
					body: params.body,
					...(params.kind ? { kind: params.kind } : {}),
					...(params.urgency ? { urgency: params.urgency } : {}),
				}, { ratePer5Min: settings.mailRatePer5Min, now: options.now });
			} catch (error) {
				if (error instanceof MailInvalidTextError) return toolError(error.message, error.code);
				throw error; // a real defect must not be disguised as bad input
			}
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
			// #309: a partially failed `implementing` had no legal exit, and this
			// description advertised neither of the two that now exist. A model only
			// learns about an argument if the tool tells it.
			description:
				"Request a validated centurion phase transition. " +
				'Pass supersedes:[<failed child>] (a direct failed child name or id; requires a settled sibling) ' +
				'to account for a failure and keep moving, or declare to:"failed" with reason:"<why the team cannot succeed>" to fail the team.',
			parameters: Type.Object({
				// #298: the phase list is declared per team, so it cannot be a
				// compile-time enum here. `requestLegionPhase` validates the value
				// against the team's own machine and refuses anything unknown with
				// the list of phases that DO exist.
				to: Type.String({
					description:
						'Target phase. Default machine: planning, implementing, reviewing, verifying. ' +
						'`done`/`aborted` are controlled by the parent or supervisor; ' +
						'`failed` is a centurion decision and requires a `reason`.',
				}),
				note: Type.Optional(Type.String()),
				evidence: Type.Optional(Type.String()),
				reason: Type.Optional(Type.String({
					description:
						'Why the team cannot succeed. Only meaningful with to:"failed", which requires it — without a ' +
						'non-empty reason the transition is refused, because a failure nobody explained is ' +
						'indistinguishable from a team that gave up. Ignored for every other target phase: it is ' +
						'not stored and does not appear in the resulting phase_change event.',
				})),
				supersedes: Type.Optional(Type.Array(Type.String(), {
					description:
						'Failed direct children (name or id) whose work a settled replacement has taken over. ' +
						'Precondition: every entry must be a direct child with status=failed, and this team must ' +
						'have at least one settled child; then the failure no longer blocks leaving implementing.',
				})),
			}),
			async execute(_id, params) {
				const result = await requestLegionPhase(db, nodeId, params.to, {
					note: params.note,
					evidence: params.evidence,
					reason: params.reason,
					supersedes: params.supersedes,
					cwd: options.cwd ?? process.cwd(),
					runDir: options.runDir,
					settings,
					eventBus: options.eventBus,
					now: options.now,
					runCommand: options.runCommand,
					sendSelfMessage: options.sendSelfMessage,
					...(options.machine ? { machine: options.machine } : {}),
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
	/**
	 * #309: required for `to: "failed"`. The blanket terminal guard used to refuse
	 * every failure a centurion asked for, which left a team whose children
	 * PARTLY failed with no exit at all (partial failure satisfies neither
	 * `children_none_failed` nor `children_all_failed`). A declared failure is the
	 * release valve; demanding a reason keeps it a decision instead of a shrug.
	 */
	reason?: string;
	/**
	 * #309: failed direct children (name or id) whose work a settled sibling took
	 * over. Handled state is deliberately NOT persisted — it is recomputed per
	 * request, exactly like the `reworkCount > 0` + `updatedAt < phaseSince`
	 * derivation, and this input is an additional source unioned into it.
	 */
	supersedes?: string[];
	/** #298: the team's declared phase machine, when its card has one. */
	machine?: PhaseMachine;
	cwd: string;
	runDir?: string;
	settings?: LegionSettings;
	eventBus?: Pick<LegionEventBus, "emit">;
	now?: () => number;
	runCommand?: LegionCommandRunner;
	sendSelfMessage?: (text: string) => void;
}

export type PhaseRequestResult =
	| { ok: true; phase: string; message: string }
	| { ok: false; message: string; code?: string };

export async function requestLegionPhase(
	db: DatabaseSync,
	nodeId: string,
	to: string,
	options: PhaseRequestOptions,
): Promise<PhaseRequestResult> {
	const now = options.now ?? Date.now;
	const self = getNode(db, nodeId);
	if (!self || self.role !== "centurion") return { ok: false, code: "INVALID_PARAMS", message: "legion_phase is centurion-only" };
	// #298: the team's own machine decides which phases exist. `options.machine`
	// carries the declaration from the node's role card; absent means the built-in
	// four-phase pipeline.
	const machine = options.machine;
	if (to === "done" || to === "aborted") {
		return { ok: false, code: "INVALID_PARAMS", message: `${to} is controlled by the parent or supervisor` };
	}
	// #309: `to: "failed"` is a centurion decision, but only a DECLARED one.
	// The reason is not decoration: it is what makes the phase_change event
	// auditable, and it is the successor of a blanket refusal that predates
	// partial failure being a reachable state.
	// #309: ONE predicate for the sites that treat a failure declaration
	// specially — the reason requirement, the machine's terminal reason, and the
	// success message. Same condition, so read it once.
	const declaredFailure = to === "failed";
	const failureReason = typeof options.reason === "string" ? options.reason.trim() : "";
	if (declaredFailure && !failureReason) {
		return { ok: false, code: "INVALID_PARAMS", message: 'to:"failed" requires a reason: pass reason:"<why the team cannot succeed>"' };
	}

	const children = getChildren(db, nodeId);
	// #309: explicit `supersedes` — the second honest source of `handled`.
	// Blank entries (and an all-blank array) mean "not provided": no validation,
	// no event, no union. Otherwise every entry must be a FAILED direct child, and
	// the team must have a settled child that actually took the work over —
	// otherwise this argument would launder any failure into an exit.
	const supersedeEntries = (options.supersedes ?? [])
		.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
		.filter((entry) => entry.length > 0);
	const supersededIds: string[] = [];
	if (supersedeEntries.length > 0) {
		for (const entry of supersedeEntries) {
			const superseded = children.find((child) => child.name === entry || child.id === entry);
			if (!superseded) {
				return { ok: false, code: "INVALID_PARAMS", message: `supersedes:[${entry}] is not a child of this team` };
			}
			if (superseded.status !== "failed") {
				return { ok: false, code: "INVALID_PARAMS", message: `supersedes:[${entry}] is not a failed child (status=${superseded.status})` };
			}
			if (!supersededIds.includes(superseded.id)) supersededIds.push(superseded.id);
		}
		if (!children.some((child) => child.status === "settled")) {
			return { ok: false, code: "INVALID_PARAMS", message: "supersedes requires a settled sibling that took the work over: no direct child of this team has status=settled" };
		}
	}
	const proposedContractPath = path.resolve(self.worktreePath ?? options.cwd, ".pi-legion", "contract.md");
	let contractText: string | undefined;
	try { contractText = fs.readFileSync(proposedContractPath, "utf8"); } catch { contractText = undefined; }
	// #298: NO role names here any more. The old code scanned for a settled
	// `role === "reviewer"` and for failed `role === "worker"` children, which made
	// those roles load-bearing: a custom machine could declare any phases it liked
	// and still be judged by the fixed pipeline's cast list.
	//
	// Now the question is asked structurally — "the newest settled child that
	// reported a verdict" and "failures recorded before this phase began" — so any
	// role can play any part.
	const settledWithSession = children
		.filter((child) => child.status === "settled" && child.sessionFile)
		.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
	const latestVerdictChild = settledWithSession.at(-1);
	const lastVerdict = latestVerdictChild?.sessionFile
		? extractVerdict(parseSessionFile(latestVerdictChild.sessionFile).lastTurnOutput ?? "")
		: null;
	const verdictOk = lastVerdict?.ok;
	const failedHandledIds = self.phase !== null && self.reworkCount > 0 && self.phaseSince !== null
		? children.filter((child) => child.status === "failed" && child.updatedAt < self.phaseSince!).map((child) => child.id)
		: [];
	// #309: `supersedes` is an ADDITIONAL source, not a replacement — the rework
	// derivation above is untouched, and the union is deduplicated so a child that
	// is handled by both rules is still counted once.
	const handledIds = [...new Set([...failedHandledIds, ...supersededIds])];
	const contractPresent = Boolean(contractText?.trim());
	// #309: a centurion-declared failure is accepted by `state-machine.ts`'s
	// `evaluateDeclaredFailure` for `terminalReason: "parent_decision"` BEFORE the
	// edge lookup ever runs (frozen semantics this change must not move). So the
	// tool must only hand it that reason when the team's own machine actually
	// declares a `failed` edge out of the CURRENT phase that THIS node may take.
	//
	// The guard reads the EFFECTIVE (normalized) machine — the very same machine the
	// transition below is evaluated against — so the guard and the state machine can
	// never disagree. Two consequences, both intended:
	//   - a card that OMITS the `failed` phase still gets it injected, with an edge
	//     out of every non-terminal phase, and therefore MAY declare failure;
	//   - a card that DECLARES the `failed` phase but leaves the edge off the current
	//     phase is refused.
	// Injection adds no capability (`normalizePhaseMachine`: it only removes the
	// possibility of a stranded team), because taking an injected terminal stays
	// gated — here by the reason requirement and by `actorRole`.
	//
	// The edge's own `require` conditions are deliberately NOT consulted: a
	// declared failure asserts that they are precisely what failed, so they are
	// vacuous for it. `actorRole` answers a different question — WHO may decide a
	// failure — and that still binds. It binds INSIDE the lookup: a machine that
	// reserves one `failed` edge to another actor and also offers a plain one is not
	// order-dependent.
	const effectiveMachine = normalizePhaseMachine(options.machine ?? DEFAULT_PHASE_MACHINE);
	const mayDeclareFailure = self.phase !== null && (findPhase(effectiveMachine, self.phase)?.next.some(
		(rule) => rule.to === "failed" && (rule.actorRole === undefined || rule.actorRole === self.role),
	) ?? false);
	const decision = evaluatePhaseTransition({
		from: self.phase ?? null,
		to,
		reworkCount: self.reworkCount,
		contractPath: contractPresent ? proposedContractPath : self.contractPath,
		contractPresent,
		children: children.map(({ id, role, status }) => ({ id, role, status })),
		failedWorkerHandledIds: handledIds,
		reviewerVerdictOk: verdictOk,
		verificationPassed: readVerificationResult(self),
		actorRole: self.role,
		...(machine ? { machine } : {}),
		...(declaredFailure && mayDeclareFailure ? { terminalReason: "parent_decision" as const } : {}),
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
	// #309: the handled-audit trail is written ONLY on the accepted path, right
	// before the transition it justified and with the same clock, so an auditor
	// reading the ledger sees "this failure was accounted for" immediately before
	// "the phase moved". Handled state itself is never stored on the node.
	const supersedeNote = typeof options.note === "string" ? options.note.trim() : "";
	for (const handledId of supersededIds) {
		const handledEvent = appendEvent(db, nodeId, "node_handled", {
			handledId,
			byNodeId: nodeId,
			...(supersedeNote ? { reason: supersedeNote.slice(0, 2_000) } : {}),
		}, { now });
		options.eventBus?.emit(handledEvent);
	}
	const phaseEvent = appendEvent(db, nodeId, "phase_change", {
		...decision.event.data,
		// The persisted reason is capped like `note`/`evidence`/the audit reason; the
		// RETURNED message keeps the full trimmed text because it is not stored.
		// Reaching this point implies `mayDeclareFailure` — a `to:"failed"` the machine
		// let through always had `terminalReason` handed to it — so the guard is not
		// repeated here.
		...(declaredFailure ? { terminalReason: "parent_decision", reason: failureReason.slice(0, 2_000) } : {}),
		...(options.note ? { note: options.note.slice(0, 2_000) } : {}),
		...(options.evidence ? { evidence: options.evidence.slice(0, 2_000) } : {}),
	}, { now });
	options.eventBus?.emit(phaseEvent);
	if (decision.notifyParent) await notifyParent(db, self, options.note ?? "centurion returned to planning", options.settings, now, options.eventBus);
	if (declaredFailure) {
		// #309 review (minor-2): a declared failure is a TERMINAL verdict, so — exactly
		// like the forced-failure path above and `failTeamIfAllChildrenFailed` — the
		// parent must hear about it by mail, not only as a tool receipt the centurion's
		// own model happens to read. Same text as the receipt, one source.
		const failureNotice = `Team failed by centurion decision: ${failureReason}`;
		await notifyParent(db, self, failureNotice, options.settings, now, options.eventBus);
		return { ok: true, phase: decision.to, message: failureNotice };
	}
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
export async function runLegionCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<LegionCommandResult> {
	const config = resolveVerifyQueueConfig();
	const slot = await acquireVerifySlot(command, config);
	try {
		const result = await runLegionCommandNow(command, cwd, timeoutMs, signal);
		const note = queueNote(slot, config.limit);
		return note ? { ...result, stderr: `${note}${result.stderr}` } : result;
	} finally {
		slot.release();
	}
}

/**
 * Run one legion-verify command now (no queue), output-capped and timed out.
 *
 * `timeout ... bash -lc cmd` runs in its own process group (`detached: true`),
 * and the timeout, output-cap and abort paths sweep that whole tree before
 * resolving (#310) — killing the `timeout` process alone used to leave the
 * shell's own children behind, reparented to init. The inner `timeout` is this
 * runner's real deadline, so an exit of `124` (or death by a signal) counts as
 * a timeout and is swept too; the `limit + 1s` timer is only a safety net.
 *
 * A normal exit is left alone on purpose: `cmd &` is a legal way to leave a
 * background process running, so leftovers are only reported
 * (`survivingDescendants`, one warning line) — and a command that has already
 * exited while an unredirected `cmd &` keeps its pipes open is a normal exit,
 * not a timeout.
 */
export function runLegionCommandNow(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<LegionCommandResult> {
	const limit = timeoutMs > 0 ? timeoutMs : 600_000;
	return new Promise((resolve) => {
		let timedOut = false;
		let settled = false;
		// Parked result while a sweep is in flight: the promise must not resolve
		// before the descendants are gone (#310).
		let sweep: Promise<unknown> | null = null;
		let parked = false;
		let leftoversReported = false;
		const child = spawn("timeout", ["--signal=TERM", `${Math.max(1, Math.ceil(limit / 1_000))}s`, "bash", "-lc", command], {
			cwd,
			env: process.env,
			// Own process group, so a tree-wide kill cannot reach the host (#310).
			detached: true,
		});
		const cleanupAbort = () => {
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const emit = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			cleanupAbort();
			const overflowed = out.truncated || err.truncated;
			resolve({ code: overflowed ? 1 : code, stdout: out.text(), stderr: `${err.text()}${extraStderr}`, ...(timedOut ? { timedOut: true } : {}) });
		};
		const finish = (code: number) => {
			if (settled) return;
			if (sweep) {
				if (parked) return;
				parked = true;
				void sweep.then(
					() => emit(code),
					() => emit(code),
				);
				return;
			}
			emit(code);
		};
		const sweepTree = (): Promise<unknown> => {
			if (sweep) return sweep;
			const pid = child.pid;
			sweep = pid === undefined
				? Promise.resolve(null)
				: sweepProcessTree(pid).then(
					(result) => {
						// A survivor means a process outlived even SIGKILL (EPERM, a
						// container boundary). Never report that silently: the whole
						// point of the sweep is that a timeout can be trusted.
						if (result.survivors.length > 0) {
							console.warn(
								`[legion] verify command sweep left ${result.survivors.length} process(es) running: ${commandSummary(command)} (pids ${result.survivors.slice(0, 5).join(", ")}${result.survivors.length > 5 ? ", …" : ""})`,
							);
						}
						return result;
					},
					() => null,
				);
			return sweep;
		};
		let extraStderr = "";
		// The inner `timeout(1)` is this runner's real deadline. When it fires it
		// kills what it can reach and exits 124 (or dies of the signal it
		// forwarded); a TERM-ignoring leftover that already gave the pipes back
		// lets `close` fire at once, and that used to be read as a clean exit —
		// warn, cancel the fallback timer, never sweep. That is this runner's
		// #310 leak, so 124 / death-by-TERM-or-KILL counts as a timeout.
		// Deliberately *not* "any signal": a command that crashed (SIGSEGV/SIGABRT,
		// SIGPIPE from a destroyed pipe) must not be reported as a timeout.
		const innerTimedOut = (code: number | null): boolean =>
			code === 124 || child.signalCode === "SIGTERM" || child.signalCode === "SIGKILL";
		const markTimedOut = (): void => {
			if (timedOut) return;
			timedOut = true;
			extraStderr += `\nverification timed out after ${limit}ms`;
		};
		const cap = resolveMaxOutputBytes();
		const killOnOverflow = () => {
			// Destroy pipes so a grandchild writer dies of SIGPIPE, then sweep and settle.
			child.stdout?.destroy();
			child.stderr?.destroy();
			sweepTree();
			finish(1);
		};
		const out = createCappedOutput(cap, killOnOverflow);
		const err = createCappedOutput(cap, killOnOverflow);
		child.stdout?.on("data", (chunk) => out.push(chunk));
		child.stderr?.on("data", (chunk) => err.push(chunk));
		child.on("error", (error) => { extraStderr += String(error); finish(1); });
		const timer = setTimeout(() => {
			// `close` waits for stdio to drain, so an unredirected background job
			// (`bash -lc 'sleep 600 &'`) keeps it pending long after the command
			// finished. If the direct child itself exited — and did not time out —
			// this is a normal exit: report the leftovers and keep its own code.
			const exited = child.exitCode;
			if (exited !== null && !innerTimedOut(exited)) {
				reportLeftovers();
				finish(exited);
				return;
			}
			markTimedOut();
			sweepTree();
			finish(1);
		}, limit + 1_000);
		function onAbort(): void {
			extraStderr += "\nverification aborted";
			sweepTree();
			finish(1);
		}
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		child.on("close", (code) => {
			// Only when nothing else already ended this command: an output cap or an
			// abort sets `sweep` first, and `timeout` re-raises the child's death
			// signal on itself, so a capped `yes` dies of SIGPIPE — that is not a
			// timeout and must not be reported as one.
			if (!sweep && innerTimedOut(code)) {
				markTimedOut();
				sweepTree();
				finish(1);
				return;
			}
			if (!sweep) reportLeftovers();
			finish(code ?? 1);
		});

		function reportLeftovers(): void {
			if (leftoversReported) return;
			leftoversReported = true;
			const pid = child.pid;
			if (pid === undefined) return;
			const survivors = survivingDescendants(pid);
			if (survivors.length === 0) return;
			console.warn(
				`[legion] verify command exited leaving ${survivors.length} process(es) running: ${commandSummary(command)} (pids ${survivors.slice(0, 5).join(", ")}${survivors.length > 5 ? ", …" : ""})`,
			);
		}
	});
}

function readContract(node: LegionNode, fallbackPath: string): string {
	try { return fs.readFileSync(node.contractPath ?? fallbackPath, "utf8"); } catch { return ""; }
}

function verificationPassed(node: LegionNode): boolean | undefined {
	return readVerificationResult(node);
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

/**
 * #353 review (major 3): send an INTERNAL notice, degrading instead of throwing.
 *
 * `sendMail` throws `MailInvalidTextError` for a U+0000 because SQLite truncates text
 * there, so a silent fragment would be stored under an `ok: true` (#353). That is the
 * right answer at the `legion_mail` boundary — the model composed the text and can fix
 * it. It is the wrong answer for every notice THIS file composes from ledger facts,
 * because those call sites run after the durable move they describe and nobody is left
 * to retry:
 *
 *   - `notifyParent` runs AFTER `updateNode` + `phase_change` (§8.4 `legion_phase`), so a
 *     throw turned an accepted phase transition — including a failed team's mandatory
 *     notice, the promise #309 made — into a tool error while the team had already moved;
 *   - `checkOwnPhaseTimeout` runs inside `LegionPostman.tick`, and `start()` swallows
 *     whatever escapes (`.catch(() => {})`), so a throw lost that stint's single notice.
 *
 * Degrade order, neither step dropping the notice:
 *   1. the U+0000 characters are dropped from `subject` and `body` and the message is sent
 *      again (the truncation `#353` refused is now explicit and total, and a warning names
 *      the field and offset). Only text is rewritten: routing (`to`) is ledger-resolved and
 *      is never re-decided here, because a notice that arrives at the wrong node is worse
 *      than one that does not arrive;
 *   2. a refusal the ledger understands (rate limit, permission, recipient gone) or a send
 *      that still throws comes back as `refused`, and the caller places the fact another
 *      way (`sendRootMessage` + this warning).
 *
 * Never throws: an internal notice may not be able to fail the ledger move it reports.
 */
function sendInternalNotice(
	db: DatabaseSync,
	input: SendMailInput,
	options: SendMailOptions,
	label: string,
): { outcome: "sent" | "degraded" | "refused"; messages: LegionMessage[] } {
	const warn = (detail: string) => console.warn(`[legion] ${label}: ${detail}`);
	try {
		const result = sendMail(db, input, options);
		if (result.ok) return { outcome: "sent", messages: result.messages };
		// A refusal the ledger understands (rate limit, permission, recipient gone) is not a
		// text problem: report it and let the caller decide where the fact goes.
		warn(`not mailed as composed (${result.code}: ${result.message}); degrading instead of dropping it.`);
		return { outcome: "refused", messages: [] };
	} catch (error) {
		if (!(error instanceof MailInvalidTextError)) {
			warn(`could not be mailed (${messageOf(error)}); the fact it reports is already committed, so this does not fail the turn.`);
			return { outcome: "refused", messages: [] };
		}
		warn(`${error.message}; dropping the U+0000 characters from the text and sending again.`);
		try {
			const retry = sendMail(db, { ...input, subject: withoutNul(input.subject), body: withoutNul(input.body) }, options);
			if (retry.ok) return { outcome: "degraded", messages: retry.messages };
			warn(`degraded send was refused too (${retry.code}: ${retry.message}).`);
			return { outcome: "refused", messages: [] };
		} catch (retryError) {
			warn(`degraded send was refused too (${messageOf(retryError)}).`);
			return { outcome: "refused", messages: [] };
		}
	}
}

/** The only character `sendMail` cannot hold; dropping it is the degrade rule above. */
function withoutNul(text: string): string {
	return text.includes("\u0000") ? text.replaceAll("\u0000", "") : text;
}

async function notifyParent(db: DatabaseSync, node: LegionNode, text: string, settings: LegionSettings | undefined, now: () => number, eventBus?: Pick<LegionEventBus, "emit">): Promise<void> {
	if (!node.parentId) return;
	// Phase/timeout events are already durable facts. If mail is rate-limited,
	// do not mislabel the failed notification as another phase timeout.
	const { messages } = sendInternalNotice(db, {
		fromNode: node.id,
		to: "parent",
		subject: `Legion update: ${node.name}`,
		body: text,
		kind: "notice",
		urgency: "action-needed",
	}, { now, ratePer5Min: settings?.mailRatePer5Min }, `parent notification for ${node.id}`);
	for (const message of messages) emitStoredMailEvent(db, eventBus, node.id, "mail_sent", message.id);
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
