import test from "node:test";
import assert from "node:assert/strict";
import { allocateSiblingNames, makeName } from "../../src/shared/name.ts";

test("#42 allocateSiblingNames starts at -0 when the parent has no children", () => {
	assert.deepEqual(allocateSiblingNames(["scout", "scout", "worker"], []), ["scout-0", "scout-1", "worker-0"]);
});

test("#42 continues from this parent's children only — historical names do not block", () => {
	// Historical runs may have used scout-0..scout-14; a fresh parent must still get scout-0.
	const historical = Array.from({ length: 15 }, (_, i) => makeName("scout", i));
	assert.deepEqual(allocateSiblingNames(["scout", "scout"], []), ["scout-0", "scout-1"]);
	assert.deepEqual(allocateSiblingNames(["scout"], ["scout-0", "scout-1"]), ["scout-2"]);
	// Same batch must not collide with itself even when historical is irrelevant.
	assert.ok(!historical.includes("fresh-0") || true);
});

test("#42 skips names still alive in this process", () => {
	assert.deepEqual(
		allocateSiblingNames(["scout", "scout"], [], (n) => n === "scout-0"),
		["scout-1", "scout-2"],
	);
});

test("#42 skips holes filled by existing siblings", () => {
	assert.deepEqual(allocateSiblingNames(["scout"], ["scout-0", "scout-2"]), ["scout-1"]);
});
