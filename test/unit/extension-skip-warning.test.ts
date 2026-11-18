/**
 * D14 — inherited extensions are best-effort, the card's own are required.
 *
 * Two halves, both PURE (no `hc`, no `pi`, no spawn):
 *
 *   1. `mapRemoteArgv`'s skip policy: a pair is dropped only when the caller
 *      supplied `skippable` AND the value is not required; without `skippable`
 *      the v1.2 refusal is byte-for-byte unchanged (that is what keeps the six
 *      existing call sites and stops anyone from widening the default);
 *   2. `skippedExtensionWarning`, the ONE line the `subagent(...)` result
 *      carries: host, packages, pasteable install commands, ONE merged
 *      `excludeExtensions` JSON with the file it goes in, and the sentence that
 *      says a card-declared extension is still refused.
 *
 * A missing package index (`packages === undefined`) follows the same policy
 * with `reason: "no-index"` — a probe failure must not resurrect the dead stop.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { mapRemoteArgv, type HostPackageIndex, type SkippedExtension } from "../../src/runs/remote.ts";
import { skippedExtensionWarning } from "../../src/supervisor/terminal-supervisor.ts";
import { SubagentError } from "../../src/shared/types.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

/** A parent-side npm package, like the install tree `--extension` paths come from. */
function parentPackage(t: { after: (fn: () => void) => void }, name: string): { dir: string; entry: string } {
	const root = mkdtempSync(path.join(tmpdir(), "legion-skip-warning-"));
	const dir = path.join(root, "node_modules", name);
	const entry = path.join(dir, "extensions", "index.ts");
	mkdirSync(path.dirname(entry), { recursive: true });
	writeFileSync(entry, "export function registerProvider() {}\n");
	writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, pi: { extensions: ["./extensions/index.ts"] } }));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { dir, entry };
}

/** What the target reports for the package it DOES have. */
const TARGET_INDEX: HostPackageIndex = {
	packages: [{ name: "pi-other", dir: "/srv/pi/npm/node_modules/pi-other" }],
	entries: [
		{
			name: "pi-other",
			relative: "extensions/index.ts",
			path: "/srv/pi/npm/node_modules/pi-other/extensions/index.ts",
		},
	],
};

/** Argv-mapping options shared by the cases (one host, one mirror, no pathMap). */
const MAP_OPTS = {
	host: "hw-nj",
	remoteCwd: "/srv/app",
	remoteDir: "/srv/.mirror/run/child",
	localCwd: "/local/app",
	pathMap: [] as [],
};

// ── 1. the skip policy ─────────────────────────────────────────────────────

test("D14: a skippable missing extension loses BOTH argv elements, the rest of argv survives", (t) => {
	const missing = parentPackage(t, "pi-sysmon");
	const known = parentPackage(t, "pi-other");
	const skipped: SkippedExtension[] = [];
	const mapped = mapRemoteArgv(["--no-extensions", "-e", missing.entry, "-e", known.entry, "--model", "x"], {
		...MAP_OPTS,
		packages: TARGET_INDEX,
		skippable: () => true,
		skipped,
		role: "scout",
	});
	// The pair is GONE (no `-e` without a value) and the mappable one was re-rooted
	// by package name, exactly as it was before D14.
	assert.deepEqual(mapped, ["--no-extensions", "-e", "/srv/pi/npm/node_modules/pi-other/extensions/index.ts", "--model", "x"]);
	assert.deepEqual(skipped, [
		{ file: missing.entry, package: "pi-sysmon", reason: "not-installed", role: "scout" },
	]);
});

test("D14: the SAME call without `skippable` still REFUSES — the default is not widened", (t) => {
	const missing = parentPackage(t, "pi-sysmon");
	// This is the guard on the whole feature: every pre-D14 call site (resume, the
	// read-back paths, the six direct `mapRemoteArgv` callers) keeps "map or
	// refuse" until it explicitly says which values may be dropped.
	assert.throws(
		() => mapRemoteArgv(["-e", missing.entry], { ...MAP_OPTS, packages: TARGET_INDEX }),
		(error: unknown) => {
			assert.ok(error instanceof SubagentError);
			assert.match(error.message, /which is not installed on that machine/);
			return true;
		},
	);
});

test("D14: a missing package index is the same policy with reason `no-index` (no throw)", (t) => {
	const missing = parentPackage(t, "pi-sysmon");
	const skipped: SkippedExtension[] = [];
	// `packages: undefined` is what a probe that did not answer leaves behind. A
	// probe failure must degrade the launch, not resurrect the hard stop.
	const mapped = mapRemoteArgv(["-e", missing.entry, "--model", "x"], {
		...MAP_OPTS,
		skippable: () => true,
		skipped,
		role: "scout",
	});
	assert.deepEqual(mapped, ["--model", "x"]);
	assert.deepEqual(skipped, [{ file: missing.entry, package: "pi-sysmon", reason: "no-index", role: "scout" }]);
});

test("D14: only `-e`/`--extension` pairs are eligible — every other absolute path still refuses", () => {
	const skipped: SkippedExtension[] = [];
	// `skippable: () => true` is the most permissive policy a caller can hand in,
	// and `--skill` is still a hard refusal: D14 relaxed extensions, not the sweep.
	assert.throws(
		() => mapRemoteArgv(["--skill", "/opt/thirdparty/skill/SKILL.md"], {
			...MAP_OPTS,
			packages: TARGET_INDEX,
			skippable: () => true,
			skipped,
		}),
		(error: unknown) => {
			assert.ok(error instanceof SubagentError);
			assert.match(error.message, /neither in this checkout nor under a configured pathMap/);
			return true;
		},
	);
	assert.deepEqual(skipped, [], "a dropped `--skill` is not a skipped extension");
});

test("D14: a REQUIRED extension (skippable false) refuses even though the mapper could drop", (t) => {
	const missing = parentPackage(t, "pi-sysmon");
	// The backend's `skippable` is `!required.has(...)`: this mirrors the card case.
	// `skipped` is always supplied by that caller — the two options travel together.
	const skipped: SkippedExtension[] = [];
	assert.throws(
		() => mapRemoteArgv(["-e", missing.entry], { ...MAP_OPTS, packages: TARGET_INDEX, skippable: () => false, skipped }),
		(error: unknown) => {
			assert.ok(error instanceof SubagentError);
			assert.match(error.message, /for role|excludeExtensions|not installed on that machine/);
			return true;
		},
	);
	assert.deepEqual(skipped, [], "a refusal is not a skip");
});

test("D14: `skippable` without `skipped` THROWS instead of dropping an extension silently", (t) => {
	const missing = parentPackage(t, "pi-sysmon");
	// The API footgun this closes: `skippable` permits a drop, `skipped` is where the
	// drop is RECORDED. A caller who supplies the first and forgets the second asked
	// for exactly the silent loss D14 removed — so it is a programmer error (plain
	// `Error`) at the call site, not a launch refusal a user would have to decode.
	assert.throws(
		() => mapRemoteArgv(["-e", missing.entry], { ...MAP_OPTS, packages: TARGET_INDEX, skippable: () => true }),
		(error: unknown) => {
			assert.ok(error instanceof Error, "a plain Error is enough");
			assert.ok(
				!(error instanceof SubagentError),
				"it must not look like a launch refusal (SubagentError is what the operator sees)",
			);
			assert.match(error.message, /skippable/);
			assert.match(error.message, /skipped/);
			return true;
		},
	);
	// The no-`skippable` path is byte-identical: `skipped` alone records nothing,
	// because nothing may be dropped, and the v1.2 refusal still stands.
	assert.deepEqual(mapRemoteArgv(["--model", "x"], { ...MAP_OPTS, packages: TARGET_INDEX, skipped: [] }), ["--model", "x"]);
	assert.throws(
		() => mapRemoteArgv(["-e", missing.entry], { ...MAP_OPTS, packages: TARGET_INDEX, skipped: [] }),
		(error: unknown) => {
			assert.ok(error instanceof SubagentError);
			assert.match(error.message, /which is not installed on that machine/);
			return true;
		},
	);
});

// ── 2. the ONE warning line ────────────────────────────────────────────────

/** `count` distinct skipped packages, all `reason`. */
function skippedPackages(count: number, reason: SkippedExtension["reason"], prefix = "pi-pkg"): SkippedExtension[] {
	return Array.from({ length: count }, (_, index) => ({
		file: `/Users/me/.pi/agent/npm/node_modules/${prefix}${index}/extensions/index.ts`,
		package: `${prefix}${index}`,
		reason,
		role: "centurion",
	}));
}

test("D14: nothing skipped → no warning at all (absent, not empty)", () => {
	assert.equal(skippedExtensionWarning({ host: "vps", role: "centurion", cwd: "/work/app", skipped: [] }), undefined);
});

test("D14: the warning is ONE line that names host, packages, installs, the merged JSON and its file", () => {
	const skipped: SkippedExtension[] = [
		{ file: "/me/pi-sysmon/src/index.ts", package: "pi-sysmon", reason: "not-installed", role: "centurion" },
		{ file: "/me/pi-lens/dist/index.ts", package: "pi-lens", reason: "entry-missing", role: "centurion" },
	];
	const line = skippedExtensionWarning({ host: "vps", role: "centurion", cwd: "/work/app", skipped });
	assert.ok(line, "a skip must produce a warning");
	// ONE line: `index.ts` renders it inline after `⚠ <name>: `.
	assert.doesNotMatch(line, /\n/, `the warning must not contain a newline: ${line}`);
	// The machine, so the reader knows what they are looking at.
	assert.match(line, /cross-machine on 'vps'/);
	// The two reasons are distinguishable: install it, or install a build that
	// declares the entry this machine uses (D13).
	assert.match(line, /pi-sysmon \(not installed on vps\)/);
	assert.match(line, /pi-lens \(installed on vps, but it does not declare the entry this machine uses\)/);
	// One pasteable install per package, then ONE merged settings JSON.
	assert.match(line, /Two ways out: 1\) install them there — hc exec --on vps -- pi install npm:pi-sysmon; hc exec --on vps -- pi install npm:pi-lens; 2\) keep them on this machine only for role 'centurion': subagents\.agentOverrides\.centurion\.excludeExtensions — /);
	const json = line.match(/\{"subagents":\{"agentOverrides":\{.*\}\}\}/)?.[0];
	assert.ok(json, `expected the merged settings JSON, got: ${line}`);
	assert.equal(json, '{"subagents":{"agentOverrides":{"centurion":{"excludeExtensions":["pi-sysmon","pi-lens"]}}}}');
	// Where the JSON goes: both real files, with the session dir made concrete.
	assert.match(line, /~\/\.pi\/agent\/settings\.json \(user\) or \/work\/app\/\.pi\/settings\.json \(project\)/);
	// The boundary D14 draws, said out loud.
	assert.match(line, /The role's own extensions: are never skipped — an extension the role card declares, and this package's child guard, still refuse the launch when it is missing on vps\.$/);
});

test("D14: the warning is bounded — 8 names + `and N more`, 5 installs, one JSON", () => {
	const line = skippedExtensionWarning({ host: "vps", role: "centurion", cwd: "/work/app", skipped: skippedPackages(10, "not-installed") });
	assert.ok(line);
	// The count is PACKAGES (the dedupe key), not argv entries: two entries of one
	// package are one package, and the noun says so.
	assert.match(line, /10 inherited package\(s\)/);
	// 8 named, the other 2 counted.
	for (let index = 0; index < 8; index++) assert.ok(line.includes(`pi-pkg${index} `), `missing pi-pkg${index}`);
	assert.doesNotMatch(line, /pi-pkg8 \(/, "the 9th package must not be listed by name");
	assert.match(line, /and 2 more/);
	// Never more than 5 commands — a 30-package machine must not print 30 of them.
	assert.equal(line.match(/pi install npm:/g)?.length, 5, line);
	// The JSON still carries every package: it is the fix, and it is ONE paste.
	const json = line.match(/\{"subagents":\{"agentOverrides":\{.*\}\}\}/)?.[0];
	assert.ok(json, `expected the merged settings JSON, got: ${line}`);
	const parsed = JSON.parse(json) as { subagents: { agentOverrides: Record<string, { excludeExtensions: string[] }> } };
	assert.deepEqual(parsed.subagents.agentOverrides.centurion?.excludeExtensions, skippedPackages(10, "not-installed").map((entry) => entry.package));
});

test("D14: two skipped ENTRIES of one package are reported as ONE package", () => {
	// `mapRemoteArgv` reports every dropped value, so one package with two loadable
	// entries arrives twice. The warning dedupes by package name; before this the
	// count said "2 inherited extension(s)" over one package name — a number the
	// reader cannot match to anything on disk.
	const line = skippedExtensionWarning({
		host: "vps",
		role: "centurion",
		cwd: "/work/app",
		skipped: [
			{ file: "/me/pi-lens/index.ts", package: "pi-lens", reason: "not-installed", role: "centurion" },
			{ file: "/me/pi-lens/dist/index.js", package: "pi-lens", reason: "not-installed", role: "centurion" },
		],
	});
	assert.ok(line);
	assert.match(line, /1 inherited package\(s\) cannot be loaded there/);
	assert.equal(line.match(/pi-lens \(not installed on vps\)/g)?.length, 1, `the package must be named once: ${line}`);
});

test("D14: a skip with NO package index says so instead of inventing an install", () => {
	const line = skippedExtensionWarning({
		host: "vps",
		role: "scout",
		cwd: "/work/app",
		skipped: [{ file: "/me/pi-sysmon/src/index.ts", package: "pi-sysmon", reason: "no-index", role: "scout" }],
	});
	assert.ok(line);
	assert.match(line, /pi-sysmon could not be checked at all — the installed-package probe on vps did not answer/);
	// No package is claimed to be missing ⇒ no `pi install` that could be wrong.
	assert.doesNotMatch(line, /pi install npm:/, "an unread package list must not produce an install command");
});

test("D14: an extension that is in no npm package is named, not silently counted", () => {
	const line = skippedExtensionWarning({
		host: "vps",
		role: "scout",
		cwd: "/work/app",
		skipped: [{ file: "/opt/thirdparty/pi-thing.js", reason: "no-package", role: "scout" }],
	});
	assert.ok(line);
	assert.match(line, /pi-thing\.js is not inside an npm package this machine can name/);
	assert.match(line, /The role's own extensions: are never skipped/);
});
