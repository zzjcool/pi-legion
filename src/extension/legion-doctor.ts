/**
 * `/legion doctor` and `subagent action=diagnose`: broad self-check for
 * pi-legion (inspired by `pi list` / `pi auth check` / `pi --help`).
 *
 * Sections are filterable via `/legion doctor [section]` or
 * `subagent({ action: "diagnose", section })` so the main agent can pull only
 * what it needs, then act on the structured Next steps.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BUILTIN_CODEMODE,
	CHILD_EXTENSIONS_ENV,
	CHILD_INHERIT_EXTENSIONS_ENV,
	buildPiArgs,
	childExtraExtensions,
	childGuardExtensionPath,
	childInheritsExtensions,
	collectChildExtensions,
	isCodemodeExtension,
	roleListsCodemode,
} from "../runs/args.ts";
import { getAgentDir } from "../agents/paths.ts";
import {
	CHILD_MAX_OLD_SPACE_ENV,
	CHILD_RESERVE_ENV,
	CHILD_SEMI_SPACE_ENV,
	MIN_FREE_MEM_ENV,
	availableMemoryMb,
	childNodeOptions,
	resolveMemoryGateConfig,
	checkMemoryGate,
} from "../supervisor/child-memory.ts";
import {
	HYGIENE_ENV,
	HYGIENE_LAST_FILE,
	dirBytes,
	hygieneEnabled,
	resolveHygieneConfig,
} from "../runs/hygiene.ts";
import { TEMP_OWNER_FILE, ownerState } from "../runs/owner.ts";
import { legionDbPath } from "../legion/db.ts";
import {
	VERIFY_CONCURRENCY_ENV,
	VERIFY_LOCK_DIR_ENV,
	VERIFY_QUEUE_MAX_MS_ENV,
	inspectVerifySlots,
	resolveVerifyQueueConfig,
} from "../runs/verify-queue.ts";
import { ALLOW_NESTED_ENV } from "./budget.ts";
import { IDLE_STOP_HINT, IDLE_STOP_HINT_SHORT } from "./legion-stop.ts";
import type { AgentConfig } from "../shared/types.ts";
import { recentSpawnFailures, type SpawnFailureRecord } from "./spawn-hints.ts";

/**
 * Canonical slash surface. `/legion help` and the doctor Tools section both
 * print these lines so the two lists cannot drift.
 */
export const LEGION_SLASH_HELP_LINES = [
	"/legion — open the Legion view (TUI)",
	"/legion status [name] — whole-tree summary, or one node (same text as subagent status)",
	"/legion team [list|use <name> [--global]|create <name> a,b,c [--global]]",
	"/legion agents [user|project|both]",
	"/legion on | /legion off — enable/disable subagents for this session (status is shown after each run)",
	"/scout-guard | /no-scout-guard — session override for the main-session scout guard",
	"/legion summary [--all] [<name>]",
	"/legion doctor [section]",
	"/legion stop [name|all]",
	"/legion --tree | /legion <node>",
	"/legion help",
] as const;

export const DOCTOR_SECTIONS = [
	"summary",
	"extensions",
	"models",
	"spawn",
	"memory",
	"tools",
	"storage",
	"runtime",
	"next",
] as const;

export type DoctorSection = (typeof DOCTOR_SECTIONS)[number];

/**
 * Doctor warns when `.hygiene-last.json` is missing or older than this.
 * Shorter than the 14-day run-retention default so a week without a root
 * restart surfaces before retention pruning goes quiet (#85).
 */
export const HYGIENE_SWEEP_STALE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DoctorPackage {
	source: string;
	name: string;
	root?: string;
	extensionPaths: string[];
	keywords: string[];
	likelyProvider: boolean;
}

export interface DoctorIssue {
	severity: "error" | "warning" | "info";
	code: string;
	message: string;
	fix?: string;
	section?: DoctorSection;
}

export interface DoctorLiveJob {
	name: string;
	state: string;
	nodeId?: string;
}

export interface DoctorTreeNode {
	id: string;
	name: string;
	status: string;
	phase?: string;
}

export interface DoctorRuntimeSnapshot {
	liveJobs?: readonly DoctorLiveJob[];
	treeNodes?: readonly DoctorTreeNode[];
	/** True when /legion stop is wired. */
	stopAvailable?: boolean;
	/** True when idle Esc → cascade stop is registered. */
	idleEscWired?: boolean;
	/** Known legion tool names registered in this process. */
	legionTools?: readonly string[];
	/** Nested spawn allowed in this process (child with ALLOW_NESTED). */
	allowNestedEnv?: boolean;
}

export interface DoctorReport {
	ok: boolean;
	text: string;
	issues: DoctorIssue[];
	sections: DoctorSection[];
	hostModelCount: number;
	childModelCount: number;
	packages: DoctorPackage[];
}

export interface DoctorOptions {
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
	piCli?: string;
	sampleAgent?: AgentConfig;
	/** All discovered roles (for per-role extension preview). */
	agents?: readonly AgentConfig[];
	expectedModels?: string[];
	probeModels?: boolean;
	hostModels?: string[];
	childModels?: string[];
	failures?: readonly SpawnFailureRecord[];
	runPi?: (args: string[], timeoutMs: number) => string;
	cwd?: string;
	/** `.pi-subagents` root for storage section. */
	storeRoot?: string;
	runtime?: DoctorRuntimeSnapshot;
	/** Limit to these sections (plus always `next` when issues exist). */
	sections?: readonly DoctorSection[];
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function packageNameFromSource(source: string): string {
	const s = source.trim();
	if (s.startsWith("npm:")) {
		const rest = s.slice(4);
		const m = /^(@[^/]+\/[^@]+|[^@]+)(?:@.+)?$/.exec(rest);
		return m?.[1] ?? rest;
	}
	if (s.startsWith("git:")) {
		const rest = s.slice(4).replace(/^github\.com\//, "");
		const parts = rest.split("/").filter(Boolean);
		return parts[parts.length - 1]?.replace(/\.git$/, "") ?? rest;
	}
	return path.basename(path.resolve(s));
}

function resolvePackageRoot(agentDir: string, source: string): string | undefined {
	const s = source.trim();
	if (s.startsWith("npm:")) {
		const name = packageNameFromSource(s);
		const candidate = path.join(agentDir, "npm", "node_modules", ...name.split("/"));
		return fs.existsSync(candidate) ? candidate : undefined;
	}
	if (s.startsWith("git:")) {
		const rest = s.slice(4);
		const candidates = [
			path.join(agentDir, "git", rest),
			path.join(agentDir, "git", rest.replace(/^github\.com\//, "")),
			path.join(agentDir, "npm", "node_modules", packageNameFromSource(s)),
		];
		return candidates.find((c) => fs.existsSync(c));
	}
	const abs = path.isAbsolute(s) ? s : path.resolve(agentDir, s);
	return fs.existsSync(abs) ? abs : undefined;
}

function extensionEntries(pkgRoot: string): string[] {
	const pkg = readJson(path.join(pkgRoot, "package.json"));
	if (!pkg || typeof pkg !== "object") return [];
	const pi = (pkg as { pi?: { extensions?: unknown } }).pi;
	const raw = pi?.extensions;
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
	return list
		.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
		.map((entry) => path.resolve(pkgRoot, entry));
}

function keywordsOf(pkgRoot: string): string[] {
	const pkg = readJson(path.join(pkgRoot, "package.json"));
	if (!pkg || typeof pkg !== "object") return [];
	const k = (pkg as { keywords?: unknown }).keywords;
	return Array.isArray(k) ? k.filter((x): x is string => typeof x === "string") : [];
}

function descriptionOf(pkgRoot: string): string {
	const pkg = readJson(path.join(pkgRoot, "package.json"));
	if (!pkg || typeof pkg !== "object") return "";
	const d = (pkg as { description?: unknown }).description;
	return typeof d === "string" ? d : "";
}

export function loadHostPackages(agentDir: string): DoctorPackage[] {
	const settings = readJson(path.join(agentDir, "settings.json"));
	const packages =
		settings && typeof settings === "object" && Array.isArray((settings as { packages?: unknown }).packages)
			? ((settings as { packages: unknown[] }).packages.filter((p): p is string => typeof p === "string"))
			: [];
	const out: DoctorPackage[] = [];
	for (const source of packages) {
		const name = packageNameFromSource(source);
		const root = resolvePackageRoot(agentDir, source);
		const extensionPaths = root ? extensionEntries(root) : [];
		const keywords = root ? keywordsOf(root) : [];
		const desc = root ? descriptionOf(root) : "";
		const likelyProvider =
			keywords.some((k) => /provider/i.test(k)) ||
			/provider|endpoint|oauth|api key/i.test(desc) ||
			/endpoint|provider|auth/i.test(name);
		out.push({ source, name, root, extensionPaths, keywords, likelyProvider });
	}
	return out;
}

function defaultPiCli(env: NodeJS.ProcessEnv): string {
	if (env.PI_SUBAGENT_CLI) return path.resolve(env.PI_SUBAGENT_CLI);
	const host = process.argv[1];
	if (host && path.isAbsolute(host)) {
		try {
			const real = fs.realpathSync(host);
			const marker = path.join("node_modules", "@earendil-works", "pi-coding-agent");
			const idx = real.indexOf(marker);
			if (idx >= 0) {
				const cli = path.join(real.slice(0, idx + marker.length), "dist", "cli.js");
				if (fs.existsSync(cli)) return cli;
			}
		} catch { /* fall through */ }
		return host;
	}
	return "pi";
}

function defaultRunPi(piCli: string, cwd: string | undefined) {
	return (args: string[], timeoutMs: number): string => {
		try {
			return execFileSync(piCli, args, {
				encoding: "utf8",
				timeout: timeoutMs,
				cwd,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			const err = error as { stdout?: string; stderr?: string; message?: string };
			return `${err.stdout ?? ""}${err.stderr ?? err.message ?? String(error)}`;
		}
	};
}

export function parseListModels(output: string): string[] {
	const lines = output.split(/\r?\n/);
	const models: string[] = [];
	for (const line of lines) {
		if (/^provider\b/i.test(line) || !line.trim()) continue;
		if (/^No models available/i.test(line)) return [];
		const m = /^(\S+)\s+(\S+)\s+/.exec(line);
		if (!m) continue;
		const provider = m[1];
		const id = m[2];
		if (provider === "provider" || id === "model") continue;
		models.push(`${provider}/${id}`);
	}
	return models;
}

function modelMatches(expected: string, available: readonly string[]): boolean {
	const e = expected.includes(":") ? expected.slice(0, expected.lastIndexOf(":")) : expected;
	if (available.includes(e)) return true;
	return available.some((a) => a === e || a.endsWith(`/${e}`) || a.split("/").slice(1).join("/") === e);
}

function sampleAgentConfig(agent?: AgentConfig): AgentConfig {
	return (
		agent ?? {
			name: "scout",
			description: "doctor sample",
			kind: "pi",
			filePath: "",
			tools: ["read", "bash"],
			systemPrompt: "",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: false,
			source: "user",
		}
	);
}

function previewChildArgv(agent: AgentConfig, env: NodeJS.ProcessEnv): string[] {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legion-doctor-"));
	try {
		const prev = { ...process.env };
		for (const [k, v] of Object.entries(env)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			return buildPiArgs({
				agent,
				task: "(doctor preview)",
				sessionFile: path.join(dir, "session.jsonl"),
				tempDir: dir,
				model: "example/model",
				thinking: "high",
			}).args;
		} finally {
			for (const k of Object.keys(process.env)) {
				if (!(k in prev)) delete process.env[k];
			}
			Object.assign(process.env, prev);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function homeize(p: string, home: string): string {
	if (p === home) return "~";
	if (p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
	return p;
}

function want(sections: ReadonlySet<DoctorSection>, name: DoctorSection): boolean {
	return sections.has(name);
}

export function parseDoctorSections(raw: string | undefined): DoctorSection[] | undefined {
	if (!raw?.trim()) return undefined;
	const parts = raw.trim().split(/[\s,]+/).filter(Boolean);
	const out: DoctorSection[] = [];
	for (const part of parts) {
		const key = part.toLowerCase() as DoctorSection;
		if ((DOCTOR_SECTIONS as readonly string[]).includes(key)) out.push(key);
		else throw new Error(`Unknown doctor section "${part}". Available: ${DOCTOR_SECTIONS.join(", ")}`);
	}
	return out.length ? out : undefined;
}

function extensionsForRole(agent: AgentConfig, env: NodeJS.ProcessEnv, _extras: string[]): string[] {
	if (childInheritsExtensions(agent, env)) return ["(all host-discovered extensions)"];
	// Same effective list as `buildPiArgs` / `collectChildExtensions` (#89 builtin:codemode).
	return collectChildExtensions(agent, env);
}

function scanOrphanTemps(storeRoot: string): { total: number; orphanDead: number; live: number; unknown: number; samples: string[] } {
	const runsRoot = path.join(storeRoot, "runs");
	let total = 0;
	let orphanDead = 0;
	let live = 0;
	let unknown = 0;
	const samples: string[] = [];
	try {
		for (const runEnt of fs.readdirSync(runsRoot, { withFileTypes: true })) {
			if (!runEnt.isDirectory()) continue;
			const runDir = path.join(runsRoot, runEnt.name);
			for (const ent of fs.readdirSync(runDir, { withFileTypes: true })) {
				if (!ent.isDirectory() || !ent.name.startsWith("rpc-child-")) continue;
				total++;
				const state = ownerState(path.join(runDir, ent.name, TEMP_OWNER_FILE));
				if (state === "dead") {
					orphanDead++;
					if (samples.length < 5) samples.push(`${runEnt.name}/${ent.name} (dead owner)`);
				} else if (state === "live") live++;
				else {
					unknown++;
					if (samples.length < 5) samples.push(`${runEnt.name}/${ent.name} (no/.legacy owner)`);
				}
			}
		}
	} catch { /* missing store */ }
	return { total, orphanDead, live, unknown, samples };
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

interface HygieneLastMarker {
	at?: number;
	removedTempDirs?: number;
	prunedRuns?: number;
	deletedEvents?: number;
	freedBytes?: number;
	errors?: number;
}

function readHygieneLast(storeRoot: string): HygieneLastMarker | undefined {
	const last = readJson(path.join(storeRoot, HYGIENE_LAST_FILE));
	if (!last || typeof last !== "object") return undefined;
	return last as HygieneLastMarker;
}

function hygieneSweepAt(last: HygieneLastMarker | undefined): number | undefined {
	return typeof last?.at === "number" && Number.isFinite(last.at) ? last.at : undefined;
}

/**
 * Mirrors `envNumber` in hygiene.ts: blank or non-finite / negative values
 * fall back to the built-in default, so doctor labels those as default.
 */
function hygieneConfigSource(env: NodeJS.ProcessEnv, key: string): "default" | "env" {
	const raw = env[key]?.trim();
	if (!raw) return "default";
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? "env" : "default";
}

function formatHygieneToggleSource(env: NodeJS.ProcessEnv): string {
	const raw = env[HYGIENE_ENV.disable]?.trim();
	if (!raw) return `default; ${HYGIENE_ENV.disable}`;
	return `env ${HYGIENE_ENV.disable}=${raw}`;
}

/** Effective `resolveHygieneConfig()` values, each tagged default or env. */
function formatHygieneConfigLines(env: NodeJS.ProcessEnv): string[] {
	const hy = resolveHygieneConfig(env);
	const rows: Array<[string, string, string]> = [
		["retentionDays", `${hy.retentionDays}d`, HYGIENE_ENV.retentionDays],
		["staleNodeHours", `${hy.staleNodeHours}h`, HYGIENE_ENV.staleNodeHours],
		["legacyTempHours", `${hy.legacyTempHours}h`, HYGIENE_ENV.legacyTempHours],
		["eventRetentionDays", `${hy.eventRetentionDays}d`, HYGIENE_ENV.eventRetentionDays],
		["eventMaxRows", String(hy.eventMaxRows), HYGIENE_ENV.eventMaxRows],
	];
	return rows.map(([label, value, envKey]) => {
		const source = hygieneConfigSource(env, envKey);
		return `    ${label}=${value} (${source === "env" ? `env ${envKey}` : "default"})`;
	});
}

const HYGIENE_SWEEP_HINT =
	`Restart the root pi session so startup hygiene runs, or check ${HYGIENE_ENV.disable}=0.`;

export function runLegionDoctor(options: DoctorOptions = {}): DoctorReport {
	const env = options.env ?? process.env;
	const agentDir = options.agentDir ?? getAgentDir();
	const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
	const issues: DoctorIssue[] = [];
	const packages = loadHostPackages(agentDir);
	const selected = new Set<DoctorSection>(
		options.sections?.length ? options.sections : DOCTOR_SECTIONS,
	);
	// Always keep next when filtering so the model gets actions.
	if (options.sections?.length) selected.add("next");

	const inheritGlobal = childInheritsExtensions({}, env);
	const extras = childExtraExtensions(env);
	const sample = sampleAgentConfig(options.sampleAgent);
	const argv = previewChildArgv(sample, env);
	const noExtensions = argv.includes("--no-extensions");
	const explicitExts = argv.flatMap((a, i) => (a === "--extension" ? [argv[i + 1]!] : []));

	const probe = options.probeModels !== false;
	const piCli = options.piCli ?? defaultPiCli(env);
	const runPi = options.runPi ?? defaultRunPi(piCli, options.cwd);
	let hostModels = options.hostModels ?? [];
	let childModels = options.childModels ?? [];
	if (probe && (want(selected, "models") || want(selected, "summary") || want(selected, "extensions"))) {
		try {
			hostModels = parseListModels(runPi(["--list-models"], 15_000));
			childModels = parseListModels(runPi(["--no-extensions", "--list-models"], 15_000));
		} catch (error) {
			issues.push({
				severity: "warning",
				code: "PROBE_FAILED",
				section: "models",
				message: `Could not run pi --list-models: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	const restoring: { pkg: DoctorPackage; path: string; models: number }[] = [];
	if (probe && !inheritGlobal && childModels.length === 0 && hostModels.length > 0 && want(selected, "models")) {
		const candidates = packages.filter((p) => p.likelyProvider || p.name === "pi-any-endpoint");
		const tryList = candidates.length > 0 ? candidates : packages.filter((p) => p.name !== "pi-legion");
		for (const pkg of tryList) {
			for (const ext of pkg.extensionPaths) {
				if (!fs.existsSync(ext)) continue;
				const models = parseListModels(
					runPi(["--no-extensions", "--extension", ext, "--list-models"], 15_000),
				);
				if (models.length > 0) {
					restoring.push({ pkg, path: ext, models: models.length });
					break;
				}
			}
		}
	}

	const providerExtPaths = [
		...restoring.map((r) => r.path),
		...packages
			.filter((pkg) => pkg.likelyProvider)
			.flatMap((pkg) => pkg.extensionPaths.filter((ext) => fs.existsSync(ext))),
	].filter((ext, i, all) => all.indexOf(ext) === i);
	const providerExtHome = providerExtPaths.map((ext) => homeize(ext, home));

	if (!inheritGlobal && noExtensions && hostModels.length > 0 && childModels.length === 0) {
		issues.push({
			severity: "error",
			code: "CHILD_NO_MODELS",
			section: "models",
			message:
				`Host has ${hostModels.length} model(s) but a child with --no-extensions sees none. ` +
				`Providers are registered by host packages that children no longer load (#43).`,
			fix: providerExtHome.length
				? `export ${CHILD_EXTENSIONS_ENV}=${providerExtHome.join(",")}`
				: `Add the provider package extension path to ${CHILD_EXTENSIONS_ENV}, or set role extensions: / inheritExtensions: true.`,
		});
	} else if (!inheritGlobal && noExtensions && hostModels.length > childModels.length && childModels.length > 0) {
		issues.push({
			severity: "warning",
			code: "CHILD_FEWER_MODELS",
			section: "models",
			message: `Child --no-extensions sees ${childModels.length}/${hostModels.length} host models.`,
		});
	}

	const expected = options.expectedModels ?? [];
	const missing = inheritGlobal
		? expected.filter((m) => !modelMatches(m, hostModels))
		: expected.filter((m) => !modelMatches(m, childModels));
	if (missing.length > 0 && (childModels.length === 0 || !inheritGlobal)) {
		issues.push({
			severity: "error",
			code: "TEAM_MODELS_MISSING",
			section: "models",
			message: `Team/roster model(s) invisible to children: ${missing.join(", ")}`,
			fix: providerExtHome.length
				? `export ${CHILD_EXTENSIONS_ENV}=${providerExtHome.join(",")}`
				: undefined,
		});
	}

	for (const pkg of packages) {
		if (!pkg.root) {
			issues.push({
				severity: "warning",
				code: "PACKAGE_UNRESOLVED",
				section: "extensions",
				message: `settings package not found on disk: ${pkg.source}`,
			});
		}
		for (const ext of pkg.extensionPaths) {
			if (!fs.existsSync(ext)) {
				issues.push({
					severity: "warning",
					code: "EXTENSION_MISSING",
					section: "extensions",
					message: `${pkg.name} extension path missing: ${ext}`,
				});
			}
		}
	}

	const agents = options.agents ?? (options.sampleAgent ? [options.sampleAgent] : []);
	for (const agent of agents) {
		const needsLens = (agent.tools ?? []).some((t) => /lens|symbol_search|project_report|module_report|read_symbol|read_enclosing/i.test(t));
		const exts = extensionsForRole(agent, env, extras);
		const hasLens =
			childInheritsExtensions(agent, env) ||
			exts.some((e) => /pi-lens/i.test(e));
		if (needsLens && !hasLens && !inheritGlobal) {
			issues.push({
				severity: "warning",
				code: "ROLE_MISSING_LENS",
				section: "extensions",
				message: `Role "${agent.name}" lists lens tools but would not load pi-lens under --no-extensions.`,
				fix: `Add pi-lens to ${agent.name}'s extensions: frontmatter, or to ${CHILD_EXTENSIONS_ENV}.`,
			});
		}
		const needsCodemode = roleListsCodemode(agent);
		const hasCodemode =
			childInheritsExtensions(agent, env) ||
			inheritGlobal ||
			exts.some(isCodemodeExtension);
		if (needsCodemode && !hasCodemode) {
			issues.push({
				severity: "warning",
				code: "ROLE_MISSING_CODEMODE",
				section: "extensions",
				message: `Role "${agent.name}" lists codemode but would not load ${BUILTIN_CODEMODE} under --no-extensions.`,
				fix: `Add ${BUILTIN_CODEMODE} to ${agent.name}'s extensions: frontmatter, or ensure tools: includes codemode so Legion auto-loads it.`,
			});
		}
	}

	const failures = options.failures ?? recentSpawnFailures();
	if (failures.some((f) => f.hadNoExtensions !== false && /not found|No models/i.test(f.stderr ?? f.message))) {
		issues.push({
			severity: "error",
			code: "RECENT_MODEL_SPAWN_FAIL",
			section: "spawn",
			message: "A recent child spawn failed with a model/provider error under --no-extensions.",
			fix: providerExtHome.length
				? `export ${CHILD_EXTENSIONS_ENV}=${providerExtHome.join(",")}`
				: undefined,
		});
	}

	const gate = resolveMemoryGateConfig(env);
	const availableMb = availableMemoryMb();
	const inFlight = options.runtime?.liveJobs?.filter((j) => j.state === "starting").length ?? 0;
	const gateProbe = checkMemoryGate({
		name: "(doctor)",
		inFlight,
		config: gate,
		available: () => availableMb,
	});
	if (!gateProbe.ok) {
		issues.push({
			severity: "warning",
			code: "MEMORY_GATE_WOULD_REFUSE",
			section: "memory",
			message: gateProbe.message ?? `Memory gate would refuse a new child (${availableMb} MB free).`,
			fix: `Free memory, stop children with /legion stop, or set ${MIN_FREE_MEM_ENV}=0.`,
		});
	}

	const storeRoot = options.storeRoot ?? (options.cwd ? path.join(options.cwd, ".pi-subagents") : undefined);
	const orphans = storeRoot ? scanOrphanTemps(storeRoot) : undefined;
	const hygieneLast = storeRoot ? readHygieneLast(storeRoot) : undefined;
	if (orphans && orphans.orphanDead > 0) {
		issues.push({
			severity: "info",
			code: "ORPHAN_TEMPS",
			section: "storage",
			message: `${orphans.orphanDead} rpc-child temp dir(s) have a dead owner (startup hygiene will remove them).`,
		});
	}
	const sweepAt = hygieneSweepAt(hygieneLast);
	const sweepStale = storeRoot !== undefined && (sweepAt === undefined || Date.now() - sweepAt > HYGIENE_SWEEP_STALE_DAYS * DAY_MS);
	if (sweepStale) {
		issues.push({
			severity: "info",
			code: "HYGIENE_SWEEP_STALE",
			section: "storage",
			message: sweepAt === undefined
				? `No ${HYGIENE_LAST_FILE} marker — startup hygiene has not recorded a sweep.`
				: `Last hygiene sweep ${new Date(sweepAt).toISOString()} is older than ${HYGIENE_SWEEP_STALE_DAYS} days.`,
			fix: HYGIENE_SWEEP_HINT,
		});
	}

	const verify = inspectVerifySlots(resolveVerifyQueueConfig(env));
	const staleVerify = verify.holders.filter((h) => h.alive === false);
	if (staleVerify.length) {
		issues.push({
			severity: "warning",
			code: "STALE_VERIFY_SLOTS",
			section: "memory",
			message: `${staleVerify.length} verify slot(s) held by dead pids — will be reclaimed on next acquire.`,
			fix: `Remove ${staleVerify.map((h) => h.file).join(", ")} if stuck.`,
		});
	}

	const runtime = options.runtime ?? {};
	const lines: string[] = [];
	const push = (...xs: string[]) => { for (const x of xs) lines.push(x); };

	push("# Legion doctor", "");
	push(`Agent dir: ${homeize(agentDir, home)}`);
	push(`Pi CLI: ${piCli}`);
	push(`Sections: ${[...selected].join(", ")}`);
	push("");

	if (want(selected, "summary")) {
		push("## Summary");
		const errN = issues.filter((i) => i.severity === "error").length;
		const warnN = issues.filter((i) => i.severity === "warning").length;
		push(`- status: ${errN ? "FAIL" : warnN ? "WARN" : "OK"} (${errN} error(s), ${warnN} warning(s))`);
		push(`- child --no-extensions: ${noExtensions ? "yes" : "no"}; inherit: ${inheritGlobal ? "yes" : "no"}`);
		push(`- models host/child: ${hostModels.length}/${childModels.length}`);
		push(`- live children: ${runtime.liveJobs?.length ?? "(unknown — pass runtime)"}`);
		push(`- free memory: ${availableMb} MB (gate min ${gate.minFreeMb})`);
		if (storeRoot) push(`- store: ${homeize(storeRoot, home)}`);
		push("");
	}

	if (want(selected, "extensions")) {
		push("## Extensions");
		push(`- inheritExtensions (env/role default): ${inheritGlobal ? "yes (loads all host extensions)" : "no"}`);
		push(`- child argv includes --no-extensions: ${noExtensions ? "yes" : "no"}`);
		push(`- ${CHILD_INHERIT_EXTENSIONS_ENV}=${env[CHILD_INHERIT_EXTENSIONS_ENV] ?? "(unset)"}`);
		push(`- ${CHILD_EXTENSIONS_ENV}=${env[CHILD_EXTENSIONS_ENV] ?? "(unset)"}`);
		push(`- extra extension paths: ${extras.length ? extras.map((p) => homeize(p, home)).join(", ") : "(none)"}`);
		push(`- guard extension: ${homeize(childGuardExtensionPath(), home)}`);
		push("");
		push("### Host packages (settings.packages)");
		if (packages.length === 0) push("(none)");
		for (const pkg of packages) {
			const tag = pkg.likelyProvider ? " [provider?]" : "";
			const root = pkg.root ? homeize(pkg.root, home) : "(missing)";
			push(`- ${pkg.source} → ${root}${tag}`);
			for (const ext of pkg.extensionPaths) {
				const ok = fs.existsSync(ext) ? "" : " MISSING";
				push(`    --extension ${homeize(ext, home)}${ok}`);
			}
		}
		push("");
		push("### Per-role effective extensions");
		const roles = agents.length ? agents : [sample];
		for (const agent of roles.slice(0, 24)) {
			const inherit = childInheritsExtensions(agent, env);
			const list = extensionsForRole(agent, env, extras);
			push(`- ${agent.name}: inheritExtensions=${inherit ? "true" : "false"} → ${list.map((e) => (e.startsWith("(") ? e : homeize(e, home))).join(", ")}`);
		}
		if (roles.length > 24) push(`  … +${roles.length - 24} more roles`);
		push("");
	}

	if (want(selected, "models")) {
		push("## Models / providers");
		push(`- host (normal discovery): ${hostModels.length}`);
		push(`- child (--no-extensions): ${childModels.length}`);
		if (hostModels.length && childModels.length === 0) {
			push("- child sees NO models — providers come from host packages that `--no-extensions` skips.");
		}
		if (restoring.length) {
			push("- packages that restore models when passed via `--extension`:");
			for (const r of restoring) {
				push(`    ${r.pkg.name}: ${homeize(r.path, home)} (${r.models} models)`);
			}
		}
		if (expected.length) {
			push(`- expected (team/roster): ${expected.join(", ")}`);
			if (missing.length) push(`- MISSING for children: ${missing.join(", ")}`);
		}
		const show = hostModels.slice(0, 12);
		for (const m of show) push(`    host: ${m}`);
		if (hostModels.length > show.length) push(`    ... +${hostModels.length - show.length} more`);
		push("");
	}

	if (want(selected, "spawn")) {
		push("## Spawn");
		push(`### Sample child argv (${sample.name})`);
		push("```");
		push(argv.join(" "));
		push("```");
		push(`- explicit --extension count: ${explicitExts.length}`);
		push(`- nested spawn env ${ALLOW_NESTED_ENV}=${env[ALLOW_NESTED_ENV] ?? "(unset)"}`);
		push(`- runtime.allowNestedEnv: ${runtime.allowNestedEnv ?? "(unknown)"}`);
		push(`- roles with allowNestedSubagents: ${
			agents.filter((a) => a.allowNestedSubagents).map((a) => a.name).join(", ") || "(none listed)"
		}`);
		push("");
		push("### Recent spawn failures");
		if (failures.length === 0) push("(none recorded in this process)");
		for (const f of failures.slice(0, 8)) {
			const when = new Date(f.ts).toISOString();
			push(`- ${when} ${f.name}: ${(f.stderr ?? f.message).trim().slice(0, 280).replace(/\s+/g, " ")}`);
		}
		push("");
	}

	if (want(selected, "memory")) {
		push("## Memory");
		push(`- available: ${availableMb} MB`);
		push(`- gate: ${MIN_FREE_MEM_ENV}=${gate.minFreeMb} (0=off), ${CHILD_RESERVE_ENV}=${gate.reserveMb}`);
		push(`- gate probe (inFlight=${inFlight}): ${gateProbe.ok ? "would allow spawn" : "would REFUSE"}`);
		push(`- child NODE_OPTIONS: ${childNodeOptions(env) ?? "(unchanged)"}`);
		push(`- ${CHILD_MAX_OLD_SPACE_ENV}=${env[CHILD_MAX_OLD_SPACE_ENV] ?? "(default)"}`);
		push(`- ${CHILD_SEMI_SPACE_ENV}=${env[CHILD_SEMI_SPACE_ENV] ?? "(default)"}`);
		push("");
		push("### Verify concurrency");
		push(`- ${VERIFY_CONCURRENCY_ENV}=${verify.config.limit} (0=unlimited)`);
		push(`- ${VERIFY_QUEUE_MAX_MS_ENV}=${verify.config.maxWaitMs}`);
		push(`- lock dir: ${homeize(verify.config.lockDir, home)} (${VERIFY_LOCK_DIR_ENV})`);
		push(`- slots in use: ${verify.inUse}/${verify.config.limit || "∞"}`);
		for (const h of verify.holders) {
			push(`    slot-${h.index}: pid=${h.pid ?? "?"} alive=${h.alive ?? "?"} cmd=${(h.command ?? "").slice(0, 80)}`);
		}
		push("");
	}

	if (want(selected, "tools")) {
		push("## Tools / commands");
		push("- slash:");
		for (const line of LEGION_SLASH_HELP_LINES) push(`    ${line}`);
		push(`- stop wired: ${runtime.stopAvailable === undefined ? "(unknown)" : runtime.stopAvailable ? "yes" : "no"}`);
		push(`- idle Esc stop wired: ${runtime.idleEscWired === undefined ? "(unknown)" : runtime.idleEscWired ? "yes" : "no"}`);
		push(`- idle strip hints: "${IDLE_STOP_HINT}" / short "${IDLE_STOP_HINT_SHORT}"`);
		push(`- legion tools registered: ${(runtime.legionTools ?? ["(unknown — typically subagent, vexillatio, legion-* mail/tools)"]).join(", ")}`);
		push("- slash: `/legion doctor [section]`");
		push("- tool: `subagent({ action: \"diagnose\", section? })` — optional section filter (same as `/legion doctor [section]`)");
		push("");
	}

	if (want(selected, "storage")) {
		push("## Storage / hygiene");
		push(`- hygiene enabled: ${hygieneEnabled(env)} (${formatHygieneToggleSource(env)})`);
		push("- resolveHygieneConfig():");
		for (const line of formatHygieneConfigLines(env)) push(line);
		if (!storeRoot) {
			push("- storeRoot: (not provided — pass cwd/storeRoot for db/orphan stats)");
		} else {
			push(`- storeRoot: ${homeize(storeRoot, home)}`);
			if (sweepAt !== undefined) {
				push(`- last sweep: ${new Date(sweepAt).toISOString()} (removedTemps=${hygieneLast?.removedTempDirs ?? 0}, prunedRuns=${hygieneLast?.prunedRuns ?? 0}, deletedEvents=${hygieneLast?.deletedEvents ?? 0}, freed=${formatBytes(hygieneLast?.freedBytes ?? 0)}, errors=${hygieneLast?.errors ?? 0})`);
			} else {
				push("- last sweep: (no marker yet — written on next root-session startup hygiene)");
			}
			const runsRoot = path.join(storeRoot, "runs");
			let runCount = 0;
			let dbBytes = 0;
			let largestName = "";
			let largestSize = 0;
			try {
				for (const ent of fs.readdirSync(runsRoot, { withFileTypes: true })) {
					if (!ent.isDirectory()) continue;
					runCount++;
					const dbPath = legionDbPath(path.join(runsRoot, ent.name));
					try {
						const size = fs.statSync(dbPath).size;
						dbBytes += size;
						if (size > largestSize) {
							largestSize = size;
							largestName = ent.name;
						}
					} catch { /* no db */ }
				}
			} catch { /* missing */ }
			push(`- runs: ${runCount}; legion.db total ≈ ${formatBytes(dbBytes)}${largestName ? `; largest ${largestName} (${formatBytes(largestSize)})` : ""}`);
			if (orphans) {
				push(`- rpc-child temps: ${orphans.total} (live=${orphans.live}, dead-owner=${orphans.orphanDead}, unknown=${orphans.unknown})`);
				for (const s of orphans.samples) push(`    ${s}`);
			}
			try {
				push(`- store bytes (approx): ${formatBytes(dirBytes(storeRoot))}`);
			} catch { /* ignore */ }
		}
		push("");
	}

	if (want(selected, "runtime")) {
		push("## Session / runtime");
		const jobs = runtime.liveJobs ?? [];
		const nodes = runtime.treeNodes ?? [];
		if (!options.runtime) {
			push("(no runtime snapshot — `/legion doctor` in a live session fills this; `diagnose` from the tool does too)");
		} else {
			push(`- live jobs: ${jobs.length}`);
			for (const j of jobs.slice(0, 20)) {
				push(`    ${j.name} state=${j.state}${j.nodeId ? ` node=${j.nodeId}` : ""}`);
			}
			if (jobs.length > 20) push(`    … +${jobs.length - 20} more`);
			const byStatus = new Map<string, number>();
			for (const n of nodes) byStatus.set(n.status, (byStatus.get(n.status) ?? 0) + 1);
			push(`- tree nodes: ${nodes.length}${byStatus.size ? ` (${[...byStatus.entries()].map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}`);
			const pending = nodes.filter((n) => /running|starting|blocked|working/i.test(n.status) || /verify|accept/i.test(n.phase ?? ""));
			push(`- active / acceptance-ish: ${pending.length}`);
			for (const n of pending.slice(0, 15)) {
				push(`    ${n.name} (${n.id}) status=${n.status}${n.phase ? ` phase=${n.phase}` : ""}`);
			}
		}
		push("");
	}

	if (want(selected, "next")) {
		push("## Issues");
		const shown = options.sections?.length
			? issues.filter((i) => !i.section || selected.has(i.section) || i.section === "next")
			: issues;
		if (shown.length === 0) push("None.");
		for (const issue of shown) {
			push(`- [${issue.severity}] ${issue.code}${issue.section ? ` @${issue.section}` : ""}: ${issue.message}`);
			if (issue.fix) push(`    fix: ${issue.fix}`);
		}
		push("");
		push("## Next steps (actionable)");
		const steps: string[] = [];
		if (providerExtHome.length && issues.some((i) => i.code === "CHILD_NO_MODELS" || i.code === "TEAM_MODELS_MISSING" || i.code === "RECENT_MODEL_SPAWN_FAIL")) {
			steps.push(`export ${CHILD_EXTENSIONS_ENV}=${providerExtHome.join(",")}  # then restart pi`);
			steps.push(`# or role frontmatter extensions: […] / inheritExtensions: true (more RAM)`);
		}
		if (issues.some((i) => i.code === "ROLE_MISSING_LENS")) {
			steps.push("Add pi-lens extension path to roles that list lens_* tools, or to PI_LEGION_CHILD_EXTENSIONS.");
		}
		if (issues.some((i) => i.code === "ROLE_MISSING_CODEMODE")) {
			steps.push(`Add ${BUILTIN_CODEMODE} to roles that list codemode (or keep tools: codemode so Legion auto-loads it).`);
		}
		if (issues.some((i) => i.code === "MEMORY_GATE_WOULD_REFUSE")) {
			steps.push("Stop idle children (`/legion stop`) or lower/disable PI_LEGION_MIN_FREE_MEM_MB before launching more.");
		}
		if (issues.some((i) => i.code === "ORPHAN_TEMPS")) {
			steps.push("Orphan temps clear on next root session start; or restart pi to trigger hygiene.");
		}
		if (selected.has("storage") && issues.some((i) => i.code === "HYGIENE_SWEEP_STALE")) {
			steps.push(HYGIENE_SWEEP_HINT);
		}
		if (issues.some((i) => i.code === "STALE_VERIFY_SLOTS")) {
			steps.push("Stale verify locks are reclaimed automatically; delete slot-*.lock under the lock dir if a slot stays stuck.");
		}
		if (steps.length === 0) {
			steps.push("No blocking fixes. Re-run `/legion doctor` after changing env (restart pi). Use `/legion doctor models` etc. to focus.");
		} else {
			steps.push("Re-run `/legion doctor` or `subagent({ action: \"diagnose\" })` after changes (restart pi so env is picked up).");
		}
		for (let i = 0; i < steps.length; i++) push(`${i + 1}. ${steps[i]}`);
		push("");
		push(`Available sections: ${DOCTOR_SECTIONS.join(", ")}`);
	}

	const ok = !issues.some((i) => i.severity === "error");
	return {
		ok,
		text: lines.join("\n"),
		issues,
		sections: [...selected],
		hostModelCount: hostModels.length,
		childModelCount: childModels.length,
		packages,
	};
}

/** Collect model strings from a team roster settings blob (best-effort). */
export function expectedModelsFromSettings(settings: unknown): string[] {
	if (!settings || typeof settings !== "object") return [];
	const sub = (settings as { subagents?: unknown }).subagents;
	if (!sub || typeof sub !== "object") return [];
	const out = new Set<string>();
	const defaultModel = (sub as { defaultModel?: unknown }).defaultModel;
	if (typeof defaultModel === "string" && defaultModel.trim()) out.add(defaultModel.trim());
	const team = (sub as { team?: unknown }).team;
	const teams = (sub as { teams?: unknown }).teams;
	const active =
		typeof team === "string" && teams && typeof teams === "object"
			? (teams as Record<string, unknown>)[team]
			: undefined;
	const members =
		active && typeof active === "object" && Array.isArray((active as { members?: unknown }).members)
			? (active as { members: unknown[] }).members
			: [];
	for (const m of members) {
		if (typeof m === "object" && m && typeof (m as { model?: unknown }).model === "string") {
			const model = (m as { model: string }).model.trim();
			if (model) out.add(model);
		}
	}
	const overrides = (sub as { agentOverrides?: unknown }).agentOverrides;
	if (overrides && typeof overrides === "object") {
		for (const entry of Object.values(overrides as Record<string, unknown>)) {
			if (entry && typeof entry === "object" && typeof (entry as { model?: unknown }).model === "string") {
				const model = (entry as { model: string }).model.trim();
				if (model) out.add(model);
			}
		}
	}
	return [...out];
}
