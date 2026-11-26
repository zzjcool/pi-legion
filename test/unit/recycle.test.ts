import { test } from "node:test";
import assert from "node:assert/strict";
import {
	canUseCachedCollect,
	formatAlreadyRecycled,
} from "../../src/extension/recycle.ts";

// Retention test (tool-surface-ops-verbs-v2 D1): `formatAlreadyRecycled` lost its
// last caller when the `retire` action was deleted. It is kept because
// `src/api.ts` re-exports it as a published surface — so the copy stays pinned
// here rather than being dropped along with the action.
test("formatAlreadyRecycled is a no-op explanation, not a new close", () => {
	const text = formatAlreadyRecycled("worker-0", "/tmp/w.jsonl");
	assert.match(text, /Already retired worker-0/);
	// D1: backend-neutral noun — the copy must not claim an rpc backend.
	assert.match(text, /the child is already stopped/);
	assert.doesNotMatch(text, /RPC child/);
	assert.match(text, /Session kept for resume: \/tmp\/w\.jsonl/);
});

test("canUseCachedCollect is true after collect, not while the child is working", () => {
	assert.equal(canUseCachedCollect("working"), false);
	assert.equal(canUseCachedCollect("launching"), false);
	assert.equal(canUseCachedCollect("retired"), true);
	assert.equal(canUseCachedCollect("awaiting"), true);
	assert.equal(canUseCachedCollect("blocked"), true);
	assert.equal(canUseCachedCollect("exited"), true);
});
