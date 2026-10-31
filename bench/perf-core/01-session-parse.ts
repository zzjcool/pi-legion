/**
 * perf-core bench 1 — session parse cost vs line count.
 *
 * Drives the production `parseSessionFile` (`src/shared/session.ts`) directly.
 * Nothing here reimplements the hot path.
 *
 * Cost model this measures:
 *   warmParse(N) = fixed(open+fstat+fingerprint+1MiB alloc) + projectForCaller(N)
 * because a warm parse reads zero new bytes but still deep-projects every turn.
 *
 * Run: node --expose-gc --experimental-strip-types bench/perf-core/01-session-parse.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseSessionFile } from "../../src/shared/session.ts";
import { assistantMsg, modelChange, sessionHeader, toolResult, userMsg } from "../../test/helpers/fixtures.ts";

const REPS = 3;

interface Sample {
	ms: number;
	heapMb: number;
	turns: number;
	assistants: number;
	bytes: number;
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

/** 4 lines per turn: user, assistant(text+2 toolCalls), toolResult, assistant(stop). */
function buildSession(dir: string, lines: number, tag: string): string {
	const file = path.join(dir, `${tag}-${lines}.jsonl`);
	const chunks: string[] = [sessionHeader(), modelChange("test/glm-5.3-flash")];
	const turns = Math.floor(lines / 4);
	const body = "x".repeat(180);
	for (let t = 0; t < turns; t += 1) {
		const base = 1_767_225_600_000 + t * 4_000;
		chunks.push(userMsg(`turn ${t}: please do the thing with some realistic prompt length ${body}`, { timestamp: base }));
		chunks.push(
			assistantMsg({
				text: `working on it — step ${t} ${body}`,
				tools: ["bash", "read"],
				stopReason: "toolUse",
				timestamp: base + 1_000,
				usage: { input: 12_000, output: 400, cacheRead: 8_000, cacheWrite: 100, cost: { total: 0.004 } },
			}),
		);
		chunks.push(toolResult({ text: `ok output line ${body}`, timestamp: base + 2_000 }));
		chunks.push(
			assistantMsg({
				text: `done with ${t} ${body}`,
				stopReason: "stop",
				timestamp: base + 3_000,
				usage: { input: 12_500, output: 250, cacheRead: 8_100, cost: { total: 0.003 } },
			}),
		);
	}
	fs.writeFileSync(file, `${chunks.join("\n")}\n`);
	return file;
}

function gcNow(): void {
	const g = globalThis as { gc?: () => void };
	g.gc?.();
	g.gc?.();
}

function sampleOnce(file: string): { ms: number; heapMb: number; turns: number; assistants: number; bytes: number } {
	gcNow();
	const before = process.memoryUsage().heapUsed;
	const t0 = process.hrtime.bigint();
	const parsed = parseSessionFile(file);
	const t1 = process.hrtime.bigint();
	gcNow();
	const after = process.memoryUsage().heapUsed;
	const assistants = parsed.turns.reduce((n, turn) => n + turn.assistants.length, 0);
	// Keep `parsed` alive across the heap read.
	if (parsed.turns.length < 0) throw new Error("unreachable");
	return {
		ms: Number(t1 - t0) / 1e6,
		heapMb: Math.max(0, (after - before) / (1024 * 1024)),
		turns: parsed.turns.length,
		assistants,
		bytes: fs.statSync(file).size,
	};
}

function run3(fn: () => { ms: number; heapMb: number; turns: number; assistants: number; bytes: number }): Sample {
	const out: Sample[] = [];
	for (let i = 0; i < REPS; i += 1) out.push(fn());
	const med = {
		ms: median(out.map((s) => s.ms)),
		heapMb: median(out.map((s) => s.heapMb)),
		turns: out[0]?.turns ?? 0,
		assistants: out[0]?.assistants ?? 0,
		bytes: out[0]?.bytes ?? 0,
	};
	return med;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-core-parse-"));
const rows: Record<string, unknown>[] = [];

try {
	const sizes = [1_000, 10_000, 100_000];
	const files = new Map<number, string>();
	for (const n of sizes) files.set(n, buildSession(dir, n, "s"));

	// Fixed overhead: warm-parse an empty file (open+fstat+fingerprint+1MiB alloc).
	const emptyFile = path.join(dir, "empty.jsonl");
	fs.writeFileSync(emptyFile, "");
	parseSessionFile(emptyFile);
	const fixed = run3(() => sampleOnce(emptyFile));

	for (const n of sizes) {
		const file = files.get(n) as string;

		// cold: fresh copy per repetition so the module cache never has it.
		const coldSamples: Sample[] = [];
		for (let i = 0; i < REPS; i += 1) {
			const copy = path.join(dir, `cold-${n}-${i}.jsonl`);
			fs.copyFileSync(file, copy);
			coldSamples.push(sampleOnce(copy));
			fs.rmSync(copy, { force: true });
		}
		const cold = {
			ms: median(coldSamples.map((s) => s.ms)),
			heapMb: median(coldSamples.map((s) => s.heapMb)),
		};

		// warm: first call populates, measured calls read 0 new bytes.
		parseSessionFile(file);
		const warm = run3(() => sampleOnce(file));

		// incremental: one appended line, then parse again.
		const incFile = path.join(dir, `inc-${n}.jsonl`);
		fs.copyFileSync(file, incFile);
		parseSessionFile(incFile);
		const incSamples: Sample[] = [];
		for (let i = 0; i < REPS; i += 1) {
			const one = assistantMsg({ text: `appended ${i}`, stopReason: "stop", timestamp: 1_767_225_600_000 + i });
			fs.appendFileSync(incFile, `${one}\n`);
			incSamples.push(sampleOnce(incFile));
		}
		const inc = { ms: median(incSamples.map((s) => s.ms)) };

		rows.push({
			lines: n,
			turns: warm.turns,
			assistants: warm.assistants,
			fileMb: Number((warm.bytes / (1024 * 1024)).toFixed(2)),
			coldMs: Number(cold.ms.toFixed(2)),
			warmMs: Number(warm.ms.toFixed(3)),
			incrementalMs: Number(inc.ms.toFixed(3)),
			coldHeapMb: Number(cold.heapMb.toFixed(1)),
			warmHeapMb: Number(warm.heapMb.toFixed(1)),
			// projection share: warm parse minus the fixed zero-turn cost
			projectionMs: Number(Math.max(0, warm.ms - fixed.ms).toFixed(3)),
			warmSamples: warm.ms,
		});
	}

	// A collect() does >= 3 warm parses of the same file (orchestrator.ts:2178/2195/2210).
	const hundredK = files.get(100_000) as string;
	parseSessionFile(hundredK);
	const batch = (count: number): number => {
		const t0 = process.hrtime.bigint();
		for (let i = 0; i < count; i += 1) parseSessionFile(hundredK);
		return Number(process.hrtime.bigint() - t0) / 1e6;
	};
	const perCall = [batch(20), batch(20), batch(20)].map((ms) => ms / 20);

	console.log(
		JSON.stringify(
			{
				bench: "01-session-parse",
				env: { node: process.version, cpus: os.cpus().length, memGb: Math.round(os.totalmem() / 1024 ** 3) },
				fixedOverheadMs: Number(fixed.ms.toFixed(4)),
				rows,
				collectThreeWarmParsesMs: Number((median(perCall) * 3).toFixed(2)),
				perWarmParse100kMs: Number(median(perCall).toFixed(3)),
				perWarmParse100kSamples: perCall.map((ms) => Number(ms.toFixed(3))),
			},
			null,
			2,
		),
	);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
