import { test } from "node:test";
import assert from "node:assert/strict";
import { providerForModel } from "../../src/runs/provider-pin.ts";

const registry = (models: Array<{ provider: string; id: string }>) => ({ getAll: () => models });

test("providerForModel finds the unique owner of a bare id", () => {
	const reg = registry([{ provider: "any-endpoint", id: "workbuddy/hy4-preview-ioa" }]);
	assert.equal(providerForModel(reg, "workbuddy/hy4-preview-ioa"), "any-endpoint");
});

test("providerForModel prefers the provider named by the id prefix on collision", () => {
	const reg = registry([
		{ provider: "magpie", id: "workbuddy/hy4-preview-ioa" },
		{ provider: "any-endpoint", id: "workbuddy/hy4-preview-ioa" },
	]);
	assert.equal(providerForModel(reg, "any-endpoint/workbuddy/hy4-preview-ioa"), "any-endpoint");
});

test("providerForModel returns undefined on unresolvable input", () => {
	assert.equal(providerForModel(undefined, "workbuddy/x"), undefined);
	assert.equal(providerForModel(registry([]), "workbuddy/x"), undefined);
	assert.equal(providerForModel(registry([]), undefined), undefined);
	assert.equal(providerForModel(registry([]), "  "), undefined);
});

// #123 residual (D-R3.4): a model id may carry a `:thinking` suffix — the
// registry never stores it, so matching the raw string silently answered
// `undefined` and stopped pinning exactly on revived/replayed launches.
test("providerForModel strips a `:thinking` suffix before matching", () => {
	const reg = registry([{ provider: "any-endpoint", id: "workbuddy/hy4-preview-ioa" }]);
	assert.equal(providerForModel(reg, "workbuddy/hy4-preview-ioa:high"), "any-endpoint");
	assert.equal(providerForModel(reg, "any-endpoint/workbuddy/hy4-preview-ioa:max"), "any-endpoint");
});

test("providerForModel keeps refusing to guess on ambiguity, suffix or not", () => {
	const reg = registry([
		{ provider: "magpie", id: "workbuddy/hy4" },
		{ provider: "live", id: "workbuddy/hy4" },
	]);
	assert.equal(providerForModel(reg, "workbuddy/hy4"), undefined);
	assert.equal(providerForModel(reg, "workbuddy/hy4:high"), undefined);
});

test("providerForModel leaves a non-thinking `:variant` part of the id", () => {
	// `splitThinkingSuffix` strips only KNOWN levels, so this is not a suffix.
	const reg = registry([{ provider: "p", id: "a/b:variant" }]);
	assert.equal(providerForModel(reg, "a/b:variant"), "p");
});
