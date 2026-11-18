#!/usr/bin/env node
/**
 * A fake `hc` (herdr-core) used as the ORACLE for cross-machine spawn.
 *
 * Injected through `HC_BIN` (`src/hc/client.ts:resolveHcBin` prefers it), so a
 * test can drive the real `HcCliClient` + `TerminalSupervisor` end to end
 * without a core, a socket, or a second machine.
 *
 * It is deliberately STRICTER than a real core — that is the point:
 *
 *   - with `on`, the "other machine" is `FAKE_HC_REMOTE_ROOT`, and
 *   - every absolute argv element must live inside that root, and
 *   - `cwd` must be inside that root, and
 *   - `PATH`/`HOME`/`TERM*` must NOT be overridden (they are parent facts), and
 *   - a bare terminal name never resolves to a remote terminal.
 *
 * So "we forgot to rewrite `process.execPath`" fails here as a hard error
 * (`cannot start …: No such file or directory`, the real core's own wording)
 * instead of quietly passing a params-shape assertion.
 *
 * Env:
 *   FAKE_HC_REMOTE_ROOT   required for remote calls; stands for that machine's fs
 *   FAKE_HC_MACHINES      comma-separated names (default: "fakebox")
 *   FAKE_HC_MACHINE_LIST  what `machine.list` reports (v1.1 admission):
 *                         unset = FAKE_HC_MACHINES, "empty" = a registered-nothing
 *                         core, "unsupported" = the method fails (an old core),
 *                         otherwise a comma-separated override list
 *   FAKE_HC_REMOTE_PATH   PATH the "other machine" has for machine.exec — the
 *                         only way a test can say "there is no node there"
 *   FAKE_HC_REMOTE_HOME   HOME that machine's shell sees (pi install layout)
 *   FAKE_HC_LOG           optional path; every request is appended as JSONL
 *   FAKE_HC_LOCAL_ROOT    where local (no `on`) file/temp paths may live
 *                         (default: FAKE_HC_REMOTE_ROOT)
 *
 * Protocol: newline-delimited JSON-RPC on stdin/stdout, same as `hc connect`.
 * Result shapes mirror `hc schema` (verified against herdr-core 0.1.21):
 *   RunResult{address,name,state,turn,cwd,argv,cols,rows,created_ms,pid,status}
 *   ExecResult{code,ms,signal,stdout,stderr,truncated,timed_out}  stdout/stderr BASE64
 *   FileReadResult{text,first,last,lines}                          lines = total
 *   FileResult{path,bytes}
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REMOTE_ROOT = (process.env.FAKE_HC_REMOTE_ROOT ?? "").trim();
const LOCAL_ROOT = (process.env.FAKE_HC_LOCAL_ROOT ?? REMOTE_ROOT).trim();
const MACHINES = (process.env.FAKE_HC_MACHINES ?? "fakebox")
	.split(",")
	.map((name) => name.trim())
	.filter(Boolean);
const LOG = (process.env.FAKE_HC_LOG ?? "").trim();
/** v1.1: the machine.exec sandbox, so a test can control that machine's PATH/HOME. */
const REMOTE_PATH = (process.env.FAKE_HC_REMOTE_PATH ?? "").trim();
const REMOTE_HOME = (process.env.FAKE_HC_REMOTE_HOME ?? "").trim();

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EXEC_TIMEOUT_S = 600;
const CAPTURE_BYTES = 1024 * 1024;

/** name -> terminal. `host` is undefined for a local terminal. */
const terminals = new Map();
let terminalSeq = 0;

// ── wire helpers ────────────────────────────────────────────────────────────

function reply(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, kind, message, extra = {}) {
	process.stdout.write(
		`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message, data: { kind, ...extra } } })}\n`,
	);
}

function rpcError(id, code, message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function note(request) {
	if (LOG.length === 0) return;
	try {
		fs.appendFileSync(LOG, `${JSON.stringify(request)}\n`);
	} catch {
		/* diagnostics only */
	}
}

const inside = (root, candidate) => {
	if (!root) return false;
	const rel = path.relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** The positive form of "this path belongs to the parent machine". */
function remotePathProblem(value, root) {
	if (typeof value !== "string" || value.length === 0) return "not a path";
	if (!path.isAbsolute(value)) return "not absolute";
	if (!inside(root, path.resolve(value))) return `outside ${root}`;
	return undefined;
}

// ── terminal.run ────────────────────────────────────────────────────────────

function terminalRun(id, params) {
	const on = typeof params.on === "string" && params.on.trim().length > 0 ? params.on.trim() : undefined;
	const name = typeof params.name === "string" && params.name.length > 0 ? params.name : undefined;
	const argv = Array.isArray(params.argv) ? params.argv.map(String) : [];
	const cwd = typeof params.cwd === "string" ? params.cwd : "";
	const env = params.env && typeof params.env === "object" ? params.env : {};
	const labels = params.labels && typeof params.labels === "object" ? params.labels : {};

	if (on && !MACHINES.includes(on)) {
		fail(id, "machine_unknown", `unknown machine: ${on}`, { machine: on });
		return;
	}

	if (on) {
		// 1. cwd must exist on that machine.
		const cwdProblem = remotePathProblem(cwd, REMOTE_ROOT);
		if (cwdProblem) {
			fail(id, "bad_cwd", `host '${on}': cwd '${cwd}' is ${cwdProblem}`, { cwd });
			return;
		}
		if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
			fail(id, "bad_cwd", `host '${on}': no such directory: ${cwd}`, { cwd });
			return;
		}
		// 2. argv[0] is a parent absolute path ⇒ the real core's own wording.
		const first = argv[0] ?? "";
		if (path.isAbsolute(first) && !inside(REMOTE_ROOT, path.resolve(first))) {
			fail(
				id,
				"spawn_failed",
				`cannot start "${first}": No such file or directory`,
				{ argv0: first },
			);
			return;
		}
		// 3. no OTHER parent absolute path may survive either (--session, --system-prompt…).
		for (const arg of argv) {
			if (!path.isAbsolute(arg)) continue;
			const problem = remotePathProblem(arg, REMOTE_ROOT);
			if (problem) {
				fail(id, "bad_path", `host '${on}': argument '${arg}' is ${problem}`, { arg });
				return;
			}
		}
		// 4. the parent's PATH/HOME/TERM are facts about the parent, not this machine.
		for (const key of ["PATH", "HOME", "TERM", "TERM_PROGRAM", "COLORTERM"]) {
			if (typeof env[key] === "string") {
				fail(id, "parent_env", `host '${on}': '${key}' must not be overridden from the parent`, { key });
				return;
			}
		}
		// 5. legion identity is a parent ledger path; it cannot travel.
		for (const key of Object.keys(env)) {
			if (key.startsWith("PI_LEGION_") && key !== "PI_LEGION_CHILD_EXTENSIONS") {
				fail(id, "parent_env", `host '${on}': '${key}' must not be inherited across machines`, { key });
				return;
			}
		}
	}

	// Names are unique per core; a remote terminal lives in the remote namespace.
	for (const terminal of terminals.values()) {
		if (terminal.state !== "finished" && terminal.name === name && terminal.host === on) {
			fail(id, "name_taken", `terminal name taken: ${name}`, { name });
			return;
		}
	}

	terminalSeq += 1;
	const address = on ? `${on}/t${terminalSeq}` : `t${terminalSeq}`;
	const terminal = {
		address,
		name: name ?? address,
		host: on,
		state: "running",
		turn: 0,
		pid: 900000 + terminalSeq,
		argv,
		cwd,
		env,
		labels,
		created_ms: Date.now(),
	};
	terminals.set(address, terminal);
	reply(id, {
		address,
		name: terminal.name,
		state: "running",
		turn: 0,
		cwd,
		argv,
		cols: 200,
		rows: 120,
		created_ms: terminal.created_ms,
		pid: terminal.pid,
		labels,
		keep: false,
		rm: false,
		die_with_parent: false,
		status: { state: "idle" },
		screen: "",
		identity: "",
	});
}

/** `t7`, a name, or `machine/t7`. A bare name NEVER matches a remote terminal. */
function resolveTerminal(reference) {
	if (typeof reference !== "string" || reference.length === 0) return undefined;
	const slash = reference.indexOf("/");
	if (slash > 0) {
		const host = reference.slice(0, slash);
		const rest = reference.slice(slash + 1);
		for (const terminal of terminals.values()) {
			if (terminal.host !== host) continue;
			if (terminal.address.slice(host.length + 1) === rest || terminal.name === rest) return terminal;
		}
		return undefined;
	}
	for (const terminal of terminals.values()) {
		if (terminal.host !== undefined) continue;
		if (terminal.address === reference || terminal.name === reference) return terminal;
	}
	return undefined;
}

function terminalGet(id, params) {
	const terminal = resolveTerminal(params.terminal);
	if (!terminal) {
		fail(id, "not_found", `no such terminal: ${String(params.terminal)}`);
		return;
	}
	reply(id, {
		address: terminal.address,
		name: terminal.name,
		state: terminal.state,
		turn: terminal.turn,
		cwd: terminal.cwd,
		argv: terminal.argv,
		labels: terminal.labels,
		cols: 200,
		rows: 120,
		created_ms: terminal.created_ms,
		keep: false,
		rm: false,
		die_with_parent: false,
		...(terminal.state === "finished" ? { exit_code: 0, finished_ms: Date.now() } : {}),
		status: { state: terminal.state === "running" ? "idle" : "finished" },
		screen: "",
	});
}

function withTerminal(id, params, fn) {
	const terminal = resolveTerminal(params.terminal);
	if (!terminal) {
		fail(id, "not_found", `no such terminal: ${String(params.terminal)}`);
		return;
	}
	fn(terminal);
}

// ── machine.list ────────────────────────────────────────────────────────────

/**
 * `machine.list` — the ADMISSION registry of a v1.1 launch.
 *
 * Deliberately richer than the real core has to be: `FAKE_HC_MACHINE_LIST` can
 * say "this core knows nothing" (`empty`) or "this core cannot answer"
 * (`unsupported`), which are the two failure modes legion must tell apart from
 * "the machine is registered but the launch is misconfigured".
 */
function machineList(id) {
	const override = (process.env.FAKE_HC_MACHINE_LIST ?? "").trim();
	if (override === "unsupported") {
		fail(id, "method_not_found", "unknown method: machine.list");
		return;
	}
	let names = MACHINES;
	if (override === "empty" || override === "none") names = [];
	else if (override.length > 0) {
		names = override.split(",").map((name) => name.trim()).filter(Boolean);
	}
	reply(id, {
		machines: names.map((name) => ({ name, kind: "ssh", address: `ssh://${name}` })),
	});
}

// ── machine.exec ────────────────────────────────────────────────────────────

function machineExec(id, params) {
	const on = typeof params.on === "string" && params.on.trim().length > 0 ? params.on.trim() : undefined;
	if (on && !MACHINES.includes(on)) {
		fail(id, "machine_unknown", `unknown machine: ${on}`, { machine: on });
		return;
	}
	const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : on ? REMOTE_ROOT : process.cwd();
	if (on) {
		const problem = remotePathProblem(cwd, REMOTE_ROOT);
		if (problem) {
			fail(id, "bad_cwd", `host '${on}': cwd '${cwd}' is ${problem}`, { cwd });
			return;
		}
	}
	// The real core caps `timeout` at 600s; report the clamp rather than silently
	// honoring a bigger number.
	let seconds = typeof params.timeout === "number" && params.timeout > 0 ? params.timeout : 60;
	let clamped = false;
	if (seconds > MAX_EXEC_TIMEOUT_S) {
		seconds = MAX_EXEC_TIMEOUT_S;
		clamped = true;
	}
	const argv = Array.isArray(params.argv) ? params.argv.map(String) : undefined;
	const line = typeof params.line === "string" ? params.line : undefined;
	const input = typeof params.input === "string" ? Buffer.from(params.input, "base64") : undefined;
	const env = { ...process.env, ...(params.env && typeof params.env === "object" ? params.env : {}) };
	// The "other machine" has its own PATH/HOME. Both are only set when a test
	// asks for them, so every existing fixture keeps running with the parent's.
	if (on && REMOTE_PATH.length > 0) env.PATH = REMOTE_PATH;
	if (on && REMOTE_HOME.length > 0) env.HOME = REMOTE_HOME;
	const started = Date.now();
	const run = line !== undefined
		? spawnSync("sh", ["-c", line], {
			cwd,
			env,
			input,
			timeout: Math.ceil(seconds * 1000),
			maxBuffer: 16 * 1024 * 1024,
			encoding: "buffer",
		})
		: spawnSync(argv?.[0] ?? "true", argv?.slice(1) ?? [], {
			cwd,
			env,
			input,
			timeout: Math.ceil(seconds * 1000),
			maxBuffer: 16 * 1024 * 1024,
			encoding: "buffer",
		});
	const timedOut = run.error?.code === "ETIMEDOUT" || run.signal === "SIGTERM";
	const stdout = Buffer.isBuffer(run.stdout) ? run.stdout : Buffer.alloc(0);
	const stderr = Buffer.isBuffer(run.stderr) ? run.stderr : Buffer.alloc(0);
	const truncated = stdout.length > CAPTURE_BYTES;
	reply(id, {
		code: typeof run.status === "number" ? run.status : null,
		ms: Date.now() - started,
		signal: run.signal ?? null,
		stdout: stdout.subarray(0, CAPTURE_BYTES).toString("base64"),
		stderr: stderr.subarray(0, CAPTURE_BYTES).toString("base64"),
		truncated,
		timed_out: timedOut,
		...(clamped ? { timeout_clamped_to_s: MAX_EXEC_TIMEOUT_S } : {}),
	});
}

// ── file.read / file.write ──────────────────────────────────────────────────

function targetPath(params, on) {
	const raw = typeof params.path === "string" ? params.path : "";
	const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : on ? REMOTE_ROOT : LOCAL_ROOT;
	const resolved = path.isAbsolute(raw) ? raw : path.join(cwd, raw);
	return path.resolve(resolved);
}

function fileCommon(id, params, fn) {
	const on = typeof params.on === "string" && params.on.trim().length > 0 ? params.on.trim() : undefined;
	if (on && !MACHINES.includes(on)) {
		fail(id, "machine_unknown", `unknown machine: ${on}`, { machine: on });
		return;
	}
	const file = targetPath(params, on);
	if (on) {
		const problem = remotePathProblem(file, REMOTE_ROOT);
		if (problem) {
			fail(id, "bad_path", `host '${on}': path '${file}' is ${problem}`, { path: file });
			return;
		}
	}
	fn(file);
}

function fileRead(id, params) {
	fileCommon(id, params, (file) => {
		let stats;
		try {
			stats = fs.statSync(file);
		} catch {
			fail(id, "not_found", `no such file: ${file}`, { path: file });
			return;
		}
		if (!stats.isFile()) {
			fail(id, "not_found", `not a file: ${file}`, { path: file });
			return;
		}
		if (stats.size > MAX_FILE_BYTES) {
			fail(id, "too_large", `file is ${stats.size} bytes, over the ${MAX_FILE_BYTES} limit`, { path: file });
			return;
		}
		const text = fs.readFileSync(file, "utf8");
		const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
		const offset = typeof params.offset === "number" && params.offset > 0 ? Math.floor(params.offset) : 1;
		const limit = typeof params.limit === "number" && params.limit >= 0 ? Math.floor(params.limit) : undefined;
		const all = text.split("\n");
		if (text.endsWith("\n")) all.pop();
		const first = Math.min(offset, all.length + 1);
		const last = limit === undefined ? all.length : Math.min(all.length, first + limit - 1);
		const slice = last < first ? [] : all.slice(first - 1, last);
		reply(id, {
			text: slice.length === 0 ? "" : `${slice.join("\n")}\n`,
			first,
			last,
			lines,
		});
	});
}

function fileWrite(id, params) {
	fileCommon(id, params, (file) => {
		const data = typeof params.data === "string" ? params.data : "";
		const buffer = Buffer.from(data, "base64");
		if (buffer.length > MAX_FILE_BYTES) {
			fail(id, "too_large", `refusing to write ${buffer.length} bytes: over the ${MAX_FILE_BYTES} limit`, { path: file });
			return;
		}
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, buffer);
		} catch (error) {
			fail(id, "write_failed", `cannot write ${file}: ${error?.message ?? error}`, { path: file });
			return;
		}
		reply(id, { path: file, bytes: buffer.length });
	});
}

// ── dispatch ────────────────────────────────────────────────────────────────

function handle(request) {
	const { id, method, params } = request;
	const p = params && typeof params === "object" ? params : {};
	switch (method) {
		case "hello":
			reply(id, {
				generation: 1,
				version: "fake-hc-0",
				core: { id: "fake", name: "fake", machine_id: "fake" },
				framed: false,
				methods: ["hello", "terminal.run", "terminal.get", "terminal.send", "terminal.wait",
					"terminal.interrupt", "terminal.kill", "terminal.rm", "machine.exec",
					"machine.list", "file.read", "file.write"],
				features: [],
				keeps_running_after_logout: null,
				logout_linger_user: null,
				login_session: null,
			});
			return;
		case "terminal.run":
			terminalRun(id, p);
			return;
		case "terminal.get":
			terminalGet(id, p);
			return;
		case "terminal.send":
			withTerminal(id, p, (terminal) => {
				if (terminal.state !== "running") {
					fail(id, "finished", `terminal finished: ${terminal.address}`);
					return;
				}
				terminal.turn += 1;
				reply(id, { turn: terminal.turn, started: true });
			});
			return;
		case "terminal.wait":
			withTerminal(id, p, (terminal) => {
				reply(id, { address: terminal.address, state: terminal.state, turn: terminal.turn, timed_out: false });
			});
			return;
		case "terminal.interrupt":
			withTerminal(id, p, (terminal) => {
				reply(id, { key: "esc", outcome: "stopped" });
			});
			return;
		case "terminal.kill":
			withTerminal(id, p, (terminal) => {
				terminal.state = "finished";
				reply(id, { address: terminal.address, state: "finished" });
			});
			return;
		case "terminal.rm":
			withTerminal(id, p, (terminal) => {
				terminals.delete(terminal.address);
				reply(id, { removed: terminal.address });
			});
			return;
		case "machine.list":
			machineList(id);
			return;
		case "machine.exec":
			machineExec(id, p);
			return;
		case "file.read":
			fileRead(id, p);
			return;
		case "file.write":
			fileWrite(id, p);
			return;
		default:
			rpcError(id, -32601, `method not found: ${method}`);
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline === -1) break;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (!line.startsWith("{")) continue;
		let request;
		try {
			request = JSON.parse(line);
		} catch {
			continue;
		}
		note(request);
		if (typeof request?.id !== "number") continue;
		try {
			handle(request);
		} catch (error) {
			rpcError(request.id, -32603, `fake core failed: ${error?.message ?? error}`);
		}
	}
});
process.stdin.on("end", () => process.exit(0));
