/**
 * #193 — Headless child contract docs must keep the locked key phrases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const doc = readFileSync(path.join(root, "docs/headless-child-contract.md"), "utf8");
const readme = readFileSync(path.join(root, "README.md"), "utf8");

test("#193 docs: Headless child contract key phrases", () => {
	assert.match(doc, /rpc only/i);
	assert.match(doc, /no\*?\*? interactive tool-approval UI/i);
	assert.match(doc, /\/trust/);
	assert.match(doc, /defaultProjectTrust=always/);
	assert.match(doc, /onBlocked/);
	assert.match(doc, /not\*?\*? a replacement/i);
	assert.match(doc, /subagents\.rpc\.approve/);
	assert.match(doc, /agent_settled/);
	assert.match(doc, /abnormal:true/);
	assert.match(readme, /Headless child contract/);
	assert.match(readme, /docs\/headless-child-contract\.md/);
});
