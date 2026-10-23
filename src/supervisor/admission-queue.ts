/**
 * Launch admission queue (issue #266, contract `launch-admission-queue-v1`).
 *
 * Turns "over the concurrent/fanout cap → throw `BUDGET_EXCEEDED` and let the
 * caller retry" into "over a *queueable* cap → wait in a queue, then admit
 * automatically once a slot is released". One scheduler for both backends.
 *
 * Scope of this module: the queue itself plus the single gate verdict function.
 * It is deliberately **pure** (contract §4.1 / §13.7-1):
 *  - no filesystem, no path module, no database,
 *  - no timers (superseded by an injected clock + the caller's single fallback timer, D2-d),
 *  - no environment reads,
 *  - the only time source is `options.now` (default `Date.now`), and
 *  - the only global state is the process-level registry below.
 * A unit test asserts these properties by reading this file's source text.
 *
 * Two consequences that are easy to get wrong:
 *  1. Timeouts are evaluated **only** inside `next()` (R7). Never reject an item
 *     that is already being admitted: it has left the queue and its child may
 *     already be spawned, so a late reject would orphan it.
 *  2. Ordering is one global `seq`. A smaller `seq` that cannot pass the probe
 *     is skipped, never allowed to block later items — and never reordered by
 *     parent (D5).
 *
 * The registry lives on `globalThis` under `Symbol.for(...)` because `jiti`
 * reloads modules with `moduleCache: false`: a module-level `Map` would be
 * reset by such a reload, and the five `new Orchestrator` sites in `index.ts`
 * would stop sharing one queue. Keys are namespaced with the process id
 * (I-O6) so a child process cannot inherit a parent's queue by using the same
 * run directory.
 *
 * NOTE: `§` references point at `docs/contracts/launch-admission-queue-v1.md`.
 */

export const DEFAULT_LAUNCH_QUEUE_MAX_PENDING = 32;
export const DEFAULT_LAUNCH_QUEUE_TIMEOUT_MS = 900_000;
/**
 * D2-d: the fallback recheck window. Even with event-driven pumps, a slot can
 * be released by *another* process (sibling session / hygiene), which sends no
 * event here — so the owner keeps one unref'd timer capped at this interval.
 * Fixed on purpose: no settings key for it.
 */
export const LAUNCH_QUEUE_RECHECK_MS = 1000;

/** D1: which resource the queued item is waiting for. */
export type AdmissionDimension = "fanout" | "active";

/** D1: the four gates that may be queued on. Everything else is a hard refusal. */
export type QueueableGate =
	| "inprocess.maxChildrenPerNode"
	| "inprocess.maxActive"
	| "ledger.maxChildrenPerNode"
	| "ledger.maxActiveNodes";

/**
 * D1/D11: gates that can never be satisfied by waiting — queueing them would
 * disguise a permanent failure (or a config error) as a 15-minute delay.
 */
export type HardGate =
	| "inprocess.maxSpawnsPerSession"
	| "inprocess.maxDepth"
	| "inprocess.maxChildrenPerNode.disabled"
	| "ledger.maxChildrenPerNode.disabled"
	| "legion.maxDepth"
	| "legion.parentNotFound"
	| "orchestrator.maxDepth"
	| "orchestrator.maxSpawns"
	| "other";

/**
 * Structured gate verdict (D1-a). The enqueue/refuse decision must be taken
 * from this shape — never from catching `BUDGET_EXCEEDED` (D1-b): one error
 * code covers eight distinct conditions, some of them permanent.
 */
export type AdmissionVerdict =
	| { readonly admitted: true }
	| {
			readonly admitted: false;
			readonly queueable: true;
			readonly gate: QueueableGate;
			readonly dimension: AdmissionDimension;
			readonly message: string;
	  }
	| { readonly admitted: false; readonly queueable: false; readonly gate: HardGate; readonly message: string };

/** In-process count snapshot, provided read-only by `InProcessSupervisor` (I-O1). */
export interface InProcessAdmissionCounts {
	readonly parentKey: string;
	/** Live children under `parentKey` — same filter as `assertWithinLimits`. */
	readonly siblings: number;
	/** All live children (everything not `exited`/`retired`; `idle` still holds a slot). */
	readonly active: number;
	readonly spawnCount: number;
	/** `inProcessDepth()` at call time. */
	readonly depth: number;
	readonly limits: {
		readonly maxDepth: number;
		readonly maxChildrenPerNode: number;
		readonly maxActive: number;
		readonly maxSpawnsPerSession?: number;
	};
}

// ── Frozen user-visible copy (A6 asserts these byte-for-byte) ──────────────

/** `inprocess spawn budget exhausted (n/N); raise …` */
export function inProcessSpawnsMessage(spawnCount: number, limit: number): string {
	return `inprocess spawn budget exhausted (${spawnCount}/${limit}); raise subagents.inprocess.maxSpawnsPerSession to allow more`;
}

/** `inprocess maxActive reached (n/30); raise …` */
export function inProcessActiveMessage(active: number, limit: number): string {
	return `inprocess maxActive reached (${active}/${limit}); raise subagents.inprocess.maxActive to allow more`;
}

/** `inprocess nesting limit reached (depth d, max 4); raise …` */
export function inProcessDepthMessage(depth: number, limit: number): string {
	return `inprocess nesting limit reached (depth ${depth}, max ${limit}); raise subagents.inprocess.maxDepth to allow deeper nesting`;
}

/**
 * `inprocess maxChildrenPerNode reached for '<parent>' (n/8)`.
 * An empty `parentKey` (a root-level child) renders as `<root>`, exactly as
 * `assertWithinLimits` always has.
 */
export function inProcessFanoutMessage(parentKey: string, siblings: number, limit: number): string {
	return `inprocess maxChildrenPerNode reached for '${parentKey || "<root>"}' (${siblings}/${limit})`;
}

/** D6: `launch queue overflow (<size>/<max>); raise …` */
export function queueOverflowMessage(size: number, maxPending: number): string {
	return `launch queue overflow (${size}/${maxPending}); raise subagents.inprocess.maxQueuedLaunches to allow more`;
}

/** D6: `launch queue timed out after <N>s ('<name>')` */
export function queueTimeoutMessage(name: string, waitedMs: number): string {
	return `launch queue timed out after ${Math.round(waitedMs / 1000)}s ('${name}')`;
}

/**
 * The one and only in-process gate implementation (D1-a).
 *
 * `assertWithinLimits` and the Orchestrator's admission probe both call this,
 * so the four user-visible messages cannot drift apart.
 *
 * Evaluation order matches `assertWithinLimits` verbatim:
 * `maxSpawnsPerSession` → `maxActive` → `maxDepth` → `maxChildrenPerNode`.
 *
 * `inflight` is the Orchestrator's in-flight reservation (D2-b): admissions it
 * has already waved through in this tick but which have not reached the
 * supervisor's `children` map yet. It only offsets the two queueable
 * dimensions (fanout/active); it never affects the hard gates.
 */
export function evaluateInProcessAdmission(
	counts: InProcessAdmissionCounts,
	inflight?: { readonly fanout: number; readonly active: number },
): AdmissionVerdict {
	const limits = counts.limits;
	const inflightFanout = inflight?.fanout ?? 0;
	const inflightActive = inflight?.active ?? 0;

	const spawnLimit = limits.maxSpawnsPerSession;
	if (spawnLimit !== undefined && counts.spawnCount >= spawnLimit) {
		return {
			admitted: false,
			queueable: false,
			gate: "inprocess.maxSpawnsPerSession",
			message: inProcessSpawnsMessage(counts.spawnCount, spawnLimit),
		};
	}

	const active = counts.active + inflightActive;
	if (active >= limits.maxActive) {
		return {
			admitted: false,
			queueable: true,
			gate: "inprocess.maxActive",
			dimension: "active",
			message: inProcessActiveMessage(active, limits.maxActive),
		};
	}

	if (counts.depth + 1 > limits.maxDepth) {
		return {
			admitted: false,
			queueable: false,
			gate: "inprocess.maxDepth",
			message: inProcessDepthMessage(counts.depth, limits.maxDepth),
		};
	}

	const siblings = counts.siblings + inflightFanout;
	if (limits.maxChildrenPerNode === 0) {
		// D11: 0 means "no children at all" — `siblings >= 0` is always true, so
		// this gate can never be satisfied by waiting. Refuse immediately, under
		// a distinct gate name so the decision is assertable and diagnosable.
		return {
			admitted: false,
			queueable: false,
			gate: "inprocess.maxChildrenPerNode.disabled",
			message: inProcessFanoutMessage(counts.parentKey, siblings, limits.maxChildrenPerNode),
		};
	}
	if (siblings >= limits.maxChildrenPerNode) {
		return {
			admitted: false,
			queueable: true,
			gate: "inprocess.maxChildrenPerNode",
			dimension: "fanout",
			message: inProcessFanoutMessage(counts.parentKey, siblings, limits.maxChildrenPerNode),
		};
	}

	return { admitted: true };
}

// ── Queue ─────────────────────────────────────────────────────────────────

export interface QueuedLaunch<T = unknown> {
	readonly name: string;
	readonly parentKey: string;
	readonly seq: number;
	readonly enqueuedAt: number;
	readonly payload: T;
}

export interface AdmissionQueueOptions {
	readonly maxPending?: number;
	readonly timeoutMs?: number;
	/** Injected clock; defaults to `Date.now`. The only time source in this module. */
	readonly now?: () => number;
}

export type EnqueueOutcome<T> =
	| { readonly ok: true; readonly item: QueuedLaunch<T>; readonly position: number }
	| { readonly ok: false; readonly kind: "overflow"; readonly message: string };

export type NextAdmission<T> =
	| { readonly kind: "none" }
	| { readonly kind: "admit"; readonly item: QueuedLaunch<T>; readonly waitedMs: number }
	| { readonly kind: "expired"; readonly item: QueuedLaunch<T>; readonly waitedMs: number; readonly message: string };

export interface AdmissionQueueEntry {
	readonly name: string;
	readonly parentKey: string;
	readonly seq: number;
	/** 1-based position in the queue as it stands right now. */
	readonly position: number;
	readonly waitedMs: number;
}

export interface AdmissionQueue<T = unknown> {
	/** Number of *waiting* items (an item under admission has already left). */
	readonly size: number;
	readonly maxPending: number;
	readonly timeoutMs: number;
	enqueue(payload: T, meta: { name: string; parentKey: string }): EnqueueOutcome<T>;
	positionOf(name: string): number | undefined;
	waitedMs(name: string): number | undefined;
	/** Dequeue and return (stop / abort flush). `undefined` when absent. */
	remove(name: string): QueuedLaunch<T> | undefined;
	/** Clear and return, in ascending `seq` order. */
	flush(): QueuedLaunch<T>[];
	/**
	 * Decide who leaves the queue next.
	 *
	 * Scans in `seq` order and returns the first item that either (a) has
	 * outlived `timeoutMs` or (b) passes `probe`. Items whose probe fails are
	 * skipped without blocking the scan (head-of-line skip, D5-2).
	 *
	 * The returned item is **dequeued**: an item being admitted is no longer
	 * "waiting", so a concurrent `next()` can never hand out the same item
	 * twice and a timeout can never fire against it (R7).
	 */
	next(probe: (item: QueuedLaunch<T>) => AdmissionVerdict): NextAdmission<T>;
	entries(): readonly AdmissionQueueEntry[];
	/** When the owner should re-check: `min(earliest expiry, now + LAUNCH_QUEUE_RECHECK_MS)`. */
	nextDeadlineAt(): number | undefined;
}

/** A non-positive/invalid option falls back to the documented default. */
function normalizeLimit(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.floor(value);
}

let listener: ((event: LaunchQueueEvent) => void) | undefined;

/** D9: process-local UI hook. Same shape as verify's listener, different function. */
export function setLaunchQueueListener(fn: ((event: LaunchQueueEvent) => void) | undefined): void {
	listener = fn;
}

/** A UI hook must never be able to break admission. */
function emit(event: LaunchQueueEvent): void {
	const fn = listener;
	if (!fn) return;
	try {
		fn(event);
	} catch {
		/* swallow: the pill is cosmetic */
	}
}

export function createAdmissionQueue<T = unknown>(options: AdmissionQueueOptions = {}): AdmissionQueue<T> {
	const maxPending = normalizeLimit(options.maxPending, DEFAULT_LAUNCH_QUEUE_MAX_PENDING);
	const timeoutMs = normalizeLimit(options.timeoutMs, DEFAULT_LAUNCH_QUEUE_TIMEOUT_MS);
	const now = options.now ?? (() => Date.now());
	/** Ascending `seq`: appended on enqueue, so array order IS queue order (D5). */
	const items: QueuedLaunch<T>[] = [];
	let nextSeq = 1;

	return {
		get size() {
			return items.length;
		},
		maxPending,
		timeoutMs,

		enqueue(payload, meta) {
			if (items.length >= maxPending) {
				// D6: overflow is an immediate hard refusal — nothing is enqueued, so
				// nothing needs timing out later.
				const message = queueOverflowMessage(items.length, maxPending);
				emit({ phase: "overflow", name: meta.name, queued: items.length, message });
				return { ok: false, kind: "overflow", message };
			}
			const item: QueuedLaunch<T> = {
				name: meta.name,
				parentKey: meta.parentKey,
				seq: nextSeq,
				enqueuedAt: now(),
				payload,
			};
			nextSeq += 1;
			items.push(item);
			const position = items.length;
			emit({ phase: "queued", name: item.name, position, queued: items.length });
			return { ok: true, item, position };
		},

		positionOf(name) {
			const index = items.findIndex((item) => item.name === name);
			return index === -1 ? undefined : index + 1;
		},

		waitedMs(name) {
			const item = items.find((candidate) => candidate.name === name);
			return item === undefined ? undefined : now() - item.enqueuedAt;
		},

		remove(name) {
			const index = items.findIndex((item) => item.name === name);
			const removed = index === -1 ? undefined : items[index];
			if (removed === undefined) return undefined;
			items.splice(index, 1);
			emit({ phase: "stopped", name: removed.name, queued: items.length });
			return removed;
		},

		flush() {
			// Array order IS seq order (append-only), so a copy is already sorted.
			const flushed = [...items];
			items.length = 0;
			if (flushed.length > 0) {
				emit({ phase: "flushed", queued: 0, message: `launch queue flushed (${flushed.length} pending)` });
			}
			return flushed;
		},

		next(probe) {
			const at = now();
			for (let index = 0; index < items.length; index += 1) {
				const item = items[index];
				if (item === undefined) continue;
				const waitedMs = at - item.enqueuedAt;
				if (item.enqueuedAt + timeoutMs <= at) {
					items.splice(index, 1);
					const message = queueTimeoutMessage(item.name, waitedMs);
					emit({ phase: "expired", name: item.name, position: index + 1, waitedMs, queued: items.length, message });
					return { kind: "expired", item, waitedMs, message };
				}
				const verdict = probe(item);
				if (!verdict.admitted) continue; // head-of-line skip (D5-2)
				items.splice(index, 1);
				emit({ phase: "admitted", name: item.name, position: index + 1, waitedMs, queued: items.length });
				return { kind: "admit", item, waitedMs };
			}
			return { kind: "none" };
		},

		entries() {
			const at = now();
			return items.map((item, index) => ({
				name: item.name,
				parentKey: item.parentKey,
				seq: item.seq,
				position: index + 1,
				waitedMs: at - item.enqueuedAt,
			}));
		},

		nextDeadlineAt() {
			if (items.length === 0) return undefined;
			let earliest = Number.POSITIVE_INFINITY;
			for (const item of items) earliest = Math.min(earliest, item.enqueuedAt + timeoutMs);
			return Math.min(earliest, now() + LAUNCH_QUEUE_RECHECK_MS);
		},
	};
}

// ── Process-level registry (D5/I-O6) ──────────────────────────────────────

const REGISTRY_KEY = Symbol.for("pi-legion.launch-admission-queue");

/** Symbol-indexed view of `globalThis` so the registry survives a module reload. */
type RegistryHolder = {
	[key: symbol]: Map<string, AdmissionQueue<unknown>> | undefined;
};

function registry(): Map<string, AdmissionQueue<unknown>> {
	// SAFETY: `globalThis` is an object, so a `Symbol.for`-keyed property is
	// readable on it; the invariant TypeScript cannot check is that the slot
	// holds this module's registry map. Both writer and reader of the slot live
	// in this file (plus `resetAdmissionQueuesForTests`), and the declared slot
	// type is the only thing ever stored there.
	const holder = globalThis as unknown as RegistryHolder;
	return (holder[REGISTRY_KEY] ??= new Map<string, AdmissionQueue<unknown>>());
}

/** I-O6: the pid keeps a child process from sharing its parent's queue. */
function registryKey(scope: string): string {
	return `${process.pid}:${scope}`;
}

/**
 * One queue per (process, scope). `scope` is the parent run directory — not the
 * cwd — because the control-action Orchestrators (`index.ts` has five
 * `new Orchestrator` sites) must find the queue a `launch` created, so that
 * `subagent stop` can dequeue an item that never spawned.
 *
 * `options` only apply when this scope has no queue yet: the first acquisition
 * wins, so a later reader cannot silently shrink a live queue's bounds.
 */
export function acquireAdmissionQueue<T = unknown>(
	scope: string,
	options?: AdmissionQueueOptions,
): AdmissionQueue<T> {
	const queues = registry();
	const key = registryKey(scope);
	const existing = queues.get(key);
	// SAFETY: a scope has exactly one payload type (the `LaunchQueuePayload` of
	// the run that owns it), so the erased entry is this call site's `T`. The
	// erasure is what lets one registry serve every run in the process.
	if (existing) return existing as AdmissionQueue<T>;
	const created = createAdmissionQueue<T>(options);
	// SAFETY: see above — the write-side half of the same erasure. `T` is only
	// a compile-time parameter and never appears at runtime.
	queues.set(key, created as unknown as AdmissionQueue<unknown>);
	return created;
}

/** Tests only (A17): drop every registered queue so suites cannot pollute each other. */
export function resetAdmissionQueuesForTests(): void {
	registry().clear();
}

/** D9: process-local UI events. Phases with no name are queue-wide transitions. */
export interface LaunchQueueEvent {
	readonly phase: "queued" | "admitted" | "expired" | "overflow" | "stopped" | "flushed";
	readonly name?: string;
	readonly position?: number;
	readonly waitedMs?: number;
	readonly queued: number;
	readonly slotsInUse?: number;
	readonly slots?: number;
	readonly message?: string;
}
