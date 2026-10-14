import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_CODEMODE } from "../../src/runs/args.ts";
import {
	ROLE_TOOL_EXTENSION_GATES,
	collectRoleToolExtensionIssues,
	roleToolGateNextSteps,
} from "../../src/runs/role-tool-gates.ts";

test("#97 ROLE_TOOL_EXTENSION_GATES covers lens + codemode with stable codes", () => {
	const codes = ROLE_TOOL_EXTENSION_GATES.map((g) => g.code);
	assert.deepEqual(codes, ["ROLE_MISSING_LENS", "ROLE_MISSING_CODEMODE"]);
});

test("#97 declare codemode without loading builtin → ROLE_MISSING_CODEMODE", () => {
	const issues = collectRoleToolExtensionIssues(
		{ name: "worker", tools: ["read", "bash", "codemode"] },
		["/tmp/child-guard.ts"],
		{ inheritsExtensions: false },
	);
	assert.equal(issues.length, 1);
	assert.equal(issues[0]!.code, "ROLE_MISSING_CODEMODE");
	assert.match(issues[0]!.message, /codemode/);
	assert.match(issues[0]!.message, /builtin:codemode/);
	assert.match(issues[0]!.fix, /builtin:codemode/);
	assert.equal(issues[0]!.section, "extensions");
	assert.deepEqual(roleToolGateNextSteps(issues), [
		ROLE_TOOL_EXTENSION_GATES.find((g) => g.code === "ROLE_MISSING_CODEMODE")!.nextStep,
	]);
});

test("#97 load builtin:codemode → ROLE_MISSING_CODEMODE gone", () => {
	const issues = collectRoleToolExtensionIssues(
		{ name: "worker", tools: ["codemode"] },
		[BUILTIN_CODEMODE, "/tmp/child-guard.ts"],
		{ inheritsExtensions: false },
	);
	assert.equal(issues.filter((i) => i.code === "ROLE_MISSING_CODEMODE").length, 0);
	assert.deepEqual(roleToolGateNextSteps(issues), []);
});

test("#97 lens tools without pi-lens → ROLE_MISSING_LENS", () => {
	const issues = collectRoleToolExtensionIssues(
		{ name: "scout", tools: ["read", "lens_diagnostics", "bash"] },
		["/tmp/child-guard.ts"],
		{ inheritsExtensions: false },
	);
	assert.ok(issues.some((i) => i.code === "ROLE_MISSING_LENS"));
	assert.equal(issues.some((i) => i.code === "ROLE_MISSING_CODEMODE"), false);
});

test("#97 inheritsExtensions skips all gates", () => {
	const issues = collectRoleToolExtensionIssues(
		{ name: "scout", tools: ["codemode", "lens_diagnostics"] },
		[],
		{ inheritsExtensions: true },
	);
	assert.deepEqual(issues, []);
});

test("#97 table is extensible: unknown tools do not warn", () => {
	const issues = collectRoleToolExtensionIssues(
		{ name: "x", tools: ["read", "bash", "grep"] },
		[],
		{ inheritsExtensions: false },
	);
	assert.deepEqual(issues, []);
});
