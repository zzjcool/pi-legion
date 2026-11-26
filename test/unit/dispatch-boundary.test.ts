/**
 * `dispatch-boundary-v1` D4 — the package's own teaching surfaces must not show a call
 * that D1 now refuses.
 *
 * Once `subagent` rejects a `utility: true` target, a doc that still says
 * `subagent({ agent: "scout", … })` is teaching the model a call that fails every
 * time — playbook #303 ("documented path is a dead end") as a shipped artifact.
 *
 * Two classes of surface are pinned here:
 *
 * - D4's documents. `README.md` and `skills/pi-legion/SKILL.md` carry the headline
 *   examples (the skill travels in the tarball and lands in the system prompt);
 *   `examples/subagents-parent-context.md` is the `subagents.parentContext` convention
 *   file README recommends, i.e. it lands in a real session's prompt too; the two
 *   `docs/reports/*` files and the runbook ship inside the npm package (the
 *   `package.json` `files` allowlist covers all of `docs/`).
 * - D4-plus (appendix A): the RUNTIME nag in `src/extension/scout-guard.ts`, which is a
 *   teaching surface with no doc status at all — it fires mid-session and used to say
 *   "未派发 subagent … 拆 scout" (naming the wrong tool for the action it asks for).
 *
 * For every document the forbidden SHAPE is refused; for the two example docs the
 * replacement call is also required to still be present, so deleting the recon
 * guidance outright cannot pass either.
 *
 * The scan is a line window rather than one flat regex: a call may be written on one
 * line or spread over the next few (`subagent({\n  agent: "scout",`), and `docs/reports/
 * xm-harness.md` spells it without parentheses at all (`subagent{agent:"scout", …}`).
 * Both the paren-less opener and the 12-line spread are pinned by their own test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { scoutGuardReminder } from "../../src/extension/scout-guard.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Every document held to the D4 rule (appendix A extended the list past the three
 * original surfaces). `docs/design.md` §9.3 states the boundary itself.
 */
const DOCS = [
	"README.md",
	"skills/pi-legion/SKILL.md",
	"docs/design.md",
	"examples/subagents-parent-context.md",
	"docs/runbooks/cross-machine-live-e2e.md",
	"docs/reports/cross-machine-host-discovery.md",
	"docs/reports/xm-harness.md",
] as const;

/** The two documents that must ALSO keep the replacement call (they teach the shapes). */
const DOCS_WITH_EXAMPLES = ["README.md", "skills/pi-legion/SKILL.md"] as const;

/**
 * A `subagent` call opener: `subagent(`, `subagent (`, and — the loose spelling this
 * repo really uses — `subagent{`. The `(` is optional on purpose: requiring it let
 * `docs/reports/xm-harness.md`'s `subagent{agent:"scout", host:"remote"}` through.
 */
const OPEN_CALL = /subagent\s*\(?\s*\{/i;
const UTILITY_TARGET = /agent\s*:\s*["'`]scout["'`]/i;
/**
 * Upper bound on how many extra lines one multi-line call may span.
 *
 * 6 was too small: a reviewer's 12-line `subagent({ … })` (every field on its own line,
 * `agent: "scout"` at line 8) scanned GREEN. A real call cannot be longer than this
 * without being unreasonable; a scanner that misses a plausible hand-formatted example
 * is worse than useless.
 */
const WINDOW = 12;

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
	// Appendix A blind spot 1: the PAREN-LESS opener (`docs/reports/xm-harness.md`'s own
	// spelling) used to be invisible to a scanner that required `(`.
	assert.deepEqual(doomedScoutDispatches('subagent{agent:"scout", host:"remote"}'), ["line 1"]);
	// Appendix A blind spot 2: a 12-line call whose `agent:` sits on line 8.
	const spread = [
		"subagent({",
		'\tmodel: "m",',
		'\tpreset: "p",',
		"\tverify: [\"npm test\"],",
		"\tworktree: false,",
		'\thost: "vps",',
		'\thostCwd: "/srv/app",',
		'\tagent: "scout",',
		'\ttask: "t",',
		'\tname: "recon",',
		'\tcwd: ".",',
		"})",
	].join("\n");
	assert.deepEqual(doomedScoutDispatches(spread), ["line 1"], "a 12-line call must not scan green");
	// And it leaves the two legitimate shapes alone.
	assert.deepEqual(doomedScoutDispatches('subagent({ agent: "worker", task: "t" })'), []);
	assert.deepEqual(doomedScoutDispatches('vexillatio({ task: "t", agent: "scout" })'), []);
	assert.deepEqual(doomedScoutDispatches('subagent{agent:"centurion", host:"remote"}'), []);
});

test("the scout-guard nag points recon at vexillatio (runtime teaching surface)", () => {
	// Appendix A: the steer message is read mid-session, by a model that is about to
	// dispatch. "未派发 subagent … 拆 scout" names the tool D1 refuses; the copy has to
	// carry the one that works. Logic untouched — this is the reminder string only.
	const reminder = scoutGuardReminder(8);
	assert.match(reminder, /vexillatio/, `the nag must name the recon tool: ${reminder}`);
	assert.match(reminder, /scout/, `the nag must still name the role: ${reminder}`);
	assert.match(reminder, /8/, "the copy still carries the threshold");
	assert.doesNotMatch(
		reminder,
		/未派发 subagent/,
		`recon must not be described as a bare subagent dispatch: ${reminder}`,
	);
});

test("the parentContext convention file carries the four-part task card (D4-plus)", () => {
	// The shipped convention file is what README tells people to copy into
	// `subagents.parentContext`, i.e. into a real system prompt. A rewrite dropped the
	// "paste the settled facts and mark them confirmed" rule while keeping the rest, and
	// nothing failed: the model then re-derived every fact in a fresh child (measured —
	// three scouts re-running one probe). Pin the GUIDANCE, not just the call shape, so
	// deleting it cannot scan green.
	const file = readFileSync(path.join(REPO_ROOT, "examples/subagents-parent-context.md"), "utf8");
	assert.match(file, /已确认，禁止重新侦察/, "handed-over facts must be marked settled");
	assert.match(file, /你的专属取证面/, "a card must own its surface");
	assert.match(file, /以下命令归别人/, "a card must name the probes another child owns");
	assert.match(file, /纠错用 steer/, "a wrong conclusion is corrected, not re-dispatched");
	assert.match(file, /负面结论要举证/, "a negative claim must show its probe matrix");
	assert.match(file, /待验证/, "an unprobed negative claim degrades to pending");
});
