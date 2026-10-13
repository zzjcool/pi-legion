/**
 * Byte-capped accumulation for spawned-process output (#35).
 *
 * `spawn` + manual `data` concatenation has no built-in limit (Node's
 * maxBuffer applies only to the exec* family), so a runaway command can
 * exhaust host memory. Each stream is capped; on overflow the collector keeps
 * the first `maxBytes` bytes, appends a truncation marker, and calls
 * `onOverflow` once so the caller can kill the child.
 */

export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_BYTES_ENV = "PI_LEGION_MAX_OUTPUT_BYTES";

/** Resolve the per-stream cap from env; garbage / <=0 → default. */
export function resolveMaxOutputBytes(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[MAX_OUTPUT_BYTES_ENV]?.trim();
	if (!raw) return DEFAULT_MAX_OUTPUT_BYTES;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_OUTPUT_BYTES;
}

export interface CappedOutput {
	push(chunk: Buffer | string): void;
	readonly truncated: boolean;
	readonly bytesSeen: number;
	text(): string;
}

export function createCappedOutput(maxBytes: number, onOverflow?: () => void): CappedOutput {
	const parts: Buffer[] = [];
	let kept = 0;
	let seen = 0;
	let truncated = false;
	return {
		push(chunk) {
			const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			seen += buf.length;
			if (truncated) return;
			const room = maxBytes - kept;
			if (buf.length <= room) {
				parts.push(buf);
				kept += buf.length;
				return;
			}
			if (room > 0) parts.push(buf.subarray(0, room));
			kept = maxBytes;
			truncated = true;
			onOverflow?.();
		},
		get truncated() { return truncated; },
		get bytesSeen() { return seen; },
		text() {
			const body = Buffer.concat(parts).toString("utf8");
			return truncated ? `${body}\n[output truncated: exceeded ${maxBytes} bytes; process killed]` : body;
		},
	};
}
