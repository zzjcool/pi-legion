/**
 * Run-scoped completion batching ("smart join").
 *
 * A `tasks[]` fan-out launches children together but they finish at different
 * times. Without batching the parent gets one wake-up per child; with it, one
 * grouped message per run. This coordinator is the pure state machine: it
 * holds no jobs, touches no UI, never retires a pane — the runtime only hooks
 * track/watch/release/dispose into it.
 *
 * State machine (smart mode, one runId group):
 *  - pending:   tracked, not yet terminal (addPending; rewatch re-adds)
 *  - buffered:  terminal, waiting for the flush window (onTerminal)
 *  - flushed:   delivered; no state retained
 *
 * On terminal:
 *  1. mode "each" → deliver immediately (the pre-join behaviour).
 *  2. Removing this member leaves the group with no pending members → flush
 *     the whole buffer now (the common "all children done" path).
 *  3. Otherwise buffer it; the window starts at the FIRST onTerminal.
 *
 * Window expiry: flush what is buffered, once. The window exists only to
 * collect stragglers from one batch — it is NEVER extended because the parent
 * session happens to be busy. A turn-level busy signal was the wrong predictor
 * (the parent is busy for the whole tool loop by definition) and it stacked a
 * second delay on top of the runtime's run-scoped outbox, which is the single
 * place a completion may be held. Pending members survive — a straggler
 * finishing later starts a fresh batch of its own.
 */

import {
	completionStatusOf,
	type CompletionInput,
	type CompletionStatus,
} from "./notify.ts";

export type JoinMode = "each" | "smart";

export const DEFAULT_JOIN_MODE: JoinMode = "smart";
export const DEFAULT_FLUSH_MS = 10_000;

export interface JoinConfig {
	mode: JoinMode;
	flushMs: number;
}

/** Default: smart mode with a ten-second window. */
function defaultJoinConfig(): JoinConfig {
	return { mode: DEFAULT_JOIN_MODE, flushMs: DEFAULT_FLUSH_MS };
}

export interface JoinEntry {
	runId: string;
	name: string;
	/**
	 * Reporting round of this child (D10). The runtime assigns it from a per-name
	 * monotonic counter in `track()`; the coordinator only carries it, because one
	 * round is one deliverable result — two unread rounds of the same child must
	 * both survive the buffer, which a `(runId, name)` key cannot express.
	 */
	round: number;
	/** Raw collect result; the deliver sink feeds it to formatGroupedNotice. */
	input: CompletionInput;
	/** From the triggering watch() call, forwarded to the delivery options. */
	triggerTurn: boolean;
}

export interface JoinSchedulerHandle {
	cancel: () => void;
}

export interface JoinCoordinatorDeps {
	/** Injectable timer (default: unref'd setTimeout); tests trigger manually. */
	schedule?: (ms: number, fn: () => void) => JoinSchedulerHandle;
	/** The single flush exit: the runtime wraps its completion delivery. */
	deliver: (entries: Array<JoinEntry & { status: CompletionStatus }>) => void;
}

/** Terminal entries already prepared with their coarse status. */
type BufferedEntry = JoinEntry & { status: CompletionStatus };

interface Group {
	/** Names tracked but not yet terminal (blocked members are excluded). */
	pending: Set<string>;
	buffered: BufferedEntry[];
	timer?: JoinSchedulerHandle;
}

function defaultSchedule(
	ms: number,
	fn: () => void,
): JoinSchedulerHandle {
	const id = setTimeout(fn, ms);
	id.unref?.();
	return { cancel: () => clearTimeout(id) };
}

export class JoinCoordinator {
	private config: JoinConfig;
	private readonly groups = new Map<string, Group>();
	/** name → runId, so release() can clean bookkeeping without a runId. */
	private readonly groupOf = new Map<string, string>();
	private readonly scheduleFn: NonNullable<JoinCoordinatorDeps["schedule"]>;
	private readonly deliverFn: JoinCoordinatorDeps["deliver"];
	private disposed = false;

	constructor(deps: JoinCoordinatorDeps) {
		this.config = defaultJoinConfig();
		this.scheduleFn = deps.schedule ?? defaultSchedule;
		this.deliverFn = deps.deliver;
	}

	setConfig(config: JoinConfig): void {
		this.config = config;
	}

	/** Register a member at track()/rewatch() time. */
	addPending(runId: string, name: string): void {
		if (this.disposed) return;
		this.groupOf.set(name, runId);
		const group = this.ensureGroup(runId);
		group.pending.add(name);
	}

	/** Drop all bookkeeping for a name (release()/retire). */
	remove(name: string): void {
		const runId = this.groupOf.get(name);
		if (runId === undefined) return;
		this.groupOf.delete(name);
		const group = this.groups.get(runId);
		if (!group) return;
		group.pending.delete(name);
		if (group.pending.size === 0 && group.buffered.length === 0) {
			this.dropGroup(runId, group);
		}
	}

	/**
	 * D8: drop the already-TERMINAL entries of one member.
	 *
	 * `remove()` only clears `pending` (a member that has already finished lives in
	 * `buffered`, not in `pending`), so a released child left its buffered entry
	 * behind as an orphan that fired at window expiry (W3) — most visibly right
	 * after a `wait()` hit, which retires and releases the very child whose entry
	 * is sitting in the window. Semantics of `remove()` are otherwise unchanged.
	 */
	dropBuffered(runId: string, name: string): void {
		if (this.disposed) return;
		const group = this.groups.get(runId);
		if (!group || group.buffered.length === 0) return;
		const kept = group.buffered.filter((entry) => entry.name !== name);
		if (kept.length === group.buffered.length) return;
		group.buffered = kept;
		if (group.pending.size === 0 && group.buffered.length === 0) {
			this.dropGroup(runId, group);
		}
	}

	/** Terminal entry point (success and collect-failure alike). */
	onTerminal(entry: JoinEntry): void {
		if (this.disposed) return;
		const status = completionStatusOf(
			entry.input.execution.status,
			entry.input.acceptance?.status,
		);
		if (status === "running") {
			// A running snapshot is not a completion (B). The runtime's watch()
			// re-arms on it; buffering it here would mislabel the child and the
			// aggregate status would silently swallow it. Fail loud instead.
			throw new Error("running snapshot is not a completion");
		}
		const buffered: BufferedEntry = { ...entry, status };
		if (this.config.mode === "each") {
			this.deliverFn([buffered]);
			return;
		}
		const group = this.groups.get(entry.runId);
		if (!group) {
			// Never addPending'd (or the group was already cleaned up): the
			// coordinator must not swallow a completion — deliver it directly.
			this.deliverFn([buffered]);
			return;
		}
		group.pending.delete(entry.name);
		group.buffered.push(buffered);
		if (group.pending.size === 0) {
			// Everyone is home: deliver the whole batch immediately.
			this.flush(entry.runId);
			return;
		}
		if (!group.timer) {
			group.timer = this.scheduleFn(this.config.flushMs, () => {
				this.onWindowExpired(entry.runId);
			});
		}
	}

	/** True when a group has no non-blocked members still pending. */
	allSettled(runId: string): boolean {
		const group = this.groups.get(runId);
		if (!group) return true;
		return group.pending.size === 0;
	}

	/** Cancel every timer and drop all state (runtime.dispose). */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const [runId, group] of this.groups) {
			this.dropGroup(runId, group);
		}
		this.groups.clear();
		this.groupOf.clear();
	}

	private ensureGroup(runId: string): Group {
		let group = this.groups.get(runId);
		if (!group) {
			group = { pending: new Set(), buffered: [] };
			this.groups.set(runId, group);
		}
		return group;
	}

	private onWindowExpired(runId: string): void {
		const group = this.groups.get(runId);
		if (!group || this.disposed) return;
		group.timer = undefined;
		this.flush(runId);
	}

	private flush(runId: string): void {
		const group = this.groups.get(runId);
		if (!group || group.buffered.length === 0) return;
		const batch = group.buffered;
		group.buffered = [];
		this.deliverFn(batch);
		if (group.pending.size === 0 && group.buffered.length === 0) {
			this.dropGroup(runId, group);
		}
	}

	private dropGroup(runId: string, group: Group): void {
		group.timer?.cancel();
		group.timer = undefined;
		this.groups.delete(runId);
	}
}
