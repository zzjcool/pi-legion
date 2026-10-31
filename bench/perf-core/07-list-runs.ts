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
 * #344 turned the scan into a FALLBACK and gave `listRuns()` a snapshot, so the
 * same numbers now split in two: `coldMs` (a store that must scan) and `warmMs`
 * (a repeat call served from the snapshot). The last section measures the thing
 * the report is really about — one control call resolving a name it is scoped to
 * — on both the pre-#344 path (`listRuns` + linear find) and the current one.
 *
 * Run: node --experimental-strip-types bench/perf-core/07-list-runs.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveScopedChild } from "../../src/runs/child-scope.ts";
import { RunStore } from "../../src/runs/store.ts";

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

const REPS = 5;
function timeListRuns(store: RunStore): {
	medianMs: number;
	coldMs: number;
	warmMs: number;
	samples: number[];
	runs: number;
	children: number;
} {
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
	const round = (x: number): number => Number(x.toFixed(3));
	return {
		medianMs: Number(median(samples).toFixed(2)),
		// Sample 0 pays for the scan; the rest are served from the snapshot, as long
		// as the registry does not change under the loop.
		coldMs: round(samples[0] as number),
		warmMs: round(median(samples.slice(1))),
		samples: samples.map((s) => Number(s.toFixed(3))),
		runs,
		children,
	};
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

// --- #344: one control call resolving a scoped name, old path vs new ---------
// The pre-#344 control path was: `const runs = store.listRuns()` and then a
// find of `(scopeRunId, name)` inside that scan. The current one asks the store
// for ONE run. Both are measured on the same corpus with the same target, and
// the counters prove which reads each path actually performed.
function measureControlPath(label: string, store: RunStore, scopeRunId: string, name: string): Record<string, unknown> {
	let listRunsCalls = 0;
	let readRunCalls = 0;
	const readRun = (runId: string) => {
		readRunCalls += 1;
		return store.readRun(runId);
	};
	const listRuns = () => {
		listRunsCalls += 1;
		return store.listRuns();
	};

	const oldSamples: number[] = [];
	for (let i = 0; i < REPS; i += 1) {
		// The pre-#344 path had no snapshot at all, so every call scanned. Dropping
		// the snapshot first reproduces exactly that per-rep cost; without it this
		// loop would be timing #344's cache and calling it "before".
		store.invalidateRunsCache();
		const t0 = process.hrtime.bigint();
		const runs = store.listRuns();
		const hit = runs.find((run) => run.runId === scopeRunId)?.children.find((child) => child.name === name) ?? null;
		oldSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
		if (!hit) throw new Error(`control-path bench: ${name} is not a child of ${scopeRunId}`);
	}

	listRunsCalls = 0;
	readRunCalls = 0;
	const newSamples: number[] = [];
	for (let i = 0; i < REPS; i += 1) {
		const t0 = process.hrtime.bigint();
		const resolution = resolveScopedChild({ name, directRunId: scopeRunId, readRun, listRuns });
		newSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
		if (resolution.hit.kind !== "direct") throw new Error(`control-path bench: expected a direct hit for ${name}`);
	}

	const oldMs = median(oldSamples);
	const newMs = median(newSamples);
	return {
		label,
		target: { scopeRunId, name },
		runsInStore: store.listRuns().length,
		oldPathMs: Number(oldMs.toFixed(3)),
		newPathMs: Number(newMs.toFixed(3)),
		speedup: Number((oldMs / newMs).toFixed(1)),
		newPathCalls: { listRuns: listRunsCalls, readRun: readRunCalls },
		oldSamples: oldSamples.map((x) => Number(x.toFixed(3))),
		newSamples: newSamples.map((x) => Number(x.toFixed(3))),
	};
}

const controlPath: Array<Record<string, unknown>> = [];
try {
	// Real corpus: a run that actually holds a child, resolved exactly as a
	// parent's `collect name: "..."` would resolve it.
	const real = new RunStore({ rootDir: "/root/code/pi-legion/.pi-subagents" });
	const populated = real.listRuns().find((run) => run.children.length > 0);
	const target = populated?.children[0];
	if (populated && target) controlPath.push(measureControlPath("real corpus", real, populated.runId, target.name));
} catch (error) {
	controlPath.push({ label: "real corpus", error: String(error) });
}
try {
	// Synthetic 1000-run store: the size where the scan stopped being noise.
	const { store, dir } = await buildStore(1000, 3);
	try {
		controlPath.push(measureControlPath("synthetic 1000 runs", store, store.listRuns()[0]!.runId, "w0"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
} catch (error) {
	controlPath.push({ label: "synthetic 1000 runs", error: String(error) });
}
out.controlPath = controlPath;

console.log(JSON.stringify(out, null, 2));
