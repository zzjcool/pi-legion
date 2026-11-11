/**
 * Child result artifacts: the immutable on-disk bodies behind the result ledger.
 *
 * Contract: `docs/contracts/result-ledger-v1.md` §3 — D1 (identity is
 * `(runId, name, round)` and the round is part of the path), D1a (rounds come
 * from the ledger, disk-only fallback), D1b (identical bytes add no round),
 * D1d (`name` is a path segment, so it is sanitized) and A1 (atomic writes, no
 * half file is ever readable).
 *
 * Nothing here reads env or keeps module-level state, and nothing here decides
 * policy: the orchestrator is still the one writer, this module only answers
 * "which file" / "how many bytes" / "what is the newest one".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "../legion/db.ts";
import { maxRoundFor } from "../legion/ledger.ts";
import { sanitizeNameForFs } from "./store.ts";

/** Directory under a run dir that holds one sub-directory per child name. */
const ARTIFACTS_DIRECTORY = "artifacts";
/** `<runDir>/artifacts/<name>/r<round>.md` — the round is part of the filename. */
const ARTIFACT_FILE_PATTERN = /^r(\d+)\.md$/;

/**
 * One `(run, name)` slice of the artifact store.
 *
 * `db` is optional because `this.legion` is optional in the orchestrator and
 * every orchestrator integration test runs without one (§3 D1a): with a DB the
 * next round is `MAX(round)+1` from the ledger (authoritative, survives a
 * restart), without one it is a directory scan.
 */
export interface ArtifactScope {
	/** Run directory that owns `<runDir>/artifacts/…`. */
	runDir: string;
	/** Child name, **raw** as the caller knows it: both the id segment and the directory are derived from it via {@link artifactNameSegment} (§3 D1d), while the ledger's `name` column keeps this raw value. */
	name: string;
	/** `<runId>` component of the artifact id (§3 D1). */
	runId: string;
	/** Legion connection when the caller has one. */
	db?: DatabaseSync;
}

/** The newest artifact of one `(run, name)` slice, as it is on disk. */
export interface LatestArtifact {
	/** Absolute-or-run-relative path of the body, exactly as it will be written. */
	path: string;
	round: number;
	/** `stat.size` — the same number `rebuild` derives (§3 D10). */
	bytes: number;
}

/**
 * The `<name>` segment of an artifact id and of its path: always SANITIZED
 * (§3 D1d, v1.5).
 *
 * One definition for both halves of the identity — the id
 * (`"<runId>/<segment>/r<round>"`) and the directory it lives in — because
 * `rebuild` can only re-derive the name from the DIRECTORY (D10). A raw-name id
 * would make the writer and the rebuild disagree about the same body.
 */
export function artifactNameSegment(name: string): string {
	return sanitizeNameForFs(name);
}

/**
 * `<runDir>/artifacts/<sanitize(name)>/r<round>.md`.
 *
 * The round in the path is what fixes W6: the old `<name>.output.md` was one file
 * per name, so a second turn of the same name overwrote the first and an unread
 * output physically disappeared.
 *
 * D1d: `name` used to be part of a FILENAME; it is a path SEGMENT now, so `..`
 * and `/` have a different escape surface. {@link sanitizeNameForFs} is the
 * repo's one sanitizer (`worktreePathFor` uses it too) — the ledger keeps the raw
 * name in its `name` column, only the id/path segment is cleaned.
 */
export function artifactPathFor(runDir: string, name: string, round: number): string {
	if (typeof runDir !== "string" || runDir.length === 0) {
		throw new TypeError("runDir must be a non-empty path");
	}
	// 1-based, like the ledger column (D1a): `r0.md` is not an artifact.
	if (!Number.isSafeInteger(round) || round < 1) {
		throw new TypeError("round must be a positive safe integer (artifact rounds are 1-based)");
	}
	return path.join(artifactDirectoryFor(runDir, name), `r${round}.md`);
}

/**
 * The artifact id a path names, or `undefined` when it names none (§3 D5, P5a).
 *
 * The READ-side twin of {@link artifactPathFor}: one definition of "what an artifact
 * path looks like", so a parser here and a writer there can never disagree about the
 * same file. Accepts exactly `<runDir>/artifacts/<segment>/r<round>.md`:
 *
 * - the **canonical** spelling only. `rebuild`/`maxRoundOnDisk` tolerate `r01.md` for
 *   the round cursor, but the writer (`artifactIdFor`/`artifactPathFor`) only ever
 *   produces `r<round>.md`, and the id `"<runId>/<segment>/r<round>"` is compared
 *   against ledger rows keyed by that canonical spelling — answering an id for `r01.md`
 *   would point at a DIFFERENT path than the one that was read;
 * - `round` must be a positive safe integer (`r0.md` is not an artifact, A1);
 * - a segment that would escape (`..`) or is empty is not a name, so not an artifact.
 *
 * `runId` defaults to `path.basename(runDir)` — the same fallback `artifactRunId()` in
 * the orchestrator uses when the run has no legion context, which keeps the id this
 * parser derives equal to the id the writer recorded (`pinned by`
 * `test/unit/artifacts.test.ts`).
 *
 * Paths are resolved before comparing, so a relative `read` argument and an absolute
 * `runDir` can still meet. A path outside `runDir` is `undefined`, never a throw: this
 * is called from a `tool_result` hook (§3 D5).
 */
export function artifactIdFromPath(filePath: string, runDir: string, runId?: string): string | undefined {
	if (typeof filePath !== "string" || filePath.length === 0) return undefined;
	if (typeof runDir !== "string" || runDir.length === 0) return undefined;
	const relative = path.relative(path.resolve(runDir), path.resolve(filePath));
	const parts = relative.split(path.sep);
	if (parts.length !== 3) return undefined;
	const [directory, segment, file] = parts;
	if (directory !== ARTIFACTS_DIRECTORY) return undefined;
	if (segment === undefined || segment.length === 0 || segment === "." || segment === "..") return undefined;
	if (file === undefined) return undefined;
	const match = ARTIFACT_FILE_PATTERN.exec(file);
	if (!match) return undefined;
	const round = Number(match[1]);
	if (!Number.isSafeInteger(round) || round < 1) return undefined;
	// Canonical only: the id names `r<round>.md`, so a differently spelled file (r01.md)
	// must not borrow that identity.
	if (file !== `r${round}.md`) return undefined;
	const idRunId = typeof runId === "string" && runId.length > 0 ? runId : path.basename(path.resolve(runDir));
	return `${idRunId}/${segment}/r${round}`;
}

/**
 * The highest round already used by this `(run, name)`, `0` when none (D1a).
 *
 * **Both** sources, and their maximum (v1.5):
 *
 * - the ledger's `MAX(round)` for this `(runId, name segment)`, which is what
 *   survives a restart, a `dispose()` or a reload — an in-process counter (the
 *   runtime's report round) does **not**, so it can never be the source;
 * - the highest `r<digits>.md` on disk.
 *
 * Taking only the ledger was wrong (found in P2 delivery): delete or replace
 * `legion.db` without running `rebuild` and the ledger says "nothing written",
 * the next write takes round 1 and **overwrites** an existing `r1.md` — A1
 * ("paths are never reused") outranks "one source of truth". Both sources are
 * self-describing: the ledger needs a row, the disk needs a `readdir` and a
 * `r<digits>.md` match.
 *
 * Without a DB this degrades to the disk scan alone — which is what every
 * orchestrator integration test exercises.
 *
 * Deliberately NOT the runtime's report round: that one is an in-process Map
 * (`roundOfName`) cleared on `dispose()`, and it advances on a resume that
 * produced no output at all. Artifact rounds count output rounds; the two
 * semantics are not merged (D1a).
 */
export function latestArtifactRound(scope: ArtifactScope): number {
	const onDisk = maxRoundOnDisk(scope.runDir, scope.name);
	if (!scope.db) return onDisk;
	const inLedger = maxRoundFor(scope.db, { runId: scope.runId, name: artifactNameSegment(scope.name) });
	return Math.max(inLedger, onDisk);
}

/** The round the next write must use (1-based, never a reuse). */
export function nextArtifactRound(scope: ArtifactScope): number {
	return latestArtifactRound(scope) + 1;
}

/**
 * The newest artifact of this `(run, name)`, or `null` when there is none.
 *
 * `bytes` is the on-disk size, which is what the writer compares against before
 * allocating a round (D1b) and what the reader compares against `read_bytes`.
 * A ledger row whose body is gone answers `null`: there is no content to compare
 * with, and the next round must not overwrite a path that a row still points at.
 *
 * The path returned is the file's **real** name from the directory, never one
 * rebuilt from the number: `r01.md` still parses as round 1, and rebuilding
 * `r1.md` from that number would silently answer "nothing to compare against" —
 * turning the D1b dedupe off for a file that is right there. The canonical
 * `r<round>.md` wins when both spellings exist.
 */
export function readLatestArtifact(scope: ArtifactScope): LatestArtifact | null {
	const round = latestArtifactRound(scope);
	if (round < 1) return null;
	const candidates = artifactFilesOnDisk(scope.runDir, scope.name).filter((entry) => entry.round === round);
	if (candidates.length === 0) return null;
	const canonical = path.join(artifactDirectoryFor(scope.runDir, scope.name), `r${round}.md`);
	const file = candidates.find((entry) => entry.file === canonical)?.file ?? candidates[0]!.file;
	let stats: fs.Stats;
	try {
		stats = fs.statSync(file);
	} catch {
		return null;
	}
	if (!stats.isFile()) return null;
	return { path: file, round, bytes: stats.size };
}

/**
 * Write an artifact body atomically and return its size in bytes.
 *
 * A1: `mkdir -p`, then write `${file}.tmp` and `rename` it into place, so a reader
 * never sees a half-written body (same sequence as `src/runs/store.ts`). Mode is
 * `0o600` — a child's result is as private as its session file.
 *
 * The return value is the UTF-8 byte count (`Buffer.byteLength`, not
 * `content.length`), because it becomes the ledger's `bytes` while `rebuild`
 * measures `stat.size`: any other count would make the two paths disagree and
 * drift the "read how much" comparison (A1/D10).
 */
export function writeArtifactAtomic(file: string, content: string): number {
	if (typeof file !== "string" || file.length === 0) {
		throw new TypeError("file must be a non-empty path");
	}
	if (typeof content !== "string") {
		throw new TypeError("content must be a string");
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp`;
	try {
		fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temp, file);
	} catch (error) {
		// A failed write/rename must not leave a full-size body behind: a `.tmp` is
		// not an artifact (nothing reads it, no round parses it) yet it would sit in
		// `artifacts/` forever and be counted by `dirBytes`/retention. Cleanup itself
		// is best-effort; the original failure is what the caller must see.
		try { fs.rmSync(temp, { force: true }); } catch { /* already gone */ }
		throw error;
	}
	return Buffer.byteLength(content, "utf8");
}

/**
 * D1b: does the newest artifact already hold exactly these bytes?
 *
 * Compared as bytes rather than as text, so a multi-byte body cannot match by an
 * accident of normalisation, and short-circuited on the size first (the cheap
 * half of the answer). A read error answers `false`: the caller then writes a new
 * round instead of reusing a body it cannot verify.
 *
 * `null` (no artifact yet) answers `false` — an absent file is never "the same".
 */
export function artifactContentMatches(latest: LatestArtifact | null, content: string): boolean {
	if (!latest) return false;
	try {
		const encoded = Buffer.from(content, "utf8");
		if (encoded.byteLength !== latest.bytes) return false;
		return fs.readFileSync(latest.path).equals(encoded);
	} catch {
		return false;
	}
}

/**
 * Highest `r<digits>.md` in this name's directory; `0` when there is none.
 *
 * Anything that is not `r<digits>.md` is ignored on purpose: a leftover
 * `r1.md.tmp` (a crashed write), `rX.md`, and `r0.md` — round 0 does not exist,
 * so it must not push the next round to 2 from a file nothing ever wrote.
 *
 * `0` means "the directory holds no rounds", so it is only correct for a path
 * that does not exist yet (`ENOENT`/`ENOTDIR`). Every other failure (`EACCES`,
 * `EIO`, …) propagates: answering 0 there would hand out round 1 to a writer over
 * a directory it merely could not read — the other half of the A1 hole v1.5
 * closed. The caller (`writeOutputFile`) already degrades a throw to "wrote
 * nothing", which is the safe answer: never overwrite, rather write nothing.
 */
function maxRoundOnDisk(runDir: string, name: string): number {
	let highest = 0;
	for (const entry of artifactFilesOnDisk(runDir, name)) {
		if (entry.round > highest) highest = entry.round;
	}
	return highest;
}

/** `<runDir>/artifacts/<segment>`, the directory that holds one name's rounds. */
function artifactDirectoryFor(runDir: string, name: string): string {
	return path.join(runDir, ARTIFACTS_DIRECTORY, artifactNameSegment(name));
}

/**
 * The directory entries that really are artifacts, as `{ round, file }` sorted by
 * file name.
 *
 * A missing directory is "no rounds yet" (`[]`); an unreadable one throws — see
 * {@link maxRoundOnDisk} for why that distinction is load-bearing.
 */
function artifactFilesOnDisk(runDir: string, name: string): Array<{ round: number; file: string }> {
	const directory = artifactDirectoryFor(runDir, name);
	let entries: string[];
	try {
		entries = fs.readdirSync(directory);
	} catch (error) {
		if (isMissingPath(error)) return [];
		throw error;
	}
	const files: Array<{ round: number; file: string }> = [];
	for (const entry of entries.sort()) {
		const match = ARTIFACT_FILE_PATTERN.exec(entry);
		if (!match) continue;
		const round = Number(match[1]);
		// 1-based: `r0.md` is not an artifact (A1), and `Number` of a giant digit
		// run is not a safe integer.
		if (!Number.isSafeInteger(round) || round < 1) continue;
		files.push({ round, file: path.join(directory, entry) });
	}
	return files;
}

/** `ENOENT`/`ENOTDIR` = the path is absent, not that we are not allowed to look. */
function isMissingPath(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}
