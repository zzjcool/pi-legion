/**
 * Host-side extension_ui_request types and in-memory forwarding queue.
 * M1-integration supplies the real TUI consumer; this module owns no UI.
 */

export type ExtensionUIRequest =
	| {
			type: "extension_ui_request";
			id: string;
			method: "select";
			title: string;
			options: string[];
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "confirm";
			title: string;
			message: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText?: string;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines?: string[];
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setTitle";
			title: string;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "set_editor_text";
			text: string;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setActivity";
			source: string;
			activity?: { message?: string };
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setProgramRecord";
			record: {
				state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
				id: string;
				app?: string;
				kind?: "permission" | "question" | "auth";
				message?: string;
			};
	  };

/** Response payload; UIProxy adds the RPC envelope and request id. */
export type ExtensionUIResponse =
	| { value: string }
	| { confirmed: boolean }
	| { cancelled: true };

export interface PendingUIRequest {
	/** Supervisor-local id; unique even when children reuse RPC request ids. */
	id: string;
	childName: string;
	rpcRequestId: string;
	request: ExtensionUIRequest;
	receivedAt: number;
}

export interface UIProxyEnqueueInput {
	childName: string;
	request: ExtensionUIRequest;
	respond?: (response: ExtensionUIResponse) => void;
}

/** Adapter surface for forwarding requests to a future TUI consumer. */
export interface UIProxy {
	enqueue(input: UIProxyEnqueueInput): PendingUIRequest;
	pending(): readonly PendingUIRequest[];
	take(): PendingUIRequest | undefined;
	respond(id: string, response: ExtensionUIResponse): boolean;
	forgetChild(childName: string): void;
	onRequest(listener: (request: PendingUIRequest) => void): () => void;
}

interface StoredResponse {
	childName: string;
	respond: (response: ExtensionUIResponse) => void;
}

/** Type guard for the JSON event delivered by RpcClient's extension UI path. */
export function isExtensionUIRequest(value: unknown): value is ExtensionUIRequest {
	if (!value || typeof value !== "object") return false;
	// SAFETY: the object check above guarantees the value has an object record shape;
	// all properties below are still validated before they narrow the request.
	const record = value as Record<string, unknown>;
	if (
		record.type !== "extension_ui_request" ||
		typeof record.id !== "string" ||
		typeof record.method !== "string"
	) {
		return false;
	}

	switch (record.method) {
		case "select":
			return (
				typeof record.title === "string" &&
				Array.isArray(record.options) &&
				record.options.every((option) => typeof option === "string")
			);
		case "confirm":
			return typeof record.title === "string" && typeof record.message === "string";
		case "input":
			return typeof record.title === "string";
		case "editor":
			return typeof record.title === "string";
		case "notify":
			return typeof record.message === "string";
		case "setStatus":
			return typeof record.statusKey === "string";
		case "setWidget":
			return typeof record.widgetKey === "string";
		case "setTitle":
			return typeof record.title === "string";
		case "set_editor_text":
			return typeof record.text === "string";
		case "setActivity":
			return typeof record.source === "string";
		case "setProgramRecord": {
			const rec = record.record;
			if (!rec || typeof rec !== "object" || Array.isArray(rec)) return false;
			const body = rec as Record<string, unknown>;
			return typeof body.id === "string" && typeof body.state === "string";
		}
		default:
			return false;
	}
}

function isDialogRequest(request: ExtensionUIRequest): boolean {
	return (
		request.method === "select" ||
		request.method === "confirm" ||
		request.method === "input" ||
		request.method === "editor"
	);
}

/**
 * In-memory queue plus request-id routing. Dialog replies are kept separately
 * from the drainable queue so a TUI may dequeue a request before answering it.
 */
export class InMemoryUIProxy implements UIProxy {
	private readonly queue: PendingUIRequest[] = [];
	private readonly responders = new Map<string, StoredResponse>();
	private readonly listeners = new Set<(request: PendingUIRequest) => void>();
	private nextId = 1;

	enqueue(input: UIProxyEnqueueInput): PendingUIRequest {
		const request: PendingUIRequest = {
			id: `ui-${this.nextId++}`,
			childName: input.childName,
			rpcRequestId: input.request.id,
			request: input.request,
			receivedAt: Date.now(),
		};
		this.queue.push(request);
		if (input.respond && isDialogRequest(input.request)) {
			this.responders.set(request.id, {
				childName: input.childName,
				respond: input.respond,
			});
		}
		for (const listener of [...this.listeners]) {
			try {
				listener(request);
			} catch {
				// One UI adapter must not prevent delivery to another subscriber.
			}
		}
		return request;
	}

	pending(): readonly PendingUIRequest[] {
		return this.queue.slice();
	}

	take(): PendingUIRequest | undefined {
		return this.queue.shift();
	}

	respond(id: string, response: ExtensionUIResponse): boolean {
		const stored = this.responders.get(id);
		if (!stored) return false;
		this.responders.delete(id);
		const queuedAt = this.queue.findIndex((request) => request.id === id);
		if (queuedAt >= 0) this.queue.splice(queuedAt, 1);
		stored.respond(response);
		return true;
	}

	forgetChild(childName: string): void {
		for (let index = this.queue.length - 1; index >= 0; index -= 1) {
			if (this.queue[index]?.childName === childName) this.queue.splice(index, 1);
		}
		for (const [id, stored] of this.responders) {
			if (stored.childName === childName) this.responders.delete(id);
		}
	}

	onRequest(listener: (request: PendingUIRequest) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

/** Top-level RPC event from Pi child `ui.setActivity` / `ui.setProgramRecord` (OSC busy fan-in). */
export type ExtensionActivityEvent =
	| {
			type: "extension_activity";
			id: string;
			source: string;
			activity: { message?: string } | null;
			record?: undefined;
	  }
	| {
			type: "extension_activity";
			id: string;
			record: {
				state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
				id: string;
				app?: string;
				kind?: "permission" | "question" | "auth";
				message?: string;
			};
	  };

export function isExtensionActivity(value: unknown): value is ExtensionActivityEvent {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.type !== "extension_activity" || typeof record.id !== "string") return false;
	if (record.record && typeof record.record === "object" && !Array.isArray(record.record)) {
		const body = record.record as Record<string, unknown>;
		return typeof body.id === "string" && typeof body.state === "string";
	}
	return typeof record.source === "string";
}

/** Map a child extension_activity event into the UIProxy request shape. */
export function extensionActivityToUIRequest(event: ExtensionActivityEvent): ExtensionUIRequest {
	if ("record" in event && event.record) {
		return {
			type: "extension_ui_request",
			id: event.id,
			method: "setProgramRecord",
			record: event.record,
		};
	}
	return {
		type: "extension_ui_request",
		id: event.id,
		method: "setActivity",
		source: event.source,
		...(event.activity ? { activity: event.activity } : {}),
	};
}
