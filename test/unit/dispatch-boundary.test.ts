/**
 * `dispatch-boundary-v1` D4 — the package's own headline examples must not teach a
 * call that D1 now refuses.
 *
 * Once `subagent` rejects a `utility: true` target, a doc that still says
 * `subagent({ agent: "scout", … })` is teaching the model a call that fails every
 * time — playbook #303 ("documented path is a dead end") as a shipped artifact.
 * `README.md` and `skills/pi-legion/SKILL.md` are the two that carry the headline
 * examples (the skill travels in the tarball and lands in the system prompt), so
 * they are pinned here: the forbidden SHAPE is refused, and the replacement call is
 * required to still be present, so deleting the recon guidance cannot pass either.
 *
 * The scan is a line window rather than one flat regex: a call may be written on one
 * line or spread over the next few (`subagent({\n  agent: "scout",`), and both forms
 * are the same mistake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Every document held to the D4 rule. `docs/design.md` §9.3 states the boundary too. */
const DOCS = ["README.md", "skills/pi-legion/SKILL.md", "docs/design.md"] as const;

/** The two documents that must ALSO keep the replacement call (they teach the shapes). */
const DOCS_WITH_EXAMPLES = ["README.md", "skills/pi-legion/SKILL.md"] as const;

const OPEN_CALL = /subagent\s*\(/i;
const UTILITY_TARGET = /agent\s*:\s*["'`]scout["'`]/i;
/** Upper bound on how many extra lines one multi-line call may span. */
const WINDOW = 6;

/** Bracket depth of a snippet: `(` / `{` / `[` open, their closers return it. */
function depthOf(text: string): number {
	let depth = 0;
	for (const char of text) {
		if (char === "(" || char === "{" || char === "[") depth += 1;
		else if (char === ")" || char === "}" || char === "]") depth -= 1;
	}
	return depth;
}

/**
 * `file:line` of every `subagent(… agent: "scout" …)` shape, or an empty list.
 *
 * One call is one unit: the snippet starts at the `subagent(` opener and grows only
 * while its brackets are still open, so a `vexillatio(... agent: "scout")` written on
 * the NEXT line (the correct shape, in every doc that shows both) is never counted
 * against the `subagent` line above it.
 */
function doomedScoutDispatches(text: string): string[] {
	const lines = text.split("\n");
	const hits: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const opener = lines[index] ?? "";
		if (!OPEN_CALL.test(opener)) continue;
		let snippet = opener;
		for (let next = index + 1; depthOf(snippet) > 0 && next < lines.length && next <= index + WINDOW; next += 1) {
			snippet += `\n${lines[next] ?? ""}`;
		}
		if (UTILITY_TARGET.test(snippet)) hits.push(`line ${index + 1}`);
	}
	return hits;
}

for (const doc of DOCS) {
	test(`${doc} does not teach subagent({ agent: "scout" }) — subagent refuses it`, () => {
		const text = readFileSync(path.join(REPO_ROOT, doc), "utf8");
		assert.deepEqual(
			doomedScoutDispatches(text),
			[],
			`${doc} still teaches a subagent recon dispatch; read-only recon is \`vexillatio\`'s (dispatch-boundary-v1 D1/D4)`,
		);
	});
}

for (const doc of DOCS_WITH_EXAMPLES) {
	test(`${doc} teaches the vexillatio replacement call`, () => {
		const text = readFileSync(path.join(REPO_ROOT, doc), "utf8");
		// The positive control: dropping the recon guidance entirely is not a fix — the
		// reader has to be handed the call that REPLACES the refused one.
		assert.match(text, /vexillatio\(\{/, `${doc} must show a vexillatio(...) call an agent can copy`);
		assert.match(text, /vexillatio\([^)]*agent/, `${doc}'s vexillatio example names the recon role`);
	});
}

test("the D4 scan is not vacuous: it catches the retired shape, in both spellings", () => {
	assert.deepEqual(doomedScoutDispatches('subagent({ agent: "scout", task: "t" })'), ["line 1"]);
	assert.deepEqual(doomedScoutDispatches("subagent( {agent:'scout', task: 't'})"), ["line 1"]);
	assert.deepEqual(doomedScoutDispatches('subagent({\n\tagent: "scout",\n\ttask: "t",\n})'), ["line 1"]);
	// And it leaves the two legitimate shapes alone.
	assert.deepEqual(doomedScoutDispatches('subagent({ agent: "worker", task: "t" })'), []);
	assert.deepEqual(doomedScoutDispatches('vexillatio({ task: "t", agent: "scout" })'), []);
});
