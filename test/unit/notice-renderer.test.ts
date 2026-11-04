import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSubagentNotice } from "../../src/extension/notice-renderer.ts";
import { formatCompletionNotice } from "../../src/extension/notify.ts";
import type { CompletionDetails } from "../../src/extension/notify.ts";

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Parameters<typeof renderSubagentNotice>[2];

type NoticeMessage = Parameters<typeof renderSubagentNotice>[0];

function noticeMessage(input: Parameters<typeof formatCompletionNotice>[0]) {
	const notice = formatCompletionNotice(input);
	return {
		customType: "subagent-notify",
		content: notice.content,
		display: notice.display,
		details: notice.details,
	} as NoticeMessage;
}

const success = noticeMessage({
	name: "worker-0",
	agent: "worker",
	execution: { status: "success" },
	output: "done",
});

test("renderer: collapsed success is one compact row", () => {
	const component = renderSubagentNotice(success, {
		expanded: false,
		outputPad: 1,
		keyText: () => "",
		keyHint: () => "",
	}, identityTheme);
	assert.ok(component);
	const lines = component.render(120);
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /worker-0 \(worker\)/);
	assert.match(lines[0] ?? "", /✓/);
	assert.doesNotMatch(lines[0] ?? "", /done/);
});

test("renderer: collapsed success stays one row at hostile widths", () => {
	const component = renderSubagentNotice(success, {
		expanded: false,
		outputPad: 1,
		keyText: () => "",
		keyHint: () => "",
	}, identityTheme);
	assert.ok(component);
	for (const width of [80, 40, 10, 1, 0]) {
		const lines = component.render(width);
		assert.equal(lines.length, 1, `width=${width}`);
	}
});

test("renderer: hostile names render as one row without escapes", () => {
	const hostile = noticeMessage({
		name: "w\x1b[41mEVIL\x1b[0m\r\nnext",
		execution: { status: "success" },
		output: "ok",
	});
	const component = renderSubagentNotice(hostile, {
		expanded: false,
		outputPad: 1,
		keyText: () => "",
		keyHint: () => "",
	}, identityTheme);
	assert.ok(component);
	const lines = component.render(80);
	assert.equal(lines.length, 1);
	assert.equal((lines[0] ?? "").includes("\x1b"), false);
	assert.equal((lines[0] ?? "").includes("\n"), false);
	assert.match(lines[0] ?? "", /EVIL/);
});

test("renderer: expanded success falls back to the default Markdown block", () => {
	assert.equal(
		renderSubagentNotice(success, { expanded: true, outputPad: 1, keyText: () => "", keyHint: () => "" }, identityTheme),
		undefined,
	);
});

test("renderer: failures and stops always use the full default block", () => {
	for (const execution of [
		{ status: "failed", reason: "model error" },
		{ status: "aborted" },
	]) {
		const notice = noticeMessage({
			name: "reviewer-1",
			execution,
			output: "boom",
		});
		assert.equal(
			renderSubagentNotice(notice, { expanded: false, outputPad: 1, keyText: () => "", keyHint: () => "" }, identityTheme),
			undefined,
		);
	}
});

test("renderer: notices without details (old sessions) fall back", () => {
	const legacy = {
		customType: "subagent-notify",
		content: "Background task completed: **worker-0**",
		display: true,
	} as NoticeMessage;
	assert.equal(
		renderSubagentNotice(legacy, { expanded: false, outputPad: 1, keyText: () => "", keyHint: () => "" }, identityTheme),
		undefined,
	);
});

test("renderer: details round-trips through JSON and still collapses", () => {
	// Session reload hands the renderer details that went through
	// JSON.stringify; the shape must survive.
	const reloaded = JSON.parse(
		JSON.stringify(formatCompletionNotice({
			name: "worker-0",
			agent: "worker",
			execution: { status: "success" },
			output: "done",
		}).details),
	) as CompletionDetails;
	const component = renderSubagentNotice(
		{
			customType: "subagent-notify",
			content: "irrelevant",
			display: true,
			details: reloaded,
		} as NoticeMessage,
		{ expanded: false, outputPad: 1, keyText: () => "", keyHint: () => "" },
		identityTheme,
	);
	assert.ok(component);
	assert.equal(component.render(80).length, 1);
});
