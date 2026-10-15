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
