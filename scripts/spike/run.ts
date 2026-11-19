#!/usr/bin/env node
/**
 * Driver for the issue #417 hold-spike.
 *
 * EXPERIMENT ONLY — delete with scripts/spike/.
 *
 * Boots the *real* pi host (real `before_settle` dispatch, real settle loop) against
 * a logged mock provider, with one or two throwaway extensions registered on
 * `agent_before_settle`. Every case writes its raw artifacts to /tmp/hold-spike/<case>/.
 *
 *   node --experimental-strip-types scripts/spike/run.ts [case ...]
 *   node --experimental-strip-types scripts/spike/run.ts --list
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startLoggedMock } from "./logged-mock.ts";
import { mockPiEnv, writeMockPiHome } from "../../test/mock-llm/pi-home.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT_A = path.join(HERE, "ext-a.ts");
const EXT_B = path.join(HERE, "ext-b.ts");
/** optional third registrant: the real pi-async extension (hold is TUI-only; print-wait is live) */
const PI_ASYNC = process.env.SPIKE_PI_ASYNC ?? "";
const OUT_ROOT = process.env.SPIKE_OUT ?? "/tmp/hold-spike";
const MARKER = "SPIKE_FOLLOWUP";

interface CaseSpec {
	name: string;
	/** false = register only ext-a (single-registrant baseline) */
	withB?: boolean;
	env: Record<string, string>;
	timeoutMs?: number;
	/** whether a stand-in long-lived child process should be alive during the run */
	standInChild?: boolean;
	/** extension registration order; default "ab" */
	order?: "ab" | "ba";
	/** slow the mock provider down so a "long turn" exists without any hold */
	replyDelayMs?: number;
	note: string;
}

const CASES: CaseSpec[] = [
	{
		name: "1a-a-only",
		withB: false,
		env: { SPIKE_A_ITERS: "2", SPIKE_A_HOLD_MS: "200" },
		note: "single registrant holds twice — baseline continuation count",
	},
	{
		name: "1b-both-hold",
		env: { SPIKE_A_ITERS: "2", SPIKE_A_HOLD_MS: "200", SPIKE_B_ITERS: "2", SPIKE_B_HOLD_MS: "200" },
		note: "two extensions both hold: does pi continue twice per boundary?",
	},
	{
		name: "1c-a-long-b-short",
		env: { SPIKE_A_ITERS: "4", SPIKE_A_HOLD_MS: "150", SPIKE_B_ITERS: "2", SPIKE_B_HOLD_MS: "150" },
		note: "unequal budgets: who decides when the boundary releases, and how many drafts",
	},
	{
		name: "1d-b-replace",
		env: {
			SPIKE_A_ITERS: "1",
			SPIKE_A_HOLD_MS: "100",
			SPIKE_A_MODE: "spread",
			SPIKE_B_ITERS: "1",
			SPIKE_B_HOLD_MS: "100",
			SPIKE_B_MODE: "replace",
		},
		note: "B returns a bare list (no spread) — does A's draft survive?",
	},
	{
		name: "1e-a-replace-b-spread",
		env: {
			SPIKE_A_ITERS: "1",
			SPIKE_A_HOLD_MS: "100",
			SPIKE_A_MODE: "replace",
			SPIKE_B_ITERS: "1",
			SPIKE_B_HOLD_MS: "100",
			SPIKE_B_MODE: "spread",
		},
		note: "A returns a bare list, B spreads — both survive?",
	},
	{
		name: "1g-bare-continue",
		env: { SPIKE_A_ITERS: "1", SPIKE_A_HOLD_MS: "100", SPIKE_A_MODE: "none" },
		note: "hold returns continue:true with NO draft — is a bare continuation accepted?",
	},
	{
		name: "1h-unequal-order",
		env: { SPIKE_A_ITERS: "0", SPIKE_B_ITERS: "1", SPIKE_B_HOLD_MS: "100" },
		note: "A releases immediately, B holds once — does a non-holding sibling kill the hold?",
	},
	{
		name: "1i-veto",
		env: {
			SPIKE_A_ITERS: "1",
			SPIKE_A_HOLD_MS: "150",
			SPIKE_B_ITERS: "1",
			SPIKE_B_HOLD_MS: "0",
			SPIKE_B_MODE: "veto",
		},
		note: "A holds, B explicitly returns continue:false — can a sibling cancel a hold?",
	},
	{
		name: "1j-order-ba",
		env: { SPIKE_A_ITERS: "1", SPIKE_A_HOLD_MS: "80", SPIKE_B_ITERS: "1", SPIKE_B_HOLD_MS: "80" },
		order: "ba",
		note: "same as a single A+B hold but B is registered first — does entry order follow load order?",
	},
	{
		name: "1f-no-hold",
		env: { SPIKE_A_ITERS: "0", SPIKE_B_ITERS: "0" },
		note: "two observers, nobody holds — request count baseline",
	},
	{
		name: "2a-hold-blind",
		env: {
			SPIKE_A_ITERS: "1",
			SPIKE_A_HOLD_MS: "6000",
			SPIKE_A_SEND_AT_MS: "300",
			SPIKE_A_SEND_TEXT: MARKER,
		},
		note: "6s hold, followUp enqueued at +300ms, hold does NOT watch pending messages",
	},
	{
		name: "2b-hold-watch-pending",
		env: {
			SPIKE_A_ITERS: "1",
			SPIKE_A_HOLD_MS: "6000",
			SPIKE_A_WATCH: "pending",
			SPIKE_A_SEND_AT_MS: "300",
			SPIKE_A_SEND_TEXT: MARKER,
		},
		note: "same, but the hold releases as soon as a queued message exists",
	},
	{
		name: "2c-hold-user-msg",
		env: {
			SPIKE_A_ITERS: "1",
			SPIKE_A_HOLD_MS: "6000",
			SPIKE_A_WATCH: "pending",
			SPIKE_A_SEND_AT_MS: "300",
			SPIKE_A_SEND_TEXT: MARKER,
			SPIKE_A_SEND_KIND: "user",
		},
		note: "same as 2b but a USER message (sendUserMessage) — does ctx.hasPendingMessages() see it?",
	},
	{
		name: "2d-control-no-hold",
		env: {
			SPIKE_A_ITERS: "0",
			SPIKE_A_SEND_AT_MS: "300",
			SPIKE_A_SEND_TEXT: MARKER,
		},
		replyDelayMs: 1500,
		note: "CONTROL: no hold at all, 1.5s provider latency, followUp sent mid-turn at +300ms",
	},
	{
		name: "3a-abort-signal-watch",
		env: {
			SPIKE_A_ITERS: "1",
			SPIKE_A_HOLD_MS: "6000",
			SPIKE_A_WATCH: "signal",
			SPIKE_A_SEND_AT_MS: "200",
			SPIKE_A_SEND_TEXT: MARKER,
			SPIKE_A_ABORT_AT_MS: "400",
		},
		standInChild: true,
		note: "hold watches ctx.signal, abort at +400ms — does the signal fire inside before_settle?",
	},
	{
		name: "3b-abort-blind-hold",
		env: {
			SPIKE_A_ITERS: "1",
			SPIKE_A_HOLD_MS: "6000",
			SPIKE_A_SEND_AT_MS: "200",
			SPIKE_A_SEND_TEXT: MARKER,
			SPIKE_A_ABORT_AT_MS: "400",
		},
		standInChild: true,
		note: "abort at +400ms against a blind 6s hold — when does the process actually exit?",
	},
	{
		name: "3c-abort-clean",
		env: { SPIKE_A_ITERS: "0", SPIKE_B_ITERS: "0", SPIKE_A_ABORT_AT_MS: "200" },
		note: "abort with no hold — control for exit timing and ③ duplicate delivery",
	},
];

interface CaseResult {
	name: string;
	spec: CaseSpec;
	exitCode: number | null;
	wallMs: number;
	abortSentAt?: number;
	exitAt: number;
	startedAt: number;
	requests: number;
	boundaries: Array<Record<string, unknown>>;
	holds: Array<Record<string, unknown>>;
	sends: Array<Record<string, unknown>>;
	aborts: Array<Record<string, unknown>>;
	settles: Array<Record<string, unknown>>;
	markerFirstSeen?: { t: number; idx: number };
	markerSends: Array<{ t: number }>;
	latencyMs?: number;
	transcript: Array<{ type?: string; customType?: string; role?: string; content?: unknown; t?: number }>;
	standInChildAliveAfter?: boolean;
	stdout: string;
	stderr: string;
	dir: string;
}

function readJsonl(file: string): Array<any> {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return { raw: line };
			}
		});
}

function walk(dir: string, out: string[] = []): string[] {
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCase(spec: CaseSpec): Promise<CaseResult> {
	const dir = path.join(OUT_ROOT, spec.name);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const spikeLog = path.join(dir, "spike.jsonl");
	const mockLog = path.join(dir, "mock.jsonl");
	const sessionDir = path.join(dir, "sessions");
	const homeDir = path.join(dir, "agent");

	const mock = await startLoggedMock({
		logPath: mockLog,
		markers: [MARKER],
		replyDelayMs: spec.replyDelayMs,
	});
	const home = writeMockPiHome({ dir: homeDir, baseUrl: mock.baseUrl, packages: [] });

	// stand-in for "the child subagent that is still running": an unrelated long-lived
	// process the abort must not touch (see the report's ③ note — this is a proxy).
	let standIn: ReturnType<typeof spawn> | undefined;
	if (spec.standInChild) {
		standIn = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: false });
	}

	const args = [
		"--print",
		"--mode",
		"text",
		"--session-dir",
		sessionDir,
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-tools",
		"--no-mcp",
		"--no-extensions",
		...(spec.order === "ba"
			? ["--extension", EXT_B, "--extension", EXT_A]
			: ["--extension", EXT_A, ...(spec.withB === false ? [] : ["--extension", EXT_B])]),
		...(PI_ASYNC ? ["--extension", PI_ASYNC] : []),
		"--thinking",
		"off",
		"--model",
		home.modelRef,
		"--offline",
		"--approve",
		"--",
		"SPIKE_PROMPT reply with one line of text",
	];

	const env = {
		...process.env,
		...mockPiEnv(homeDir),
		SPIKE_LOG: spikeLog,
		...spec.env,
	};
	const startedAt = Date.now();
	const child = spawn("pi", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (c) => {
		stdout += String(c);
	});
	child.stderr?.on("data", (c) => {
		stderr += String(c);
	});

	const timeoutMs = spec.timeoutMs ?? 60_000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = await new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(true), timeoutMs);
		child.on("exit", () => resolve(false));
	});
	if (timedOut) {
		child.kill("SIGTERM");
		await sleep(1500);
		child.kill("SIGKILL");
	}
	if (timer) clearTimeout(timer);
	const exitAt = Date.now();
	const exitCode = child.exitCode;

	let standInChildAliveAfter: boolean | undefined;
	if (standIn?.pid !== undefined) {
		standInChildAliveAfter = isAlive(standIn.pid);
		standIn.kill("SIGKILL");
	}

	await mock.close();
	fs.writeFileSync(path.join(dir, "stdout.txt"), stdout);
	fs.writeFileSync(path.join(dir, "stderr.txt"), stderr);

	const spike = readJsonl(spikeLog);
	const mockLines = readJsonl(mockLog);
	const sessionFiles = walk(sessionDir).filter((f) => f.endsWith(".jsonl"));
	let transcript: CaseResult["transcript"] = [];
	if (sessionFiles[0]) {
		fs.copyFileSync(sessionFiles[0], path.join(dir, "session.jsonl"));
		transcript = readJsonl(path.join(dir, "session.jsonl")).map((entry: any) => ({
			type: entry.type,
			customType: entry.customType,
			role: entry.message?.role,
			content:
				typeof entry.message?.content === "string"
					? entry.message.content.slice(0, 120)
					: Array.isArray(entry.message?.content)
						? entry.message.content.map((p: any) => p?.text ?? p?.type).join("|").slice(0, 120)
						: entry.content,
			t: entry.timestamp ? Date.parse(entry.timestamp) : undefined,
		}));
	}

	const boundaries = spike.filter((r) => r.ev === "boundary:in");
	const holds = spike.filter((r) => r.ev === "boundary:held");
	const sends = spike.filter((r) => r.ev === "send:begin");
	const aborts = spike.filter((r) => r.ev === "abort:begin");
	const settles = spike.filter((r) => r.ev === "agent_settled");

	const markerSeen = mockLines.find((l) => l.markerHits && l.markerHits[MARKER] > 0);
	const markerSends = sends.filter((s) => s.text === MARKER).map((s) => ({ t: s.t as number }));
	const result: CaseResult = {
		name: spec.name,
		spec,
		exitCode,
		wallMs: exitAt - startedAt,
		abortSentAt: aborts[0]?.t as number | undefined,
		exitAt,
		startedAt,
		requests: mockLines.filter((l) => typeof l.idx === "number").length,
		boundaries,
		holds,
		sends,
		aborts,
		settles,
		markerFirstSeen: markerSeen ? { t: markerSeen.t, idx: markerSeen.idx } : undefined,
		markerSends,
		latencyMs:
			markerSeen && markerSends[0] ? (markerSeen.t as number) - markerSends[0].t : undefined,
		transcript,
		standInChildAliveAfter,
		stdout,
		stderr,
		dir,
	};
	fs.writeFileSync(path.join(dir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
	return result;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function brief(r: CaseResult): string {
	const lines: string[] = [];
	lines.push(`── ${r.name}  (exit=${r.exitCode} wall=${r.wallMs}ms requests=${r.requests})`);
	lines.push(`   note: ${r.spec.note}`);
	const heads = r.boundaries.slice(0, 6);
	lines.push(
		`   boundary handler calls: ${r.boundaries.length}  first ${heads.length}: ${heads
			.map((b) => `${b.ext}#${b.fires}(run${b.runStarts})[in=${JSON.stringify(b.entriesIn)} c=${b.continueIn}]`)
			.join(" ")}`,
	);
	if (r.holds.length) {
		const hs = r.holds.slice(0, 6);
		lines.push(`   holds: ${r.holds.length} → ${hs.map((h) => `${h.ext}#${h.fires} ${h.reason} ${h.heldMs}ms`).join(" | ")}`);
	}
	if (r.markerSends.length) {
		lines.push(
			`   send@${r.markerSends[0].t} firstSeenAtProvider@${r.markerFirstSeen?.t ?? "-"} (req#${r.markerFirstSeen?.idx ?? "-"}) latency=${r.latencyMs ?? "-"}ms`,
		);
	}
	if (r.abortSentAt) {
		lines.push(`   abort@${r.abortSentAt} → exit@${r.exitAt} (abort→exit ${r.exitAt - r.abortSentAt}ms)`);
	}
	const custom = r.transcript.filter((e) => e.customType);
	lines.push(
		`   transcript custom entries (${custom.length}): ${custom.slice(0, 8).map((e) => e.customType).join(", ") || "(none)"}`,
	);
	const markerCount = r.transcript.filter((e) => String(e.content ?? "").includes(MARKER)).length;
	lines.push(`   transcript entries containing ${MARKER}: ${markerCount}`);
	if (r.standInChildAliveAfter !== undefined) {
		lines.push(`   stand-in child alive after abort: ${r.standInChildAliveAfter}`);
	}
	return lines.join("\n");
}

const argNames = process.argv.slice(2);
if (argNames.includes("--list")) {
	for (const c of CASES) console.log(`${c.name}\t${c.note}`);
	process.exit(0);
}
const selected = argNames.length ? CASES.filter((c) => argNames.includes(c.name)) : CASES;
if (selected.length === 0) {
	console.error(`no such case; try --list`);
	process.exit(2);
}
fs.mkdirSync(OUT_ROOT, { recursive: true });
const results: CaseResult[] = [];
for (const spec of selected) {
	const result = await runCase(spec);
	results.push(result);
	console.log(brief(result));
	console.log("");
}
fs.writeFileSync(path.join(OUT_ROOT, "all-summary.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(`artifacts: ${OUT_ROOT}/<case>/`);
