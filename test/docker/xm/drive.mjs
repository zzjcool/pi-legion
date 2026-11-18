#!/usr/bin/env node
// Cross-machine driver for the xm-harness (contract `docs/contracts/xm-harness-v1.md`,
// revision v1.1 — the deterministic driver).
//
// This process runs on the HOST. Everything it asserts happens inside the two
// containers, and every fact it returns is read back with `docker exec`:
//
//   parent container ("xm-parent")  → hc (herdr-core) + pi + two mock LLM ports
//   remote container ("xm-remote")  → sshd + pi, reached only by hc over ssh
//
// WHY `hc run`: a parent pi WITHOUT a terminal host (`HC_TERMINAL_SOCKET` +
// `HC_TERMINAL_ID`) refuses every `host:` dispatch (orchestrator.ts:1449-1462), and
// `hc run` is the non-interactive way to get them injected. A plain
// `docker exec … pi …` therefore cannot drive a cross-machine launch at all.
//
// WHY `docker exec -d` instead of one blocking exec: the parent run spends minutes
// waiting on a remote child. A host-side killed exec takes the hc core down with it
// (observed: the terminal vanished and every artefact with it), so the run is
// detached inside the container, redirects its own output to `/root/xm/<step>.out`
// and reports completion through `/root/xm/<step>.rc`, which this process polls.
//
// Exported surface (assert.mjs consumes it); `node drive.mjs selftest` prints the
// environment facts it relies on, without spending a model call.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ────────────────────────────────────────────────────────────── configuration

export const XM_ENV = {
	parent: process.env.XM_PARENT || "xm-parent",
	remote: process.env.XM_REMOTE || "xm-remote",
	host: process.env.XM_HOST || "remote",
	hostCwd: process.env.XM_HOST_CWD || "/root/work",
	/** The mock model both containers register (`<provider>/<model>`). */
	mockModel: process.env.XM_MOCK_MODEL || "xm/flash",
	/** The real model `make xm-real` uses. */
	realModel: process.env.XM_MODEL || "workbuddy/hy4std",
	/** Directory inside the parent container that holds scripts/scripts' output. */
	dir: process.env.XM_CONTAINER_DIR || "/root/xm",
	/** Parent-side run store (the pi cwd is `hostCwd`), where `runs/<id>/` lives. */
	runStore: process.env.XM_RUN_STORE || "/root/work/.pi-subagents/runs",
	pluginDir: process.env.XM_PLUGIN_DIR || "/plugin",
};

/**
 * TWO ports, TWO scripts, zero parent/child ambiguity (contract v1.1).
 *
 * 8765 is what the PARENT's models.json points at; 8766 is what the REMOTE
 * container's models.json points at. The parent's scenario script is swapped per
 * step (a1 / a2 / launch / model-missing) by restarting the 8765 mock, so a
 * refusal probe can never be answered by the launch script. Sharing one port
 * between the two roles instead would make `promptIncludes`/`turnIndex` the only
 * discriminator — and the parent's tool result carries the child's task text, so
 * that discriminator is exactly what v1.1 rejects.
 */
export const MOCK_PORTS = {
	/** parent pi — launch/collect, or one refusal probe per step */
	parent: 8765,
	/** remote child — write marker / final text */
	child: 8766,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(line) {
	process.stdout.write(`${line}\n`);
}

// ────────────────────────────────────────────────────────────── docker plumbing

/** Run a host command and capture it; never throws on a non-zero exit. */
export function runHost(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: options.timeoutMs ?? 120_000,
		maxBuffer: 32 * 1024 * 1024,
		input: options.input,
	});
	return {
		status: result.status ?? (result.error ? 1 : 0),
		ok: (result.status ?? 0) === 0 && !result.error,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? (result.error ? String(result.error.message ?? result.error) : ""),
	};
}

const docker = (args, options) => runHost("docker", args, options);

/** `docker exec <container> bash -lc <script>` with optional stdin. */
export function inContainer(container, script, options = {}) {
	return docker(["exec", "-i", container, "bash", "-lc", script], options);
}

/** Start a detached process inside a container (never blocks the host). */
export function inContainerDetached(container, script) {
	return docker(["exec", "-d", container, "bash", "-lc", script], { timeoutMs: 30_000 });
}

export function dockerAvailable() {
	return runHost("docker", ["info"], { timeoutMs: 30_000 }).ok;
}

export function containerRunning(name) {
	const result = docker(["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 30_000 });
	return result.ok && result.stdout.trim() === "true";
}

/** Write a file inside a container without any shell quoting games. */
export function writeContainerFile(container, filePath, content) {
	const result = docker(
		["exec", "-i", container, "bash", "-lc", 'mkdir -p "$(dirname "$1")" && cat > "$1" && wc -c < "$1"', "xm", filePath],
		{ input: content, timeoutMs: 60_000 },
	);
	if (!result.ok) {
		throw new Error(`cannot write ${filePath} in ${container}: ${result.stderr || result.stdout}`);
	}
	return Number(result.stdout.trim());
}

export function readContainerFile(container, filePath) {
	const result = docker(["exec", container, "bash", "-lc", `cat ${shellQuote(filePath)} 2>/dev/null`], {
		timeoutMs: 60_000,
	});
	return result.ok ? result.stdout : null;
}

/** `{size, mtime}` in seconds, or undefined when the file is absent. */
export function containerFileStat(container, filePath) {
	const result = docker(
		["exec", container, "bash", "-lc", `stat -c '%s %Y' ${shellQuote(filePath)} 2>/dev/null || echo MISSING`],
		{ timeoutMs: 30_000 },
	);
	const text = result.stdout.trim();
	if (!result.ok || text === "MISSING" || text === "") return undefined;
	const [size, mtime] = text.split(/\s+/).map((value) => Number(value));
	if (!Number.isFinite(size) || !Number.isFinite(mtime)) return undefined;
	return { size, mtime };
}

export function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// ────────────────────────────────────────────────────────────── mock LLMs

/** Stop every mock this driver may have started (idempotent, never throws). */
export function stopMocks() {
	const ports = Object.values(MOCK_PORTS);
	for (const port of ports) {
		inContainer(
			XM_ENV.parent,
			[
				`if [ -f ${XM_ENV.dir}/mock-${port}.pid ]; then kill "$(cat ${XM_ENV.dir}/mock-${port}.pid)" 2>/dev/null || true; rm -f ${XM_ENV.dir}/mock-${port}.pid; fi`,
				`pkill -f "mock-llm/cli.ts --port ${port} " 2>/dev/null || true`,
				`pkill -f "mock-llm/cli.ts --port ${port}$" 2>/dev/null || true`,
			].join("\n"),
			{ timeoutMs: 30_000 },
		);
	}
}

/**
 * Start one mock in the PARENT container, bound to 0.0.0.0 so the remote container
 * can reach it through docker DNS (`http://parent:<port>/v1`).
 *
 * The mock-llm sources live in the read-only `/plugin` mount; node 24 strips the
 * TypeScript without a build step (the flag stays accepted).
 */
export async function startMock({ port, scriptName }) {
	const scriptPath = `${XM_ENV.dir}/scenarios/${scriptName}`;
	const command = [
		`mkdir -p ${XM_ENV.dir}`,
		`rm -f ${XM_ENV.dir}/mock-${port}.log ${XM_ENV.dir}/mock-${port}.requests.log ${XM_ENV.dir}/mock-${port}.pid`,
		`MOCK_LLM_LOG=${XM_ENV.dir}/mock-${port}.requests.log nohup node --experimental-strip-types ${XM_ENV.pluginDir}/test/mock-llm/cli.ts --port ${port} --host 0.0.0.0 --script ${scriptPath} > ${XM_ENV.dir}/mock-${port}.log 2>&1 &`,
		`echo $! > ${XM_ENV.dir}/mock-${port}.pid`,
	].join("\n");
	const started = inContainer(XM_ENV.parent, command, { timeoutMs: 30_000 });
	if (!started.ok) {
		throw new Error(`cannot start mock on ${port}: ${started.stderr || started.stdout}`);
	}
	const deadline = Date.now() + 30_000;
	for (;;) {
		const health = inContainer(
			XM_ENV.parent,
			`curl -fsS --max-time 2 http://127.0.0.1:${port}/health 2>/dev/null || true`,
			{ timeoutMs: 10_000 },
		);
		if (health.stdout.includes('"ok"')) return { port, scriptName, scriptPath };
		if (Date.now() > deadline) {
			const mockLog = readContainerFile(XM_ENV.parent, `${XM_ENV.dir}/mock-${port}.log`) ?? "";
			throw new Error(`mock on ${port} did not become healthy in 30s:\n${mockLog}`);
		}
		await sleep(250);
	}
}

/** Start the mocks a scenario needs; ports not listed are stopped first. */
export async function ensureMocks(mocks) {
	stopMocks();
	const started = [];
	for (const mock of mocks) started.push(await startMock(mock));
	return started;
}

/** Write the scenario files (with `{{NONCE}}` substituted) into the container. */
export function installScenarios(scenarioDir, nonce, options = {}) {
	const scenarios = {};
	const substitute = (text) =>
		text
			.replaceAll("{{NONCE}}", nonce)
			.replaceAll("{{HOST}}", XM_ENV.host)
			.replaceAll("{{HOST_CWD}}", XM_ENV.hostCwd)
			.replaceAll("{{MOCK_MODEL}}", XM_ENV.mockModel)
			.replaceAll("{{CHILD_NAME}}", options.childName ?? "centurion-0");
	for (const name of fs.readdirSync(scenarioDir)) {
		if (!name.endsWith(".json")) continue;
		const raw = fs.readFileSync(path.join(scenarioDir, name), "utf8");
		const rendered = substitute(raw);
		// Refuse a half-substituted script: it would run with a placeholder nonce and
		// every later assertion would look like a product bug. (`{{lastToolContent}}`
		// is the MOCK's own template and must survive — only the harness tokens are
		// checked here.)
		if (/\{\{(NONCE|HOST|HOST_CWD|MOCK_MODEL|CHILD_NAME)\}\}/.test(rendered)) {
			throw new Error(`scenario ${name} still has an unexpanded harness placeholder`);
		}
		writeContainerFile(XM_ENV.parent, `${XM_ENV.dir}/scenarios/${name}`, rendered);
		scenarios[name] = rendered;
	}
	return scenarios;
}

// ────────────────────────────────────────────────────────────── runs

export function runIds() {
	const result = inContainer(XM_ENV.parent, `ls -1 ${XM_ENV.runStore} 2>/dev/null || true`, { timeoutMs: 30_000 });
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

export function readRunJson(runId) {
	const raw = readContainerFile(XM_ENV.parent, `${XM_ENV.runStore}/${runId}/run.json`);
	if (raw === null) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/** Every `*.jsonl` the remote wrote for a child (session + any transcript mirror). */
export function remoteJsonlPaths(child) {
	const result = inContainer(
		XM_ENV.remote,
		[
			`for p in ${shellQuote(`/root/.pi-worktrees/${child}`)} /root/.pi-subagents-mirror; do`,
			`  [ -e "$p" ] && find "$p" -type f -name '*.jsonl' 2>/dev/null || true`,
			`done`,
		].join("\n"),
		{ timeoutMs: 60_000 },
	);
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter((line) => line.includes(`/${child}/`) || line.includes(`/${child}.jsonl`));
}

/** Read a remote file (used for the child's session transcript). */
export function readRemoteFile(remotePath) {
	const result = docker(["exec", XM_ENV.remote, "bash", "-lc", `cat ${shellQuote(remotePath)}`], {
		timeoutMs: 60_000,
	});
	return result.ok ? result.stdout : null;
}

/**
 * The last non-empty assistant TEXT in a pi session JSONL.
 *
 * A turn is a line with `message.role`/`role`; assistant content is either a string
 * or an array of parts (`{type:"text",text}` / tool calls). Empty text parts are
 * skipped so a tool-only turn cannot answer for a later final message.
 */
export function lastAssistantText(jsonl) {
	let last = "";
	for (const line of String(jsonl ?? "").split("\n")) {
		if (line.trim().length === 0) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry?.message ?? entry;
		if (message?.role !== "assistant") continue;
		const content = message.content;
		let text = "";
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content
				.filter((part) => part && typeof part === "object" && part.type === "text")
				.map((part) => (typeof part.text === "string" ? part.text : ""))
				.join("\n");
		}
		if (text.trim().length > 0) last = text;
	}
	return last;
}

export function remoteWorktreeList() {
	const result = inContainer(XM_ENV.remote, `git -C ${shellQuote(XM_ENV.hostCwd)} worktree list`, {
		timeoutMs: 60_000,
	});
	return { ok: result.ok, text: result.stdout, stderr: result.stderr };
}

export function localWorktreeList() {
	const result = inContainer(XM_ENV.parent, `git -C ${shellQuote(XM_ENV.hostCwd)} worktree list`, {
		timeoutMs: 60_000,
	});
	return { ok: result.ok, text: result.stdout, stderr: result.stderr };
}

// ────────────────────────────────────────────────────────────── the pi run

/**
 * Render the two container-side scripts for one parent pi run.
 *
 * `pi-<step>.sh` is what `hc run` executes (it must be a file: nesting a quoted pi
 * argv inside `hc run … -- bash -lc '…'` is where shell quoting bugs live).
 */
function writeStepScripts(step, { model, prompt }) {
	writeContainerFile(XM_ENV.parent, `${XM_ENV.dir}/prompt-${step}.txt`, `${prompt}\n`);
	writeContainerFile(
		XM_ENV.parent,
		`${XM_ENV.dir}/pi-${step}.sh`,
		[
			"#!/usr/bin/env bash",
			"set -u",
			`cd ${shellQuote(XM_ENV.hostCwd)}`,
			`exec pi --print --model ${shellQuote(model)} "$(cat ${XM_ENV.dir}/prompt-${step}.txt)"`,
			"",
		].join("\n"),
	);
	writeContainerFile(
		XM_ENV.parent,
		`${XM_ENV.dir}/run-${step}.sh`,
		[
			"#!/usr/bin/env bash",
			"set -u",
			"export PATH=/usr/local/bin:$PATH",
			`rm -f ${XM_ENV.dir}/${step}.rc ${XM_ENV.dir}/${step}.out`,
			`hc run --name xm-${step} --timeout 1500 --json -- bash ${XM_ENV.dir}/pi-${step}.sh > ${XM_ENV.dir}/${step}.out 2>&1`,
			`echo $? > ${XM_ENV.dir}/${step}.rc`,
			"",
		].join("\n"),
	);
}

/** Parse the last JSON object printed by `hc run --json`. */
export function parseHcRunJson(raw) {
	const lines = String(raw ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i];
		if (!line.startsWith("{")) continue;
		try {
			return JSON.parse(line);
		} catch {
			/* keep looking */
		}
	}
	return undefined;
}

/**
 * Run one parent pi process through `hc run` and wait for its FINAL TEXT.
 *
 * Why not just wait for `hc run` to exit: a parent pi that launched a child can keep
 * its event loop alive after printing its last line (the extension has a queued
 * completion notice to deliver), so `hc run` may never return on its own. The run is
 * therefore considered finished when the deterministic final text appears on the
 * terminal (`sentinel`), and the terminal is ended only if the process did not exit
 * by itself right after — `naturalExit` records which of the two happened.
 *
 * Two more polls run alongside: `<step>.rc` (written by the detached wrapper after
 * `hc run` returns) and, when `watchMirror` is set, the parent-side transcript mirror
 * — "pi is slow" and "the mirror never appeared" are different findings.
 */
export async function runParentStep(step, options) {
	const { model, prompt, budgetMs = 600_000, watchMirror = false, sentinel } = options;
	writeStepScripts(step, { model, prompt });
	const terminal = `xm-${step}`;
	const startedAt = Math.floor(Date.now() / 1000);
	const launch = inContainerDetached(XM_ENV.parent, `bash ${XM_ENV.dir}/run-${step}.sh`);
	if (!launch.ok) {
		throw new Error(`cannot start ${step}: ${launch.stderr || launch.stdout}`);
	}
	const deadline = Date.now() + budgetMs;
	const rcPath = `${XM_ENV.dir}/${step}.rc`;
	const readRc = () => {
		const value = readContainerFile(XM_ENV.parent, rcPath);
		return value !== null && value.trim() !== "" ? Number(value.trim()) : undefined;
	};
	let sentinelSeenAt;
	let mirrorSeenAt;
	let mirror;
	let naturalExit = false;
	let killed = false;
	for (;;) {
		const rc = readRc();
		if (rc !== undefined) {
			naturalExit = killed === false;
			break;
		}
		if (watchMirror && mirror === undefined) {
			const seen = findNewMirrors(startedAt);
			if (seen.length > 0) {
				mirrorSeenAt = Math.floor(Date.now() / 1000);
				mirror = seen[0];
			}
		}
		if (sentinel !== undefined && sentinelSeenAt === undefined) {
			const screen = terminalScreen(terminal);
			if (screen.includes(sentinel)) sentinelSeenAt = Math.floor(Date.now() / 1000);
		}
		if (sentinelSeenAt !== undefined) {
			// Grace for the natural exit path, then end the terminal ourselves.
			for (let waited = 0; waited < 5_000; waited += 250) {
				if (readRc() !== undefined) break;
				await sleep(250);
			}
			if (readRc() === undefined) {
				killTerminal(terminal);
				killed = true;
				for (let waited = 0; waited < 20_000; waited += 250) {
					if (readRc() !== undefined) break;
					await sleep(250);
				}
			}
			continue;
		}
		if (Date.now() > deadline) {
			const partial = readContainerFile(XM_ENV.parent, `${XM_ENV.dir}/${step}.out`) ?? "";
			const screen = terminalScreen(terminal);
			const terminals = inContainer(XM_ENV.parent, "export PATH=/usr/local/bin:$PATH; hc ls 2>&1 || true", {
				timeoutMs: 30_000,
			});
			throw new Error(
				`${step} did not reach ${sentinel === undefined ? "an exit" : `the sentinel ${JSON.stringify(sentinel)}`} within ${Math.round(budgetMs / 1000)}s\n` +
					`--- /root/xm/${step}.out ---\n${partial}\n--- terminal screen ---\n${screen}\n--- hc ls ---\n${terminals.stdout}${terminals.stderr}`,
			);
		}
		await sleep(500);
	}
	const endedAt = Math.floor(Date.now() / 1000);
	const rc = readRc();
	const raw = readContainerFile(XM_ENV.parent, `${XM_ENV.dir}/${step}.out`) ?? "";
	const json = parseHcRunJson(raw);
	return {
		step,
		terminal,
		startedAt,
		endedAt,
		rc,
		naturalExit,
		killed,
		sentinelSeenAt,
		raw,
		json,
		output: typeof json?.output === "string" ? json.output : "",
		address: json?.address,
		terminalState: json?.state,
		wait: json?.wait,
		mirrorSeenAt,
		mirror,
	};
}

/** The terminal's screen + history, as `hc read` prints it. */
export function terminalScreen(name) {
	const result = inContainer(
		XM_ENV.parent,
		`export PATH=/usr/local/bin:$PATH; hc read --lines 400 ${shellQuote(name)} 2>&1 || true`,
		{ timeoutMs: 30_000 },
	);
	return result.stdout;
}

/** End a terminal's program (used once the deterministic final text is on screen). */
export function killTerminal(name) {
	inContainer(XM_ENV.parent, `export PATH=/usr/local/bin:$PATH; hc kill ${shellQuote(name)} >/dev/null 2>&1 || true`, {
		timeoutMs: 30_000,
	});
}

/** Switch the parent container's settings between the two asserted shapes. */
export function applySettingsMode(mode) {
	const script = `${XM_ENV.pluginDir}/test/docker/xm/settings-mode.mjs`;
	const result = inContainer(
		XM_ENV.parent,
		`node ${shellQuote(script)} ${shellQuote(mode)} ${shellQuote(XM_ENV.host)} ${shellQuote(XM_ENV.hostCwd)}`,
		{ timeoutMs: 60_000 },
	);
	if (!result.ok) throw new Error(`settings-mode ${mode} failed: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

/**
 * The parent pi writes its own session transcript under the agent dir. It is the
 * most reliable place to see TOOL RESULTS (stdout only carries the final text).
 */
export function parentSessionSince(sinceSeconds) {
	const result = inContainer(
		XM_ENV.parent,
		`find /root/.pi/agent/sessions -type f -name '*.jsonl' -newermt '@${sinceSeconds - 1}' 2>/dev/null | xargs -r ls -1t 2>/dev/null | head -1 || true`,
		{ timeoutMs: 30_000 },
	);
	const path = result.stdout.trim().split("\n")[0];
	if (!path) return undefined;
	return { path, text: readContainerFile(XM_ENV.parent, path) ?? "" };
}

/** `[{toolName, text, isError}]` from a pi session transcript. */
export function toolResultsFromSession(jsonl) {
	const out = [];
	for (const line of String(jsonl ?? "").split("\n")) {
		if (line.trim().length === 0) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry?.message ?? entry;
		if (message?.role !== "toolResult") continue;
		const content = message.content;
		const text = typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter((part) => part && typeof part === "object" && part.type === "text")
						.map((part) => (typeof part.text === "string" ? part.text : ""))
						.join("\n")
				: "";
		out.push({ toolName: message.toolName ?? "", text, isError: message.isError === true });
	}
	return out;
}

/** Any `remote/*.jsonl` in the run store modified at/after `sinceSeconds`. */
export function findNewMirrors(sinceSeconds) {
	const result = inContainer(
		XM_ENV.parent,
		`find ${XM_ENV.runStore} -path '*/remote/*.jsonl' -newermt '@${sinceSeconds - 1}' -type f 2>/dev/null | head -5 || true`,
		{ timeoutMs: 30_000 },
	);
	return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function nonce() {
	return crypto.randomBytes(8).toString("hex");
}

/** Last assistant text across every remote jsonl this child owns. */
export function remoteLastAssistantText(child) {
	const paths = remoteJsonlPaths(child);
	const collected = [];
	for (const remotePath of paths) {
		const raw = readRemoteFile(remotePath);
		const last = lastAssistantText(raw);
		if (last.length > 0) collected.push({ path: remotePath, text: last });
	}
	const final = collected.at(-1);
	return { paths, text: final?.text ?? "", source: final?.path };
}

export function scenarioDir() {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "scenarios");
}

// ────────────────────────────────────────────────────────────── selftest CLI

async function main() {
	const argv = process.argv.slice(2);
	if (argv[0] !== "selftest") {
		process.stderr.write("usage: node drive.mjs selftest\n");
		process.exit(2);
	}
	const facts = {
		docker: dockerAvailable(),
		parent: containerRunning(XM_ENV.parent),
		remote: containerRunning(XM_ENV.remote),
		env: XM_ENV,
		ports: MOCK_PORTS,
		parentModels: inContainer(XM_ENV.parent, `cd ${shellQuote(XM_ENV.hostCwd)} && pi --list-models 2>&1 | head -8`, { timeoutMs: 60_000 }).stdout,
		remoteModels: inContainer(XM_ENV.remote, `cd ${shellQuote(XM_ENV.hostCwd)} && pi --list-models 2>&1 | head -8`, { timeoutMs: 60_000 }).stdout,
		machines: inContainer(XM_ENV.parent, "export PATH=/usr/local/bin:$PATH; hc machine ls 2>&1", { timeoutMs: 30_000 }).stdout,
		scenarios: fs.readdirSync(scenarioDir()),
	};
	log(JSON.stringify(facts, null, 2));
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exit(1);
	});
}
