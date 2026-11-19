/**
 * 6.2.5 / D5 — a LIVE child always says where it runs.
 *
 * The reported block (real output) was:
 *
 *   psid-rev-a — state=working agent=centurion kind=pi
 *   alive · quiet 176s (living)
 *   supervisor=terminal
 *   session=/Users/…/runs/r-1bb33dde/psid-rev-a.jsonl
 *
 * The child was running on `hw-nj/t5g`; the block was byte-identical to a local
 * one, so nothing could be found in the Herdr UI. These pin the fix: both facts
 * for every live child, from the run-store record or the ledger row, with an
 * explicit fallback and one line telling the reader how to look at it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { renderLegionStatus } from "../../src/extension/legion-status.ts";
import { renderLiveChildStatus } from "../../src/extension/runtime.ts";
import { renderStatusOverview } from "../../index.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { ChildRecord } from "../../src/shared/types.ts";
import type { LegionNode } from "../../src/legion/nodes.ts";

const HOST = "hw-nj";
const TERMINAL = "hw-nj/t5g";

function record(partial: Partial<ChildRecord> & { name: string }): ChildRecord {
	return {
		sessionFile: `/tmp/${partial.name}.jsonl`,
		ownerToken: `tok-${partial.name}`,
		state: "working",
		spawnedAt: "2026-01-01T00:00:00.000Z",
		agent: "centurion",
		kind: "pi",
		...partial,
	};
}

function node(over: Partial<LegionNode> & Pick<LegionNode, "id" | "name" | "parentId" | "depth">): LegionNode {
	return {
		role: "centurion",
		kind: "pi",
		runId: null,
		sessionFile: null,
		worktreePath: null,
		worktreeHost: null,
		host: null,
		remoteDir: null,
		remoteTerminal: null,
		model: null,
		team: null,
		status: "running",
		phase: null,
		phaseSince: null,
		reworkCount: 0,
		contractPath: null,
		taskSummary: null,
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

test("D5: a live cross-machine child prints host, terminal and how to look at it", () => {
	const text = renderStatusOverview(
		[{ child: record({ name: "psid-rev-a", host: HOST, remoteTerminal: TERMINAL }), alive: true }],
		1_000_000,
	);
	assert.match(text, new RegExp(`^host=${HOST}$`, "m"));
	assert.match(text, new RegExp(`^terminal=${TERMINAL}$`, "m"));
	assert.match(
		text,
		new RegExp(`^see: hc read ${TERMINAL}   \\(cross-machine children have no Herdr pane\\)$`, "m"),
		"the one line that tells the reader how to reach it",
	);
});

test("D5: a live LOCAL child says host=local / terminal=- and grows no hint", () => {
	const text = renderStatusOverview([{ child: record({ name: "worker-0" }), alive: true }], 1_000_000);
	assert.match(text, /^host=local$/m);
	assert.match(text, /^terminal=-$/m, "unknown is printed, never omitted");
	assert.doesNotMatch(text, /^see: hc read /m);
});

test("D5: a live child with a host but no recorded address still prints both lines", () => {
	const text = renderLiveChildStatus({
		name: "psid-rev-a",
		state: "working",
		agent: "centurion",
		kind: "pi",
		sessionFile: "/tmp/psid-rev-a.jsonl",
		alive: true,
		host: HOST,
		now: 0,
	});
	assert.match(text, /^host=hw-nj$/m);
	assert.match(text, /^terminal=-$/m);
	// The hint falls back to the machine, which `hc read` accepts as an address.
	assert.match(text, /^see: hc read hw-nj   \(cross-machine children have no Herdr pane\)$/m);
});

test("D5: the 6.2.4 dead block keeps its shape — cross-machine two lines, local none", () => {
	const remote = renderStatusOverview(
		[{ child: record({ name: "psid-rev-a", state: "orphaned", host: HOST, remoteTerminal: TERMINAL }), alive: false, owner: "dead" }],
		1_000_000,
	);
	assert.match(remote, /^host=hw-nj$/m);
	assert.match(remote, /^terminal=hw-nj\/t5g$/m);
	assert.doesNotMatch(remote, /^see: /m, "a fate note is not a place to look");

	const local = renderStatusOverview(
		[{ child: record({ name: "worker-0", state: "retired" }), alive: false, owner: "dead" }],
		1_000_000,
	);
	assert.doesNotMatch(local, /^host=/m);
	assert.doesNotMatch(local, /^terminal=/m);
});

test("D5: /legion status takes the pair from the ledger row when the record lacks it", () => {
	// The reported shape: run.json holds the child but not the machine facts; the
	// ledger row (schema v5) still knows. The named status must not lose them.
	const facts = {
		name: "psid-rev-a",
		state: "working",
		agent: "centurion",
		kind: "pi",
		sessionFile: "/tmp/psid-rev-a.jsonl",
		alive: true,
	};
	const report = renderLegionStatus({
		query: "psid-rev-a",
		nodes: [
			node({ id: "root", name: "root", parentId: null, depth: 0, role: "root" }),
			node({ id: "root.psid-rev-a", name: "psid-rev-a", parentId: "root", depth: 1, host: HOST, remoteTerminal: TERMINAL }),
		],
		lookupChild: () => facts,
		now: 0,
	});
	assert.equal(report.ok, true);
	assert.match(report.text, /^host=hw-nj$/m);
	assert.match(report.text, /^terminal=hw-nj\/t5g$/m);
});

test("D5: /legion status falls back to the node row when there is no record at all", () => {
	const report = renderLegionStatus({
		query: "root.psid-rev-a",
		nodes: [
			node({ id: "root", name: "root", parentId: null, depth: 0, role: "root" }),
			node({ id: "root.psid-rev-a", name: "psid-rev-a", parentId: "root", depth: 1, host: HOST, remoteTerminal: TERMINAL }),
		],
		now: 0,
	});
	assert.equal(report.ok, true);
	assert.match(report.text, /^host=hw-nj$/m);
	assert.match(report.text, /^terminal=hw-nj\/t5g$/m);
});

test("D5: /legion status and subagent status agree on the same facts", () => {
	const facts = {
		name: "psid-rev-a",
		state: "working",
		agent: "centurion",
		kind: "pi",
		sessionFile: "/tmp/psid-rev-a.jsonl",
		host: HOST,
		remoteTerminal: TERMINAL,
		alive: true,
	};
	const report = renderLegionStatus({ query: "psid-rev-a", nodes: [], lookupChild: () => facts, now: 0 });
	assert.equal(report.text, renderLiveChildStatus({ ...facts, now: 0 }));
});

test("D5 root cause: the fields ARE persisted by the launch path — run.json keeps host/remoteDir/remoteTerminal", async () => {
	// The report claimed `r-1bb33dde/run.json` had `children: []`, which would make
	// D5 a persistence bug rather than a rendering one. Pin the two halves that are
	// checkable here: the launch record carries the pair (`Orchestrator.recordChild`
	// is pinned by `cross-machine-orchestrator.test.ts` / `remote-child-fate.test.ts`),
	// and the run store round-trips them verbatim.
	const root = mkdtempSync(path.join(tmpdir(), "d5-persist-"));
	try {
		const store = new RunStore({ rootDir: root });
		const run = await store.createRun({ task: "t", cwd: "/tmp", path: [], maxDepth: 3, herdr: { supervisor: "terminal", node_id: "root" } });
		await store.addChild(run.runId, record({
			name: "psid-rev-a",
			nodeId: "root.psid-rev-a",
			host: HOST,
			remoteDir: "/srv/.pi-subagents-mirror/no-run/psid-rev-a",
			remoteTerminal: TERMINAL,
		}));
		const stored = store.findChild(run.runId, "psid-rev-a");
		assert.equal(stored?.host, HOST);
		assert.equal(stored?.remoteDir, "/srv/.pi-subagents-mirror/no-run/psid-rev-a");
		assert.equal(stored?.remoteTerminal, TERMINAL);
		// The 0-byte `<runDir>/<name>.jsonl` is the documented LOCAL PLACEHOLDER for a
		// remote child (its transcript lives on the other machine) — an empty file here
		// is the design, not the defect.
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
