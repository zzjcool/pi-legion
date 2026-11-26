/**
 * Where an in-process child's diagnostics go (#468).
 *
 * An in-process child shares the HOST's process, so `console.warn` from the
 * child's own machinery (`bindChildSessionExtensions`' `onError`, the
 * `session_shutdown` emitter, the armed `dispose()`) lands on the same TTY the
 * host TUI is drawing on — which is why a line like
 *
 *     [pi-legion] in-process child u2-automation turn_end hook skipped: …
 *
 * appeared immediately above the user's input box. Two things are wrong with
 * that: the channel (it is not the host's stderr stream to write on) and the
 * audience (the user cannot act on it). Neither is fixed by lowering the
 * severity — #415 already established the line is benign, and it still showed up.
 *
 * So every child diagnostic goes to a CHILD-scoped sink instead:
 *
 *   - **disk, always**: one timestamped line per event in
 *     `<runDir>/diagnostics.log` — `event=… child=… real=… reason=…`. Nothing is
 *     ever silently dropped; the file is the record.
 *   - **host, never by default**: `PI_LEGION_CHILD_DIAGNOSTICS=1` echoes each
 *     record to the host's console (the switch we flip when WE are debugging).
 *   - **host, once, at run end**: a REAL extension failure (a handler that
 *     threw, an extension whose `session_start` failed) is still the user's
 *     business, so {@link ChildDiagnosticSink.flush} emits exactly ONE summary
 *     line when the child is retired — not one line per event, and not a red
 *     `ui.notify` the host never asked for.
 *
 * The sink is deliberately synchronous and dependency-free: it runs on the
 * `dispose()` path, which must never be delayed, caught or made to throw by a
 * diagnostic. A failed write is swallowed on purpose — the diagnostic is worth
 * less than the teardown it is describing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Opt-in host echo for child diagnostics. Off by default — see the module doc. */
export const CHILD_DIAGNOSTICS_ENV = "PI_LEGION_CHILD_DIAGNOSTICS";

/** The per-run file every child diagnostic is appended to, inside `<runDir>`. */
export const CHILD_DIAGNOSTICS_FILE = "diagnostics.log";

/**
 * Diagnostic kinds. `real` (on {@link ChildDiagnostic}) is the second axis:
 * benign-and-expected events never reach the host, real failures reach it once.
 */
export type ChildDiagnosticEvent =
	| "turn_end.skipped"
	| "extension.error"
	| "extension.registration.error"
	| "session_shutdown.failed"
	| "dispose.failed";

/**
 * Host-facing label per event. Kept here (not at the call sites) so the live
 * echo reads exactly as it did before #468 — the text itself was never the bug,
 * the channel was.
 *
 * "Exactly as before" holds for the two events that existed then:
 * `turn_end hook skipped: …` and `extension error: …`. The other three are new
 * labels invented by this module (the pre-#468 lines were unprefixed
 * `in-process child session_shutdown failed: …` / `dispose failed: …`, and the
 * registration one was `inprocess child '<name>': …`). Byte equality is only
 * claimed for the first two, and never for a cause longer than {@link oneLine}'s
 * cap — that one is flattened and truncated on purpose.
 */
const EVENT_LABELS: Record<ChildDiagnosticEvent, string> = {
	"turn_end.skipped": "turn_end hook skipped",
	"extension.error": "extension error",
	"extension.registration.error": "extension registration error",
	"session_shutdown.failed": "session_shutdown failed",
	"dispose.failed": "dispose failed",
};

/** One record, as handed to {@link ChildDiagnosticSink.record}. */
export interface ChildDiagnostic {
	event: ChildDiagnosticEvent;
	/** Already-rendered, single-line cause (a host record is never multi-line). */
	reason: string;
	/**
	 * `true` = a real failure the user must be told about, in ONE line, when the
	 * child's run ends. `false`/absent = benign or expected; disk only.
	 */
	real?: boolean;
}

export interface ChildDiagnosticSinkOptions {
	/** Child name as the host knows it. Empty/absent = the unnamed child. */
	child?: string;
	/** `<runDir>/diagnostics.log`. Absent = keep records in memory only. */
	logFile?: string;
	/** Echo every record to the host as it happens. Default: the env switch. */
	host?: boolean;
	/** Host writer seam (tests, and any future non-TTY host). */
	hostWrite?: (line: string) => void;
	/** Clock seam. */
	now?: () => Date;
}

export interface ChildDiagnosticSink {
	/** Record one diagnostic. Never throws; appends to disk when a file is set. */
	record(diagnostic: ChildDiagnostic): void;
	/**
	 * Emit the run-end summary and return it, or `undefined` when nothing real
	 * happened. Idempotent: only the first call can emit, so two dispose paths
	 * cannot double-report.
	 */
	flush(): string | undefined;
	/** Records written so far, in order (the file's content when `logFile` is set). */
	readonly records: readonly string[];
}

/** Is the host echo switched on? Only an explicit truthy value counts. */
export function childDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[CHILD_DIAGNOSTICS_ENV]?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/**
 * `<runDir>/diagnostics.log` for a child transcript.
 *
 * The orchestrator pre-creates `<runDir>/<name>.jsonl`, so the transcript's
 * directory IS the run directory — no extra plumbing through `spawnChild`.
 * `undefined` when the session has no file (`SessionManager.inMemory()`), which
 * leaves the sink memory-only rather than writing somewhere ambiguous.
 */
export function childDiagnosticsLogFile(sessionFile: string | undefined): string | undefined {
	if (!sessionFile || sessionFile.trim() === "") return undefined;
	const dir = path.dirname(sessionFile);
	if (!dir || dir === "." || dir === path.parse(dir).root) return undefined;
	return path.join(dir, CHILD_DIAGNOSTICS_FILE);
}

/** Longest cause kept verbatim; the rest is elided (a host record is one line). */
const REASON_MAX_CHARS = 400;

/** Collapse a rendered cause to one line (host records are single-line by contract). */
function oneLine(text: string): string {
	const flat = text.replace(/\s*\r?\n\s*/g, " ").replace(/\s+/g, " ").trim();
	return flat.length > REASON_MAX_CHARS ? `${flat.slice(0, REASON_MAX_CHARS - 1)}…` : flat;
}

/**
 * The log's ceiling. A record can repeat every turn (`turn_end.skipped` does), so the
 * file must not be able to grow without bound — same policy as the notice log
 * (`notice-delivery.ts` `NOTICE_LOG_MAX_BYTES`), newer lines win.
 */
const DIAGNOSTICS_LOG_MAX_BYTES = 1024 * 1024;

/** Append one line, best effort. A diagnostic must never break the teardown it describes. */
function appendLine(file: string, line: string): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// 0600 like the sibling artifacts in the same run dir (the transcript is 0600
		// too); a diagnostic is not more public than the run it describes.
		fs.appendFileSync(file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
		trimLog(file);
	} catch {
		// Losing the record on an unwritable run dir is not worth losing the run.
	}
}

/** Keep the newest half once the cap is crossed. Best effort, like everything here. */
function trimLog(file: string): void {
	try {
		if (fs.statSync(file).size <= DIAGNOSTICS_LOG_MAX_BYTES) return;
		const kept = fs.readFileSync(file, "utf8").slice(-Math.floor(DIAGNOSTICS_LOG_MAX_BYTES / 2));
		const atLineStart = kept.indexOf("\n");
		fs.writeFileSync(file, atLineStart === -1 ? kept : kept.slice(atLineStart + 1), {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch {
		// A cap that cannot be enforced must not fail the record it just wrote.
	}
}

class FileChildDiagnosticSink implements ChildDiagnosticSink {
	private readonly child: string;
	private readonly logFile: string | undefined;
	private readonly hostEcho: boolean;
	private readonly write: (line: string) => void;
	private readonly clock: () => Date;
	private readonly lines: string[] = [];
	private readonly realReasons: string[] = [];
	private flushed = false;

	constructor(options: ChildDiagnosticSinkOptions) {
		this.child = options.child?.trim() ?? "";
		this.logFile = options.logFile;
		this.hostEcho = options.host ?? childDiagnosticsEnabled();
		this.write = options.hostWrite ?? ((line: string) => console.warn(line));
		this.clock = options.now ?? (() => new Date());
	}

	/** ` <name>`, or `""` for an unnamed child — the suffix of the host prefix. */
	private get label(): string {
		return this.child ? ` ${this.child}` : "";
	}

	get records(): readonly string[] {
		return this.lines;
	}

	record(diagnostic: ChildDiagnostic): void {
		const reason = oneLine(diagnostic.reason);
		const record =
			`${this.clock().toISOString()} child=${this.child || "-"} event=${diagnostic.event} ` +
			`real=${diagnostic.real === true} reason=${reason}`;
		this.lines.push(record);
		if (this.logFile) appendLine(this.logFile, record);
		if (diagnostic.real === true) this.realReasons.push(`${EVENT_LABELS[diagnostic.event]}: ${reason}`);
		// The live echo is the OLD behaviour, kept behind a switch for our own debugging.
		if (this.hostEcho) this.emit(`[pi-legion] in-process child${this.label} ${EVENT_LABELS[diagnostic.event]}: ${reason}`);
	}

	flush(): string | undefined {
		if (this.flushed) return undefined;
		this.flushed = true;
		if (this.realReasons.length === 0) return undefined;
		const count = this.realReasons.length;
		const first = this.realReasons[0]!;
		const more = count > 1 ? ` (+${count - 1} more)` : "";
		const where = this.logFile ? ` — details: ${this.logFile}` : "";
		const line =
			`[pi-legion] in-process child${this.label}: ${count} extension ` +
			`${count === 1 ? "error" : "errors"} this run — first: ${first}${more}${where}`;
		this.emit(line);
		return line;
	}

	private emit(line: string): void {
		try {
			this.write(line);
		} catch {
			// Same rule as appendLine: a broken host channel is not a child failure.
		}
	}
}

/** Build a sink. The only construction point, so the file layout has one owner. */
export function createChildDiagnosticSink(options: ChildDiagnosticSinkOptions = {}): ChildDiagnosticSink {
	return new FileChildDiagnosticSink(options);
}

/**
 * Run a step; if it throws, flush the sink's run-end line before rethrowing.
 *
 * Why this exists: a real failure recorded BEFORE the child session exists
 * (extension registration) has no `dispose()` to flush it — the armed release is
 * installed later, and a spawn that dies in between would leave the one line the
 * user is owed unwritten. Everything the factory does before it has a session
 * goes through here, so "the run died" never means "the failure went silent".
 */
export async function flushOnFailure<T>(
	sink: ChildDiagnosticSink,
	step: () => Promise<T> | T,
): Promise<T> {
	try {
		return await step();
	} catch (error) {
		sink.flush();
		throw error;
	}
}
