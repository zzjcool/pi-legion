/**
 * Single point of truth for the streamed-detail wire fields both supervisor
 * backends publish (`viewer-transcript-parity-v1` §3 / §9 D14).
 *
 * The in-process and RPC backends MUST agree byte-for-byte about what a
 * `message_update` detail event carries, so the parsing lives here and is
 * imported — a second copy of these rules is a second wire contract that can
 * drift silently. Anything backend-specific (the coarse payload, the subscriber
 * gate, the notify loop) stays in the backend.
 */

/** Local narrowing helper: this module owns its own copy of the trivial ones. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * D6/D7: the streamed updates that carry display-only detail — interim text,
 * interim reasoning and in-flight tool arguments. They reach ONLY a subscriber
 * that opted into the detail stream; every other subscriber keeps seeing coarse
 * lifecycle/tool facts and nothing else.
 */
export const DETAIL_UPDATE_TYPES: ReadonlySet<string> = new Set([
	"text_delta",
	"thinking_delta",
	"toolcall_start",
	"toolcall_delta",
	"toolcall_end",
]);

/**
 * D6: the tool call a `toolcall_*` update belongs to. The host names the block by
 * `contentIndex` and `partial` is the live assistant message, so the call being
 * streamed is `partial.content[contentIndex]`; provider proxies strip `partial`
 * and carry `id`/`toolName` flat on the event instead, so both dialects are read
 * here. `arguments` is returned exactly as the host shaped it — never stringified.
 */
function toolCallOf(assistantEvent: Record<string, unknown>): {
	id?: string;
	name?: string;
	arguments?: unknown;
} {
	const partial = recordOf(assistantEvent.partial);
	const content = Array.isArray(partial?.content) ? partial.content : [];
	const index =
		typeof assistantEvent.contentIndex === "number"
			? assistantEvent.contentIndex
			: undefined;
	const atIndex = recordOf(index === undefined ? undefined : content[index]);
	const call: Record<string, unknown> =
		(atIndex?.type === "toolCall" ? atIndex : undefined) ??
		[...content]
			.reverse()
			.map((part) => recordOf(part))
			.find((part) => part?.type === "toolCall") ??
		recordOf(assistantEvent.toolCall) ??
		(partial?.type === "toolCall" ? partial : undefined) ??
		{};
	const id =
		typeof call.id === "string"
			? call.id
			: typeof assistantEvent.id === "string"
				? assistantEvent.id
				: undefined;
	const name =
		typeof call.name === "string"
			? call.name
			: typeof assistantEvent.toolName === "string"
				? assistantEvent.toolName
				: undefined;
	const args = call.arguments ?? assistantEvent.arguments;
	return {
		...(id === undefined ? {} : { id }),
		...(name === undefined ? {} : { name }),
		...(args === undefined ? {} : { arguments: args }),
	};
}

/**
 * D6/D7: the display-only fields an opted-in subscriber receives for one update.
 *
 * Returns `undefined` when the update carries no publishable detail at all, and
 * the caller must then publish NOTHING. That is D15's rule for `thinking_delta`:
 * the host always ships `delta` on it, and a "last thinking block of the partial"
 * fallback would hand the overlay the WHOLE reasoning block on every update — the
 * block would be appended again and again (double render). A dialect that omits
 * `delta` simply does not stream: its thinking still lands with `message_end`.
 * No subscription may see a `thinking_delta` without a delta.
 */
export function detailFieldsOf(
	assistantEvent: Record<string, unknown>,
	updateType: string,
): Record<string, unknown> | undefined {
	if (updateType === "text_delta") {
		return typeof assistantEvent.delta === "string"
			? { delta: assistantEvent.delta }
			: {};
	}
	if (updateType === "thinking_delta") {
		return typeof assistantEvent.delta === "string"
			? { delta: assistantEvent.delta }
			: undefined;
	}
	if (!updateType.startsWith("toolcall_")) return {};
	const call = toolCallOf(assistantEvent);
	return {
		...(call.id === undefined ? {} : { toolCallId: call.id }),
		...(call.name === undefined ? {} : { toolName: call.name }),
		...(call.arguments === undefined ? {} : { args: call.arguments }),
	};
}
