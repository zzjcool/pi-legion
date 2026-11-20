/**
 * #441 real-machine harness — "run one big task for 20+ minutes and count the
 * notices".
 *
 * The unit suite proves the RULES; this script proves them against the facts they
 * will actually be judged by, on a real machine:
 *
 *   - REAL `hc` terminals on a REAL core, reporting their own OSC 7501 program status
 *     (`working` / `idle`), read back through `terminal.get` — the exact call
 *     `TerminalSupervisor.programState` makes;
 *   - the REAL `LegionPostman` ticking every 2 s, writing real `messages` rows;
 *   - a REAL wall clock: the run lasts `--minutes` (default 21) minutes.
 *
 * Phases, because "no notice" alone would also be true of a detector switched off:
 *
 *   PHASE 0  a REAL `pi` child in a terminal: prove that the status word this
 *            detector reads is the child's genuine 7501 report (`working` while a
 *            tool runs), then retire it.
 *   PHASE 1  a working child for `--minutes`: the container says `working` (a real
 *            report from a real core) while its transcript never grows again — the
 *            shape of a 20-minute compile / `gh pr checks --watch`. Expected: ZERO
 *            notices. The same fixture is ALSO fed to a local copy of the pre-#441
 *            rule ("the clock decides"), so the run reports the counterfactual: what
 *            the old code would have mailed, for the same child, at the same instants.
 *   PHASE 2  a terminal at its PROMPT (`idle`) whose transcript stopped growing 50
 *            minutes ago. Expected: exactly ONE notice — the anomaly the detector
 *            exists for, which is what keeps this fix from being a mute detector.
 *
 * Every minute the timeline records: the container's status word, the transcript's
 * byte count / age, the tier the pre-#441 rule had reached, and how many notices the
 * real postman wrote. That is what makes "the child in the notice was growing at the
 * time" checkable after the fact.
 *
 * Run (inside an `hc` terminal, from the repo root):
 *
 *   node --experimental-strip-types scripts/spike/stall-441-real.ts --minutes 21
 *
 * It writes `docs/reports/stall-441-real-timeline.json` and prints a summary. Needs a
 * live `hc` core (`HC_TERMINAL_SOCKET`/`HC_TERMINAL_ID`) and a configured `pi` for
 * phase 0; without them it exits 2 (environment, not a code failure).
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { hcCliClient, type HcClient } from "../../src/hc/client.ts";
import { LegionPostman } from "../../src/extension/legion-tools.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { inbox } from "../../src/legion/mail.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { decideStallNotice } from "../../src/legion/stall-notice.ts";
import type { LegionSupervisor } from "../../src/supervisor/types.ts";

const MINUTE = 60_000;
const TICK_MS = 2_000;

function arg(name: string, fallback: number): number {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const parsed = Number(process.argv[index + 1]);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface TerminalFacts {
	state?: string;
	name?: string;
	address?: string;
	status?: { state?: string; app?: string } | null;
	exit_code?: number | null;
}

/** The minimum `LegionSupervisor` surface the postman's stall pass touches. */
class RealTerminalSupervisor {
	private readonly client: HcClient;
	private readonly address: string;
	/** Phase 2 pins aliveness: the idle terminal is real, only its clock is advanced. */
	private readonly pinnedAlive: boolean;
	lastRead: TerminalFacts | undefined;

	constructor(client: HcClient, address: string, pinnedAlive = false) {
		this.client = client;
		this.address = address;
		this.pinnedAlive = pinnedAlive;
	}

	isAlive(): boolean {
		return this.pinnedAlive || this.lastRead?.state === "live";
	}

	async stats(): Promise<null> {
		return null;
	}

	/** #441-B: the `hc` terminal backend folds no tool events — answered explicitly. */
	observesToolEvents(): boolean {
		return false;
	}

	/** #441-C: ONE real `terminal.get`, exactly like `TerminalSupervisor.programState`. */
	async programState(): Promise<string | undefined> {
		await this.refresh();
		return typeof this.lastRead?.status?.state === "string" ? this.lastRead.status.state : undefined;
	}

	async refresh(): Promise<void> {
		try {
			this.lastRead = await this.client.request<TerminalFacts>("terminal.get", { terminal: this.address });
		} catch {
			/* leave the last reading; the detector treats unknown as unknown */
		}
	}
}

/** The PRE-#441 decision, kept here as the counterfactual ("what the old code would mail"). */
class OldRule {
	private readonly radius: number;
	private readonly announced = new Map<string, { tier: number; count: number }>();
	readonly fired: Array<{ at: string; child: string; tier: number; notice: string }> = [];

	constructor(radiusMs: number) {
		this.radius = radiusMs;
	}

	tick(now: number, childName: string, loopBaseAt: number, elapsedMs: number): void {
		if (elapsedMs < this.radius) return;
		const tier = Math.floor(elapsedMs / this.radius);
		const state = this.announced.get(childName) ?? { tier: 0, count: 0 };
		if (tier <= state.tier) return;
		if (state.count + 1 > 3) return;
		this.announced.set(childName, { tier, count: state.count + 1 });
		this.fired.push({
			at: new Date(now).toISOString(),
			child: childName,
			tier,
			notice: `"${childName}: running for ${Math.round(elapsedMs / MINUTE)}m 0s (threshold ${Math.round(this.radius / MINUTE)}m 0s), with no tool in flight"`,
		});
	}
}

function now(): number {
	return Date.now();
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/**
 * Write a terminal program that reports its own 7501 status and then holds for
 * `holdMs`. Emitting the status is what a real `pi` TUI does (`ProgramStatusReporter`
 * → `formatProgramStatus`); a FILE keeps the escaping honest and keeps the long phase
 * independent of a model's appetite for loops, which is the only part of "a big task"
 * that is not a fact.
 *
 * Wire format: `ESC ] 7501 ; state=<word> : app=<app> ESC \`.
 */
function writeStatusProgram(file: string, word: "working" | "idle", holdMs: number): string {
	const source = [
		'const ESC = String.fromCharCode(27);',
		'const ST = String.fromCharCode(92);',
		'const set = (state) => process.stdout.write(ESC + "]7501;state=" + state + ":app=long-task" + ESC + ST);',
		`set(${JSON.stringify(word)});`,
		`setTimeout(() => { set("done"); }, ${holdMs});`,
		'',
	].join("\n");
	writeFileSync(file, source);
	return file;
}

async function main(): Promise<number> {
	if (!process.env.HC_TERMINAL_SOCKET || !process.env.HC_TERMINAL_ID) {
		console.error("stall-441-real: run this inside an hc terminal (HC_TERMINAL_SOCKET + HC_TERMINAL_ID)");
		return 2;
	}
	const minutes = arg("minutes", 21);
	const radiusMs = arg("radius-minutes", 5) * MINUTE;
	const runId = `stall441-${Date.now().toString(36)}`;
	const workDir = path.join(tmpdir(), runId);
	mkdirSync(workDir, { recursive: true });
	const client = hcCliClient({ env: process.env });
	await client.start();
	const spawned: string[] = [];
	const spawnTerminal = async (name: string, argv: string[], cwd: string): Promise<string> => {
		spawned.push(name);
		const launched = await client.request<{ address?: string }>("terminal.run", { name, argv, cwd, keep: true });
		return typeof launched.address === "string" ? launched.address : name;
	};

	// ── PHASE 0: a real pi child, to prove the word this detector reads is real ──
	const piName = `${runId}-pi`;
	let piWord: string | undefined;
	try {
		const piAddress = await spawnTerminal(piName, ["pi", "--approve", "Use your bash tool to run: sleep 90 ; then reply with the single word done."], tmpdir());
		const piSupervisor = new RealTerminalSupervisor(client, piAddress);
		for (let attempt = 0; attempt < 20 && piWord !== "working"; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			await piSupervisor.refresh();
			piWord = piSupervisor.lastRead?.status?.state;
		}
	} catch (error) {
		console.warn(`[stall-441] phase 0 (pi child) failed to start: ${String(error)}`);
	}

	// ── PHASE 1: a REAL working child for `minutes` ──
	const workName = `${runId}-work`;
	const sessionPath = path.join(workDir, "child-session.jsonl");
	writeFileSync(sessionPath, '{"type":"message","message":{"role":"user","content":"a 20-minute task"}}\n');
	const heldMs = minutes * MINUTE + 30_000;
	const workProgram = writeStatusProgram(path.join(workDir, "hold-working.js"), "working", heldMs);
	const workAddress = await spawnTerminal(workName, ["node", workProgram], tmpdir());
	const supervisor = new RealTerminalSupervisor(client, workAddress);
	for (let attempt = 0; attempt < 15; attempt += 1) {
		await supervisor.refresh();
		if (supervisor.lastRead?.status?.state === "working") break;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	if (supervisor.lastRead?.status?.state !== "working") {
		console.error(`[stall-441] the working child did not report \`working\` (got ${JSON.stringify(supervisor.lastRead?.status)}); aborting instead of measuring nothing`);
		return 1;
	}

	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
	const childCreatedAt = now();
	insertNode(
		db,
		{ parentId: "root", name: "big-task", role: "worker", status: "running", sessionFile: sessionPath },
		() => childCreatedAt,
	);
	const postman = new LegionPostman({
		db,
		nodeId: "root",
		supervisor: supervisor as unknown as LegionSupervisor,
		sendRootMessage: () => {},
		settings: { orphanStaleMs: Number.MAX_SAFE_INTEGER, mailRatePer5Min: 10 },
		intervalMs: TICK_MS,
		noticeMsForRole: () => radiusMs,
	});
	const oldRule = new OldRule(radiusMs);
	const timeline: Array<Record<string, unknown>> = [];
	const startedAt = now();
	let lastMinute = -1;

	const sample = async (): Promise<void> => {
		const at = now();
		await supervisor.refresh();
		let bytes = 0;
		let mtime = 0;
		try {
			const stat = statSync(sessionPath);
			bytes = stat.size;
			mtime = stat.mtimeMs;
		} catch {
			/* the child has not written yet */
		}
		const elapsedMs = at - startedAt;
		oldRule.tick(at, "big-task", startedAt, elapsedMs);
		timeline.push({
			at: iso(at),
			elapsedMin: Math.round(elapsedMs / MINUTE),
			terminalState: supervisor.lastRead?.state ?? "unknown",
			programState: supervisor.lastRead?.status?.state ?? null,
			sessionBytes: bytes,
			sessionAgeSec: mtime === 0 ? null : Math.round((at - mtime) / 1000),
			oldRuleTier: oldRule.fired.filter((entry) => entry.child === "big-task").at(-1)?.tier ?? 0,
			notices: inbox(db, "root").length,
		});
	};

	await postman.tick();
	while (now() - startedAt < minutes * MINUTE) {
		await postman.tick();
		const minute = Math.floor((now() - startedAt) / MINUTE);
		if (minute !== lastMinute) {
			lastMinute = minute;
			await sample();
		}
		await new Promise((resolve) => setTimeout(resolve, TICK_MS));
	}
	await sample();
	const phase1Notices = inbox(db, "root").length;
	const finalWord = supervisor.lastRead?.status?.state ?? null;

	// ── PHASE 2 (REVERSE): at the prompt, transcript stale, clock advanced ──
	// Every FACT is real — the terminal's own `idle` report, the transcript's bytes and
	// mtime; only the CLOCK reading is advanced (the same trick the unit tests use with
	// `now`), because waiting 45 real minutes for the radius would not fit the run.
	const idleName = `${runId}-idle`;
	const idleSession = path.join(workDir, "idle-session.jsonl");
	writeFileSync(idleSession, '{"type":"message","message":{"role":"user","content":"idle"}}\n');
	const idleProgram = writeStatusProgram(path.join(workDir, "hold-idle.js"), "idle", heldMs);
	const idleAddress = await spawnTerminal(idleName, ["node", idleProgram], tmpdir());
	const idleSupervisor = new RealTerminalSupervisor(client, idleAddress, true);
	let idleWord: string | undefined;
	for (let attempt = 0; attempt < 20 && idleWord !== "idle"; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		await idleSupervisor.refresh();
		idleWord = idleSupervisor.lastRead?.status?.state;
	}
	const idleDb = openLegionDb(":memory:");
	insertNode(idleDb, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
	const future = now() + 50 * MINUTE;
	insertNode(
		idleDb,
		{ parentId: "root", name: "idle-child", role: "worker", status: "running", sessionFile: idleSession },
		() => now() - 46 * MINUTE,
	);
	const idlePostman = new LegionPostman({
		db: idleDb,
		nodeId: "root",
		supervisor: idleSupervisor as unknown as LegionSupervisor,
		sendRootMessage: () => {},
		settings: { orphanStaleMs: Number.MAX_SAFE_INTEGER, mailRatePer5Min: 10 },
		intervalMs: TICK_MS,
		now: () => future,
		noticeMsForRole: () => radiusMs,
	});
	await idlePostman.tick();
	idlePostman.stop();
	const reverseNotices = inbox(idleDb, "root").length;
	const reverseBody = inbox(idleDb, "root")[0]?.body ?? null;

	// The same decision with the same facts but a `working` word must NOT fire.
	const workingControl = decideStallNotice({
		now: future,
		child: {
			name: "idle-child",
			toolObservationUnavailable: true,
			programState: "working",
			lastSessionGrowthAt: future - 50 * MINUTE,
		},
		thresholds: { loopRadiusMs: radiusMs },
		window: { loopBaseAt: future - 46 * MINUTE, silence: { tier: 0, count: 0 }, longRunning: { tier: 0, count: 0 } },
	});

	const result = {
		runId,
		startedAt: iso(startedAt),
		finishedAt: iso(now()),
		wallMinutes: Math.round((now() - startedAt) / MINUTE),
		radiusMinutes: radiusMs / MINUTE,
		machine: process.env.HC_TERMINAL_ID ?? null,
		phase0: { child: "pi", address: piAddressOrNull(), reportedProgramState: piWord ?? null },
		phase1: {
			child: "big-task",
			address: workAddress,
			finalProgramState: finalWord,
			notices: phase1Notices,
			oldRuleFired: oldRule.fired,
			oldRuleNoticeCount: oldRule.fired.length,
		},
		phase2: {
			child: "idle-child",
			address: idleAddress,
			reportedProgramState: idleWord ?? null,
			notices: reverseNotices,
			body: reverseBody,
		},
		controls: { workingWordSuppresses: workingControl === undefined },
		timeline,
	};
	const outFile = path.join(process.cwd(), "docs", "reports", "stall-441-real-timeline.json");
	writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);

	for (const name of spawned) {
		try {
			await client.request("terminal.kill", { terminal: name });
			await client.request("terminal.rm", { terminal: name });
		} catch {
			/* cleanup is best-effort: a finished terminal is harmless */
		}
	}
	postman.stop();
	idlePostman.stop();
	idleDb.close();
	db.close();
	client.close();
	rmSync(workDir, { recursive: true, force: true });

	console.log(JSON.stringify({ outFile, phase0: result.phase0, phase1: result.phase1, phase2: { ...result.phase2, body: "(see file)" }, controls: result.controls }, null, 2));
	const ok = phase1Notices === 0 && finalWord === "working" && reverseNotices === 1 && workingControl === undefined;
	console.log(ok ? "[stall-441] PASS" : "[stall-441] FAIL");
	return ok ? 0 : 1;

	function piAddressOrNull(): string | null {
		return spawned.length > 0 ? spawned[0]! : null;
	}
}

main().then((code) => process.exit(code)).catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
