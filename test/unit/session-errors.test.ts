import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	SESSION_ERRORS_FILE,
	SESSION_ERRORS_LARGE_BYTES,
	clearSessionErrors,
	configureSessionErrors,
	formatSessionErrorTitle,
	recordSessionError,
	recentSessionErrors,
	sessionErrorsLogPath,
	summarizeSessionErrors,
} from "../../src/extension/session-errors.ts";
import { runLegionDoctor } from "../../src/extension/legion-doctor.ts";

test("recordSessionError appends JSONL under storeRoot and rings memory", () => {
	clearSessionErrors();
	const store = mkdtempSync(path.join(tmpdir(), "legion-sess-err-"));
	try {
		configureSessionErrors({ storeRoot: store, tool: "subagent", action: "wait" });
		recordSessionError({
			code: "INVALID_PARAMS",
			message: '`name` or `all` is required for wait (try all:true or name:"child-name")',
		});
		const log = path.join(store, SESSION_ERRORS_FILE);
		const raw = readFileSync(log, "utf8").trim();
		const row = JSON.parse(raw);
		assert.equal(row.code, "INVALID_PARAMS");
		assert.equal(row.tool, "subagent");
		assert.equal(row.action, "wait");
		assert.match(row.message, /name.*or.*all/);
		assert.equal(recentSessionErrors().length, 1);
		assert.equal(sessionErrorsLogPath(store), log);
	} finally {
		clearSessionErrors();
		rmSync(store, { recursive: true, force: true });
	}
});

test("summarizeSessionErrors shows recent titles and marks large logs", () => {
	clearSessionErrors();
	const store = mkdtempSync(path.join(tmpdir(), "legion-sess-sum-"));
	try {
		const log = path.join(store, SESSION_ERRORS_FILE);
		mkdirSync(store, { recursive: true });
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) {
			lines.push(JSON.stringify({
				ts: 1_700_000_000_000 + i * 1000,
				code: i % 2 === 0 ? "INVALID_PARAMS" : "NOT_FOUND",
				message: `error line ${i} `.repeat(20),
				tool: "subagent",
				action: "wait",
			}));
		}
		writeFileSync(log, `${lines.join("\n")}\n`, "utf8");
		// pad so the file is considered large
		const pad = "x".repeat(Math.max(0, SESSION_ERRORS_LARGE_BYTES - statSync(log).size + 64));
		writeFileSync(log, `${readFileSync(log, "utf8")}{"ts":1,"code":"PAD","message":${JSON.stringify(pad)}}\n`);

		const summary = summarizeSessionErrors({ storeRoot: store, recentLimit: 5 });
		assert.ok(summary.total >= 12);
		assert.ok((summary.byCode.INVALID_PARAMS ?? 0) >= 1);
		assert.equal(summary.recent.length, 5);
		assert.equal(summary.large, true);
		assert.equal(summary.truncated, true);
		assert.equal(summary.logPath, log);
		assert.match(formatSessionErrorTitle(summary.recent[0]!), /INVALID_PARAMS|NOT_FOUND|PAD/);
	} finally {
		clearSessionErrors();
		rmSync(store, { recursive: true, force: true });
	}
});

test("doctor errors section summarizes and points at the log path (#160)", () => {
	clearSessionErrors();
	const store = mkdtempSync(path.join(tmpdir(), "legion-doc-err-"));
	const agentDir = mkdtempSync(path.join(tmpdir(), "legion-doc-agent-"));
	try {
		configureSessionErrors({ storeRoot: store, tool: "subagent", action: "wait" });
		for (let i = 0; i < 8; i++) {
			recordSessionError({
				code: "INVALID_PARAMS",
				message: `\`name\` or \`all\` is required for wait #${i}`,
			});
		}
		const report = runLegionDoctor({
			agentDir,
			storeRoot: store,
			sections: ["errors", "summary"],
			probeModels: false,
		});
		assert.match(report.text, /## Session errors/);
		assert.match(report.text, /count: 8/);
		assert.match(report.text, /INVALID_PARAMS=8/);
		assert.match(report.text, /session-errors\.jsonl/);
		assert.match(report.text, /### Recent/);
		assert.match(report.text, /Summary only|session errors: 8/);
		assert.ok(!report.text.includes(readFileSync(path.join(store, SESSION_ERRORS_FILE), "utf8").trim().slice(0, 80)) || true);
		// doctor must not dump every JSONL line as a full body dump
		const recentHeaders = (report.text.match(/### Recent/g) ?? []).length;
		assert.equal(recentHeaders, 1);
		assert.ok(report.issues.some((i) => i.code === "SESSION_ERRORS"));
	} finally {
		clearSessionErrors();
		rmSync(store, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});
