/**
 * Master switch: `subagents.enabled` setting + `/legion on|off`.
 *
 * Covers parse/merge of the new key and the toggle command's pure surface
 * (parser + status renderer), plus the launch refusal semantics that live
 * behind them in index.ts (covered there by typecheck + the wiring below).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parseSubagentSettings,
	resolveSubagentSettings,
} from "../../src/agents/settings.ts";
import {
	parseToggleCommandArgs,
	renderToggleStatus,
} from "../../src/extension/slash.ts";

// ───────────────────────── settings: enabled ─────────────────────────

test("enabled: defaults to absent (treated as true by callers)", () => {
	assert.deepEqual(parseSubagentSettings({ subagents: {} }, "/s.json"), {});
	assert.equal(
		parseSubagentSettings({}, "/s.json").enabled,
		undefined,
	);
});

test("enabled: accepts booleans", () => {
	assert.deepEqual(
		parseSubagentSettings({ subagents: { enabled: false } }, "/s.json"),
		{ enabled: false },
	);
	assert.deepEqual(
		parseSubagentSettings({ subagents: { enabled: true } }, "/s.json"),
		{ enabled: true },
	);
});

test("enabled: rejects non-booleans with the file path", () => {
	assert.throws(
		() => parseSubagentSettings({ subagents: { enabled: "off" } }, "/s.json"),
		/invalid 'enabled'; expected a boolean/,
	);
	assert.throws(
		() => parseSubagentSettings({ subagents: { enabled: 0 } }, "/s.json"),
		/invalid 'enabled'; expected a boolean/,
	);
	assert.throws(
		() =>
			parseSubagentSettings(
				{ subagents: { enabled: 42, parentContext: 123 } },
				"/s.json",
			),
		/invalid 'enabled'; expected a boolean/,
	);
});

test("enabled: project wins over user", () => {
	const merged = resolveSubagentSettings(
		{ enabled: true },
		{ enabled: false },
	);
	assert.equal(merged.enabled, false);
	const flipped = resolveSubagentSettings(
		{ enabled: false },
		{ enabled: true },
	);
	assert.equal(flipped.enabled, true);
});

test("enabled: absent project key keeps the user's value", () => {
	const kept = resolveSubagentSettings({ enabled: false }, { team: "x" });
	assert.equal(kept.enabled, false);
});

// ───────────────────────── /legion on|off args ─────────────────────────

test("toggle: empty args show current state", () => {
	assert.deepEqual(parseToggleCommandArgs(""), {
		ok: true,
		value: { action: "show" },
	});
	assert.deepEqual(parseToggleCommandArgs("   "), {
		ok: true,
		value: { action: "show" },
	});
});

test("toggle: on/off parse", () => {
	for (const action of ["on", "off"] as const) {
		assert.deepEqual(parseToggleCommandArgs(action), {
			ok: true,
			value: { action },
		});
	}
});

test("toggle: rejects unknown or extra arguments", () => {
	assert.deepEqual(parseToggleCommandArgs("yes"), {
		ok: false,
		message: "Usage: /legion on|off",
	});
	assert.deepEqual(parseToggleCommandArgs("on off"), {
		ok: false,
		message: "Usage: /legion on|off",
	});
	assert.deepEqual(parseToggleCommandArgs("on on"), {
		ok: false,
		message: "Usage: /legion on|off",
	});
});

// ───────────────────────── toggle status rendering ─────────────────────────

test("toggle: status distinguishes session override from settings", () => {
	// Session override, disabled, with running children.
	assert.equal(
		renderToggleStatus({
			enabled: false,
			settingsEnabled: true,
			outcome: "flipped",
			running: 2,
		}),
		[
			"Subagents are disabled — session override (settings unchanged; /reload restores them).",
			"No new launches; the roster and the bash dispatch guard are off from the next turn. Existing children are untouched — status/collect/wait keep working.",
			"2 children still running; they finish and notify normally.",
		].join("\n"),
	);
	// Matches settings, enabled, no children.
	assert.equal(
		renderToggleStatus({
			enabled: true,
			settingsEnabled: true,
			outcome: "shown",
			running: 0,
		}),
		"Subagents are enabled — matches settings.",
	);
	// One child grammar.
	assert.match(
		renderToggleStatus({
			enabled: false,
			settingsEnabled: false,
			outcome: "already-off",
			running: 1,
		}),
		/1 child still running/,
	);
	// Idempotent flips say so.
	assert.match(
		renderToggleStatus({
			enabled: true,
			settingsEnabled: true,
			outcome: "already-on",
			running: 0,
		}),
		/Already enabled — nothing to do\./,
	);
});
