#!/usr/bin/env node
// The xm-harness assertions (contract `docs/contracts/xm-harness-v1.md` §4, revision
// v1.1 — the deterministic driver — plus the zero-config / product-gap ruling).
//
//   cd test/docker && make xm            # Run A (zero-config) + Run B (hosts entry)
//   cd test/docker && make xm-model      # XM_SCENARIO=model-missing (§5.4)
//   cd test/docker && make xm-real       # optional real-model pass (never a gate)
//
// TWO passes, one command:
//
//   Run A — settings carry `subagents.crossMachine.enabled: true` and NOTHING else:
//           a1 role policy, a2 machine list, b zero-config launch, c remote artefact,
//           d0 the CURRENT zero-config behaviour (collect cannot read the transcript
//           back: `host 'remote' has no entry in subagents.crossMachine.hosts` family)
//           plus "no non-empty mirror was produced". d0 asserts the GAP, so it turns
//           red the day the product is fixed — that is the intended signal.
//
//   Run B — the same topology with `hosts.remote = { cwd: "/root/work" }`:
//           c2 the worktree is really on the remote machine and d the transcript is
//           really read back (mirror line count > 0, contains the remote's LAST
//           assistant text, mtime after the launch; the parent's 0-byte placeholder
//           is printed as the contrast that must NOT be used as evidence).
//
// Every fact comes from `docker exec` on the two containers. Nothing is loosened: a
// missing piece of evidence is a FAIL; an environment that cannot host the run is a
// `SKIPPED:` line — and a skip exits 1, never 0.
//
// Output contract:
//   XM_ASSERT <id> PASS|FAIL <name>
//   evidence: <one-line JSON>                  (immediately after every FAIL)
//   XM_CONTRAST {…}                            (placeholder-vs-mirror, Run B)
//   XM_ALL_PASS run=<A>,<B> child=<childA>,<childB>   (only when everything passed)

import {
	MOCK_PORTS,
	XM_ENV,
	applySettingsMode,
	containerFileStat,
	containerRunning,
	dockerAvailable,
	ensureMocks,
	inContainer,
	installScenarios,
	nonce,
	parentSessionSince,
	readContainerFile,
	readRemoteFile,
	readRunJson,
	remoteLastAssistantText,
	remoteWorktreeList,
	runIds,
	runParentStep,
	scenarioDir,
	shellQuote,
	toolResultsFromSession,
} from "./drive.mjs";

const SCENARIO = process.env.XM_SCENARIO || "launch";
const isRealDriver = process.env.XM_DRIVER === "real" || process.env.XM_REAL === "1";
const MODEL = isRealDriver ? XM_ENV.realModel : XM_ENV.mockModel;

/**
 * Prompts handed to the parent pi. The mock driver ignores them completely (the
 * scripts decide the tool calls); a REAL model reads them in `make xm-real`, where
 * the same assertions run against a model that is free to ignore every word.
 */
const PROMPT = {
	launch: [
		"Use the subagent tool exactly twice, in order, and nothing else.",
		`1) subagent({ agent: "centurion", host: ${JSON.stringify(XM_ENV.host)}, hostCwd: ${JSON.stringify(XM_ENV.hostCwd)}, task: "Write XM_READY.txt containing the token from the task text in your current directory, then reply with the single word READY. Do not spawn children." })`,
		"2) once the child has a name, call subagent({ action: \"collect\", name: \"<that child name>\" }).",
		'Then reply "RESULT: done" and stop.',
	].join("\n"),
	scout: [
		`Use the subagent tool exactly once: subagent({ agent: "scout", host: ${JSON.stringify(XM_ENV.host)}, hostCwd: ${JSON.stringify(XM_ENV.hostCwd)}, task: "probe" }).`,
		"Then reply with the tool result text verbatim and stop. Do not retry and do not fall back to a local run.",
	].join("\n"),
	unknownHost: [
		`Use the subagent tool exactly once: subagent({ agent: "centurion", host: "no-such-machine", hostCwd: ${JSON.stringify(XM_ENV.hostCwd)}, task: "probe" }).`,
		"Then reply with the tool result text verbatim and stop. Do not retry and do not fall back to a local run.",
	].join("\n"),
	modelMissing: [
		`Use the subagent tool exactly once: subagent({ agent: "centurion", host: ${JSON.stringify(XM_ENV.host)}, hostCwd: ${JSON.stringify(XM_ENV.hostCwd)}, model: ${JSON.stringify(XM_ENV.mockModel)}, task: "probe" }).`,
		"Then reply with the tool result text verbatim and stop. Do not retry and do not fall back to a local run.",
	].join("\n"),
};

const results = [];
const print = (line) => process.stdout.write(`${line}\n`);

function recordPass(id, name) {
	print(`XM_ASSERT ${id} PASS ${name}`);
	results.push({ id, ok: true });
}

function recordFail(id, name, evidence) {
	print(`XM_ASSERT ${id} FAIL ${name}`);
	print(`evidence: ${JSON.stringify(evidence)}`);
	results.push({ id, ok: false, evidence });
}

/** One assertion; an unexpected throw is a FAIL, never a crash. */
function assertThat(id, name, body) {
	try {
		const verdict = body();
		if (verdict?.ok) {
			recordPass(id, name);
			return true;
		}
		recordFail(id, name, verdict?.evidence ?? { reason: "no evidence produced" });
		return false;
	} catch (error) {
		recordFail(id, name, { error: error instanceof Error ? error.message : String(error) });
		return false;
	}
}

function skip(reason) {
	print(`SKIPPED: ${reason}`);
	process.exit(1);
}

function failHard(reason, evidence) {
	print(`XM_FAIL ${reason}`);
	print(`evidence: ${JSON.stringify(evidence)}`);
	process.exit(1);
}

// ─────────────────────────────────────────────────────────────── small helpers

function parentModels() {
	const result = inContainer(XM_ENV.parent, `cd ${shellQuote(XM_ENV.hostCwd)} && pi --list-models 2>&1`, {
		timeoutMs: 120_000,
	});
	return result.stdout + result.stderr;
}

function remoteModels() {
	const result = inContainer(XM_ENV.remote, `cd ${shellQuote(XM_ENV.hostCwd)} && pi --list-models 2>&1`, {
		timeoutMs: 120_000,
	});
	return result.stdout + result.stderr;
}

function parentSettings() {
	const raw = readContainerFile(XM_ENV.parent, "/root/.pi/agent/settings.json");
	if (raw === null) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function newRunIdsSince(before) {
	return runIds().filter((id) => !before.has(id));
}

/** The run this step created: prefer the one that recorded a child on the host. */
function findStepRun(before) {
	const candidates = [];
	for (const runId of newRunIdsSince(before)) {
		const run = readRunJson(runId);
		if (run === undefined) continue;
		candidates.push({ runId, run, children: Array.isArray(run.children) ? run.children : [] });
	}
	return candidates.find((candidate) => candidate.children.some((child) => child?.host)) ?? candidates.at(-1);
}

/** Tool results of the parent pi process this step started. */
function stepToolResults(step) {
	const session = parentSessionSince(step.startedAt);
	if (session === undefined) return { sessionPath: undefined, results: [] };
	return { sessionPath: session.path, results: toolResultsFromSession(session.text) };
}

function lastSubagentResult(toolResults) {
	return [...toolResults].reverse().find((entry) => entry.toolName === "subagent");
}

/** Where a remote worktree for `child` must live, per `remote-worktree.ts`. */
function expectedWorktreePath(child) {
	const base = XM_ENV.hostCwd.replace(/\/+$/, "");
	const parentDir = base.slice(0, base.lastIndexOf("/")) || "/";
	return `${parentDir}/.pi-worktrees/${child}`;
}

/** `pi-subagent/<host>/<child>-<hex8>` (remote-worktree.ts:76-78). */
function expectedBranch(child) {
	return new RegExp(`^pi-subagent/${XM_ENV.host}/${child}-[0-9a-f]{8}$`);
}

function worktreeFacts(child) {
	const worktreePath = expectedWorktreePath(child);
	const list = remoteWorktreeList();
	const line = list.text.split("\n").find((entry) => entry.includes(worktreePath));
	const branch = line?.match(/\[(pi-subagent\/[^\]]+)\]/)?.[1];
	return {
		list,
		worktreePath,
		line,
		branch,
		branchOk: typeof branch === "string" && expectedBranch(child).test(branch),
	};
}

// ─────────────────────────────────────────────────────────── the two passes

/** a1: scout + host=remote is refused by the role policy. */
async function assertRolePolicy() {
	await ensureMocks([{ port: MOCK_PORTS.parent, scriptName: "scout.json" }]);
	const before = new Set(runIds());
	const worktreesBefore = remoteWorktreeList();
	const step = await runParentStep("a1", {
		model: MODEL,
		prompt: PROMPT.scout,
		budgetMs: 240_000,
		sentinel: "A1_TOOL_RESULT",
	});
	const tool = stepToolResults(step);
	const toolResult = lastSubagentResult(tool.results);
	const text = toolResult?.text ?? `${step.output}\n${step.raw}`;
	const run = findStepRun(before);
	return assertThat("a1", "role-policy", () => {
		const missing = ["allowRoles", "'centurion'", "'scout'"].filter((needle) => !text.includes(needle));
		const worktreesAfter = remoteWorktreeList();
		const newWorktrees = worktreesAfter.text
			.split("\n")
			.filter((line) => line.trim().length > 0 && !worktreesBefore.text.includes(line.trim()));
		return {
			ok: missing.length === 0 && (run?.children.length ?? 0) === 0 && newWorktrees.length === 0,
			evidence: {
				missing_substrings: missing,
				local_children_created: run?.children.length ?? 0,
				new_remote_worktrees: newWorktrees,
				tool_result: text.slice(0, 1500),
				session: tool.sessionPath,
			},
		};
	});
}

/** a2: an unknown machine is refused and the real machine list is quoted. */
async function assertMachineList() {
	await ensureMocks([{ port: MOCK_PORTS.parent, scriptName: "unknown-host.json" }]);
	const before = new Set(runIds());
	const worktreesBefore = remoteWorktreeList();
	const step = await runParentStep("a2", {
		model: MODEL,
		prompt: PROMPT.unknownHost,
		budgetMs: 240_000,
		sentinel: "A2_TOOL_RESULT",
	});
	const tool = stepToolResults(step);
	const toolResult = lastSubagentResult(tool.results);
	const text = toolResult?.text ?? `${step.output}\n${step.raw}`;
	const run = findStepRun(before);
	return assertThat("a2", "machine-list", () => {
		const missing = ["hc machine ls", XM_ENV.host].filter((needle) => !text.includes(needle));
		const worktreesAfter = remoteWorktreeList();
		const newWorktrees = worktreesAfter.text
			.split("\n")
			.filter((line) => line.trim().length > 0 && !worktreesBefore.text.includes(line.trim()));
		return {
			ok: missing.length === 0 && (run?.children.length ?? 0) === 0 && newWorktrees.length === 0,
			evidence: {
				missing_substrings: missing,
				local_children_created: run?.children.length ?? 0,
				new_remote_worktrees: newWorktrees,
				tool_result: text.slice(0, 1500),
				session: tool.sessionPath,
			},
		};
	});
}

/**
 * One launch pass: mock scenario `launch.json` + `child.json`, one parent pi run,
 * one remote child on `childName`. Returns the raw facts the assertions need.
 */
async function launchPass({ label, childName, nonceValue }) {
	installScenarios(scenarioDir(), nonceValue, { childName });
	await ensureMocks([
		{ port: MOCK_PORTS.parent, scriptName: "launch.json" },
		{ port: MOCK_PORTS.child, scriptName: "child.json" },
	]);
	const before = new Set(runIds());
	const start = Math.floor(Date.now() / 1000);
	const step = await runParentStep(label, {
		model: MODEL,
		prompt: PROMPT.launch,
		budgetMs: 600_000,
		watchMirror: true,
		sentinel: "RESULT: done",
	});
	const tool = stepToolResults(step);
	const run = findStepRun(before);
	if (run === undefined) {
		failHard(`${label}: no run directory was created by the parent pi`, {
			pi_output: `${step.output}\n${step.raw}`.slice(-4000),
			session: tool.sessionPath,
		});
	}
	const childRecord = run.children.find((entry) => entry?.host === XM_ENV.host) ?? run.children[0];
	return { step, tool, run, childRecord, start, nonceValue, label };
}

function assertLaunchSucceeded(pass) {
	return assertThat("b", "launch", () => {
		const child = pass.childRecord?.name;
		const settings = parentSettings();
		const hostsEntry = settings?.subagents?.crossMachine?.hosts;
		const crossMachineEnabled = settings?.subagents?.crossMachine?.enabled === true;
		const nameOk = typeof child === "string" && /^centurion-[a-z0-9]+$/.test(child);
		const hostOk = pass.childRecord?.host === XM_ENV.host;
		const errorMarkers = ["INVALID_PARAMS", "machine_unknown"].filter((marker) =>
			`${pass.step.output}`.includes(marker),
		);
		return {
			ok: nameOk && hostOk && hostsEntry === undefined && crossMachineEnabled && errorMarkers.length === 0,
			evidence: {
				child,
				host: pass.childRecord?.host,
				crossMachineEnabled,
				settings_has_hosts: hostsEntry !== undefined,
				error_markers: errorMarkers,
				parent_output: `${pass.step.output}`.slice(-2000),
				run: pass.run.runId,
			},
		};
	});
}

function assertRemoteArtifact(id, pass) {
	return assertThat(id, "remote-artifact", () => {
		const child = pass.childRecord?.name;
		const facts = worktreeFacts(child);
		// NOTE: a linked `git worktree` has `.git` as a FILE holding `gitdir: …`, so
		// the contract's `test -d <worktree>/.git` is not how git spells it. The
		// truthful "this is a real checkout" evidence is stronger: `.git` exists AND
		// git itself agrees about the toplevel and the branch.
		const gitPath = `${facts.worktreePath}/.git`;
		const gitLink = inContainer(
			XM_ENV.remote,
			`test -e ${shellQuote(gitPath)} && { [ -d ${shellQuote(gitPath)} ] && echo DIR || { echo FILE; head -c 200 ${shellQuote(gitPath)}; }; }`,
			{ timeoutMs: 30_000 },
		);
		const topLevel = inContainer(
			XM_ENV.remote,
			`git -C ${shellQuote(facts.worktreePath)} rev-parse --show-toplevel 2>&1`,
			{ timeoutMs: 30_000 },
		);
		const headBranch = inContainer(
			XM_ENV.remote,
			`git -C ${shellQuote(facts.worktreePath)} rev-parse --abbrev-ref HEAD 2>&1`,
			{ timeoutMs: 30_000 },
		);
		const markerPath = `${facts.worktreePath}/XM_READY.txt`;
		const markerStat = containerFileStat(XM_ENV.remote, markerPath);
		const markerText = markerStat === undefined ? "" : (readRemoteFile(markerPath) ?? "");
		const checkoutOk =
			gitLink.ok &&
			topLevel.stdout.trim() === facts.worktreePath &&
			typeof facts.branch === "string" &&
			headBranch.stdout.trim() === facts.branch;
		return {
			ok:
				facts.line !== undefined &&
				facts.branchOk &&
				checkoutOk &&
				markerStat !== undefined &&
				markerStat.size > 0 &&
				markerText.includes(pass.nonceValue),
			evidence: {
				child,
				worktree_list: facts.list.text,
				worktree_path: facts.worktreePath,
				branch: facts.branch,
				branch_ok: facts.branchOk,
				checkout_ok: checkoutOk,
				git_entry: gitLink.stdout.trim(),
				git_toplevel: topLevel.stdout.trim(),
				git_head_branch: headBranch.stdout.trim(),
				marker_path: markerPath,
				marker_bytes: markerStat?.size ?? 0,
				marker_has_this_run_nonce: markerText.includes(pass.nonceValue),
				nonce: pass.nonceValue,
			},
		};
	});
}

/**
 * d0 — the CURRENT zero-config behaviour, asserted instead of skipped.
 *
 * Zero-config launches fine, but `collect` cannot read the transcript back: the
 * read-back resolves the host through the settings-only resolver, and a host with no
 * `subagents.crossMachine.hosts.<name>` entry is refused there (src/runs/remote.ts:
 * 976-982). What the caller sees is a `collect failed: …` tool result — today the
 * worktree-ownership guard is the error that surfaces (the read-back failure is
 * swallowed first), which is the same "this machine cannot read that transcript"
 * family. The parent's mirror must NOT be written.
 *
 * This is an assertion of a GAP, not a waiver: the day the product gains a
 * zero-config read-back, this assertion must go RED so the harness gets updated.
 */
function assertZeroConfigGap(pass) {
	return assertThat(
		"d0",
		"known-gap: zero-config read-back needs hosts.<name> (src/runs/remote.ts:976-982)",
		() => {
			const child = pass.childRecord?.name;
			const collect = lastSubagentResult(pass.tool.results);
			const text = collect?.text ?? "";
			const mirrorPath = `${XM_ENV.runStore}/${pass.run.runId}/remote/${child}.jsonl`;
			const mirrorStat = containerFileStat(XM_ENV.parent, mirrorPath);
			const gapSignatures = [
				/has no entry in subagents\.crossMachine\.hosts/,
				/local filesystem and git operations on it are refused/,
			];
			const signature = gapSignatures.find((re) => re.test(text));
			const failed = /collect failed|INVALID_PARAMS|transcript/i.test(text);
			const noMirror = mirrorStat === undefined || mirrorStat.size === 0;
			// Always printed: the current gap's EXACT shape, so the report can quote it
			// and a future product fix shows up as this line disappearing (and d0 going red).
			print(
				`XM_GAP ${JSON.stringify({
					child,
					mirror_path: mirrorPath,
					mirror_bytes: mirrorStat?.size ?? 0,
					gap_signature: signature?.source ?? null,
					collect_result: text.slice(0, 600),
				})}`,
			);
			// The zero-config probe must not silently look like a read-back success.
			return {
				ok: failed && signature !== undefined && noMirror,
				evidence: {
					child,
					collect_failed: failed,
					gap_signature: signature?.source,
					mirror_path: mirrorPath,
					mirror_bytes: mirrorStat?.size ?? 0,
					collect_result: text.slice(0, 2000),
					session: pass.tool.sessionPath,
				},
			};
		},
	);
}

/**
 * d — the transcript really came BACK, after the fact (§4d).
 *
 * The mirror must have lines, contain the remote session's LAST assistant text and
 * be newer than the launch. The parent's pre-created placeholder is printed as the
 * contrast and can never be the evidence.
 */
function assertTranscriptReadback(pass) {
	return assertThat("d", "transcript-readback", () => {
		const child = pass.childRecord?.name;
		const mirrorPath = `${XM_ENV.runStore}/${pass.run.runId}/remote/${child}.jsonl`;
		const mirrorStat = containerFileStat(XM_ENV.parent, mirrorPath);
		const mirrorText = mirrorStat === undefined ? "" : (readContainerFile(XM_ENV.parent, mirrorPath) ?? "");
		const mirrorLines = mirrorText
			.split("\n")
			.filter((line) => line.trim().length > 0 && line.trimStart().startsWith("{")).length;
		const remote = remoteLastAssistantText(child);
		const contains = remote.text.length > 0 && mirrorText.includes(remote.text);
		const mtimeAfterLaunch = mirrorStat !== undefined && mirrorStat.mtime >= pass.start;
		const placeholderPath = pass.childRecord?.sessionFile ?? `${XM_ENV.runStore}/${pass.run.runId}/${child}.jsonl`;
		const placeholderStat = containerFileStat(XM_ENV.parent, placeholderPath);

		print(
			`XM_CONTRAST ${JSON.stringify({
				child,
				mirror_path: mirrorPath,
				mirror_bytes: mirrorStat?.size ?? 0,
				mirror_lines: mirrorLines,
				mirror_mtime: mirrorStat?.mtime,
				launch_start: pass.start,
				placeholder_path: placeholderPath,
				placeholder_bytes: placeholderStat?.size ?? 0,
				placeholder_used: false,
			})}`,
		);

		return {
			ok:
				mirrorStat !== undefined &&
				mirrorStat.size > 0 &&
				mirrorLines > 0 &&
				contains &&
				mtimeAfterLaunch &&
				placeholderPath !== mirrorPath &&
				placeholderStat?.size === 0,
			evidence: {
				mirror_path: mirrorPath,
				mirror_bytes: mirrorStat?.size ?? 0,
				mirror_lines: mirrorLines,
				mirror_mtime: mirrorStat?.mtime,
				launch_start: pass.start,
				mtime_after_launch: mtimeAfterLaunch,
				remote_jsonl: remote.paths,
				remote_last_assistant: remote.text.slice(0, 500),
				mirror_contains_last_assistant: contains,
				placeholder_path: placeholderPath,
				placeholder_bytes: placeholderStat?.size ?? 0,
				placeholder_used_for_verdict: false,
				collect_result: (lastSubagentResult(pass.tool.results)?.text ?? "").slice(0, 1500),
			},
		};
	});
}

// ──────────────────────────────────────────────────────── Run A / Run B flow

async function runLaunchScenario() {
	// ── Run A: zero-config ───────────────────────────────────────────────
	print(`XM_SETTINGS ${applySettingsMode("zero-config")}`);
	const nonceA = nonce();
	// The mocks read these files, so they must exist before the first one starts.
	installScenarios(scenarioDir(), nonceA, { childName: "centurion-0" });
	await assertRolePolicy();
	await assertMachineList();
	const passA = await launchPass({ label: "launch-a", childName: "centurion-0", nonceValue: nonceA });
	assertLaunchSucceeded(passA);
	assertRemoteArtifact("c", passA);
	assertZeroConfigGap(passA);

	// ── Run B: the supported shape (`hosts.remote` present) ─────────────
	print(`XM_SETTINGS ${applySettingsMode("host-entry")}`);
	const nonceB = nonce();
	const passB = await launchPass({ label: "launch-b", childName: "centurion-b", nonceValue: nonceB });
	assertRemoteArtifact("c2", passB);
	assertTranscriptReadback(passB);

	return {
		runId: `${passA.run.runId},${passB.run.runId}`,
		child: `${passA.childRecord?.name ?? "?"},${passB.childRecord?.name ?? "?"}`,
	};
}

// ──────────────────────────────────────────────── model-missing scenario (§5.4)

async function runModelMissingScenario() {
	print(`XM_SETTINGS ${applySettingsMode("zero-config")}`);
	const worktreesBefore = remoteWorktreeList();
	const nonceValue = nonce();
	installScenarios(scenarioDir(), nonceValue, { childName: "centurion-0" });
	await ensureMocks([{ port: MOCK_PORTS.parent, scriptName: "model-missing.json" }]);

	// What the remote machine really serves — the listing the refusal must quote.
	const remoteList = remoteModels();
	// `pi --list-models` prints `provider  model  …`, and the refusal quotes the same
	// rows as `provider/model` (src/shared/list-models.ts). Both spellings are handled.
	const remoteModelIds = remoteList
		.split("\n")
		.slice(1)
		.map((line) => line.trim().split(/\s+/).slice(0, 2).join("/"))
		.filter((id) => id.includes("/"));
	const [mockProvider, ...mockRest] = XM_ENV.mockModel.split("/");
	const mockModelId = mockRest.join("/");

	assertThat("m1", "remote-model-absent", () => {
		const listed = remoteList
			.split("\n")
			.some((line) => {
				const columns = line.trim().split(/\s+/);
				return columns[0] === mockProvider && columns[1] === mockModelId;
			});
		return {
			ok: !listed,
			evidence: { mock_model: XM_ENV.mockModel, remote_models: remoteList, remote_model_ids: remoteModelIds },
		};
	});

	const before = new Set(runIds());
	const step = await runParentStep("model", {
		model: MODEL,
		prompt: PROMPT.modelMissing,
		budgetMs: 240_000,
		sentinel: "MODEL_TOOL_RESULT",
	});
	const tool = stepToolResults(step);
	const toolResult = lastSubagentResult(tool.results);
	const text = toolResult?.text ?? `${step.output}\n${step.raw}`;
	const run = findStepRun(before);

	assertThat("m2", "model-missing-refusal", () => {
		const classOk = /is not visible there|model-missing/i.test(text);
		const listedSomeRemoteModel = remoteModelIds.some((id) => text.includes(id));
		const notCreated = (run?.children.length ?? 0) === 0;
		return {
			ok: classOk && listedSomeRemoteModel && notCreated,
			evidence: {
				class_marker: classOk,
				remote_models_quoted: listedSomeRemoteModel,
				local_children_created: run?.children.length ?? 0,
				remote_model_ids: remoteModelIds,
				tool_result: text.slice(0, 2500),
				session: tool.sessionPath,
			},
		};
	});

	assertThat("m3", "no-remote-worktree", () => {
		const worktreesAfter = remoteWorktreeList();
		const added = worktreesAfter.text
			.split("\n")
			.filter((line) => line.trim().length > 0 && !worktreesBefore.text.includes(line.trim()));
		return { ok: added.length === 0, evidence: { added, worktrees_after: worktreesAfter.text } };
	});

	return { runId: run?.runId ?? "none", child: "none" };
}

// ─────────────────────────────────────────────────────────────────────── main

async function main() {
	if (!dockerAvailable()) skip("docker not available");
	if (!containerRunning(XM_ENV.parent) || !containerRunning(XM_ENV.remote)) {
		skip(`xm containers not running (${XM_ENV.parent} / ${XM_ENV.remote}); run: make xm-up`);
	}

	// Environment broken is a FAIL, not a skip (§5.1): an empty model list means the
	// provider never registered (a settings overwrite is the usual cause).
	const parentList = parentModels();
	if (/No models available/i.test(parentList) || parentList.trim().split("\n").length < 2) {
		failHard("parent sees no models at all — the container environment is broken (contract §5.1)", {
			parent_models: parentList,
		});
	}
	if (!isRealDriver) {
		const [provider, ...rest] = XM_ENV.mockModel.split("/");
		const modelId = rest.join("/");
		const pattern = new RegExp(`${provider}\\s+${modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
		if (!pattern.test(parentList)) {
			failHard(`parent cannot see the mock model ${XM_ENV.mockModel} — models.json mount/merge is broken`, {
				parent_models: parentList,
			});
		}
	}

	print(`XM_DRIVER ${isRealDriver ? `real model=${MODEL}` : `mock model=${MODEL}`} scenario=${SCENARIO}`);
	const scenarioResult =
		SCENARIO === "model-missing" ? await runModelMissingScenario() : await runLaunchScenario();

	const failed = results.filter((entry) => !entry.ok);
	if (failed.length > 0) {
		print(
			`XM_ALL_FAIL failed=${failed.map((entry) => entry.id).join(",")} run=${scenarioResult.runId} child=${scenarioResult.child}`,
		);
		process.exit(1);
	}
	print(`XM_ALL_PASS run=${scenarioResult.runId} child=${scenarioResult.child}`);
	process.exit(0);
}

main().catch((error) => {
	print(`XM_FAIL unexpected :: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exit(1);
});
