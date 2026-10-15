import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWaitTargets } from "../../index.ts";

test("resolveWaitTargets: all picks working and blocked children", () => {
	const result = resolveWaitTargets(
		{ all: true },
		[
			{ name: "a", state: "working" },
			{ name: "b", state: "blocked" },
			{ name: "c", state: "awaiting" },
			{ name: "d", state: "retired" },
		],
	);
	assert.deepEqual(result, { ok: true, names: ["a", "b"] });
});

test("resolveWaitTargets: all with nothing running is a loud miss", () => {
	const result = resolveWaitTargets({ all: true }, []);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.message, /no running children/);
});

test("resolveWaitTargets: a tracked name resolves alone", () => {
	const result = resolveWaitTargets(
		{ name: "worker-0" },
		[{ name: "worker-0", state: "working" }],
	);
	assert.deepEqual(result, { ok: true, names: ["worker-0"] });
});

test("resolveWaitTargets: an untracked name fails with the unknown-child wording", () => {
	const result = resolveWaitTargets(
		{ name: "ghost" },
		[{ name: "worker-0", state: "working" }],
	);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.match(result.message, /unknown child: ghost/);
		assert.match(result.message, /not a live child/);
	}
});

test("resolveWaitTargets: neither name nor all is rejected", () => {
	const result = resolveWaitTargets({}, [{ name: "a", state: "working" }]);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.match(result.message, /`name` or `all` is required for wait/);
		assert.match(result.message, /try all:true or name:"child-name"/);
	}
});
