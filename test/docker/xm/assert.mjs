#!/usr/bin/env node
// The xm-harness assertions (contract `docs/contracts/xm-harness-v1.md` §4, revision
// v1.1 — the deterministic driver — plus the zero-config / product-gap ruling).
//
//   cd test/docker && make xm            # Run A (zero-config) + Run B (hosts entry)
//   cd test/docker && make xm-model      # §5.4 target-model fallback (6.2.2): m1..m4
//   cd test/docker && make xm-real       # optional real-model pass (never a gate)
//
// TWO passes, one command:
//
//   Run A — settings carry `subagents.crossMachine.enabled: true` and NOTHING else:
//           a1 recon-never-crosses (vexillatio vs host), a2 machine list, b zero-config
//           launch, c remote artefact,
//           d0 the CURRENT zero-config behaviour: the collect is refused by the
//           worktree-ownership guard, which MASKS the missing read-back host entry
//           (root cause is swallowed first: src/runs/remote.ts:976-982), and no
//           non-empty mirror exists. d0 asserts the GAP, so it turns red the day the
//           product is fixed — that is the intended signal.
//
//   Run B — the same topology with `hosts.remote = { cwd: "/root/work" }`:
//           c2 the worktree is really on the remote machine, d the transcript is
//           really read back (mirror line count > 0, contains the remote's LAST
//           assistant text, mtime after the launch; the parent's placeholders are
//           printed as the contrast that must NOT be used as evidence), and d1 the
//           SECOND product gap asserted: the fetch did happen (mirror non-empty) but
//           `collect` itself is still refused by assertLocalWorktree
//           (src/runs/orchestrator.ts:3515). d1 also turns red when that is fixed.
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
	remoteLastAssistantModel,
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
		// Deliberately NOT the sentinel: the sentinel carries this run's nonce (F9), so
		// a prompt echo can never satisfy it at t≈0. The token is only DESCRIBED here;
		// the mock script decides the actual text.
		'Then reply with the words "RESULT: done" followed by this run\'s token, and stop.',
	].join("\n"),
	scout: [
		`Use the vexillatio tool exactly once: vexillatio({ agent: "scout", host: ${JSON.stringify(XM_ENV.host)}, hostCwd: ${JSON.stringify(XM_ENV.hostCwd)}, task: "probe" }).`,
		"Then reply with the tool result text verbatim and stop. Do not retry and do not fall back to a local run.",
	].join("\n"),
	unknownHost: [
		`Use the subagent tool exactly once: subagent({ agent: "centurion", host: "no-such-machine", hostCwd: ${JSON.stringify(XM_ENV.hostCwd)}, task: "probe" }).`,
		"Then reply with the tool result text verbatim and stop. Do not retry and do not fall back to a local run.",
	].join("\n"),
	// A real model: dispatch the model this machine serves, then report what the launch
	// did. 6.2.2 answers with a fallback + warning instead of a refusal, so the prompt
	// must not demand a refusal any more.
	modelMissing: [
		`Use the subagent tool exactly once: subagent({ agent: "centurion", host: ${JSON.stringify(XM_ENV.host)}, hostCwd: ${JSON.stringify(XM_ENV.hostCwd)}, model: ${JSON.stringify(XM_ENV.mockModel)}, task: "probe" }).`,
		"Then reply with the tool result text verbatim and stop. Do not retry, and do not fall back to a local run.",
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

/**
 * The run THIS step created, identified by its own session credential (F11).
 *
 * `run.json.sessionFile` is the parent pi's session transcript path (`src/runs/
 * store.ts:334`), so it aligns 1:1 with the session file the step's pi wrote — the
 * only unambiguous identity available here. There is deliberately NO
 * "newest/with-a-child" fallback: zero or several matches is ambiguity, the caller
 * must FAIL on it, and a wrong run would silently turn b/c/d into asserts about a
 * different process.
 */
function findStepRun(before, sessionPath) {
	if (sessionPath === undefined) return undefined;
	const matches = [];
	for (const runId of newRunIdsSince(before)) {
		const run = readRunJson(runId);
		if (run === undefined) continue;
		if (run.sessionFile !== sessionPath) continue;
		matches.push({ runId, run, children: Array.isArray(run.children) ? run.children : [] });
	}
	return matches.length === 1 ? matches[0] : undefined;
}

/** Diagnostic for the ambiguity branch: what the run store said about this step. */
function runCandidates(before) {
	return newRunIdsSince(before).map((runId) => {
		const run = readRunJson(runId);
		return { runId, sessionFile: run?.sessionFile, children: run?.children?.length ?? 0 };
	});
}

/** Run b's evidence wants the completion time of the mirror, when it was seen. */
function mirrorSeenMsAfterStart(step) {
	if (step.mirrorSeenAt === undefined || step.startedAt === undefined) return null;
	return (step.mirrorSeenAt - step.startedAt) * 1000;
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

/**
 * The LAST tool result of `toolName` in this step.
 *
 * a1 collects `vexillatio` (recon), everything else `subagent`. Parameterized on
 * purpose: hard-coding one name would make the a1 migration a silent no-op — the
 * lookup would find nothing and the assertion would grade the pi stdout instead.
 */
function lastToolResultOf(toolResults, toolName) {
	return [...toolResults].reverse().find((entry) => entry.toolName === toolName);
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

/** a1: recon is `vexillatio`'s, and a utility child cannot cross machines. */
async function assertUtilityCannotCross() {
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
	const toolResult = lastToolResultOf(tool.results, "vexillatio");
	const text = toolResult?.text ?? `${step.output}\n${step.raw}`;
	const run = findStepRun(before, tool.sessionPath);
	return assertThat("a1", "utility-cannot-cross", () => {
		// `dispatch-boundary-v1`: D1 sends recon through `vexillatio` (subagent refuses a
		// utility target), and a utility dispatch carrying a host is then refused by the
		// orchestrator (utility = in-process hard leaf). Both halves are product facts.
		const missing = ["cannot carry a utility dispatch", "read-only helpers run in-process"].filter(
			(needle) => !text.includes(needle),
		);
		const worktreesAfter = remoteWorktreeList();
		const newWorktrees = worktreesAfter.text
			.split("\n")
			.filter((line) => line.trim().length > 0 && !worktreesBefore.text.includes(line.trim()));
		return {
			ok:
				run !== undefined &&
				missing.length === 0 &&
				run.children.length === 0 &&
				newWorktrees.length === 0,
			evidence: {
				run_found: run !== undefined,
				candidates: run === undefined ? runCandidates(before) : undefined,
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
	const run = findStepRun(before, tool.sessionPath);
	return assertThat("a2", "machine-list", () => {
		// F10: the bare machine name is too weak (the error quotes it several times).
		// Require the LISTING fragment the refusal actually prints, e.g. "lists: remote".
		const missing = ["hc machine ls", `lists: ${XM_ENV.host}`].filter((needle) => !text.includes(needle));
		const worktreesAfter = remoteWorktreeList();
		const newWorktrees = worktreesAfter.text
			.split("\n")
			.filter((line) => line.trim().length > 0 && !worktreesBefore.text.includes(line.trim()));
		return {
			ok:
				run !== undefined &&
				missing.length === 0 &&
				run.children.length === 0 &&
				newWorktrees.length === 0,
			evidence: {
				run_found: run !== undefined,
				candidates: run === undefined ? runCandidates(before) : undefined,
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
	// The mock's final text carries this run's nonce, so the completion sentinel exists
	// only once THIS run finished — not because the prompt or a log line echoed it.
	const sentinel = isRealDriver ? "RESULT: done" : `RESULT: done ${nonceValue}`;
	const step = await runParentStep(label, {
		model: MODEL,
		prompt: PROMPT.launch,
		budgetMs: 600_000,
		watchMirror: true,
		sentinel,
	});
	const tool = stepToolResults(step);
	const run = findStepRun(before, tool.sessionPath);
	if (run === undefined) {
		failHard(`${label}: the run for this pi session could not be identified unambiguously`, {
			session: tool.sessionPath,
			candidates: runCandidates(before),
			pi_output: `${step.output}\n${step.raw}`.slice(-4000),
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
		// F3: the LAUNCH's own tool result is the FIRST subagent result of this step (the
		// later one is the collect). Scanning the pi stdout was wrong: with a
		// sentinel-driven run that text is the final line, so "INVALID_PARAMS"/"refused"
		// could never appear and the check was vacuously true.
		const launchResult = pass.tool.results.find((entry) => entry.toolName === "subagent");
		const launchText = launchResult?.text ?? "";
		const errorMarkers = ["INVALID_PARAMS", "refused", "machine_unknown"].filter((marker) =>
			launchText.includes(marker),
		);
		const toolOk = launchResult !== undefined && launchResult.isError !== true && errorMarkers.length === 0;
		const nameOk = typeof child === "string" && /^centurion-[a-z0-9]+$/.test(child);
		const hostOk = pass.childRecord?.host === XM_ENV.host;
		return {
			ok: toolOk && nameOk && hostOk && hostsEntry === undefined && crossMachineEnabled,
			evidence: {
				child,
				host: pass.childRecord?.host,
				crossMachineEnabled,
				settings_has_hosts: hostsEntry !== undefined,
				launch_tool_result: launchText.slice(0, 500),
				launch_tool_is_error: launchResult?.isError ?? null,
				error_markers: errorMarkers,
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
 * Zero-config launches fine, but the collect never even fetches a transcript. The
 * ROOT CAUSE is the read-back resolving the host through the settings-only resolver,
 * which refuses a host with no `subagents.crossMachine.hosts.<name>` entry
 * (src/runs/remote.ts:976-982) — but that failure is SWALLOWED, so what the caller
 * actually sees today is the worktree-ownership guard: `collect failed: … worktree
 * '…' belongs to host 'remote': local filesystem and git operations on it are
 * refused`. The parent's mirror must NOT be written.
 *
 * F2: the assertion requires BOTH — the collect failed against a gap signature AND
 * that ownership-guard sentence is present. Fixing only the resolver (so the fetch
 * succeeds but the guard still throws) must keep d0 red; only a zero-config collect
 * that actually returns a transcript may turn it green (and then d0 needs rewriting).
 */
function assertZeroConfigGap(pass) {
	return assertThat(
		"d0",
		"known-gap: zero-config collect refused by the worktree-ownership guard, masking the missing hosts.<name> read-back (src/runs/remote.ts:976-982)",
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
			// The sentence the caller really sees today (F2): without it, a resolver-only
			// fix would leave the mirror empty AND `collect failed` true, i.e. d0 would go
			// green while nothing was actually delivered.
			const ownershipGuard = /belongs to host ['‘’]?/.test(text) &&
				/local filesystem and git operations on it are refused/.test(text);
			const failed = /collect failed|INVALID_PARAMS|transcript/i.test(text);
			const noMirror = mirrorStat === undefined || mirrorStat.size === 0;
			// Always printed: the current gap's EXACT shape, so the report can quote it
			// and a future product fix shows up as this line disappearing (and d0 going red).
			print(
				`XM_GAP ${JSON.stringify({
					id: "d0",
					child,
					mirror_path: mirrorPath,
					mirror_bytes: mirrorStat?.size ?? 0,
					gap_signature: signature?.source ?? null,
					ownership_guard: ownershipGuard,
					collect_result: text.slice(0, 600),
				})}`,
			);
			// The zero-config probe must not silently look like a read-back success.
			return {
				ok: failed && signature !== undefined && noMirror && ownershipGuard,
				evidence: {
					child,
					collect_failed: failed,
					gap_signature: signature?.source,
					ownership_guard: ownershipGuard,
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
 * The mirror must have lines, contain the remote session's LAST assistant text and be
 * newer than the launch. Both pre-created placeholders (the child record's own session
 * file and `<parentRun>/<child>.jsonl`) are printed as the contrast and can never be
 * the evidence; an ABSENT placeholder is stronger than a 0-byte one, so only
 * existing-and-non-zero fails.
 *
 * The transcript is NOT the same fact as the collect's verdict (F1): today the fetch
 * runs pre-wait inside `collect` and writes this mirror, and only afterwards
 * `finishCollect` refuses the child (asserted separately as d1). `collect_ok` /
 * `collect_error` and `collect_failed` in XM_CONTRAST make that split explicit instead
 * of leaving it buried in evidence.
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

		const collect = lastSubagentResult(pass.tool.results);
		const collectText = collect?.text ?? "";
		const collectFailed = /collect failed/i.test(collectText) || collect?.isError === true;

		const placeholderPath = pass.childRecord?.sessionFile ?? `${XM_ENV.runStore}/${pass.run.runId}/${child}.jsonl`;
		const placeholderStat = containerFileStat(XM_ENV.parent, placeholderPath);
		const parentPlaceholderPath = `${XM_ENV.runStore}/${pass.run.runId}/${child}.jsonl`;
		const parentPlaceholderStat = containerFileStat(XM_ENV.parent, parentPlaceholderPath);
		const placeholderEmpty = placeholderStat === undefined || placeholderStat.size === 0;
		const parentPlaceholderEmpty = parentPlaceholderStat === undefined || parentPlaceholderStat.size === 0;

		print(
			`XM_CONTRAST ${JSON.stringify({
				child,
				mirror_path: mirrorPath,
				mirror_bytes: mirrorStat?.size ?? 0,
				mirror_lines: mirrorLines,
				mirror_mtime: mirrorStat?.mtime,
				launch_start: pass.start,
				collect_failed: collectFailed,
				placeholder_path: placeholderPath,
				placeholder_bytes: placeholderStat?.size ?? 0,
				parent_run_placeholder_path: parentPlaceholderPath,
				parent_run_placeholder_bytes: parentPlaceholderStat?.size ?? 0,
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
				parentPlaceholderPath !== mirrorPath &&
				placeholderEmpty &&
				parentPlaceholderEmpty,
			evidence: {
				mirror_path: mirrorPath,
				mirror_bytes: mirrorStat?.size ?? 0,
				mirror_lines: mirrorLines,
				mirror_mtime: mirrorStat?.mtime,
				launch_start: pass.start,
				mtime_after_launch: mtimeAfterLaunch,
				mirror_seen_ms_after_start: mirrorSeenMsAfterStart(pass.step),
				remote_jsonl: remote.paths,
				remote_last_assistant: remote.text.slice(0, 500),
				mirror_contains_last_assistant: contains,
				collect_ok: !collectFailed,
				collect_error: collectFailed ? collectText.slice(0, 800) : null,
				placeholder_path: placeholderPath,
				placeholder_bytes: placeholderStat?.size ?? 0,
				placeholder_empty: placeholderEmpty,
				parent_run_placeholder_path: parentPlaceholderPath,
				parent_run_placeholder_bytes: parentPlaceholderStat?.size ?? 0,
				parent_run_placeholder_empty: parentPlaceholderEmpty,
				placeholder_used_for_verdict: false,
			},
		};
	});
}

/**
 * d1 — the SECOND product gap, asserted instead of hidden (F1).
 *
 * With `hosts.<name>` present the pre-wait refresh inside `collect` DOES fetch the
 * transcript and writes the mirror (that is what d proves), and only afterwards
 * `finishCollect` runs `assertLocalWorktree(child)` (src/runs/orchestrator.ts:3515) and
 * refuses the child, so the collect tool result is a failure even though the bytes
 * arrived. Today's shape: mirror non-empty AND collect failed with the ownership guard.
 *
 * This is again an assertion of a GAP: when the product lets a remote child's collect
 * finish, d1 must go RED so the harness gets updated (and d's `collect_ok` becomes true).
 */
function assertRemoteCollectGap(pass) {
	return assertThat(
		"d1",
		"known-gap: collect on a remote child is refused by assertLocalWorktree (src/runs/orchestrator.ts:3515)",
		() => {
			const child = pass.childRecord?.name;
			const collect = lastSubagentResult(pass.tool.results);
			const text = collect?.text ?? "";
			const mirrorPath = `${XM_ENV.runStore}/${pass.run.runId}/remote/${child}.jsonl`;
			const mirrorStat = containerFileStat(XM_ENV.parent, mirrorPath);
			const signature =
				/belongs to host|assertLocalWorktree|local filesystem and git operations on it are refused/.test(text);
			const mirrorNonEmpty = mirrorStat !== undefined && mirrorStat.size > 0;
			print(
				`XM_GAP ${JSON.stringify({
					id: "d1",
					child,
					mirror_path: mirrorPath,
					mirror_bytes: mirrorStat?.size ?? 0,
					signature,
					collect_result: text.slice(0, 600),
				})}`,
			);
			return {
				ok: signature && mirrorNonEmpty,
				evidence: {
					child,
					signature,
					mirror_path: mirrorPath,
					mirror_bytes: mirrorStat?.size ?? 0,
					mirror_non_empty: mirrorNonEmpty,
					collect_is_error: collect?.isError ?? null,
					collect_result: text.slice(0, 2000),
					session: pass.tool.sessionPath,
				},
			};
		},
	);
}

// ──────────────────────────────────────────────────────── Run A / Run B flow

async function runLaunchScenario() {
	// ── Run A: zero-config ───────────────────────────────────────────────
	print(`XM_SETTINGS ${applySettingsMode("zero-config")}`);
	const nonceA = nonce();
	// The mocks read these files, so they must exist before the first one starts.
	installScenarios(scenarioDir(), nonceA, { childName: "centurion-0" });
	await assertUtilityCannotCross();
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
	assertRemoteCollectGap(passB);

	return {
		runId: `${passA.run.runId},${passB.run.runId}`,
		child: `${passA.childRecord?.name ?? "?"},${passB.childRecord?.name ?? "?"}`,
	};
}

// ────────────────────────────────────── target-model fallback scenario (§5.4, 6.2.2)

/**
 * The 6.2.2 shape of §5.4: a model the target machine does not serve is no longer a
 * dead end — the launch falls back to a model THAT machine lists, warns once, and the
 * child really runs with the substituted model. These four assertions replace the
 * pre-6.2.2 "must be refused" trio (which went red exactly as designed when 567417a
 * landed).
 *
 * Determinism (why the topology looks the way it does): the remote's models.json has
 * NO `xm` provider and lists exactly ONE row, `xmock/other`, served by mock port 8766
 * — see `xm-up.sh`. A known provider with a missing id is not a refusal (pi says
 * "Using custom model id"), and with several rows `planRemoteModelFallback` would pick
 * the first one — which would be a real host model.
 */
async function runModelMissingScenario() {
	print(`XM_SETTINGS ${applySettingsMode("zero-config")}`);
	const nonceValue = nonce();
	const childName = "centurion-0";
	installScenarios(scenarioDir(), nonceValue, { childName });
	await ensureMocks([
		{ port: MOCK_PORTS.parent, scriptName: "model-missing.json" },
		{ port: MOCK_PORTS.child, scriptName: "child.json" },
	]);

	// What the remote machine really serves — both the absence and the fallback row.
	const remoteList = remoteModels();
	const remoteRows = remoteList
		.split("\n")
		.slice(1)
		.map((line) => line.trim().split(/\s+/))
		.filter((columns) => columns.length >= 2 && columns[0] !== "provider");
	const [mockProvider, ...mockRest] = XM_ENV.mockModel.split("/");
	const mockModelId = mockRest.join("/");
	const [fallbackProvider, ...fallbackRest] = XM_ENV.fallbackModel.split("/");
	const fallbackModelId = fallbackRest.join("/");

	assertThat("m1", "remote-model-absent", () => {
		const hasRequested = remoteRows.some((c) => c[0] === mockProvider && c[1] === mockModelId);
		const hasFallback = remoteRows.some((c) => c[0] === fallbackProvider && c[1] === fallbackModelId);
		return {
			ok: !hasRequested && hasFallback,
			evidence: {
				requested: XM_ENV.mockModel,
				fallback: XM_ENV.fallbackModel,
				remote_rows: remoteRows.map((c) => `${c[0]}/${c[1]}`),
				remote_models: remoteList,
			},
		};
	});

	const worktreesBefore = remoteWorktreeList();
	const before = new Set(runIds());
	const step = await runParentStep("model", {
		model: MODEL,
		prompt: PROMPT.modelMissing,
		budgetMs: 300_000,
		sentinel: "MODEL_TOOL_RESULT",
	});
	const tool = stepToolResults(step);
	const run = findStepRun(before, tool.sessionPath);
	if (run === undefined) {
		failHard("model-missing: the run for this pi session could not be identified unambiguously", {
			session: tool.sessionPath,
			candidates: runCandidates(before),
			pi_output: `${step.output}\n${step.raw}`.slice(-4000),
		});
	}
	const childRecord = run.children.find((entry) => entry?.host === XM_ENV.host) ?? run.children[0];
	const child = childRecord?.name;
	const launchResult = tool.results.find((entry) => entry.toolName === "subagent");
	const launchText = launchResult?.text ?? "";

	assertThat("m2", "fallback-warning", () => {
		// Three semantic pieces, and the text of each is the PRODUCT's (remote.ts:997-1004),
		// not invented here: what was asked for, what was substituted, and where to pin it.
		const expected = [
			`model '${XM_ENV.mockModel}' is not visible there`,
			`using '${XM_ENV.fallbackModel}' from that machine's listing`,
			`subagents.crossMachine.hosts.${XM_ENV.host}.model`,
		];
		const missing = expected.filter((needle) => !launchText.includes(needle));
		const launched = launchResult !== undefined && launchResult.isError !== true && !launchText.includes("INVALID_PARAMS");
		const childOnHost = run.children.some((entry) => entry?.host === XM_ENV.host);
		return {
			ok: missing.length === 0 && launched && childOnHost,
			evidence: {
				missing_substrings: missing,
				launch_tool_is_error: launchResult?.isError ?? null,
				child_on_host: childOnHost,
				launch_tool_result: launchText.slice(0, 1500),
				session: tool.sessionPath,
			},
		};
	});

	assertThat("m3", "fallback-is-real", () => {
		const facts = worktreeFacts(child);
		const sessionModel = remoteLastAssistantModel(child);
		const runModel = childRecord?.model;
		// The child's own transcript is the proof: it records the endpoint it called.
		const sessionOk = sessionModel.provider === fallbackProvider && sessionModel.model === fallbackModelId;
		// `run.json`'s child record keeps the REQUESTED model (`xm/flash`), measured on
		// 6.2.2 — the resolved one lives in the child's argv/transcript. So the gate is
		// the transcript, and the record is printed as the "what was asked" contrast.
		const worktreesAfter = remoteWorktreeList();
		const added = worktreesAfter.text
			.split("\n")
			.filter((line) => line.trim().length > 0 && !worktreesBefore.text.includes(line.trim()));
		// "New" is about THIS child's path, not about every line that moved: the shared
		// /root/work checkout can re-render (e.g. its branch annotation) during a run.
		const worktreeIsNew = !worktreesBefore.text.includes(facts.worktreePath);
		return {
			ok: sessionOk && facts.line !== undefined && facts.branchOk && worktreeIsNew,
			evidence: {
				child,
				expected_fallback: XM_ENV.fallbackModel,
				session_provider: sessionModel.provider,
				session_model: sessionModel.model,
				session_source: sessionModel.source,
				run_json_child_model: runModel,
				run_json_child_model_is_requested: runModel === XM_ENV.mockModel,
				worktree_is_new: worktreeIsNew,
				worktree_path: facts.worktreePath,
				branch: facts.branch,
				branch_ok: facts.branchOk,
				new_remote_worktrees: added,
				nonce: nonceValue,
			},
		};
	});

	assertThat("m4", "no-local-fallback", () => {
		const children = Array.isArray(run.children) ? run.children : [];
		const localChildren = children.filter((entry) => !entry?.host);
		const remoteChildren = children.filter((entry) => entry?.host === XM_ENV.host);
		return {
			ok: localChildren.length === 0 && remoteChildren.length === 1,
			evidence: {
				children: children.map((entry) => ({ name: entry?.name, host: entry?.host, model: entry?.model })),
				local_children: localChildren.length,
				remote_children: remoteChildren.length,
			},
		};
	});

	return { runId: run.runId, child: child ?? "none" };
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
