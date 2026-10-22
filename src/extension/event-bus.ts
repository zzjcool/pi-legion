import type { DatabaseSync } from "../legion/db.ts";
import {
	LEGION_EVENT_TYPES as STORED_LEGION_EVENT_TYPES,
	getDataVersion,
	readEventsAfterTolerant,
} from "../legion/events.ts";
import type { LegionEventType as StoredLegionEventType } from "../legion/events.ts";

/** Process-only activity. These events are never written to the closed DB enum. */
export const LEGION_PROCESS_EVENT_TYPES = [
	"node_launched",
	"node_steered",
	"node_retired",
	"node_aborted",
	"ui_request",
	"text_delta",
	"tool_call",
	"agent_settled",
	"turn_start",
] as const;
export type LegionProcessEventType = (typeof LEGION_PROCESS_EVENT_TYPES)[number];

/** Stored tree events plus transient RPC activity for consumers such as the live overlay. */
export type LegionEventType = StoredLegionEventType | LegionProcessEventType;
export const LEGION_EVENT_TYPES: readonly LegionEventType[] = [
	...new Set<LegionEventType>([
		...STORED_LEGION_EVENT_TYPES,
		...LEGION_PROCESS_EVENT_TYPES,
	]),
];

/**
 * A normalized event-bus event. Persisted events retain the DB row id; process-only
 * events have no id. `data` is machine metadata, not a source for interpreting LLM claims.
 */
export interface LegionEvent<T = unknown> {
	id?: number;
	nodeId: string;
	type: LegionEventType;
	data: T | null;
	ts: number;
}

export type LegionEventHandler = (event: LegionEvent) => void;

export interface LegionEventBus {
	on(type: LegionEventType, handler: LegionEventHandler): () => void;
	emit(event: LegionEvent): void;
	/**
	 * Report an error raised OUTSIDE a subscriber's synchronous dispatch window
	 * (a deferred repaint) through the same `onHandlerError` channel a throwing
	 * handler uses. `createLegionEventBus` isolates a handler's throw so one bad
	 * consumer cannot break delivery; a subscriber that defers work past its own
	 * dispatch window would otherwise escape that isolation entirely (#238).
	 *
	 * There is deliberately NO `event`/`handler` argument: the throw happened after
	 * dispatch, so there is no real event to attribute it to, and fabricating one
	 * (a synthetic `ui_request` on an empty nodeId) would make any consumer that
	 * groups by `event.nodeId` record a phantom event on a node that never exists.
	 * Consumers that need correlation should use `context`.
	 *
	 * Optional so any structural stand-in for a bus keeps working; a caller with no
	 * channel must contain the error itself rather than rethrow it onto the
	 * microtask queue (which is a host-killing crash, the very bug this prevents).
	 */
	reportError?(error: unknown, context: "deferred-handler"): void;
}

export interface LegionEventBusOptions {
	/** Optional observer for isolated subscriber failures. Failures here are isolated too. */
	onHandlerError?: (
		error: unknown,
		/**
		 * The event whose handler threw, or `null` for a failure reported outside a
		 * dispatch window (`reportError`, e.g. a deferred repaint). `null` means "no
		 * event", never "an event with no node": do not group it by `nodeId`.
		 */
		event: LegionEvent | null,
		/**
		 * The failing handler, or a short origin tag for a deferred failure
		 * (`"deferred-handler"`) where no single handler is responsible.
		 */
		handler: LegionEventHandler | string,
	) => void;
}

interface EventSubscription {
	handler: LegionEventHandler;
	active: boolean;
}

const EVENT_TYPE_SET = new Set<string>(LEGION_EVENT_TYPES);

/** Create a synchronous, multi-subscriber event bus with idempotent unsubscribe. */
export function createLegionEventBus(
	options: LegionEventBusOptions = {},
): LegionEventBus {
	const subscribers = new Map<LegionEventType, Set<EventSubscription>>();

	return {
		on(type, handler) {
			assertEventType(type);
			if (typeof handler !== "function") {
				throw new TypeError("event handler must be a function");
			}
			let handlers = subscribers.get(type);
			if (!handlers) {
				handlers = new Set();
				subscribers.set(type, handlers);
			}
			const subscription: EventSubscription = { handler, active: true };
			handlers.add(subscription);

			return () => {
				if (!subscription.active) return;
				subscription.active = false;
				handlers!.delete(subscription);
				if (handlers!.size === 0) subscribers.delete(type);
			};
		},
		emit(event) {
			assertEvent(event);
			const handlers = subscribers.get(event.type);
			if (!handlers?.size) return;

			// Snapshot the set so subscriptions added while dispatching start on the next emit.
			for (const subscription of [...handlers]) {
				if (!subscription.active || !handlers.has(subscription)) continue;
				try {
					subscription.handler(event);
				} catch (error) {
					try {
						options.onHandlerError?.(error, event, subscription.handler);
					} catch {
						// Error reporting must not break synchronous delivery to other consumers.
					}
				}
			}
		},
		reportError(error, context) {
			// No `event`/`handler` to attribute this to: the throw happened after the
			// dispatch window closed. Pass only what is real (the error and the
			// origin) — a synthetic event would be a fabricated fact. An unconfigured
			// `onHandlerError` stays silent, which is what `emit()` already does for a
			// throwing handler; `index.ts` wires one so the containment is not silent.
			try {
				options.onHandlerError?.(error, null, context);
			} catch {
				// Error reporting must never itself break delivery.
			}
		},
	};
}

export type EventSourceIntervalHandle = ReturnType<typeof globalThis.setInterval>;

export interface EventSourceClock {
	setInterval(callback: () => void, milliseconds: number): EventSourceIntervalHandle;
	clearInterval(handle: EventSourceIntervalHandle): void;
}

export interface DbEventSourceOptions {
	/** Contract §10.2 recommends 200–500ms; default is 250ms. */
	pollMs?: number;
	/**
	 * Resume after this persisted event id. Defaults to the beginning of the log.
	 *
	 * The default is deliberately "replay everything": a caller that attaches to
	 * a ledger it did not just write should seed this at the current tail instead
	 * (`maxEventId(db)` from `src/legion/events.ts`) — that is what the production
	 * attach path in `index.ts` does (#238, `createLegionRuntime`). A caller that
	 * really wants the full replay passes `cursor: 0` explicitly.
	 */
	cursor?: number;
	/** Injectable interval scheduler for deterministic tests and embedding. */
	clock?: EventSourceClock;
	onError?: (error: unknown) => void;
}

export interface DbEventSource {
	/** Start polling and immediately perform one initial incremental read. */
	start(bus: Pick<LegionEventBus, "emit">): void;
	stop(): void;
	/** Perform one dirty-check/read cycle when the source is running. */
	poll(): void;
	getCursor(): number;
	isRunning(): boolean;
}

const DEFAULT_POLL_MS = 250;
const EVENT_BATCH_SIZE = 1_000;
const systemClock: EventSourceClock = {
	setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
	clearInterval: (handle) => globalThis.clearInterval(handle),
};

/**
 * Poll the ledger using PRAGMA data_version as a cheap dirty check. It performs
 * one initial cursor read on start, then skips event SELECTs until another
 * connection has committed a change. Same-process writers should publish via
 * LegionEventBus.emit because SQLite does not bump data_version for local commits.
 * It deliberately does not watch DB/WAL files.
 */
export function createDbEventSource(
	db: DatabaseSync,
	options: DbEventSourceOptions = {},
): DbEventSource {
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	if (!Number.isFinite(pollMs) || pollMs < 200 || pollMs > 500) {
		throw new TypeError("pollMs must be between 200 and 500 milliseconds");
	}
	let cursor = options.cursor ?? 0;
	if (!Number.isSafeInteger(cursor) || cursor < 0) {
		throw new TypeError("cursor must be a non-negative safe integer");
	}

	const clock = options.clock ?? systemClock;
	let bus: Pick<LegionEventBus, "emit"> | undefined;
	let timer: EventSourceIntervalHandle | undefined;
	let running = false;
	let polling = false;
	let lastDataVersion: number | undefined;

	const reportError = (error: unknown): void => {
		try {
			options.onError?.(error);
		} catch {
			// Diagnostics are optional and cannot be allowed to stop the poller.
		}
	};

	const poll = (): void => {
		if (!running || !bus || polling) return;
		polling = true;
		const currentBus = bus;
		try {
			const dataVersion = getDataVersion(db);
			if (lastDataVersion === dataVersion) return;

			// Drain all batches for this dirty version so the cursor cannot strand
			// events when a busy producer commits more than one batch at once.
			for (;;) {
				let skipped = 0;
				const batch = readEventsAfterTolerant(db, cursor, {
					limit: EVENT_BATCH_SIZE,
					onInvalidRow: (error, rowId) => {
						skipped += 1;
						reportError(error);
						// Advance past the undecodable row so one bad row cannot stall the stream.
						if (rowId > cursor) cursor = rowId;
					},
				});
				for (const event of batch) {
					currentBus.emit(event);
					// Rows are ascending, but onInvalidRow may already have moved the cursor
					// past a poison row in this same batch. Never let a decoded row rewind it,
					// or the skipped row is re-read and re-reported on the next poll.
					if (event.id > cursor) cursor = event.id;
					if (!running || bus !== currentBus) return;
				}
				// Skips count toward fullness: a batch of only poison rows still read
				// a full page, so it must not be mistaken for the tail of the log.
				if (batch.length + skipped < EVENT_BATCH_SIZE) break;
			}
			lastDataVersion = dataVersion;
		} catch (error) {
			reportError(error);
		} finally {
			polling = false;
		}
	};

	return {
		start(nextBus) {
			if (running) return;
			bus = nextBus;
			running = true;
			poll();
			try {
				timer = clock.setInterval(poll, pollMs);
			} catch (error) {
				running = false;
				bus = undefined;
				throw error;
			}
		},
		stop() {
			if (timer !== undefined) {
				clock.clearInterval(timer);
				timer = undefined;
			}
			running = false;
			bus = undefined;
		},
		poll,
		getCursor: () => cursor,
		isRunning: () => running,
	};
}

function assertEventType(type: unknown): asserts type is LegionEventType {
	if (typeof type !== "string" || !EVENT_TYPE_SET.has(type)) {
		throw new TypeError(`invalid legion bus event type: ${String(type)}`);
	}
}

function assertEvent(event: LegionEvent): void {
	if (!event || typeof event !== "object") {
		throw new TypeError("event must be an object");
	}
	assertEventType(event.type);
	if (typeof event.nodeId !== "string" || event.nodeId.length === 0) {
		throw new TypeError("event nodeId must be a non-empty string");
	}
	if (!Number.isFinite(event.ts)) {
		throw new TypeError("event ts must be a finite timestamp");
	}
	if (
		event.id !== undefined &&
		(!Number.isSafeInteger(event.id) || event.id < 1)
	) {
		throw new TypeError("event id must be a positive safe integer when present");
	}
}
