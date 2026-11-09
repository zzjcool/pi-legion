/**
 * `root-mail-run-boundary-v1` D2, **production wiring**: where the reader gets
 * published, and where the gate actually reads it.
 *
 * The sibling file (`root-mail-run-boundary.test.ts`) pins the gate against a seam it
 * injects itself. That shape is exactly how the first cut shipped green while being a
 * no-op in a real session — so this file builds **nothing**: no seam, no
 * `LegionPostman`. It drives the real extension entry point and observes only what a
 * real host would see:
 *
 *   - `session_start` publishes nothing (a ROOT has no ledger identity to adopt yet);
 *   - the first `subagent` launch creates the root ledger lazily (`createRootLegion`),
 *     which both starts the REAL postman (2s cadence, `POSTMAN_INTERVAL_MS`) and hands
 *     the identity to `adoptLegionIdentity` — the single publish point;
 *   - with the run live, a PENDING stall notice on that real ledger survives a full
 *     postman tick without a single `pi.sendMessage` (`notice()`'s route) reaching the
 *     host; after `agent_settled` the next tick delivers exactly one copy;
 *   - `session_shutdown` withdraws the reader and nothing resurrects it.
 *
 * The only registry touch here is a direct READ (`isLegionRunActive`) used as an
 * auxiliary diagnostic of the write side. It cannot stand in for the read side: the
 * delivery assertions below come from the real postman's own timer and the real seam
 * `createLegionRuntime` passes it. Delete that seam (`isRunActive` in `index.ts`) and
 * step 4 goes red — the gate is then always open and the notice is injected on the
 * first tick, while the write-side read stays `true`.
 *
 * Likewise, move the publish out of `adoptLegionIdentity` and step 3's `true` (and every
 * delivery assertion after it) goes red, because the root ledger only ever exists via
 * the lazy `createRootLegion`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piLegion from "../../index.ts";
import { openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { MAIL_DELIVERY, inbox, pendingInbox } from "../../src/legion/mail.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { isLegionRunActive } from "../../src/legion/run-active.ts";
import { formatStallNotice } from "../../src/legion/stall-notice.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

initTheme("dark");

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_SUBAGENT_MAX_DEPTH",
	"PI_SUBAGENT_PARENT_PATH",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
];

/** `LegionPostman`'s frozen cadence (`POSTMAN_INTERVAL_MS`, not exported). */
const TICK_MS = 2_000;
/**
 * A window that provably contains a tick AFTER a write: strictly longer than the
 * interval, so no phase alignment between "we wrote" and "it ticks" can hide one.
 */
const ONE_TICK_WINDOW_MS = TICK_MS + 1_000;
/** Bound for the "it must arrive" direction: two ticks plus slack. */
const ARRIVAL_BOUND_MS = 2 * TICK_MS + 2_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Bounded pump over the observable (never a sleep used as synchronisation). */
async function until(pred: () => boolean, label: string, boundMs: number): Promise<void> {
	const deadline = Date.now() + boundMs;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error(`bounded wait expired (${boundMs}ms): ${label}`);
		await sleep(50);
	}
}

/** Ledger path of the tree this extension just created (one root run per session). */
function ledgerPathUnder(cwd: string): string {
	const runsDir = path.join(cwd, ".pi-subagents", "runs");
	const found = fs
		.readdirSync(runsDir)
		.map((runId) => path.join(runsDir, runId, "legion.db"))
		.filter((candidate) => fs.existsSync(candidate));
	assert.equal(found.length, 1, `exactly one ledger for this session: ${found.join(", ")}`);
	return found[0]!;
}

/**
 * The row `writeStallNotice` writes: self-addressed, `notice`, `action-needed`,
 * `PENDING`, body in the frozen `- <child>: ` grammar (same helper as the sibling file).
 */
function queueStallNotice(
	db: DatabaseSync,
	nodeId: string,
	names: readonly string[],
	createdAt: number,
): number {
	const { subject, body } = formatStallNotice(
		names.map((childName) => ({
			kind: "long-running" as const,
			childName,
			sinceBucket: createdAt,
			sequence: 1,
			elapsedMs: 600_000,
			thresholdMs: 600_000,
		})),
		createdAt,
	);
	const inserted = db
		.prepare(
			`INSERT INTO messages (
				from_node, to_node, subject, body, kind, urgency, delivered, created_at
			) VALUES (?, ?, ?, ?, 'notice', 'action-needed', ?, ?)`,
		)
		.run(nodeId, nodeId, subject, body, MAIL_DELIVERY.PENDING, createdAt);
	return Number(inserted.lastInsertRowid);
}

/** Dispatch one host event through the handlers this extension registered. */
async function fire(
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>,
	name: string,
	...args: unknown[]
): Promise<void> {
	for (const handler of handlers.get(name) ?? []) await handler(...args);
}

test("D2 production wiring: the real postman's root gate follows agent_start / agent_settled", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "legion-root-run-boundary-"));
	const agentDir = path.join(cwd, "agent-config");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({}));
	const rootSessionFile = path.join(cwd, "root-session.jsonl");
	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }> }> }>();
	/** Everything the real `notice()` route handed the host through `pi.sendMessage`. */
	const hostMessages: string[] = [];
	const pi = {
		registerTool(tool: unknown) {
			const typed = tool as { name: string; execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }> }> };
			tools.set(typed.name, typed);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage(message: { content?: unknown }) {
			hostMessages.push(typeof message?.content === "string" ? message.content : JSON.stringify(message?.content));
		},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	};
	const ctx = {
		cwd,
		hasUI: false,
		ui: { notify() {}, setStatus() {} },
		sessionManager: { getSessionFile: () => rootSessionFile },
	};
	let db: DatabaseSync | undefined;
	let dbClosed = false;
	const closeDb = (): void => {
		if (db && !dbClosed) {
			db.close();
			dbClosed = true;
		}
	};
	let shutdownFired = false;
	/**
	 * Run the extension's own `session_shutdown` chain once. Used by step 6 (as the thing
	 * under test) and by `finally` (so a FAILING run cannot leave the postman interval and
	 * the extension's ledger handle alive — a hung test process is worse than the failure).
	 */
	const fireShutdown = async (): Promise<void> => {
		if (shutdownFired) return;
		shutdownFired = true;
		for (const handler of handlers.get("session_shutdown") ?? []) await handler();
	};
	/** Stall texts the HOST was handed — the only route a root injection can take. */
	const stallTexts = (): string[] => hostMessages.filter((text) => text.includes("Stall notice: watcher"));
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		for (const name of ENV_KEYS.slice(1)) delete process.env[name];
		piLegion(pi as never, { supervisor: new FakeSupervisor({ autoSettle: { text: '{"ok":true}' } }) });
		const tool = tools.get("subagent");
		assert.ok(tool, "subagent tool registered");

		// 1. `session_start` publishes NOTHING: before the first launch a ROOT has no ledger
		//    identity to adopt. This is the step the defective cut mistook for a publish point.
		await fire(handlers, "session_start", {}, ctx);
		assert.equal(isLegionRunActive("root"), false, "no identity yet ⇒ nothing adopted ⇒ nothing published");

		// 2. First launch: the root ledger is created lazily (`createRootLegion`), which
		//    starts the REAL postman and hands the identity to `adoptLegionIdentity` (the
		//    single publish point).
		await tool.execute(
			"t",
			{ agent: "worker", task: "probe the root ledger", async: true, worktree: false },
			undefined,
			undefined,
			ctx as never,
		);
		db = openLegionDb(ledgerPathUnder(cwd));

		// A `running` child on the real ledger, born now: the stall predicate judges the
		// notice alive, and the L2 detector has no window to announce something on top of it.
		const bornAt = Date.now();
		insertNode(db, { parentId: "root", name: "watcher", role: "worker", status: "running" }, () => bornAt);

		// 3. The run starts; the notice is written AFTER that, so no tick can race it.
		await fire(handlers, "agent_start", {}, ctx);
		assert.equal(
			isLegionRunActive("root"),
			true,
			"auxiliary read of the write side: adoption published `() => parentRunActive` for the lazy root ledger",
		);
		const messageId = queueStallNotice(db, "root", ["watcher"], bornAt);

		// 4. A full tick with the run live: the real postman must inject nothing.
		await sleep(ONE_TICK_WINDOW_MS);
		assert.deepEqual(
			stallTexts(),
			[],
			"the real postman pushed nothing into the host queue while root's run was live",
		);
		assert.deepEqual(pendingInbox(db, "root").map((message) => message.id), [messageId], "the row waits, PENDING");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0);

		// 5. `agent_settled` is the boundary: the next real tick delivers, exactly once.
		await fire(handlers, "agent_settled", {}, ctx);
		await until(() => stallTexts().length > 0, "the notice to reach the host after the boundary", ARRIVAL_BOUND_MS);
		assert.equal(stallTexts().length, 1, "exactly one copy crossed into the host queue");
		assert.equal(pendingInbox(db, "root").length, 0);
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);

		// 6. Shutdown withdraws the reader. Kept in the MAIN flow, not in cleanup: a
		//    cleanup-time failure must not be able to mask a real one (and vice versa).
		await fireShutdown();
		assert.equal(isLegionRunActive("root"), false, "dispose() withdrew the reader");
		// …and it stays withdrawn: an `agent_start` after the session is gone cannot
		// resurrect a reader the runtime took with it, so the session is fail-open (D3).
		await fire(handlers, "agent_start", {}, ctx);
		assert.equal(isLegionRunActive("root"), false, "no reader, no gate — fail-open (D3)");
		closeDb(); // after `session_shutdown`, per review
	} finally {
		// Teardown only — no assertions here, so a failure in the body above is reported as
		// itself. Best effort by design: the body may have already shut everything down.
		try {
			await fireShutdown();
		} catch {
			/* the session is going away either way */
		}
		closeDb();
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
