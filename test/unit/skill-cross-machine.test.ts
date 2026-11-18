/**
 * The skill is the FIRST thing an agent reads each turn, so it is part of the
 * cross-machine surface: a session that never learns the capability exists goes
 * looking for it in the source (the 103-line session did exactly that, and the
 * 6.2.0 skill had zero mentions of `host`).
 *
 * These assertions are the contract for that sentence set: delete the
 * `## Cross-machine dispatch` section (or the description clause) and this file
 * turns red. The packaging assertions keep it SHIPPED, not just present in the
 * working tree — a skill the tarball omits never reaches a user's agent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL_PATH = "skills/pi-legion/SKILL.md";

function skillText(): string {
	return readFileSync(path.join(REPO_ROOT, SKILL_PATH), "utf8");
}

/** The YAML frontmatter, without the `---` fences. */
function frontmatter(text: string): string {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
	assert.ok(match, "precondition: SKILL.md has a frontmatter block");
	return match[1]!;
}

test("skill: the description advertises cross-machine dispatch (host + cwd)", () => {
	const description = frontmatter(skillText());
	assert.match(description, /cross-machine/i, "an agent scanning descriptions must see the capability");
	// The two inputs, in the same clause: a description that only says
	// "cross-machine" leaves the reader to discover `host`/`cwd` elsewhere.
	const clause = description.split(/[.;]/).find((part) => /cross-machine/i.test(part)) ?? "";
	assert.match(clause, /\bhost\b/, `the cross-machine clause names the host field: ${clause}`);
	assert.match(clause, /\bcwd\b/, `the cross-machine clause names the directory field: ${clause}`);
});

test("skill: the body teaches the minimal call, the one required input, and the ask-don't-probe rule", () => {
	const text = skillText();
	assert.match(text, /^## Cross-machine dispatch$/m, "a first-class section, not a footnote");
	const section = text.slice(text.indexOf("## Cross-machine dispatch"), text.indexOf("## Legion visualization"));
	// A call an agent can copy as-is.
	assert.match(section, /subagent\(\{ agent: "[a-z]+", host: "[^"]+", cwd: "[^"]+", task: "/, "a pasteable launch with host and cwd");
	// The one required input, and where it comes from.
	assert.match(section, /ONE new required input/, "says which field is new");
	assert.match(section, /ask the user/i, "says whose answer the directory is when the conversation has not named one");
	assert.match(section, /Never `ssh` or run `hc exec`/, "forbids probing the remote filesystem for a directory");
	// The two entry points a reader needs next.
	assert.match(section, /\/legion doctor crossmachine/, "points at the checkup");
	assert.match(section, /docs\/runbooks\/cross-machine-centurion-demo\.md/, "points at the runbook");
	// And how a failed remote child answers now.
	assert.match(section, /Command \(run on '<host>' to reproduce\)/, "the reproducible command the failure carries");
});

test("skill: the shipped tarball contains it (the manifest globs actually cover the file)", () => {
	const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { files?: unknown };
	assert.ok(Array.isArray(manifest.files), "package.json must declare a files allowlist");
	const files = manifest.files as string[];
	assert.ok(
		files.some((entry) => entry === "skills" || entry.startsWith("skills/")),
		`the files allowlist must ship skills/: ${files.join(", ")}`,
	);
});

test("skill: npm pack --dry-run really lists SKILL.md", () => {
	// --dry-run writes nothing; --json gives the file list. `prepublishOnly` is not
	// run by pack, so this stays a packaging check, not a second test run.
	const packed = execFileSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 120_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [entry] = JSON.parse(packed) as Array<{ files?: Array<{ path?: string }> }>;
	assert.ok(entry?.files, "npm pack --json must report the file list");
	const paths = entry.files.map((file) => file.path ?? "");
	assert.ok(paths.includes(SKILL_PATH), `tarball must contain ${SKILL_PATH}, got ${paths.filter((p) => p.startsWith("skills")).join(", ") || "no skills at all"}`);
	assert.ok(
		paths.some((file) => file.startsWith("skills/pi-legion/") && file.endsWith(".md")),
		"at least one skill document travels with the package",
	);
});
