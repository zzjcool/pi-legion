/**
 * perf-core bench 7 — `RunStore.listRuns()`: the per-control-action run registry scan.
 *
 * `index.ts:2021` runs `store.listRuns()` once for EVERY `subagent` control call
 * (collect / status / steer / abort / wait). The scan is
 * readdir(runs/) + readFileSync(run.json) + JSON.parse per entry, with no cache
 * and no upper bound other than the 14-day retention prune.
 *
 * This measures the real corpus, a synthetic 1k/3k-run store, and the breakdown
 * of the scan.
 *
 * Run: node --experimental-strip-types bench/perf-core/07-list-runs.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RunStore } from "../../src/runs/store.ts";

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

const REPS = 5;
function timeListRuns(store: RunStore): { medianMs: number; samples: number[]; runs: number; children: number } {
	let runs = 0;
	let children = 0;
	const samples: number[] = [];
	for (let i = 0; i < REPS; i += 1) {
		const t0 = process.hrtime.bigint();
		const out = store.listRuns();
		samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
		runs = out.length;
		children = out.reduce((n, r) => n + r.children.length, 0);
	}
	return { medianMs: Number(median(samples).toFixed(2)), samples: samples.map((s) => Number(s.toFixed(2))), runs, children };
}

const out: Record<string, unknown> = { bench: "07-list-runs", env: { node: process.version, cpus: os.cpus().length } };

// --- real corpus ------------------------------------------------------------
try {
	const real = new RunStore({ rootDir: "/root/code/pi-legion/.pi-subagents" });
	out.realCorpus = timeListRuns(real);
	const runsRoot = path.join("/root/code/pi-legion/.pi-subagents", "runs");
	const entries = fs.readdirSync(runsRoot);
	let totalBytes = 0;
	let parsed = 0;
	for (const entry of entries) {
		try {
			const st = fs.statSync(path.join(runsRoot, entry, "run.json"));
			totalBytes += st.size;
			parsed += 1;
		} catch { /* not a run dir */ }
	}
	out.realCorpusSize = { dirs: entries.length, runJsonFiles: parsed, totalMb: Number((totalBytes / 1048576).toFixed(2)) };
} catch (error) {
	out.realCorpusError = String(error);
}

// --- synthetic growth curve -------------------------------------------------
// Real `run.json` files average 4.7KB (the `task` field holds the whole prompt),
// so the synthetic runs carry a realistic task string and 3 children.
const REAL_TASK = "只读侦察，不要改任何文件。".repeat(60);
async function buildStore(count: number, childrenPerRun: number): Promise<{ store: RunStore; dir: string }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-core-runs-"));
	const store = new RunStore({ rootDir: dir });
	for (let i = 0; i < count; i += 1) {
		const run = store.createRun({ task: `${REAL_TASK} #${i}`, cwd: "/root/code/pi-legion" });
		for (let c = 0; c < childrenPerRun; c += 1) {
			await store.addChild(run.runId, {
				name: `w${c}`,
				agent: "worker",
				kind: "pi",
				sessionFile: `/tmp/s-${i}-${c}.jsonl`,
				state: "running",
				spawnedAt: "2026-01-01T00:00:00.000Z",
			} as unknown as Parameters<typeof store.addChild>[1]);
		}
	}
	return { store, dir };
}

const curve: Array<Record<string, unknown>> = [];
for (const [count, kids] of [[100, 3], [1000, 3], [3000, 3]] as Array<[number, number]>) {
	const { store, dir } = await buildStore(count, kids);
	try {
		const t = timeListRuns(store);
		const runsDir = path.join(dir, "runs");
		const runJsonBytes = fs.readdirSync(runsDir).reduce((n, e) => {
			try { return n + fs.statSync(path.join(runsDir, e, "run.json")).size; } catch { return n; }
		}, 0);
		// Breakdown: readdir only, then read+parse only (no sort).
		const readdirSamples: number[] = [];
		const parseSamples: number[] = [];
		for (let i = 0; i < REPS; i += 1) {
			const t0 = process.hrtime.bigint();
			const entries = fs.readdirSync(runsDir);
			readdirSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
			const t1 = process.hrtime.bigint();
			for (const entry of entries) {
				try { JSON.parse(fs.readFileSync(path.join(runsDir, entry, "run.json"), "utf8")); } catch { /* skip */ }
			}
			parseSamples.push(Number(process.hrtime.bigint() - t1) / 1e6);
		}
		// Headroom for a cached / runId-scoped fix: one `readRun` on the same store.
		const someRun = fs.readdirSync(runsDir)[0] as string;
		const readOne: number[] = [];
		for (let i = 0; i < REPS; i += 1) {
			const t0 = process.hrtime.bigint();
			store.listRuns();
			store.findChild(someRun, "w0");
			readOne.push(Number(process.hrtime.bigint() - t0) / 1e6);
		}
		curve.push({
			readRunMs: Number(median(readOne).toFixed(3)),
			childrenPerRun: kids,
			...t,
			avgRunJsonKb: Number((runJsonBytes / count / 1024).toFixed(1)),
			readdirMs: Number(median(readdirSamples).toFixed(2)),
			readParseMs: Number(median(parseSamples).toFixed(2)),
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
out.syntheticCurve = curve;

// --- cross-store miss path (findChildAcrossStores = listRuns PER candidate) --
try {
	const { resolveChildAcrossStores, candidateStoreRoots } = await import("../../src/runs/store-lookup.ts");
	const realRoot = "/root/code/pi-legion/.pi-subagents";
	const roots = candidateStoreRoots({ cwd: "/root/code/pi-legion", callerCwd: "/root/code/pi-legion" });
	const t0 = process.hrtime.bigint();
	const miss = resolveChildAcrossStores({ name: "definitely-not-a-child", cwd: "/root/code/pi-legion", callerCwd: "/root/code/pi-legion" });
	const missMs = Number(process.hrtime.bigint() - t0) / 1e6;
	out.crossStoreMiss = {
		candidateRoots: roots.length,
		storesScanned: miss.searched.length,
		runsScanned: miss.searched.reduce((n, s) => n + s.runs.length, 0),
		ms: Number(missMs.toFixed(2)),
		realRoot,
	};
} catch (error) {
	out.crossStoreMissError = String(error);
}

console.log(JSON.stringify(out, null, 2));
