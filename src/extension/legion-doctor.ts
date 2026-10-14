/**
 * `/legion doctor` and `subagent action=diagnose`: self-check for child spawn /
 * extension / provider issues (inspired by `pi list` / `pi auth check`).
 *
 * The report is meant for both humans and the main agent — especially after
 * `#43` made children start with `--no-extensions`, so provider packages like
 * `pi-any-endpoint` no longer register models in the child by default.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CHILD_EXTENSIONS_ENV,
	CHILD_INHERIT_EXTENSIONS_ENV,
	childExtraExtensions,
	childInheritsExtensions,
	buildPiArgs,
	childGuardExtensionPath,
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
} from "../supervisor/child-memory.ts";
import type { AgentConfig } from "../shared/types.ts";
import { recentSpawnFailures, type SpawnFailureRecord } from "./spawn-hints.ts";

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
}

export interface DoctorReport {
	ok: boolean;
	text: string;
	issues: DoctorIssue[];
	hostModelCount: number;
	childModelCount: number;
	packages: DoctorPackage[];
}

export interface DoctorOptions {
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
	/** `pi` CLI path; defaults to `process.argv[1]` / PATH `pi`. */
	piCli?: string;
	/** Sample role used for the argv preview (defaults to a minimal stub). */
	sampleAgent?: AgentConfig;
	/** Models the current team / roster expects children to use (`provider/id` or `id`). */
	expectedModels?: string[];
	/** Skip spawning `pi --list-models` (unit tests). */
	probeModels?: boolean;
	/** Injected model lists when probeModels is false. */
	hostModels?: string[];
	childModels?: string[];
	/** Optional override for recent spawn failures. */
	failures?: readonly SpawnFailureRecord[];
	/** Exec helper for probing; defaults to execFileSync. */
	runPi?: (args: string[], timeoutMs: number) => string;
	cwd?: string;
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
		// npm:@scope/name@version or npm:name@version
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
	const out: string[] = [];
	for (const entry of list) {
		if (typeof entry !== "string" || !entry.trim()) continue;
		const resolved = path.resolve(pkgRoot, entry);
		if (fs.existsSync(resolved)) out.push(resolved);
		else out.push(resolved); // still report; doctor flags missing
	}
	return out;
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

/** Parse `pi --list-models` table into `provider/id` strings. */
export function parseListModels(output: string): string[] {
	const lines = output.split(/\r?\n/);
	const models: string[] = [];
	for (const line of lines) {
		if (/^provider\b/i.test(line) || !line.trim()) continue;
		if (/^No models available/i.test(line)) return [];
		// provider  model  context ...
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
	// expected may be bare `workbuddy/foo` while list is `any-endpoint/workbuddy/foo`
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

export function runLegionDoctor(options: DoctorOptions = {}): DoctorReport {
	const env = options.env ?? process.env;
	const agentDir = options.agentDir ?? getAgentDir();
	const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
	const issues: DoctorIssue[] = [];
	const packages = loadHostPackages(agentDir);
	const inherit = childInheritsExtensions({ inheritExtensions: options.sampleAgent?.inheritExtensions }, env);
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
	let probeError: string | undefined;
	if (probe) {
		try {
			hostModels = parseListModels(runPi(["--list-models"], 15_000));
			childModels = parseListModels(runPi(["--no-extensions", "--list-models"], 15_000));
		} catch (error) {
			probeError = error instanceof Error ? error.message : String(error);
			issues.push({
				severity: "warning",
				code: "PROBE_FAILED",
				message: `Could not run pi --list-models: ${probeError}`,
			});
		}
	}

	// Which provider packages restore child models?
	const restoring: { pkg: DoctorPackage; path: string; models: number }[] = [];
	if (probe && !inherit && childModels.length === 0 && hostModels.length > 0) {
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

	if (!inherit && noExtensions && hostModels.length > 0 && childModels.length === 0) {
		issues.push({
			severity: "error",
			code: "CHILD_NO_MODELS",
			message:
				`Host has ${hostModels.length} model(s) but a child with --no-extensions sees none. ` +
				`Providers are registered by host packages that children no longer load (#43).`,
			fix: providerExtHome.length
				? `export ${CHILD_EXTENSIONS_ENV}=${providerExtHome.join(",")}`
				: `Add the provider package extension path to ${CHILD_EXTENSIONS_ENV}, or set role extensions: / inheritExtensions: true.`,
		});
	} else if (!inherit && noExtensions && hostModels.length > childModels.length && childModels.length > 0) {
		issues.push({
			severity: "warning",
			code: "CHILD_FEWER_MODELS",
			message: `Child --no-extensions sees ${childModels.length}/${hostModels.length} host models.`,
		});
	}

	const expected = options.expectedModels ?? [];
	const missing = inherit
		? expected.filter((m) => !modelMatches(m, hostModels))
		: expected.filter((m) => !modelMatches(m, childModels));
	if (missing.length > 0 && (childModels.length === 0 || !inherit)) {
		issues.push({
			severity: "error",
			code: "TEAM_MODELS_MISSING",
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
				message: `settings package not found on disk: ${pkg.source}`,
			});
		}
		for (const ext of pkg.extensionPaths) {
			if (!fs.existsSync(ext)) {
				issues.push({
					severity: "warning",
					code: "EXTENSION_MISSING",
					message: `${pkg.name} extension path missing: ${ext}`,
				});
			}
		}
	}

	const gate = resolveMemoryGateConfig(env);
	const availableMb = availableMemoryMb();
	const failures = options.failures ?? recentSpawnFailures();

	if (failures.some((f) => f.hadNoExtensions !== false && /not found|No models/i.test(f.stderr ?? f.message))) {
		issues.push({
			severity: "error",
			code: "RECENT_MODEL_SPAWN_FAIL",
			message: "A recent child spawn failed with a model/provider error under --no-extensions.",
			fix: providerExtHome.length
				? `export ${CHILD_EXTENSIONS_ENV}=${providerExtHome.join(",")}`
				: undefined,
		});
	}

	const lines: string[] = [];
	lines.push("# Legion doctor");
	lines.push("");
	lines.push(`Agent dir: ${homeize(agentDir, home)}`);
	lines.push(`Pi CLI: ${piCli}`);
	lines.push("");

	lines.push("## Child extension policy");
	lines.push(`- inheritExtensions (role/env): ${inherit ? "yes (loads all host extensions)" : "no"}`);
	lines.push(`- child argv includes --no-extensions: ${noExtensions ? "yes" : "no"}`);
	lines.push(`- ${CHILD_INHERIT_EXTENSIONS_ENV}=${env[CHILD_INHERIT_EXTENSIONS_ENV] ?? "(unset)"}`);
	lines.push(`- ${CHILD_EXTENSIONS_ENV}=${env[CHILD_EXTENSIONS_ENV] ?? "(unset)"}`);
	lines.push(`- extra extension paths: ${extras.length ? extras.map((p) => homeize(p, home)).join(", ") : "(none)"}`);
	lines.push(`- guard extension: ${homeize(childGuardExtensionPath(), home)}`);
	lines.push("");

	lines.push("## Host packages (settings.packages)");
	if (packages.length === 0) lines.push("(none)");
	for (const pkg of packages) {
		const tag = pkg.likelyProvider ? " [provider?]" : "";
		const root = pkg.root ? homeize(pkg.root, home) : "(missing)";
		lines.push(`- ${pkg.source} → ${root}${tag}`);
		for (const ext of pkg.extensionPaths) {
			const ok = fs.existsSync(ext) ? "" : " MISSING";
			lines.push(`    --extension ${homeize(ext, home)}${ok}`);
		}
	}
	lines.push("");

	lines.push(`## Sample child argv (${sample.name})`);
	lines.push("```");
	lines.push(argv.join(" "));
	lines.push("```");
	lines.push(`Explicit --extension count: ${explicitExts.length}`);
	lines.push("");

	lines.push("## Models");
	lines.push(`- host (normal discovery): ${hostModels.length}`);
	lines.push(`- child (--no-extensions): ${childModels.length}`);
	if (hostModels.length && childModels.length === 0) {
		lines.push("- child sees NO models — providers come from host packages that `--no-extensions` skips.");
	}
	if (restoring.length) {
		lines.push("- packages that restore models when passed via `--extension`:");
		for (const r of restoring) {
			lines.push(`    ${r.pkg.name}: ${homeize(r.path, home)} (${r.models} models)`);
		}
	}
	if (expected.length) {
		lines.push(`- expected (team/roster): ${expected.join(", ") || "(none)"}`);
		if (missing.length) lines.push(`- MISSING for children: ${missing.join(", ")}`);
	}
	if (hostModels.length <= 12) {
		for (const m of hostModels) lines.push(`    host: ${m}`);
	} else {
		for (const m of hostModels.slice(0, 8)) lines.push(`    host: ${m}`);
		lines.push(`    ... +${hostModels.length - 8} more`);
	}
	lines.push("");

	lines.push("## Memory gate / child V8");
	lines.push(`- available: ${availableMb} MB`);
	lines.push(`- ${MIN_FREE_MEM_ENV}=${gate.minFreeMb} (0 = off)`);
	lines.push(`- ${CHILD_RESERVE_ENV}=${gate.reserveMb}`);
	lines.push(`- child NODE_OPTIONS: ${childNodeOptions(env) ?? "(unchanged)"}`);
	lines.push(`- ${CHILD_MAX_OLD_SPACE_ENV}=${env[CHILD_MAX_OLD_SPACE_ENV] ?? "(default)"}`);
	lines.push(`- ${CHILD_SEMI_SPACE_ENV}=${env[CHILD_SEMI_SPACE_ENV] ?? "(default)"}`);
	lines.push("");

	lines.push("## Recent spawn failures");
	if (failures.length === 0) lines.push("(none recorded in this process)");
	for (const f of failures.slice(0, 5)) {
		const when = new Date(f.ts).toISOString();
		lines.push(`- ${when} ${f.name}: ${(f.stderr ?? f.message).trim().slice(0, 240).replace(/\s+/g, " ")}`);
	}
	lines.push("");

	lines.push("## Issues");
	if (issues.length === 0) lines.push("None. Children should see the same providers the doctor probe showed.");
	for (const issue of issues) {
		lines.push(`- [${issue.severity}] ${issue.code}: ${issue.message}`);
		if (issue.fix) lines.push(`    fix: ${issue.fix}`);
	}
	lines.push("");

	lines.push("## Suggested fixes");
	if (providerExtHome.length) {
		lines.push(`1. Prefer narrow: \`export ${CHILD_EXTENSIONS_ENV}=${providerExtHome.join(",")}\``);
		lines.push("   (or add those paths under each role's `extensions:` frontmatter).");
		lines.push(`2. Broad (more RAM): \`export ${CHILD_INHERIT_EXTENSIONS_ENV}=1\` or role \`inheritExtensions: true\`.`);
	} else if (issues.some((i) => i.code === "CHILD_NO_MODELS")) {
		lines.push(`1. Find the provider package under ${homeize(path.join(agentDir, "npm/node_modules"), home)} and set ${CHILD_EXTENSIONS_ENV} to its pi.extensions entry.`);
		lines.push(`2. Or \`export ${CHILD_INHERIT_EXTENSIONS_ENV}=1\` (loads every host extension — costly).`);
	} else {
		lines.push("No extension change required for models. If spawn still fails, check Recent spawn failures and role model ids.");
	}
	lines.push("Re-run `/legion doctor` or `subagent action=diagnose` after changing env (restart pi so env is picked up).");

	const ok = !issues.some((i) => i.severity === "error");
	return {
		ok,
		text: lines.join("\n"),
		issues,
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
