/**
 * perf-core bench 2 — how many times does one `subagent({action:"collect"})`
 * parse the child's session file, and what does that cost on real transcripts?
 *
 * Part A surveys the real session JSONL corpus (p50/p90/p99 bytes + turns) and
 * measures the production warm-parse cost on it.
 * Part B instruments `fs.openSync` (the same technique
 * `test/unit/collect-polling.test.ts` uses) to count how many times the
 * production `Orchestrator` opens one child's session file during the exact
 * sequence the tool runs: cachedCollect → collect → retire.
 *
 * Run: node --experimental-strip-types bench/perf-core/02-collect-parses.ts [runsDir]
 */

import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import { parseSessionFile } from "../../src/shared/session.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../../test/helpers/fake-supervisor.ts";

const REPS = 3;
const RUNS_DIR = process.argv[2] ?? "/root/code/pi-legion/.pi-subagents/runs";

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

function quantile(xs: number[], q: number): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * q))] as number;
}

function walkJsonl(dir: string, out: string[], depth = 0): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory() && depth < 4) walkJsonl(full, out, depth + 1);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
	}
}

// ---------------------------------------------------------------- part A
const files: string[] = [];
walkJsonl(RUNS_DIR, files);
const real = files.filter((f) => { try { return fs.statSync(f).size > 0; } catch { return false; } });

const survey: Array<{ bytes: number; turns: number; assistants: number; warmMs: number }> = [];
for (const file of real.slice(0, 120)) {
	const bytes = fs.statSync(file).size;
	parseSessionFile(file); // populate the incremental cache
	const warm: number[] = [];
	let turns = 0;
	let assistants = 0;
	for (let i = 0; i < REPS; i += 1) {
		const t0 = process.hrtime.bigint();
		const parsed = parseSessionFile(file);
		warm.push(Number(process.hrtime.bigint() - t0) / 1e6);
		turns = parsed.turns.length;
		assistants = parsed.turns.reduce((n, t) => n + t.assistants.length, 0);
	}
	survey.push({ bytes, turns, assistants, warmMs: median(warm) });
}
const warmByByte = survey.map((s) => s.warmMs);

// ---------------------------------------------------------------- part B
// `createRequire` returns the mutable CJS object; `syncBuiltinESMExports` then
// makes the ESM named import in `src/shared/session.ts` see the wrapper. Same
// technique as `test/unit/collect-polling.test.ts`.
const nodeFs = createRequire(import.meta.url)("node:fs") as {
	openSync: (file: unknown, ...rest: unknown[]) => number;
};
const realOpenSync = nodeFs.openSync;
let openTarget: string | null = null;
let opens = 0;
nodeFs.openSync = (file: unknown, ...rest: unknown[]): number => {
	if (openTarget !== null && file === openTarget) opens += 1;
	return realOpenSync(file, ...rest);
};
syncBuiltinESMExports();

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "bench agent",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a bench agent.",
		source: "user",
		filePath: "/fake/worker.md",
	};
}

interface PhaseCount {
	cachedCollectOpens: number;
	collectOpens: number;
	retireOpens: number;
	totalOpens: number;
	collectMs: number;
}

async function measureSequence(): Promise<PhaseCount> {
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-core-collect-"));
	const supervisor = new FakeSupervisor({ autoSettle: { text: "done", stopReason: "stop" } });
	const orchestrator = new Orchestrator({ supervisor, runDir, cwd: "/tmp/project" });
	try {
		const handle = await orchestrator.launch({ agent: agent(), task: "do the thing", name: "w0" });
		const sessionFile = handle.sessionFile;
		openTarget = sessionFile;

		opens = 0;
		orchestrator.cachedCollect("w0");
		const cachedCollectOpens = opens;

		opens = 0;
		const t0 = process.hrtime.bigint();
		await orchestrator.collect("w0");
		const collectMs = Number(process.hrtime.bigint() - t0) / 1e6;
		const collectOpens = opens;

		opens = 0;
		await orchestrator.retire("w0");
		const retireOpens = opens;

		openTarget = null;
		const stat = fs.statSync(sessionFile).size;
		return {
			cachedCollectOpens,
			collectOpens,
			retireOpens,
			totalOpens: cachedCollectOpens + collectOpens + retireOpens,
			collectMs: Number((collectMs + stat * 0).toFixed(3)),
		};
	} finally {
		openTarget = null;
		fs.rmSync(runDir, { recursive: true, force: true });
	}
}

const seq: PhaseCount[] = [];
for (let i = 0; i < REPS; i += 1) seq.push(await measureSequence());

console.log(
	JSON.stringify(
		{
			bench: "02-collect-parses",
			env: { node: process.version, cpus: os.cpus().length },
			corpus: {
				runsDir: RUNS_DIR,
				jsonlFiles: real.length,
				sampled: survey.length,
				bytesP50: quantile(survey.map((s) => s.bytes), 0.5),
				bytesP90: quantile(survey.map((s) => s.bytes), 0.9),
				bytesMax: Math.max(...survey.map((s) => s.bytes)),
				turnsP50: quantile(survey.map((s) => s.turns), 0.5),
				turnsP90: quantile(survey.map((s) => s.turns), 0.9),
				turnsMax: Math.max(...survey.map((s) => s.turns)),
				assistantsMax: Math.max(...survey.map((s) => s.assistants)),
				warmParseMsP50: Number(quantile(warmByByte, 0.5).toFixed(3)),
				warmParseMsP90: Number(quantile(warmByByte, 0.9).toFixed(3)),
				warmParseMsMax: Number(Math.max(...warmByByte).toFixed(3)),
			},
			collectSequence: {
				samples: seq,
				medianTotalOpens: median(seq.map((s) => s.totalOpens)),
				medianCollectOpens: median(seq.map((s) => s.collectOpens)),
				medianCollectMs: Number(median(seq.map((s) => s.collectMs)).toFixed(3)),
			},
		},
		null,
		2,
	),
);
