/**
 * Auto-attach a focused `/legion doctor` snippet to gated spawn failures so the
 * MAIN model can self-fix without waiting for a human to run `/legion doctor`.
 *
 * Only fires for: model missing, insufficient memory, extension load issues,
 * child exit before/around first reply, nested-spawn policy failures.
 */

import { getAgentDir } from "../agents/paths.ts";
import {
	runLegionDoctor,
	expectedModelsFromSettings,
	type DoctorSection,
} from "./legion-doctor.ts";
import {
	looksLikeMissingModel,
	recordSpawnFailure,
	spawnFailureHint,
	type SpawnFailureRecord,
} from "./spawn-hints.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export type AutoDoctorKind = "model" | "memory" | "extension" | "spawn_exit" | "nested";

const SECTIONS: Record<AutoDoctorKind, readonly DoctorSection[]> = {
	model: ["models", "extensions", "next"],
	memory: ["memory", "next"],
	extension: ["extensions", "next"],
	spawn_exit: ["spawn", "models", "next"],
	nested: ["spawn", "tools", "next"],
};

/** Soft cap so tool results stay readable. */
export const AUTO_DOCTOR_MAX_CHARS = 2_800;

export function classifyFailure(input: {
	message: string;
	stderr?: string;
	code?: string;
}): AutoDoctorKind | undefined {
	const blob = `${input.code ?? ""}\n${input.message}\n${input.stderr ?? ""}`;
	if (input.code === "INSUFFICIENT_MEMORY" || /insufficient memory/i.test(blob)) return "memory";
	if (looksLikeMissingModel(input.stderr) || looksLikeMissingModel(input.message)) return "model";
	if (/ERR_MODULE_NOT_FOUND|Cannot find (module|package)|--no-extensions|extension.*(fail|error|missing)/i.test(blob)) {
		return "extension";
	}
	if (/PI_SUBAGENT_ALLOW_NESTED|nested (dispatch|spawn|subagent)|allowNested/i.test(blob)) return "nested";
	if (
		/exited during startup|exited after its first prompt|Agent process exited|Pi RPC process exited|START_FAILED/i.test(
			blob,
		)
	) {
		return "spawn_exit";
	}
	return undefined;
}

function readSettings(): unknown {
	try {
		return JSON.parse(fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Build a focused doctor report. Never probes `pi --list-models` here — spawn
 * paths must stay fast; the snippet still lists packages / env / next steps.
 */
export function buildAutoDoctorSnippet(kind: AutoDoctorKind, opts?: {
	cwd?: string;
	name?: string;
	spawnMode?: "rpc" | "inprocess";
}): string {
	const settings = readSettings();
	const report = runLegionDoctor({
		agentDir: getAgentDir(),
		cwd: opts?.cwd,
		storeRoot: opts?.cwd ? path.join(opts.cwd, ".pi-subagents") : undefined,
		probeModels: false,
		expectedModels: expectedModelsFromSettings(settings),
		sections: [...SECTIONS[kind]],
		spawnMode: opts?.spawnMode,
		// Failures already recorded by the caller; doctor will pick them up.
	});
	let body = report.text.trim();
	if (body.length > AUTO_DOCTOR_MAX_CHARS) {
		body = `${body.slice(0, AUTO_DOCTOR_MAX_CHARS)}\n… (truncated; run \`/legion doctor\` or \`subagent({ action: "diagnose" })\` for the full report)`;
	}
	return [
		`--- Legion auto-doctor (${kind}${opts?.name ? ` · ${opts.name}` : ""}) ---`,
		body,
		"--- end auto-doctor ---",
	].join("\n");
}

/**
 * Enrich a spawn / memory failure message with a short Hint (when applicable)
 * plus a focused auto-doctor snippet. Returns the original message unchanged
 * when the failure is not in the gated set.
 */
export function enrichFailureWithAutoDoctor(
	message: string,
	input: {
		stderr?: string;
		args?: readonly string[];
		name?: string;
		code?: string;
		cwd?: string;
		/** When false, skip recording into the recent-failure ring. Default true. */
		record?: boolean;
		/** Prefer inprocess hints when known (#212). */
		spawnMode?: "rpc" | "inprocess";
	} = {},
): string {
	const kind = classifyFailure({ message, stderr: input.stderr, code: input.code });
	// Infer rpc when argv shows --no-extensions and caller did not tag spawnMode (#212).
	const spawnMode =
		input.spawnMode ??
		(input.args?.includes("--no-extensions") ? "rpc" as const : undefined);
	if (input.record !== false) {
		recordSpawnFailure({
			name: input.name ?? "?",
			message,
			stderr: input.stderr,
			hadNoExtensions:
				spawnMode === "inprocess" ? false : input.args?.includes("--no-extensions"),
			spawnMode,
		});
	}
	if (!kind) return message;

	const parts = [message];
	const hint = spawnFailureHint({
		stderr: input.stderr ?? message,
		args: input.args,
		spawnMode,
	});
	if (hint) parts.push("", hint);

	try {
		parts.push("", buildAutoDoctorSnippet(kind, {
			cwd: input.cwd,
			name: input.name,
			spawnMode,
		}));
	} catch (error) {
		parts.push(
			"",
			`Auto-doctor failed (${error instanceof Error ? error.message : String(error)}). Run \`/legion doctor\` manually.`,
		);
	}
	return parts.join("\n");
}

/** Test helper: map kind → sections. */
export function sectionsForKind(kind: AutoDoctorKind): readonly DoctorSection[] {
	return SECTIONS[kind];
}

export type { SpawnFailureRecord };
