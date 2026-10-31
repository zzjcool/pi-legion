/**
 * #345: the nested-worktree probe is a real subprocess and only one branch can
 * ever use its answer.
 *
 * `isInsideChildWorktree(cwd)` is a synchronous `git rev-parse` — 5–7ms, 60% of a
 * worker launch — and it was passed INTO `resolveLaunchWorktree`, so it ran before
 * the resolver could short-circuit and its value was then discarded: the demotion
 * guard forces every non-centurion to `worktree: false` whatever the probe
 * said. These tests pin both halves:
 *
 *   - no `git` probe at all for a non-centurion, across the whole
 *     18-row `roleDefault × launch × parentInWorktree` table, with the FINAL
 *     worktree still `false` in every row (no semantic drift);
 *   - a centurion still pays for it, and the probe's value still decides.
 *
 * Spawns are counted by patching the CJS `node:child_process` module and calling
 * `syncBuiltinESMExports()`, so `src/runs/worktree.ts`'s ESM import sees the
 * wrapper — a real subprocess count, not an internal flag.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { resolveLaunchWorktree } from "../../src/runs/worktree.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

// ── the probe counter ──────────────────────────────────────────────────────
const nodeCp = createRequire(import.meta.url)("node:child_process") as {
	execFileSync: (cmd: string, args?: readonly string[], ...rest: unknown[]) => unknown;
};
const realExecFileSync = nodeCp.execFileSync;
let probeSpawns = 0;
nodeCp.execFileSync = ((cmd: string, args?: readonly string[], ...rest: unknown[]) => {
	// The nested-worktree probe is the only `git` call that asks for the common
	// dir; `worktree add` and the `--is-inside-work-tree` check do not.
	if (cmd === "git" && Array.isArray(args) && args.includes("--git-common-dir")) {
		probeSpawns += 1;
	}
	return realExecFileSync(cmd, args, ...rest);
}) as typeof nodeCp.execFileSync;
syncBuiltinESMExports();

after(() => {
	nodeCp.execFileSync = realExecFileSync;
	syncBuiltinESMExports();
});

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "345 test role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test worker.",
		source: "user",
		filePath: "/fake/worker.md",
		...over,
	};
}

/** A tiny real repo, plus a linked worktree of it, both inside one temp root. */
interface Fixture {
	root(): string;
	repo: string;
	linkedWorktree: string;
	cleanup(): void;
}

function fixture(): Fixture {
	const root = mkdtempSync(path.join(tmpdir(), "legion-345-"));
	const repo = path.join(root, "repo");
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "init"]);
	const linkedWorktree = path.join(root, "linked");
	execFileSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", linkedWorktree]);
	return {
		root: () => root,
		repo,
		linkedWorktree,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

interface LaunchResult {
	/** `handle.child.worktreePath` — the arbitrated answer, as the child sees it. */
	worktreePath: string | undefined;
	/** What the supervisor was asked to spawn (the normalized agent config). */
	spawnedWorktree: boolean | undefined;
	spawnMode: string | undefined;
	probeSpawns: number;
}

async function launchOnce(input: {
	fx: Fixture;
	cwd: string;
	agentWorktree: boolean | undefined;
	launchWorktree: boolean | undefined;
	role?: "worker" | "centurion";
	name: string;
}): Promise<LaunchResult> {
	const supervisor = new FakeSupervisor();
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: path.join(input.fx.root(), "runs", input.name),
		cwd: input.cwd,
	});
	const role = input.role ?? "worker";
	const before = probeSpawns;
	const handle = await orchestrator.launch({
		agent: agent({ name: role, ...(input.agentWorktree !== undefined ? { worktree: input.agentWorktree } : {}) }),
		task: "probe me",
		name: input.name,
		...(input.launchWorktree !== undefined ? { worktree: input.launchWorktree } : {}),
	});
	const spawned = supervisor.spawns.at(-1);
	return {
		worktreePath: handle.child.worktreePath,
		spawnedWorktree: spawned?.input.agent.worktree,
		spawnMode: spawned?.input.agent.spawnMode,
		probeSpawns: probeSpawns - before,
	};
}

// ── the frozen 18-row table ────────────────────────────────────────────────

/**
 * `resolveLaunchWorktree` itself, frozen.
 *
 * Written out row by row instead of recomputed, so a change to the precedence —
 * explicit call field, then the top-level launch argument, then the
 * nested-worktree suppression, then the role default — shows up as a diff here
 * rather than silently moving the launch semantics (#345 must not change them).
 */
const RESOLVE_TABLE: Array<{
	roleDefault: boolean | undefined;
	launch: boolean | undefined;
	parentInWorktree: boolean;
	expected: boolean;
}> = [
	// roleDefault: false — nothing can turn it on
	{ roleDefault: false, launch: undefined, parentInWorktree: true, expected: false },
	{ roleDefault: false, launch: undefined, parentInWorktree: false, expected: false },
	{ roleDefault: false, launch: true, parentInWorktree: true, expected: true },
	{ roleDefault: false, launch: true, parentInWorktree: false, expected: true },
	{ roleDefault: false, launch: false, parentInWorktree: true, expected: false },
	{ roleDefault: false, launch: false, parentInWorktree: false, expected: false },
	// roleDefault: true — only the parent-in-worktree suppression turns it off
	{ roleDefault: true, launch: undefined, parentInWorktree: true, expected: false },
	{ roleDefault: true, launch: undefined, parentInWorktree: false, expected: true },
	{ roleDefault: true, launch: true, parentInWorktree: true, expected: true },
	{ roleDefault: true, launch: true, parentInWorktree: false, expected: true },
	{ roleDefault: true, launch: false, parentInWorktree: true, expected: false },
	{ roleDefault: true, launch: false, parentInWorktree: false, expected: false },
	// roleDefault: undefined — off unless asked for
	{ roleDefault: undefined, launch: undefined, parentInWorktree: true, expected: false },
	{ roleDefault: undefined, launch: undefined, parentInWorktree: false, expected: false },
	{ roleDefault: undefined, launch: true, parentInWorktree: true, expected: true },
	{ roleDefault: undefined, launch: true, parentInWorktree: false, expected: true },
	{ roleDefault: undefined, launch: false, parentInWorktree: true, expected: false },
	{ roleDefault: undefined, launch: false, parentInWorktree: false, expected: false },
];

test("#345: resolveLaunchWorktree's 18 combinations are unchanged (frozen table)", () => {
	assert.equal(RESOLVE_TABLE.length, 18);
	for (const row of RESOLVE_TABLE) {
		assert.equal(
			resolveLaunchWorktree({
				...(row.roleDefault !== undefined ? { roleDefault: row.roleDefault } : {}),
				...(row.launch !== undefined ? { launch: row.launch } : {}),
				parentInWorktree: row.parentInWorktree,
			}),
			row.expected,
			`roleDefault=${String(row.roleDefault)} launch=${String(row.launch)} parentInWorktree=${row.parentInWorktree}`,
		);
	}
});

/**
 * The same matrix at the LAUNCH level, for a non-centurion.
 *
 * `finalWorktree` is the demoted answer the child actually gets, so this is the
 * observable the #345 fix must leave alone — while never asking `git` for a value
 * it discards.
 */
test("#345: no non-centurion launch probes git, and every one still ends at worktree: false", async () => {
	const fx = fixture();
	try {
		// Two cwds so the probe's own answer would genuinely differ per row: a plain
		// checkout (probe false) and a linked worktree of it (probe true).
		const cwds = [
			{ label: "plain repo", cwd: fx.repo },
			{ label: "linked worktree", cwd: fx.linkedWorktree },
		];
		let row = 0;
		for (const roleDefault of [false, true, undefined] as const) {
			for (const launch of [undefined, true, false] as const) {
				for (const { label, cwd } of cwds) {
					row += 1;
					const result = await launchOnce({
						fx,
						cwd,
						agentWorktree: roleDefault,
						launchWorktree: launch,
						name: `w${row}`,
					});
					const where = `roleDefault=${String(roleDefault)} launch=${String(launch)} cwd=${label}`;
					assert.equal(result.probeSpawns, 0, `${where}: the probe must not run`);
					assert.equal(result.worktreePath, undefined, `${where}: finalWorktree`);
					assert.equal(result.spawnedWorktree, false, `${where}: the spawn is normalized to false`);
					assert.equal(result.spawnMode, "inprocess", `${where}: a non-centurion stays in-process`);
				}
			}
		}
		assert.equal(row, 18);
	} finally {
		fx.cleanup();
	}
});

test("#345: a centurion launch still probes, and the probe's answer still decides", async () => {
	const fx = fixture();
	try {
		// Linked-worktree cwd → probe true → the nested-worktree suppression applies
		// (roleDefault true, no explicit field): no worktree, and the probe ran.
		const suppressed = await launchOnce({
			fx,
			cwd: fx.linkedWorktree,
			agentWorktree: true,
			launchWorktree: undefined,
			role: "centurion",
			name: "cent-a",
		});
		assert.equal(suppressed.probeSpawns, 1, "a centurion is the branch that pays for the probe");
		assert.equal(suppressed.worktreePath, undefined, "suppression still wins inside a linked worktree");

		// Plain repo → probe false → the role default stands: a real worktree.
		const granted = await launchOnce({
			fx,
			cwd: fx.repo,
			agentWorktree: true,
			launchWorktree: undefined,
			role: "centurion",
			name: "cent-b",
		});
		assert.equal(granted.probeSpawns, 1, "one probe per centurion launch");
		assert.ok(granted.worktreePath, "a centurion in a plain checkout still gets its worktree");
		assert.equal(granted.spawnMode, "rpc", "worktree isolation still implies rpc");

		// An explicit `launch` field still overrides the suppression — the probe is
		// asked, and its `false`/`true` never overrules an explicit answer.
		const explicit = await launchOnce({
			fx,
			cwd: fx.linkedWorktree,
			agentWorktree: false,
			launchWorktree: true,
			role: "centurion",
			name: "cent-c",
		});
		assert.ok(explicit.worktreePath, "an explicit worktree: true still wins over the suppression");
	} finally {
		fx.cleanup();
	}
});
