/**
 * `/legion doctor crossmachine` — one command, every fact (contract
 * `first-run-success-v1` D6/D7/D8).
 *
 * The failure this module removes (real 6.2.0 session): the doctor section was
 * synchronous and probe-free, so it could only echo the configuration
 * (`resolveHostTarget`) and the last recorded delivery preflight. Nothing in it
 * answered "what is missing on that machine RIGHT NOW", and the operator paid
 * ~50 rounds of source reading for facts one `hc` round trip each can produce.
 *
 * Two rules shape everything below:
 *
 *   - **Read-only.** No `git` write, no `mkdir`, no launch, no settings edit. The
 *     module describes the world; the `fix:` lines are commands the READER runs.
 *   - **Never throws.** A probe that fails is a FAIL item carrying the failure's
 *     own sentence, and the items after it become SKIP with the reason — a
 *     checkup that dies tells the operator nothing, which is the same bug in a
 *     new costume. A transport failure is `host '<h>' unreachable: …` (the
 *     transport layer's wording, `remoteExec`), never "the path is missing".
 *
 * The item order is frozen (D7) and is the ORDER OF THE FACTS, not the order of
 * a launch: this session's checkout, then the machine registry, then per host the
 * target's checkout, its origin, its runtime, the inherited extensions that must
 * exist there, and the models its `pi` serves. Every FAIL line is followed by
 * pasteable `fix:` lines with REAL values (host, path, package, role) — a
 * placeholder in a fix is the "read the source" answer wearing a costume.
 *
 * `legion-doctor.ts` stays synchronous and probe-free: it renders the
 * {@link CrossMachineCheckup} snapshot both async callers hand it, and only when
 * the `crossmachine` section is selected.
 */

import * as path from "node:path";
import { discoverAgents } from "../agents/agents.ts";
import { applyAgentOverrides } from "../agents/overrides.ts";
import { getAgentDir } from "../agents/paths.ts";
import { loadSubagentSettings } from "../agents/settings.ts";
import { modelMatches, parseListModels } from "../shared/list-models.ts";
import type { AgentConfig, SubagentsSettings } from "../shared/types.ts";
import { hcCliClient, type HcClient } from "../hc/client.ts";
import { SELF_EXTENSION_NAME } from "./args.ts";
import {
	childInheritsExtensions,
	discoveredHostExtensions,
	inheritedExtensions,
	matchesExcludedExtension,
} from "./extension-inheritance.ts";
import {
	REMOTE_PREFLIGHT_TIMEOUT_S,
	execResultText,
	listHcMachines,
	missingRemoteCwdQuestion,
	packageLoaderFor,
	resolveHostTargetAsync,
	resolvePackagePathOnHost,
	type HcExecResult,
	type HcMachineEntry,
	type HostPackageIndex,
	type HostTarget,
} from "./remote.ts";
import {
	localCheckoutState,
	noLocalGitMessage,
	notALocalCheckoutMessage,
	normalizeGitRemoteUrl,
	remoteExec,
	remoteOriginUrl,
	remotePathIsDirectory,
	type LocalCheckoutState,
} from "./remote-worktree.ts";

/** One checkup fact, in the frozen order of D7. */
export type CrossMachineCheckupStatus = "pass" | "fail" | "skip";

export type CrossMachineCheckupItemId =
	| "parent-checkout"
	| "hc-machines"
	| "target-checkout"
	| "target-origin"
	| "target-runtime"
	| "inherited-extensions"
	| "target-models";

export interface CrossMachineCheckupItem {
	id: CrossMachineCheckupItemId;
	status: CrossMachineCheckupStatus;
	/** One line, no leading "- " and no host prefix: doctor composes those. */
	line: string;
	/** Pasteable commands / JSON, in order. Real values only — never `<...>` placeholders. */
	fixes?: string[];
}

export interface CrossMachineCheckupHost {
	host: string;
	/** "settings" = a subagents.crossMachine.hosts key, "hc" = only `machine list` knows it. */
	source: "settings" | "hc";
	items: CrossMachineCheckupItem[];
	/** Real, pasteable launch line built from resolved values; absent when no cwd is known. */
	launch?: string;
	/** When `launch` is absent: the D2 question (`missingRemoteCwdQuestion(host)`). */
	question?: string;
}

export interface CrossMachineCheckup {
	enabled: boolean;
	/** Session cwd this checkup judged ("parent checkout" item is about it). */
	cwd: string;
	parent: CrossMachineCheckupItem[];
	hosts: CrossMachineCheckupHost[];
	at: number;
}

/** Bounds from D7: the rest is a count, never a wall of text. */
const MAX_HOSTS = 5;
const MAX_MISSING_PACKAGES = 8;
const MAX_PACKAGE_FIXES = 5;
const MAX_MODELS_LISTED = 10;
/** How much of a program's stderr a one-line item carries. */
const DETAIL_CLIP = 300;

/** The per-host probes, in D7's order — also the SKIP list when one fails. */
const TARGET_ITEM_IDS: readonly CrossMachineCheckupItemId[] = [
	"target-checkout",
	"target-origin",
	"target-runtime",
	"inherited-extensions",
	"target-models",
];

/**
 * Doctor's label for an item (`target-checkout` → `target checkout`).
 *
 * Kept here as the single spelling; doctor re-derives the same string from the id
 * so it needs no runtime import from this module (D6 keeps doctor probe-free and
 * dependency-light).
 */
function itemLabel(id: CrossMachineCheckupItemId): string {
	return id.replace(/-/g, " ");
}

export async function runCrossMachineCheckup(options: {
	cwd: string;
	settings?: SubagentsSettings["crossMachine"];
	/** Role cards; when absent the checkup loads them (`discoverAgents(cwd,"both")` + `applyAgentOverrides` + `loadSubagentSettings`). */
	agents?: readonly AgentConfig[];
	/** Model a launch would use; falls back to `agents[0]?.model`, then SKIP. */
	model?: string;
	env?: NodeJS.ProcessEnv;
	/** Test seam: reuse one client for `machine.list` + every `machine.exec`. */
	client?: HcClient;
	now?: () => number;
	/** Test seam for the parent-side probe (defaults to the real `localCheckoutState`). */
	localCheckout?: (repo: string) => LocalCheckoutState;
}): Promise<CrossMachineCheckup> {
	const cwd = options.cwd;
	const settings = options.settings;
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const at = now();
	const enabled = settings?.enabled === true;

	// ONE connection for the whole checkup: `machine.list`, discovery and every
	// probe share it, so a checkup costs one `hc connect` instead of one per
	// question. The client is a seam in tests and owned here in production.
	const owned = options.client === undefined;
	const client: HcClient = options.client ?? hcCliClient({ env });
	let startError: string | undefined;
	if (owned) {
		try {
			await client.start();
		} catch (error) {
			// No `hc` binary / no core is a fact about THIS machine, and every remote
			// item below inherits it: reporting five identical transport failures
			// would bury it.
			startError = oneLine(errorMessage(error));
		}
	}
	try {
		return await collect({
			cwd,
			settings,
			env,
			client,
			at,
			now,
			agents: options.agents,
			model: options.model,
			localCheckout: options.localCheckout,
			startError,
		});
	} catch (error) {
		// Belt and braces: the contract is "never throws out of here". Everything
		// inside is already per-probe guarded, so this is only reachable through a
		// bug — and even then the operator gets a report instead of a stack trace.
		return {
			enabled,
			cwd,
			parent: [{ id: "parent-checkout", status: "fail", line: `the checkup stopped early: ${oneLine(errorMessage(error))}` }],
			hosts: [],
			at,
		};
	} finally {
		if (owned) {
			try {
				client.close();
			} catch {
				/* closing a connection that already died is not a finding */
			}
		}
	}
}

interface CollectInput {
	cwd: string;
	settings?: SubagentsSettings["crossMachine"];
	agents?: readonly AgentConfig[];
	model?: string;
	env: NodeJS.ProcessEnv;
	client: HcClient;
	now: () => number;
	localCheckout?: (repo: string) => LocalCheckoutState;
	at: number;
	startError?: string;
}

async function collect(input: CollectInput): Promise<CrossMachineCheckup> {
	const { cwd, settings, env, client, at } = input;
	const agents: AgentConfig[] = input.agents !== undefined ? [...input.agents] : loadAgents(cwd, env);
	const model = firstNonEmpty(input.model) ?? firstNonEmpty(agents[0]?.model);

	// 1. the machine registry. `undefined` is a THIRD answer ("old core / no
	// answer") and stays one: turning it into "no machines" would report every
	// configured host as unregistered.
	let machines: HcMachineEntry[] | undefined;
	let machineError: string | undefined;
	if (input.startError !== undefined) machineError = input.startError;
	else machines = await listHcMachines({ env, client, refresh: false });

	// 2. the host set: settings keys in their own order, then registry-only names.
	// D6: the v1.1 minimal config (`{enabled:true}`, no `hosts` block) must appear.
	const settingsHosts = Object.keys(settings?.hosts ?? {});
	const machineNames = machines?.map((machine) => machine.name) ?? [];
	const hostRefs: Array<{ host: string; source: "settings" | "hc" }> = [
		...settingsHosts.map((host) => ({ host, source: "settings" as const })),
		...machineNames.filter((name) => !settingsHosts.includes(name)).map((host) => ({ host, source: "hc" as const })),
	];
	const firstHost = hostRefs[0]?.host ?? "";
	const checkedHosts = hostRefs.slice(0, MAX_HOSTS);
	const remainder = hostRefs.length - checkedHosts.length;

	// 3. this session's directory, from the ONE probe D5 froze (`localCheckoutState`).
	let parentState: LocalCheckoutState;
	try {
		parentState = (input.localCheckout ?? localCheckoutState)(cwd);
	} catch {
		// A seam that throws is a directory git could not answer for at all.
		parentState = { kind: "not-a-checkout" };
	}
	const parent = parentItem(parentState, cwd, firstHost);
	const localOrigin = parentState.kind === "checkout" ? parentState.origin : undefined;

	// 4. the registry item, which also carries the host cap's remainder.
	const machineItem = machinesItem({
		machines,
		machineError,
		settingsHosts,
		remainder,
	});

	// 5. per host, one block each.
	const hosts: CrossMachineCheckupHost[] = [];
	for (const ref of checkedHosts) {
		hosts.push(
			await checkHost({
				host: ref.host,
				source: ref.source,
				settings,
				env,
				client,
				agents,
				model,
				localOrigin,
				cwd,
				unreachable: machineError,
			}),
		);
	}

	// `parent` is every fact about THIS side (D7 items 1 and 2): the session's
	// checkout and the machine registry. The per-host blocks follow.
	return { enabled: settings?.enabled === true, cwd, parent: [parent, machineItem], hosts, at };
}

/** The parent-side fact, in D5's three answers (plus "no git at all"). */
function parentItem(state: LocalCheckoutState, cwd: string, firstHost: string): CrossMachineCheckupItem {
	if (state.kind === "checkout" && state.origin !== undefined) {
		return { id: "parent-checkout", status: "pass", line: `${cwd} is a git checkout; origin ${state.origin}` };
	}
	if (state.kind === "checkout") {
		// `noLocalOriginMessage` names a host and teaches a settings rule; here the
		// fact is about THIS directory, and the fix is the one command that adds a
		// remote. `<url>` stays a metavariable because no url is knowable here —
		// inventing one would be worse than naming the slot.
		return {
			id: "parent-checkout",
			status: "fail",
			line: `${cwd} is a git checkout but has no origin`,
			fixes: [`git -C ${cwd} remote add origin <url>`],
		};
	}
	if (state.kind === "not-a-checkout") {
		// D5's sentence, verbatim: the advice "git remote add origin" is IMPOSSIBLE
		// in a directory that is not a repository, and that was pitfall #1.
		return {
			id: "parent-checkout",
			status: "fail",
			line: oneLine(notALocalCheckoutMessage({ host: firstHost, localRepo: cwd })),
			fixes: [
				`restart pi inside the checkout, or pass a relative cwd: subagent({ agent: "centurion", host: "${firstHost}", cwd: "../my-repo", task: "..." })`,
			],
		};
	}
	return {
		id: "parent-checkout",
		status: "fail",
		line: oneLine(noLocalGitMessage({ host: firstHost, localRepo: cwd, code: state.code, detail: state.detail })),
		fixes: ["install git on this machine (git --version must work here), then re-run: /legion doctor crossmachine"],
	};
}

/** `machine.list`'s answer: PASS with the names, FAIL with the missing ones, SKIP when it cannot answer. */
function machinesItem(input: {
	machines: HcMachineEntry[] | undefined;
	machineError: string | undefined;
	settingsHosts: string[];
	remainder: number;
}): CrossMachineCheckupItem {
	const note = input.remainder > 0 ? `; ${input.remainder} more host(s) not checked (cap ${MAX_HOSTS})` : "";
	if (input.machines === undefined) {
		return {
			id: "hc-machines",
			status: "skip",
			line: `machine.list did not answer${input.machineError ? ` (${input.machineError})` : " (old core or no hc)"} — checking the hosts this configuration names${note}`,
		};
	}
	const known = input.machines.map((machine) => machine.name);
	const listing = known.length > 0 ? known.join(", ") : "no machines registered";
	const absent = input.settingsHosts.filter((host) => !known.includes(host));
	if (absent.length > 0) {
		return {
			id: "hc-machines",
			status: "fail",
			line: `${listing}; configured in settings but unknown to hc: ${absent.join(", ")}${note}`,
			fixes: absent.slice(0, MAX_PACKAGE_FIXES).map((host) => `hc machine add --name ${host} ssh://user@${host}`),
		};
	}
	return { id: "hc-machines", status: "pass", line: `${listing}${note}` };
}

/** Everything one host's block needs. */
async function checkHost(input: {
	host: string;
	source: "settings" | "hc";
	settings: SubagentsSettings["crossMachine"] | undefined;
	env: NodeJS.ProcessEnv;
	client: HcClient;
	agents: readonly AgentConfig[];
	model: string | undefined;
	localOrigin: string | undefined;
	cwd: string;
	unreachable: string | undefined;
}): Promise<CrossMachineCheckupHost> {
	const { host, source, settings, env, client, agents, model, localOrigin, cwd } = input;
	const items: CrossMachineCheckupItem[] = [];

	// Transport already dead before this host was reached (no `hc` core): one
	// sentence, then every probe is skipped for the same reason.
	if (input.unreachable !== undefined) {
		const reason = `host '${host}' unreachable: ${input.unreachable}`;
		items.push({ id: "target-checkout", status: "fail", line: reason });
		for (const id of TARGET_ITEM_IDS.slice(1)) {
			items.push({ id, status: "skip", line: `${itemLabel(id)} not checked: ${firstSentence(reason)}` });
		}
		return { host, source, items };
	}

	// D3: `{}` is a complete entry when `hc` knows the name, so a registry-only
	// host resolves through the same function a launch uses — one rule, no second
	// `machine.list` (`admission: "never"`).
	const targetConfig: SubagentsSettings["crossMachine"] = {
		enabled: true,
		hosts: { ...(settings?.hosts ?? {}), [host]: settings?.hosts?.[host] ?? {} },
	};
	let target: HostTarget;
	try {
		target = await resolveHostTargetAsync(host, targetConfig, {
			admission: "never",
			client,
			env,
			cacheDir: null,
		});
	} catch (error) {
		// The resolver's own sentence is the answer (it names the missing input);
		// nothing after it can be asked, because every probe needs its `cwd`.
		const message = oneLine(errorMessage(error));
		const question = message === oneLine(missingRemoteCwdQuestion(host)) ? missingRemoteCwdQuestion(host) : undefined;
		items.push({ id: "target-checkout", status: "fail", line: message });
		for (const id of TARGET_ITEM_IDS.slice(1)) {
			items.push({ id, status: "skip", line: `${itemLabel(id)} not checked: ${firstSentence(message)}` });
		}
		return { host, source, items, ...(question !== undefined ? { question } : {}) };
	}

	const steps: Array<{ id: CrossMachineCheckupItemId; run: () => Promise<CrossMachineCheckupItem> }> = [
		{ id: "target-checkout", run: () => probeTargetCheckout(client, target) },
		{ id: "target-origin", run: () => probeTargetOrigin({ client, target, localOrigin, localRepo: cwd }) },
		{ id: "target-runtime", run: () => probeTargetRuntime(client, target) },
		{
			id: "inherited-extensions",
			run: () => probeInheritedExtensions({ target, agents, env }),
		},
		{ id: "target-models", run: () => probeTargetModels({ client, target, model }) },
	];

	// D7's stop rule: a transport failure FAILs ITS item and turns the rest into
	// SKIP — a later fact about an unreachable machine would be a guess.
	let stopped: string | undefined;
	for (let index = 0; index < steps.length; index++) {
		const step = steps[index]!;
		if (stopped !== undefined) {
			items.push({ id: step.id, status: "skip", line: `${itemLabel(step.id)} not checked: ${firstSentence(stopped)}` });
			continue;
		}
		try {
			items.push(await step.run());
		} catch (error) {
			const message = oneLine(errorMessage(error));
			items.push({ id: step.id, status: "fail", line: message });
			stopped = message;
		}
	}

	// D8: the last line of the block is a launch with REAL values. Built from the
	// RESOLVED target, so the directory printed is the one a child would start in.
	return { host, source, items, launch: launchLine(host, target.cwd) };
}

/** a. does the directory exist ON that machine? */
async function probeTargetCheckout(client: HcClient, target: HostTarget): Promise<CrossMachineCheckupItem> {
	const exists = await remotePathIsDirectory(client, target, target.cwd);
	if (exists) return { id: "target-checkout", status: "pass", line: `${target.cwd} exists` };
	return {
		id: "target-checkout",
		status: "fail",
		line: `${target.cwd} does not exist on ${target.host}`,
		fixes: [
			`hc exec --on ${target.host} -- ls -d ${target.cwd}`,
			`point subagents.crossMachine.hosts.${target.host}.cwd at an existing absolute path on ${target.host}, then re-run: /legion doctor crossmachine`,
		],
	};
}

/** b. is it a checkout THERE, and does its origin equal this checkout's (normalized)? */
async function probeTargetOrigin(input: {
	client: HcClient;
	target: HostTarget;
	localOrigin: string | undefined;
	localRepo: string;
}): Promise<CrossMachineCheckupItem> {
	const { client, target, localOrigin, localRepo } = input;
	const gitDir = await remoteExec(
		client,
		target,
		{ argv: ["git", "-C", target.cwd, "rev-parse", "--git-dir"], timeout: REMOTE_PREFLIGHT_TIMEOUT_S },
		`git -C ${target.cwd} rev-parse --git-dir`,
	);
	if (gitDir.code === 127) {
		// The shell's "command not found". A directory that is fine must not be
		// reported as "not a repository" because the PROGRAM is missing (D6).
		return {
			id: "target-origin",
			status: "fail",
			line: `git is not installed on ${target.host} (exit 127: ${detailOf(gitDir)})`,
			fixes: [
				`hc exec --on ${target.host} -- git --version`,
				`install git on ${target.host} and put it on PATH, then re-run: /legion doctor crossmachine`,
			],
		};
	}
	if (gitDir.code !== 0) {
		return {
			id: "target-origin",
			status: "fail",
			line: `${target.cwd} is not a git checkout on ${target.host} (${detailOf(gitDir)})`,
			fixes: [`hc exec --on ${target.host} -- git -C ${target.cwd} rev-parse --git-dir`],
		};
	}
	const remoteOrigin = await remoteOriginUrl(client, target, target.cwd);
	if (remoteOrigin === undefined) {
		return {
			id: "target-origin",
			status: "fail",
			line: `${target.cwd} has no origin on ${target.host}`,
			fixes: [
				localOrigin !== undefined
					? `hc exec --on ${target.host} -- git -C ${target.cwd} remote add origin ${localOrigin}`
					: `hc exec --on ${target.host} -- git -C ${target.cwd} remote add origin <url>`,
			],
		};
	}
	if (localOrigin === undefined) {
		// The parent item already said this checkout has no origin; naming the
		// target's url is what makes the parent-side fix pasteable.
		return {
			id: "target-origin",
			status: "fail",
			line: `${target.host}:${target.cwd} has origin ${remoteOrigin} but this checkout has none`,
			fixes: [`git -C ${localRepo} remote add origin ${remoteOrigin}`],
		};
	}
	if (normalizeGitRemoteUrl(remoteOrigin) !== normalizeGitRemoteUrl(localOrigin)) {
		return {
			id: "target-origin",
			status: "fail",
			line: `origin ${remoteOrigin} on ${target.host} but ${localOrigin} here`,
			fixes: [
				`hc exec --on ${target.host} -- git -C ${target.cwd} remote set-url origin ${localOrigin}`,
				`git -C ${localRepo} remote set-url origin ${remoteOrigin}`,
			],
		};
	}
	return { id: "target-origin", status: "pass", line: `${target.cwd} origin ${remoteOrigin} matches this checkout` };
}

/** c. node and pi, invoked exactly as the child would invoke them. */
async function probeTargetRuntime(client: HcClient, target: HostTarget): Promise<CrossMachineCheckupItem> {
	const node = await remoteExec(
		client,
		target,
		{ argv: [target.node, "--version"], timeout: REMOTE_PREFLIGHT_TIMEOUT_S },
		`${target.node} --version`,
	);
	const nodeVersion = stdoutFirstLine(node);
	if (node.code !== 0 || nodeVersion.length === 0) {
		return {
			id: "target-runtime",
			status: "fail",
			line: `${target.node} does not run on ${target.host} (exit ${codeOf(node)}: ${detailOf(node)})`,
			fixes: [
				`hc exec --on ${target.host} -- ${target.node} --version`,
				`install node on ${target.host} (or point subagents.crossMachine.hosts.${target.host}.node at the real binary), then re-run: /legion doctor crossmachine`,
			],
		};
	}
	const pi = await remoteExec(
		client,
		target,
		{ argv: [target.node, target.piCli, "--version"], timeout: REMOTE_PREFLIGHT_TIMEOUT_S },
		`${target.node} ${target.piCli} --version`,
	);
	const piVersion = stdoutFirstLine(pi);
	if (pi.code !== 0 || piVersion.length === 0) {
		return {
			id: "target-runtime",
			status: "fail",
			line: `${target.piCli} does not run under ${target.node} on ${target.host} (exit ${codeOf(pi)}: ${detailOf(pi)})`,
			fixes: [
				`hc exec --on ${target.host} -- ${target.node} ${target.piCli} --version`,
				`point subagents.crossMachine.hosts.${target.host}.piCli at the JavaScript entry (…/dist/bundle/cli.js), never the launcher`,
			],
		};
	}
	return {
		id: "target-runtime",
		status: "pass",
		line: `${target.node} ${nodeVersion} and ${target.piCli} ${piVersion} — the paths the child will use there`,
	};
}

/** d. every inherited package that must exist on the target, resolved by NAME (v1.2). */
async function probeInheritedExtensions(input: {
	target: HostTarget;
	agents: readonly AgentConfig[];
	env: NodeJS.ProcessEnv;
}): Promise<CrossMachineCheckupItem> {
	const { target, agents, env } = input;

	// The inherited set is a list of THIS machine's package paths, so it is
	// collected first: a host where nothing is inherited needs no probe at all.
	const hostExtensions = discoveredHostExtensions() ?? [];
	const wanted: Array<{ role: string; extension: string }> = [];
	for (const agent of agents) {
		if (!childInheritsExtensions(agent, env)) continue;
		for (const extension of inheritedExtensions(agent, hostExtensions, env)) {
			// Legion's own extension is never inherited — the child-guard names it
			// explicitly, and loading it twice kills the child (`args.ts` rule).
			if (matchesExcludedExtension(extension, SELF_EXTENSION_NAME)) continue;
			wanted.push({ role: agent.name, extension });
		}
	}
	if (wanted.length === 0) {
		return { id: "inherited-extensions", status: "pass", line: "no inherited extensions to check" };
	}

	// A FULLY EXPLICIT host entry (operator wrote `cwd`/`node`/`piCli`/
	// `piLegionRoot`) resolves without any discovery probe, so it carries no
	// package index — and that is exactly the operator who most needs the
	// "package missing on that machine" answer. The resolver registered an
	// on-demand loader for precisely this case (`packageLoaderFor`), so one probe
	// buys the target's installed packages instead of a SKIP.
	let index: HostPackageIndex | undefined = target.packageIndex;
	if (index === undefined) {
		const loader = packageLoaderFor(target);
		if (loader === undefined) {
			return {
				id: "inherited-extensions",
				status: "skip",
				line: `could not read the installed packages on ${target.host} (no discovery report and no on-demand probe — write the host's fields in subagents.crossMachine.hosts.${target.host} or re-run: /legion doctor crossmachine)`,
			};
		}
		index = await loader();
		if (index === undefined) {
			return {
				id: "inherited-extensions",
				status: "skip",
				line: `could not read the installed packages on ${target.host} (the installed-package probe did not answer — check the connection to that machine)`,
			};
		}
	}

	const missing = new Map<string, string>();
	let checked = 0;
	for (const entry of wanted) {
		checked++;
		const resolution = resolvePackagePathOnHost(entry.extension, index);
		if (resolution.ok || resolution.reason !== "not-installed") continue;
		const name = resolution.packageName ?? path.basename(entry.extension);
		// One role per package: the FIRST role whose set contained it, because the
		// `excludeExtensions` fix is written per role and one is enough to launch.
		if (!missing.has(name)) missing.set(name, entry.role);
	}
	if (missing.size === 0) {
		return {
			id: "inherited-extensions",
			status: "pass",
			line: `${checked} inherited extension(s) resolve on ${target.host}`,
		};
	}
	const entries = [...missing.entries()];
	const shown = entries.slice(0, MAX_MISSING_PACKAGES);
	const more = entries.length - shown.length;
	const fixes: string[] = [];
	for (const [name, role] of entries.slice(0, MAX_PACKAGE_FIXES)) {
		// D4's two ways out, with the concrete values: install it there, or keep it
		// on this machine only for ONE role — as pasteable settings JSON, which is
		// the key the reader would otherwise have to look up in the source.
		fixes.push(`hc exec --on ${target.host} -- pi install npm:${name}`);
		fixes.push(JSON.stringify({ subagents: { agentOverrides: { [role]: { excludeExtensions: [name] } } } }));
	}
	return {
		id: "inherited-extensions",
		status: "fail",
		line: `${entries.length} package(s) missing on ${target.host}: ${shown
			.map(([name, role]) => `${name}(role '${role}')`)
			.join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
		fixes,
	};
}

/** e. does that machine's `pi` see the model a launch would use? */
async function probeTargetModels(input: {
	client: HcClient;
	target: HostTarget;
	model: string | undefined;
}): Promise<CrossMachineCheckupItem> {
	const { client, target, model } = input;
	if (model === undefined) {
		// Nothing to compare: the checkup does not invent a model, and a PASS on a
		// model nobody would launch is a false green.
		return { id: "target-models", status: "skip", line: "no model to check (no role carries one and this run named none)" };
	}
	const argv = [
		target.node,
		target.piCli,
		"--no-extensions",
		...target.piExtensions.flatMap((extension) => ["--extension", extension]),
		"--list-models",
	];
	const result = await remoteExec(
		client,
		target,
		{ argv, cwd: target.cwd, timeout: REMOTE_PREFLIGHT_TIMEOUT_S },
		`${target.piCli} --list-models`,
	);
	if (result.code !== 0) {
		return {
			id: "target-models",
			status: "fail",
			line: `${target.piCli} --list-models exited ${codeOf(result)} on ${target.host} (${detailOf(result)})`,
			fixes: [`hc exec --on ${target.host} -- ${target.node} ${target.piCli} --list-models`],
		};
	}
	const models = parseListModels(execResultText({ stdout: result.stdout }));
	if (modelMatches(model, models)) {
		return { id: "target-models", status: "pass", line: `${model} is in ${target.host}'s listing (${models.length} model(s))` };
	}
	const shown = models.slice(0, MAX_MODELS_LISTED);
	const more = models.length - shown.length;
	const listing = shown.length > 0 ? `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : "no models at all";
	return {
		id: "target-models",
		status: "fail",
		line: `${model} is not in ${target.host}'s listing: ${listing}`,
		fixes: [
			shown.length > 0
				? `use a model that machine serves, e.g. model: "${shown[0]}" on the role card`
				: `that machine's pi serves no models: hc exec --on ${target.host} -- ${target.node} ${target.piCli} auth check, then re-run: /legion doctor crossmachine`,
			`# aside: the child runs with --no-extensions, so a provider extension installed there must be named in subagents.crossMachine.hosts.${target.host}.piExtensions (list them: hc exec --on ${target.host} -- ${target.node} ${target.piCli} list)`,
		],
	};
}

/**
 * D8: the one line a reader can paste, from REAL values.
 *
 * `worktree: true` because the delivery channel is a git worktree (and this
 * checkup has just proved both sides share an origin), and the phase list is the
 * minimal legal machine — a terminal phase carries no `next`.
 */
function launchLine(host: string, cwd: string): string {
	return "subagent({ agent: \"centurion\", "
		+ `host: "${host}", `
		+ `cwd: "${cwd}", `
		+ "worktree: true, "
		+ "task: \"demo: report pwd and stop\", "
		+ "phases: [{ id: \"planning\", next: [{ to: \"implementing\" }] }, "
		+ "{ id: \"implementing\", next: [{ to: \"done\" }] }, "
		+ "{ id: \"done\", terminal: true }] })";
}

/**
 * Role cards for the inheritance probe, loaded the way a launch loads them.
 *
 * Only paid for when the caller did not hand them over (the `/legion doctor`
 * caller does not hold a catalog; `diagnose` in `index.ts` does).
 */
function loadAgents(cwd: string, env: NodeJS.ProcessEnv): AgentConfig[] {
	try {
		const settings = loadSubagentSettings({
			userSettingsPath: path.join(getAgentDir(), "settings.json"),
			projectSettingsPath: path.join(cwd, ".pi", "settings.json"),
		});
		const discovery = discoverAgents(cwd, "both");
		return applyAgentOverrides(discovery.agents, settings.agentOverrides);
	} catch {
		// A checkup must not die because a card is unreadable: the other items are
		// still worth reporting.
		return [];
	}
}

// ── small helpers (one line per item, D7) ─────────────────────────────────

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** The first sentence of an already-one-lined message, for `… not checked: <reason>`. */
function firstSentence(text: string): string {
	const end = text.search(/\.\s/);
	return end < 0 ? text : text.slice(0, end + 1);
}

function firstNonEmpty(value: string | undefined): string | undefined {
	const trimmed = typeof value === "string" ? value.trim() : "";
	return trimmed.length > 0 ? trimmed : undefined;
}

function codeOf(result: HcExecResult): string {
	return typeof result.code === "number" ? String(result.code) : "no exit code";
}

function detailOf(result: HcExecResult): string {
	const text = oneLine(execResultText(result));
	return text.length > 0 ? text.slice(0, DETAIL_CLIP) : "no output";
}

/** stdout only, decoded, trimmed to its first line — for `--version` answers. */
function stdoutFirstLine(result: HcExecResult): string {
	const text = execResultText({ stdout: result.stdout });
	return oneLine(text.split(/\r?\n/)[0] ?? "");
}
