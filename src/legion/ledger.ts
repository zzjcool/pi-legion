import type { DatabaseSync, SqliteRow } from "./db.ts";
import { sqliteHasRow } from "./db.ts";

/**
 * Result ledger (P1): pure data access over the v3 `artifacts` / `consumptions`
 * tables. Contract: `docs/contracts/result-ledger-v1.md` §3 D2/D4/D6/A2.
 *
 * Nothing here reads env or module-level state: every function takes the
 * connection, exactly like `usage.ts` / `nodes.ts`. Delivery, notification and
 * projection wiring belong to later phases; this file only stores the two
 * orthogonal consumption facts and answers the one suppression predicate.
 */

/** An immutable child result: identity = `(runId, name, round)` (§3 D1). */
export interface Artifact {
	/** `"<runId>/<name>/r<round>"` — never reused, so it is safe as a path key. */
	id: string;
	/** Consumer node id: the artifact's parent (root or a centurion). */
	parentId: string;
	/** Node id of the child that produced the output. */
	nodeId: string;
	name: string;
	round: number;
	/** Absolute path of the artifact body on disk. */
	path: string;
	bytes: number;
	createdAt: number;
}

/** Everything {@link recordArtifact} needs; same shape as {@link Artifact}. */
export type NewArtifact = Artifact;

/**
 * The two orthogonal per-consumer facts (A2):
 * `read_bytes` is a high-water mark of how much of the body was read,
 * `notified_at` records the first successful notice delivery.
 */
export interface Consumption {
	artifactId: string;
	consumerId: string;
	readBytes: number;
	readAt: number | null;
	notifiedAt: number | null;
}

/** Which `(runId, name)` slice of the artifact table a round belongs to. */
export interface ArtifactRoundScope {
	runId: string;
	/**
	 * The artifact id's `<name>` **segment**, i.e. the sanitized directory name
	 * (`artifactNameSegment` in `src/runs/artifacts.ts`), not the raw child name.
	 * The `artifacts.name` column keeps the raw value; the id must match the path
	 * so a `rebuild` that only has the directory arrives at the same id (§3 D1d).
	 */
	name: string;
}

export interface MarkReadInput {
	artifactId: string;
	consumerId: string;
	/** Bytes readable by this consumer; stored as a max (never moves backwards). */
	bytesRead: number;
	at: number;
}

export interface MarkNotifiedInput {
	artifactId: string;
	consumerId: string;
	at: number;
}

const ARTIFACT_COLUMNS = "id, parent_id, node_id, name, round, path, bytes, created_at";

/**
 * Insert one artifact row, or leave the existing row untouched.
 *
 * `ON CONFLICT(id) DO NOTHING` — not `INSERT OR REPLACE` (contract A1b): a
 * replay must be idempotent **without updating**, because REPLACE can shrink
 * `bytes`, which makes `read_bytes >= bytes` true early, flips "read half" into
 * "read all" and silently drops a notice. REPLACE is also DELETE+INSERT and
 * would later cascade away the consumption facts of that artifact.
 *
 * Artifact identity is immutable, so a second write of the same id can only be
 * a replay of the same fact.
 */
export function recordArtifact(db: DatabaseSync, input: NewArtifact): void {
	assertNonEmptyString(input.id, "id");
	assertNonEmptyString(input.parentId, "parentId");
	assertNonEmptyString(input.nodeId, "nodeId");
	assertNonEmptyString(input.name, "name");
	assertNonEmptyString(input.path, "path");
	if (!Number.isSafeInteger(input.round) || input.round < 0) {
		throw new TypeError("round must be a non-negative safe integer");
	}
	// A1: an empty output never becomes an artifact (D1), so 0 bytes is invalid.
	assertPositiveInteger(input.bytes, "bytes");
	assertTimestamp(input.createdAt, "createdAt");
	db.prepare(
		`INSERT INTO artifacts (${ARTIFACT_COLUMNS})
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO NOTHING`,
	).run(
		input.id,
		input.parentId,
		input.nodeId,
		input.name,
		input.round,
		input.path,
		input.bytes,
		input.createdAt,
	);
}

export function artifactById(db: DatabaseSync, id: string): Artifact | null {
	assertNonEmptyString(id, "id");
	const row = db.prepare(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?`).get(id);
	return row ? mapArtifact(row) : null;
}

/**
 * The highest artifact round recorded for one `(runId, name)`, or `0` when there
 * is none.
 *
 * The artifact id is `"<runId>/<name>/r<round>"` (§3 D1), so the scope is a plain
 * prefix of the primary key — no extra table, column or index. `name` is matched
 * together with its surrounding separators (`"<runId>/<name>/r"`), which is what
 * keeps `a` from swallowing `ab` and one run id from swallowing another.
 *
 * `name` is the id segment (already sanitized by the caller — see
 * {@link ArtifactRoundScope}), because `rebuild` re-derives the id from the
 * on-disk directory name and both sides must agree (§3 D1d v1.5).
 *
 * Read-only on purpose: the round generator lives in `src/runs/artifacts.ts`
 * (§3 D1a) and this function is its only ledger dependency.
 */
export function maxRoundFor(db: DatabaseSync, input: ArtifactRoundScope): number {
	assertNonEmptyString(input.runId, "runId");
	assertNonEmptyString(input.name, "name");
	const prefix = `${input.runId}/${input.name}/r`;
	const row = db
		.prepare(
			`SELECT COALESCE(MAX(round), 0) AS max_round
			 FROM artifacts
			 WHERE substr(id, 1, length(?)) = ?`,
		)
		.get(prefix, prefix);
	return Number(row?.max_round ?? 0);
}

/** Artifacts whose consumer is `parentId`, oldest first (stable tie-break on id). */
export function listArtifacts(db: DatabaseSync, parentId: string): Artifact[] {
	assertNonEmptyString(parentId, "parentId");
	return db
		.prepare(
			`SELECT ${ARTIFACT_COLUMNS} FROM artifacts
			 WHERE parent_id = ?
			 ORDER BY created_at ASC, id ASC`,
		)
		.all(parentId)
		.map(mapArtifact);
}

/**
 * Record how much of the body a consumer managed to read.
 *
 * `read_bytes` is a high-water mark: `max()` keeps a re-read of an earlier,
 * shorter range from lowering it (a paging client that scrolls back up must not
 * be re-notified). `read_at` tracks the latest read attempt. `notified_at` is
 * deliberately absent from the update list — reading never rewrites it.
 */
export function markRead(db: DatabaseSync, input: MarkReadInput): void {
	assertNonEmptyString(input.artifactId, "artifactId");
	assertNonEmptyString(input.consumerId, "consumerId");
	assertNonNegativeInteger(input.bytesRead, "bytesRead");
	assertTimestamp(input.at, "at");
	db.prepare(
		`INSERT INTO consumptions (artifact_id, consumer_id, read_bytes, read_at, notified_at)
		 VALUES (?, ?, ?, ?, NULL)
		 ON CONFLICT(artifact_id, consumer_id) DO UPDATE SET
			read_bytes = max(read_bytes, excluded.read_bytes),
			read_at = excluded.read_at`,
	).run(input.artifactId, input.consumerId, input.bytesRead, input.at);
}

/**
 * Record the first successful notice delivery for a consumer.
 *
 * Write-once in the only sense that matters: `COALESCE(notified_at, excluded.…)`
 * keeps the original timestamp, so a replayed delivery cannot move the moment
 * (and can never clear it — nothing here ever writes `NULL` over a value).
 */
export function markNotified(db: DatabaseSync, input: MarkNotifiedInput): void {
	assertNonEmptyString(input.artifactId, "artifactId");
	assertNonEmptyString(input.consumerId, "consumerId");
	assertTimestamp(input.at, "at");
	db.prepare(
		`INSERT INTO consumptions (artifact_id, consumer_id, read_bytes, read_at, notified_at)
		 VALUES (?, ?, 0, NULL, ?)
		 ON CONFLICT(artifact_id, consumer_id) DO UPDATE SET
			notified_at = COALESCE(notified_at, excluded.notified_at)`,
	).run(input.artifactId, input.consumerId, input.at);
}

/** The stored consumption row for one `(artifact, consumer)` pair, if any. */
export function consumptionFor(
	db: DatabaseSync,
	artifactId: string,
	consumerId: string,
): Consumption | null {
	assertNonEmptyString(artifactId, "artifactId");
	assertNonEmptyString(consumerId, "consumerId");
	const row = db
		.prepare(
			`SELECT artifact_id, consumer_id, read_bytes, read_at, notified_at
			 FROM consumptions WHERE artifact_id = ? AND consumer_id = ?`,
		)
		.get(artifactId, consumerId);
	return row ? mapConsumption(row) : null;
}

/**
 * True when this consumer has read the whole body (`read_bytes >= artifacts.bytes`).
 *
 * Byte coverage, not a rank: paging through part of the file answers `false`
 * (§3 D6 — "read half is not read"). An unknown artifact answers `false`; there
 * is nothing to have read.
 */
export function hasRead(db: DatabaseSync, artifactId: string, consumerId: string): boolean {
	assertNonEmptyString(artifactId, "artifactId");
	assertNonEmptyString(consumerId, "consumerId");
	const row = db
		.prepare(
			`SELECT 1 AS found
			 FROM artifacts AS artifact
			 JOIN consumptions AS consumption
			   ON consumption.artifact_id = artifact.id AND consumption.consumer_id = ?
			 WHERE artifact.id = ? AND consumption.read_bytes >= artifact.bytes
			 LIMIT 1`,
		)
		.get(consumerId, artifactId);
	return sqliteHasRow(row);
}

/**
 * The notice projection (§3 D4): artifacts this consumer owns, has not been
 * notified about, and has not fully read.
 *
 * The predicate lives here and only here — all three conjuncts, none optional
 * (D2):
 *
 * ```
 * a.parent_id = :consumerId                       -- whose artifact it is
 * AND c.notified_at IS NULL                       -- never announced
 * AND COALESCE(c.read_bytes, 0) < a.bytes         -- not read to EOF
 * ```
 *
 * `parent_id` is the consumer scope: `consumptions` is a two-dimensional
 * `(artifact_id, consumer_id)` table, so without it a consumer would be handed
 * its siblings' — or another run's — artifacts and the notice would go to the
 * wrong node. Consequences that are intentional:
 * - a notification is sent at most once per artifact, however little was read;
 * - reading the whole body settles the artifact even if nothing was notified;
 * - a partial read suppresses nothing (§3 D6).
 * Ordered `created_at ASC, id ASC` so paging through the projection is stable;
 * the `(parent_id, created_at)` index serves both the scope and the order.
 */
export function undelivered(db: DatabaseSync, consumerId: string): Artifact[] {
	assertNonEmptyString(consumerId, "consumerId");
	return db
		.prepare(
			`SELECT ${prefixColumns("a", ARTIFACT_COLUMNS)}
			 FROM artifacts AS a
			 LEFT JOIN consumptions AS c
			   ON c.artifact_id = a.id AND c.consumer_id = ?
			 WHERE a.parent_id = ?
			   AND c.notified_at IS NULL
			   AND COALESCE(c.read_bytes, 0) < a.bytes
			 ORDER BY a.created_at ASC, a.id ASC`,
		)
		.all(consumerId, consumerId)
		.map(mapArtifact);
}

function prefixColumns(alias: string, columns: string): string {
	return columns
		.split(",")
		.map((column) => `${alias}.${column.trim()}`)
		.join(", ");
}

function mapArtifact(row: SqliteRow): Artifact {
	return {
		id: String(row.id),
		parentId: String(row.parent_id),
		nodeId: String(row.node_id),
		name: String(row.name),
		round: Number(row.round),
		path: String(row.path),
		bytes: Number(row.bytes),
		createdAt: Number(row.created_at),
	};
}

function mapConsumption(row: SqliteRow): Consumption {
	return {
		artifactId: String(row.artifact_id),
		consumerId: String(row.consumer_id),
		readBytes: Number(row.read_bytes),
		readAt: row.read_at === null || row.read_at === undefined ? null : Number(row.read_at),
		notifiedAt:
			row.notified_at === null || row.notified_at === undefined ? null : Number(row.notified_at),
	};
}

function assertNonEmptyString(value: string, field: string): void {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${field} must be a non-empty string`);
	}
}

function assertNonNegativeInteger(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${field} must be a non-negative safe integer`);
	}
}

function assertPositiveInteger(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new TypeError(`${field} must be a positive safe integer (an empty artifact does not exist, A1)`);
	}
}

function assertTimestamp(value: number, field: string): void {
	if (!Number.isFinite(value)) {
		throw new TypeError(`${field} must be a finite millisecond timestamp`);
	}
}
