/**
 * #441-A: the run-record answer to "is this child's run over?".
 *
 * `run.json` is written by the process that actually RAN the child, so it retires
 * the child (`state: "retired"`) the moment that happens; the ledger row only moves
 * when the parent collects. The measured ghost (#441) was announced 1h 23m after
 * that retire, while its row still looked live — so the record is the earlier, and
 * the only available, answer.
 *
 * One read per postman pass (`readRun` once, then N `find`s), never per child: an
 * in-place `run.json` rewrite is only visible on a fresh read, and a child can retire
 * between two 2 s ticks. A missing/corrupt record contributes NOTHING (absence is not
 * evidence); the caller keeps its ledger-only answer.
 */

import * as path from "node:path";

import type { LegionNode } from "../legion/nodes.ts";
import type { StallRunFacts } from "../legion/stall-candidates.ts";
import { RunStore } from "./store.ts";

/** The slice of a `run.json` read this module needs (structurally `RunRecord`). */
export interface ChildRunRecordLike {
	readonly name: string;
	readonly nodeId?: string;
	readonly state?: string;
	readonly execution?: { readonly status?: string };
}

/** Injected for tests; production reads the store. */
export type ChildRecordReader = (runId: string) => { readonly children: readonly ChildRunRecordLike[] } | null;

/**
 * Build the postman's `childRunStates` reader for ONE run.
 *
 * Keyed by `nodeId` (the record's own identity, `ChildRecord.nodeId`) with a NAME
 * fallback for records written before that field existed. A missing run, a corrupt
 * record, or an orphaned name simply contributes nothing — absence is not evidence,
 * and the postman must fall back to the ledger rather than guess.
 */
export function createChildRunStateReader(input: {
	storeRootDir: string;
	runId: string;
	readRun?: ChildRecordReader;
}): (children: readonly Pick<LegionNode, "id" | "name">[]) => ReadonlyMap<string, StallRunFacts> {
	const store = new RunStore({ rootDir: input.storeRootDir });
	const readRun: ChildRecordReader = input.readRun ?? ((runId) => store.readRun(runId));
	return (children) => {
		const states = new Map<string, StallRunFacts>();
		if (children.length === 0) return states;
		let run: { readonly children: readonly ChildRunRecordLike[] } | null;
		try {
			run = readRun(input.runId);
		} catch {
			return states;
		}
		if (!run) return states;
		for (const child of children) {
			const record = run.children.find((candidate) => candidate.nodeId === child.id)
				?? run.children.find((candidate) => candidate.name === child.name);
			if (!record) continue;
			const facts: { state?: string; executionStatus?: string } = {};
			if (typeof record.state === "string") facts.state = record.state;
			if (typeof record.execution?.status === "string") facts.executionStatus = record.execution.status;
			states.set(child.id, facts);
		}
		return states;
	};
}

