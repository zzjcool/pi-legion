#!/usr/bin/env node
// Switch ONE container's settings.json between the two cross-machine shapes the
// xm-harness asserts (contract v1.1 + the zero-config/product-gap ruling).
//
//   node settings-mode.mjs zero-config
//   node settings-mode.mjs host-entry remote /root/work
//
// Why a second settings script instead of `settings-merge.mjs`: merge can only ADD,
// but the zero-config run must be able to take a `hosts` entry BACK OUT (a previous
// `host-entry` run would otherwise poison it). Like the merge script, this one keeps
// the image's `packages` as a hard invariant — dropping them silently empties
// `pi --list-models` and turns a real assertion into an environment bug.
//
// Reads/writes `<settingsPath>` (default /root/.pi/agent/settings.json), atomically.
// Prints one line: XM_SETTINGS_MODE path=… mode=… host=… hosts=<yes|no> packages=<n>

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

const DEFAULT_PATH = "/root/.pi/agent/settings.json";

function fail(message) {
	process.stderr.write(`XM_SETTINGS_MODE_FAIL ${message}\n`);
	process.exit(1);
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const mode = process.argv[2] || "zero-config";
const host = process.argv[3] || "remote";
const hostCwd = process.argv[4] || "/root/work";
const settingsPath = process.env.XM_SETTINGS_PATH || DEFAULT_PATH;

if (mode !== "zero-config" && mode !== "host-entry") {
	fail(`unknown mode '${mode}' (zero-config | host-entry)`);
}
if (mode === "host-entry" && !hostCwd.startsWith("/")) {
	fail(`hostCwd must be absolute, got '${hostCwd}'`);
}

let settings = {};
let existed = false;
if (existsSync(settingsPath)) {
	existed = true;
	const raw = readFileSync(settingsPath, "utf8");
	if (raw.trim().length > 0) {
		try {
			settings = JSON.parse(raw);
		} catch (error) {
			fail(`${settingsPath} is not valid JSON :: ${error.message}`);
		}
	}
}
if (!isPlainObject(settings)) fail(`${settingsPath} must contain a JSON object`);
const packagesBefore = Array.isArray(settings.packages) ? [...settings.packages] : [];

const subagents = isPlainObject(settings.subagents) ? { ...settings.subagents } : {};
const crossMachine = isPlainObject(subagents.crossMachine) ? { ...subagents.crossMachine } : {};
crossMachine.enabled = true;

if (mode === "zero-config") {
	delete crossMachine.hosts;
} else {
	const hosts = isPlainObject(crossMachine.hosts) ? { ...crossMachine.hosts } : {};
	hosts[host] = { ...(isPlainObject(hosts[host]) ? hosts[host] : {}), cwd: hostCwd };
	crossMachine.hosts = hosts;
}

subagents.crossMachine = crossMachine;
settings.subagents = subagents;
settings.defaultProvider = "xm";
settings.defaultModel = "flash";

// Hard invariant, same as settings-merge.mjs: never drop a package registration.
const packagesAfter = Array.isArray(settings.packages) ? settings.packages : [];
for (const entry of packagesBefore) {
	if (!packagesAfter.includes(entry)) fail(`this edit would drop packages entry "${entry}"`);
}

const tmp = `${settingsPath}.tmp-${process.pid}`;
try {
	writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, {
		mode: existed ? statSync(settingsPath).mode & 0o777 : 0o644,
	});
	renameSync(tmp, settingsPath);
} catch (error) {
	fail(`cannot write ${settingsPath} :: ${error.message}`);
}

process.stdout.write(
	`XM_SETTINGS_MODE path=${settingsPath} mode=${mode} host=${host} hosts=${mode === "host-entry" ? "yes" : "no"} packages=${packagesAfter.length}\n`,
);
