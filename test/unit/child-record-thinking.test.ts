/**
 * R8 / D-R8.4 — the RECORD must agree with what the child actually runs.
 *
 * A resume replays the model string saved in run.json (`saved.model`) next to
 * the card's CURRENT `thinking`. When the saved model carries a `:level`, that
 * level is what runs — `applyThinkingSuffix` keeps the suffix and only appends
 * when there is none — but `Orchestrator` recorded `input.thinking ?? agent.thinking`
 * (the card's value) instead. run.json then claimed `thinking: max` for a child
 * running `:high`, and every later view (summary detail, status, the next
 * resume's card) repeated the claim.
 *
 * These cases drive the real `Orchestrator` with a recording `FakeSupervisor`,
 * so the assertion can be made on BOTH halves of the contract: the record is
 * honest, AND the spawn is untouched (model string, thinking field and the
 * `--model` argv it produces).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "thinking record test role",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are the worker.",
		source: "user",
		filePath: "/fake/worker.md",
		...overrides,
	};
}

function harness(): {
	orchestrator: Orchestrator;
	supervisor: FakeSupervisor;
	cleanup(): void;
} {
	const root = fs.mkdtempSync(path.join(tmpdir(), "legion-thinking-record-"));
	const runDir = path.join(root, "run");
	fs.mkdirSync(runDir, { recursive: true });
	const supervisor = new FakeSupervisor();
	const orchestrator = new Orchestrator({ supervisor, runDir, cwd: runDir, maxDepth: 4 });
	return {
		orchestrator,
		supervisor,
		cleanup() {
			orchestrator.flushLaunchQueue("test cleanup");
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

test("D-R8.4: a model that carries `:high` records `high`, not the card's `max`", async () => {
	const h = harness();
	try {
		// The resume shape: `saved.model` from run.json + the card's current level.
		const handle = await h.orchestrator.launch({
			agent: agent({ thinking: "max" }),
			task: "resume me",
			name: "worker-0",
			model: "cb/x:high",
			worktree: false,
		});
		assert.equal(handle.child.model, "cb/x:high");
		assert.equal(
			handle.child.thinking,
			"high",
			"the record must name the level the model string really runs",
		);

		// …and the spawn is untouched by the bookkeeping fix: the same model
		// string, the same `thinking` field, the same `--model` argv.
		const spawn = h.supervisor.spawns[0];
		assert.ok(spawn, "the child spawned");
		assert.equal(spawn.input.model, "cb/x:high");
		assert.equal(spawn.input.thinking, "max");
		const modelIdx = spawn.args.indexOf("--model");
		assert.ok(modelIdx >= 0, `the argv carries --model: ${spawn.args.join(" ")}`);
		assert.equal(spawn.args[modelIdx + 1], "cb/x:high", "applyThinkingSuffix keeps the suffix");
	} finally {
		h.cleanup();
	}
});

test("D-R8.4: a model with no suffix still records the configured level (no regression)", async () => {
	const h = harness();
	try {
		const fromCard = await h.orchestrator.launch({
			agent: agent({ thinking: "max" }),
			task: "plain card level",
			name: "worker-0",
			model: "cb/x",
			worktree: false,
		});
		assert.equal(fromCard.child.thinking, "max");
		const first = h.supervisor.spawns[0];
		assert.ok(first, "the child spawned");
		assert.equal(first.args[first.args.indexOf("--model") + 1], "cb/x:max", "no suffix in the model id: the level is appended");

		// An explicit per-launch level outranks the card, and `false` is a real
		// choice — both are recorded as sent.
		const explicit = await h.orchestrator.launch({
			agent: agent({ thinking: "max" }),
			task: "explicit level",
			name: "worker-1",
			model: "cb/x",
			thinking: "low",
			worktree: false,
		});
		assert.equal(explicit.child.thinking, "low");
		const off = await h.orchestrator.launch({
			agent: agent({ thinking: "max" }),
			task: "reasoning off",
			name: "worker-2",
			model: "cb/x",
			thinking: false,
			worktree: false,
		});
		assert.equal(off.child.thinking, false);
	} finally {
		h.cleanup();
	}
});
