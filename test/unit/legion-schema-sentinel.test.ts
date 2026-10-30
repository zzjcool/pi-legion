import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const contract = readFileSync(
	fileURLToPath(new URL("../../docs/legion-v2-contract.md", import.meta.url)),
	"utf8",
);

const EXPECTED_COLUMNS: Record<string, readonly string[]> = {
	nodes: [
		"id",
		"parent_id",
		"name",
		"role",
		"kind",
		"depth",
		"run_id",
		"session_file",
		"worktree_path",
		"model",
		"team",
		"status",
		"phase",
		"phase_since",
		"rework_count",
		"contract_path",
		"task_summary",
		"created_at",
		"updated_at",
	],
	events: ["id", "node_id", "type", "data", "ts"],
	usage: ["node_id", "tokens_in", "tokens_out", "cost_usd", "updated_at"],
	messages: [
		"id",
		"from_node",
		"to_node",
		"subject",
		"body",
		"kind",
		"urgency",
		"delivered",
		"delivered_at",
		"created_at",
	],
};

const EXPECTED_INDEXES = [
	{ table: "nodes", name: "idx_nodes_parent", columns: ["parent_id"] },
	{ table: "nodes", name: "idx_nodes_status", columns: ["status", "updated_at"] },
	{ table: "events", name: "idx_events_node", columns: ["node_id", "id"] },
	{ table: "events", name: "idx_events_type_ts", columns: ["type", "ts"] },
	{ table: "messages", name: "idx_messages_inbox", columns: ["to_node", "delivered", "id"] },
	{ table: "messages", name: "idx_messages_rate", columns: ["from_node", "created_at"] },
] as const;

const EXPECTED_EVENTS = [
	"node_launched",
	"node_settled",
	"node_failed",
	"node_retired",
	"node_resumed",
	"node_blocked",
	// `node_abandoned` (hygiene's `markAbandoned`, #233) and `node_handled` (#309)
	// reached `LEGION_EVENT_TYPES` without the §4.3 list following them, so the
	// sentinel kept certifying a 14-name contract while the code wrote 16 types.
	// REV-22 of `docs/legion-v2-contract.md` records the revision; this list moves
	// with it, on purpose and once.
	"node_abandoned",
	"node_handled",
	"phase_change",
	"phase_timeout",
	"mail_sent",
	"mail_delivered",
	"mail_bounced",
	"budget_refused",
	"orphan_detected",
	"tree_finalized",
] as const;

function tableBody(sql: string, table: string): string {
	const match = sql.match(
		new RegExp(
			`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(([\\s\\S]*?)\\);`,
			"i",
		),
	);
	assert.ok(
		match,
		`Schema sentinel: §4.2 is missing CREATE TABLE ${table}; if the contract schema is intentionally revised, update this test explicitly.`,
	);
	return match[1] ?? "";
}

function declaredColumns(body: string): string[] {
	return body
		.split(/\r?\n/)
		.map((line) => line.match(/^\s*([a-z_][a-z0-9_]*)\s+[a-z_][a-z0-9_]*/i)?.[1])
		.filter((column): column is string => column !== undefined);
}

test("legion v2 contract §4.2 keeps the frozen four-table schema", () => {
	const schemaSection = contract.match(/^### 4\.2\b[\s\S]*?(?=^### 4\.3\b)/m)?.[0];
	assert.ok(schemaSection, "Schema sentinel: contract §4.2 is missing; update this test explicitly when revising the contract.");

	const sql = schemaSection.match(/```sql\s*([\s\S]*?)```/)?.[1];
	assert.ok(sql, "Schema sentinel: §4.2 is missing its SQL code block; update this test explicitly when revising the contract.");
	const userVersions = Array.from(
		schemaSection.matchAll(/\bPRAGMA\s+user_version\s*=\s*(\d+)\b/gi),
		(match) => match[1] ?? "",
	);
	assert.ok(
		userVersions.length > 0,
		"Schema sentinel: §4.2 must declare PRAGMA user_version; update this test explicitly when revising the contract.",
	);
	const unexpectedUserVersions = userVersions.filter((version) => version !== "1");
	assert.deepEqual(
		unexpectedUserVersions,
		[],
		`Schema sentinel: every §4.2 PRAGMA user_version declaration must remain 1 (found: ${userVersions.join(", ")}). If the contract schema is intentionally revised, update this test explicitly.`,
	);

	const expectedTables = Object.keys(EXPECTED_COLUMNS);
	const actualTables = Array.from(
		sql.matchAll(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gim),
		(match) => match[1] ?? "",
	);
	const missingTables = expectedTables.filter((table) => !actualTables.includes(table));
	const unexpectedTables = actualTables.filter((table) => !expectedTables.includes(table));
	assert.deepEqual(
		[...actualTables].sort(),
		[...expectedTables].sort(),
		`Schema sentinel: §4.2 must define exactly nodes/events/usage/messages (missing: ${missingTables.join(", ") || "none"}; unexpected: ${unexpectedTables.join(", ") || "none"}); update this test explicitly when revising the contract.`,
	);

	for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
		const actual = declaredColumns(tableBody(sql, table));
		const missing = expected.filter((column) => !actual.includes(column));
		const unexpected = actual.filter((column) => !expected.includes(column));
		const duplicates = actual.filter((column, index) => actual.indexOf(column) !== index);
		assert.deepEqual(
			[...actual].sort(),
			[...expected].sort(),
			`Schema sentinel: §4.2 ${table} columns changed (missing: ${missing.map((column) => `${table}.${column}`).join(", ") || "none"}; unexpected: ${unexpected.map((column) => `${table}.${column}`).join(", ") || "none"}; duplicates: ${duplicates.map((column) => `${table}.${column}`).join(", ") || "none"}). If the contract schema is intentionally revised, update this test explicitly.`,
		);
	}

	// Capture the column list too, not just the name: the index SET below compares
	// names only, so a reordered tuple would otherwise slip through. Order is
	// load-bearing (e.g. a swapped idx_messages_inbox tuple stops serving the
	// delivery-less inbox read, mail.ts `inbox()`; a swapped idx_messages_rate
	// tuple costs ~40x on the rate-limit COUNT -- see legion-mail-rate-index.test.ts).
	const actualIndexes = Array.from(
		sql.matchAll(/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+ON\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gim),
		(match) => ({
			name: match[1] ?? "",
			table: match[2] ?? "",
			columns: (match[3] ?? "").split(",").map((column) => column.trim()).filter((column) => column.length > 0),
		}),
	);
	const actualIndexKeys = actualIndexes.map(({ name, table }) => `${table}.${name}`);
	const expectedIndexes = EXPECTED_INDEXES.map(({ name, table }) => `${table}.${name}`);
	const missingIndexes = expectedIndexes.filter((index) => !actualIndexKeys.includes(index));
	const unexpectedIndexes = actualIndexKeys.filter((index) => !expectedIndexes.includes(index));
	assert.deepEqual(
		[...actualIndexKeys].sort(),
		[...expectedIndexes].sort(),
		`Schema sentinel: §4.2 index set changed (missing: ${missingIndexes.join(", ") || "none"}; unexpected: ${unexpectedIndexes.join(", ") || "none"}). If the contract schema is intentionally revised, update this test explicitly.`,
	);

	// Ordered tuple per known index, so reordering one is a test failure rather
	// than a silent plan change.
	for (const expected of EXPECTED_INDEXES) {
		const actual = actualIndexes.find((index) => index.name === expected.name && index.table === expected.table);
		assert.ok(
			actual,
			`Schema sentinel: §4.2 is missing CREATE INDEX ${expected.name} ON ${expected.table}; update this test explicitly when revising the contract.`,
		);
		assert.deepEqual(
			actual.columns,
			[...expected.columns],
			`Schema sentinel: §4.2 ${expected.name} column order changed (found: ${JSON.stringify(actual.columns)}; expected: ${JSON.stringify([...expected.columns])}). Index tuples are load-bearing for the queries they serve. If the contract schema is intentionally revised, update this test explicitly.`,
		);
	}
});

test("legion v2 contract §4.3 keeps exactly the frozen 16 event names", () => {
	const eventsSection = contract.match(/^### 4\.3\b[\s\S]*?(?=^### 4\.4\b)/m)?.[0];
	assert.ok(eventsSection, "Schema sentinel: contract §4.3 is missing; update this test explicitly when revising the contract.");

	const eventListLine = eventsSection
		.split(/\r?\n/)
		.slice(1)
		.find((line) => line.trim().length > 0);
	assert.ok(
		eventListLine,
		"Schema sentinel: §4.3 is missing its event-name list line; update this test explicitly when revising the contract.",
	);
	const actualEvents = Array.from(
		eventListLine.matchAll(/`([^`]+)`/g),
		(match) => match[1] ?? "",
	);
	const expectedEvents: readonly string[] = EXPECTED_EVENTS;
	const missing = expectedEvents.filter((event) => !actualEvents.includes(event));
	const unexpected = actualEvents.filter((event) => !expectedEvents.includes(event));
	const duplicates = actualEvents.filter((event, index) => actualEvents.indexOf(event) !== index);
	assert.deepEqual(
		[...actualEvents].sort(),
		[...expectedEvents].sort(),
		`Schema sentinel: §4.3 must contain exactly 16 events (found ${actualEvents.length}; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}; duplicates: ${duplicates.join(", ") || "none"}). If the contract event set is intentionally revised, update this test explicitly.`,
	);
});

test("legion v2 contract §11.1 keeps the three frozen gate defaults", () => {
	const limitsSection = contract.match(/^### 11\.1\b[\s\S]*?(?=^### 11\.2\b)/m)?.[0];
	assert.ok(limitsSection, "Schema sentinel: contract §11.1 is missing; update this test explicitly when revising the contract.");

	const tableRows = limitsSection
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^\|/.test(line))
		.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
	const header = tableRows[0] ?? [];
	const defaultColumn = header.findIndex((cell) => cell === "默认");
	assert.ok(
		defaultColumn >= 0,
		"Schema sentinel: §11.1 limit table is missing the 默认 column; update this test explicitly when revising the contract.",
	);

	for (const [name, value] of [
		["maxDepth", "4"],
		["maxChildrenPerNode", "8"],
		["maxActiveNodes", "30"],
		// #266: the admission queue's own bound. Registered here because it is a
		// hard cap in the same table, and the row is what tells operators that a
		// saturated queue refusing a launch is a limit, not a bug.
		["maxQueuedLaunches", "32"],
	] as const) {
		const row = tableRows.find((cells) => cells[0]?.includes(`\`${name}\``));
		assert.ok(row, `Schema sentinel: §11.1 is missing the ${name} default row; update this test explicitly when revising the contract.`);
		const actualDefault = row[defaultColumn]?.trim() ?? "<missing>";
		assert.equal(
			actualDefault,
			value,
			`Schema sentinel: §11.1 ${name} default must remain ${value} (found: ${actualDefault}); update this test explicitly when revising the contract.`,
		);
	}
});
