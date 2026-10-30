/**
 * #338 M1: the root ledger row has to record THIS session's file.
 *
 * The postman proves `DELIVERED` from `nodes.session_file` — the recipient's own
 * turns (`mailReachedTurns`). Children get that column from `reserveNode`; the root
 * node is created by `createRootLegion`, which used to leave it NULL. Root is a
 * recipient too (`legion_mail({ to: "parent" })` from a top-level centurion, which is
 * the entire #333 phase-timeout path), so without the column every one of those
 * mails sat at `ACCEPTED` forever.
 *
 * The first assertion drives the real extension entry point, so it fails if the
 * creation site stops recording the file; the second pins the payoff end to end.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piLegion from "../../index.ts";
import { LegionPostman } from "../../src/extension/legion-tools.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { getChildren, getNode } from "../../src/legion/nodes.ts";
import { MAIL_DELIVERY, formatMail, inbox, sendMail } from "../../src/legion/mail.ts";
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

function userSession(texts: readonly string[]): string {
	return `${texts.map((text) => JSON.stringify({ type: "message", message: { role: "user", content: text } })).join("\n")}\n`;
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

test("#338 M1: createRootLegion records the root session file, and root mail can reach DELIVERED", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "legion-root-session-"));
	const agentDir = path.join(cwd, "agent-config");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({}));
	const rootSessionFile = path.join(cwd, "root-session.jsonl");
	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }> }> }>();
	const pi = {
		registerTool(tool: unknown) {
			const typed = tool as { name: string; execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }> }> };
			tools.set(typed.name, typed);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	};
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		for (const name of ENV_KEYS.slice(1)) delete process.env[name];
		piLegion(pi as never, { supervisor: new FakeSupervisor({ autoSettle: { text: '{"ok":true}' } }) });
		const tool = tools.get("subagent");
		assert.ok(tool, "subagent tool registered");
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify() {}, setStatus() {} },
			// The identity credential the CLI hands the extension: this process's own
			// session file. `createRootLegion` must persist it on the root row.
			sessionManager: { getSessionFile: () => rootSessionFile },
		};

		await tool.execute("t", { agent: "worker", task: "probe the root row", async: true, worktree: false }, undefined, undefined, ctx as never);

		const db = openLegionDb(ledgerPathUnder(cwd));
		try {
			assert.equal(
				getNode(db, "root")?.sessionFile,
				rootSessionFile,
				"the root node records this session's file, like every child node does",
			);

			const child = getChildren(db, "root")[0];
			assert.ok(child, "the launch created a child node to send mail from");
			const sent = sendMail(db, { fromNode: child.id, to: "parent", subject: "verdict", body: "ready" }, { now: () => 10 });
			assert.equal(sent.ok, true);
			if (!sent.ok) return;
			const message = sent.messages[0]!;

			let now = 20;
			const inboxForRoot: string[] = [];
			const postman = new LegionPostman({
				db,
				nodeId: "root",
				supervisor: new FakeSupervisor(),
				now: () => now,
				sendRootMessage: (text) => inboxForRoot.push(text),
				intervalMs: 10_000,
			});
			await postman.tick();
			assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1, "the send returned — nothing more is known yet");

			fs.writeFileSync(rootSessionFile, userSession([formatMail(message)]));
			now = 30;
			await postman.tick();
			postman.stop();
			assert.equal(
				inbox(db, "root", { delivery: MAIL_DELIVERY.DELIVERED }).length,
				1,
				"root's own session is evidence, so mail to root is confirmable",
			);
		} finally {
			db.close();
		}
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler();
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
