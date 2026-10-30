import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createSessionRuntime,
	formatAliveQuiet,
	formatContextTokens,
	lastJsonlEventAgeMs,
	MAX_PENDING_AGE_MS,
	renderLiveChildStatus,
	shouldRecycleAfterCollect,
} from "../../src/extension/runtime.ts";
import { collectChild } from "../../index.ts";
import { SUBAGENT_NOTIFY_TYPE } from "../../src/extension/notify.ts";
import type { CollectSnapshot } from "../../src/extension/runtime.ts";
import { withTempDir } from "../helpers/tmp.ts";
import { assistantMsg, modelChange, sessionHeader, userMsg } from "../helpers/fixtures.ts";
import type { TreeNodeSnapshot } from "../../src/tui/tree-view.ts";
import type { StatusUi } from "../../src/tui/status.ts";
import { createLegionEventBus, type LegionEventBus } from "../../src/extension/event-bus.ts";

function snapshot(over: Partial<CollectSnapshot> = {}): CollectSnapshot {
	return {
		execution: { status: "success" },
		output: "ok",
		acceptance: { status: "attested", level: "attested" },
		...over,
	};
}

function statusTreeNode(
	id: string,
	parentId: string | null,
	name: string,
	depth: number,
	tokensTotal?: number,
): TreeNodeSnapshot {
	return {
		id,
		parentId,
		name,
		role: name === "root" ? "root" : "worker",
		kind: "pi",
		depth,
		runId: null,
		sessionFile: null,
		worktreePath: null,
		model: null,
		team: null,
		status: "running",
		phase: null,
		phaseSince: null,
		reworkCount: 0,
		contractPath: null,
		taskSummary: null,
		createdAt: 0,
		updatedAt: 0,
		...(tokensTotal ? { tokensTotal } : {}),
	};
}

async function waitFor(pred: () => boolean, label: string): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > 1_000) throw new Error(`timeout: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * Deterministic drain, NOT a sleep: when this returns, every continuation
 * queued by an already-resolved promise has run. Unlike `setTimeout(n)` this
 * carries a happens-before guarantee, so it cannot be "too short" on a slow
 * machine — which is what made the old `setTimeout(20)` guard fake-green.
 */
async function drainContinuations(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test("runtime: async watch notifies the parent once and drops the widget entry", async () => {
	const messages: unknown[] = [];
	const busy: unknown[] = [];
	let resolveCollect!: (value: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message, options) {
			messages.push({ message, options });
		},
		emitBusy(active, label) {
			busy.push({ active, label });
		},
		now: () => 1_000,
	});

	runtime.track({
		name: "worker-0",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
	});
	assert.equal(runtime.activeJobs().length, 1);
	assert.equal((busy.at(-1) as { active: boolean }).active, true);

	runtime.watch("worker-0");
	assert.equal(runtime.get("worker-0")?.watching, true);
	resolveCollect(snapshot());
	await waitFor(() => messages.length === 1, "completion notify");
	await waitFor(() => runtime.activeJobs().length === 0, "job released");
	const sent = messages[0] as {
		message: { customType: string; content: string; display: boolean };
		options: { triggerTurn: boolean; deliverAs: string };
	};
	assert.equal(sent.message.customType, SUBAGENT_NOTIFY_TYPE);
	// display: true — the transcript records every finish, not just failures.
	assert.equal(sent.message.display, true);
	assert.equal(sent.options.triggerTurn, true);
	assert.equal(sent.options.deliverAs, "followUp");
	assert.match(sent.message.content, /Background task completed: \*\*worker-0 \(worker\)\*\*/);
	assert.equal(runtime.activeJobs().length, 0);
	assert.equal((busy.at(-1) as { active: boolean }).active, false);
});

test("runtime: watch retires the RPC child after a terminal collect", async () => {
	const messages: unknown[] = [];
	let retired = 0;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
	});
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => snapshot(),
		retire: async () => {
			retired += 1;
		},
	});
	runtime.watch("w1");
	await waitFor(() => messages.length === 1, "completion notify");
	await waitFor(() => retired === 1, "auto-retire");
	assert.equal(retired, 1);
});

test("runtime: a blocked child is not recycled", async () => {
	let retired = 0;
	const runtime = createSessionRuntime({
		sendMessage() {},
	});
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => snapshot({ execution: { status: "blocked" } }),
		retire: async () => {
			retired += 1;
		},
	});
	runtime.watch("w1");
	await waitFor(() => runtime.activeJobs().length === 0, "job released");
	assert.equal(retired, 0);
});

test("runtime: an explicit collect suppresses the completion message", async () => {
	const messages: unknown[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
	});
	let collects = 0;
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => {
			collects += 1;
			return snapshot();
		},
	});
	runtime.watch("w1");
	const pending = runtime.consumeCollect("w1");
	assert.ok(pending);
	const collected = (await pending).snapshot;
	assert.equal(collected.execution.status, "success");
	await waitFor(() => runtime.activeJobs().length === 0, "watcher release");
	assert.equal(collects, 1, "tool collect and watcher must share one wait");
	assert.equal(messages.length, 0, "parent must not also get a notify");
});

test("runtime: collect failure still wakes the parent", async () => {
	const messages: unknown[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
	});
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => {
			throw new Error("pane gone");
		},
	});
	runtime.watch("w1");
	await waitFor(() => messages.length === 1, "failure notify");
	const sent = messages[0] as { content: string; display: boolean };
	assert.equal(sent.display, true);
	assert.match(sent.content, /pane gone/);
});

test("runtime: dispose clears jobs and busy overlay", () => {
	const busy: unknown[] = [];
	const runtime = createSessionRuntime({
		sendMessage() {},
		emitBusy(active, label) {
			busy.push({ active, label });
		},
	});
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => snapshot(),
	});
	runtime.dispose();
	assert.equal(runtime.activeJobs().length, 0);
	assert.equal((busy.at(-1) as { active: boolean }).active, false);
	runtime.watch("w1");
	assert.equal(runtime.activeJobs().length, 0);
});

test("runtime: collect after watch finished returns the cached snapshot", async () => {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => snapshot({ output: "cached-output" }),
	});
	runtime.watch("w1");
	await waitFor(() => runtime.activeJobs().length === 0, "watch finished");
	const pending = runtime.consumeCollect("w1");
	assert.ok(pending, "finished collect must stay cached after the widget drops");
	const collected = (await pending).snapshot;
	assert.equal(collected.output, "cached-output");
});

test("runtime: a blocked child asks the parent and does not recycle", async () => {
	let retired = 0;
	let handled = 0;
	const messages: unknown[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
	});
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () =>
			snapshot({
				execution: { status: "running", reason: "blocked: waiting for approval" },
				blocked: true,
			}),
		retire: async () => {
			retired += 1;
		},
		handleBlocked: async () => {
			handled += 1;
			return "hold";
		},
	});
	runtime.watch("w1");
	await waitFor(() => handled === 1, "blocked handler");
	assert.equal(retired, 0);
	assert.equal(messages.length, 0, "blocked is not a completion");
	assert.equal(runtime.get("w1")?.state, "blocked");
	assert.equal(runtime.activeJobs().length, 1, "blocked RPC child stays on the widget");
});

test("runtime: approving a blocked child rewatches instead of releasing", async () => {
	let collects = 0;
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => {
			collects += 1;
			if (collects === 1) {
				return snapshot({
					execution: { status: "running" },
					blocked: true,
				});
			}
			return snapshot();
		},
		handleBlocked: async () => "resume",
	});
	runtime.watch("w1");
	await waitFor(() => collects >= 2, "rewatch after approve");
	await waitFor(() => runtime.activeJobs().length === 0, "terminal release");
	assert.equal(collects, 2);
});

test("runtime: session jsonl fills model, turns, and in-flight tools", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = join(dir, "worker-0.jsonl");
		writeFileSync(
			sessionFile,
			[
				sessionHeader(),
				modelChange("cb/glm-5.3"),
				userMsg("go"),
				assistantMsg({
					stopReason: "toolUse",
					tools: ["bash"],
					model: "cb/glm-5.3",
				}),
			].join("\n"),
		);
		const rendered: string[] = [];
		const runtime = createSessionRuntime({
			sendMessage() {},
			now: () => 5_000,
		});
		runtime.bind({
			hasUI: true,
			ui: {
				theme: { fg: (_c, text) => text },
				setStatus() {},
				setWidget(_key, content) {
					if (typeof content === "function") {
						const component = content({ requestRender() {} }, {
							fg: (_c, text) => text,
						});
						rendered.splice(0, rendered.length, ...component.render());
					}
				},
			},
		});
		runtime.track({
			name: "worker-0",
			runId: "r-1",
			agent: "worker",
			sessionFile,
			timeoutMs: 1_000,
			kind: "pi",
			thinking: "medium",
			worktreeBranch: "pi-subagent/worker-0-abcd",
			collect: () => new Promise(() => {}),
		});
		assert.match(rendered.join("\n"), /cb\/glm-5\.3:medium/);
		assert.match(rendered.join("\n"), /turn 1/);
		assert.match(rendered.join("\n"), /bash/);
		assert.match(rendered.join("\n"), /wt worker-0-abcd/);
		runtime.dispose();
	});
});

test("shouldRecycleAfterCollect keeps running/blocked RPC children, recycles unknown", () => {
	assert.equal(shouldRecycleAfterCollect("running"), false);
	assert.equal(shouldRecycleAfterCollect("blocked"), false);
	assert.equal(shouldRecycleAfterCollect("unknown"), true);
	assert.equal(shouldRecycleAfterCollect("success"), true);
	assert.equal(shouldRecycleAfterCollect("aborted"), true);
});

// ───────────────────── smart join integration (T4/T5) ─────────────────────

type SentMessage = {
	customType: string;
	content: string;
	display: boolean;
};

function joinSnapshot(over: Partial<CollectSnapshot> = {}): CollectSnapshot {
	return {
		execution: { status: "success" },
		output: "ok",
		acceptance: { status: "accepted", level: "attested" },
		...over,
	};
}

test("runtime: same-run children batch into exactly one grouped notice", async () => {
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	for (const name of ["worker-0", "worker-1"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
		});
	}
	runtime.watch("worker-0");
	runtime.watch("worker-1");
	resolvers.get("worker-0")!(joinSnapshot({ output: "first done" }));
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(messages.length, 0, "first finisher waits for the group");
	resolvers.get("worker-1")!(joinSnapshot({ output: "second done" }));
	await waitFor(() => messages.length === 1, "grouped notify");
	const sent = messages[0]!;
	assert.match(sent.content, /Background tasks completed \(2\):/);
	assert.match(sent.content, /worker-0 \(worker\): completed — acceptance: accepted \(attested\)/);
	assert.match(sent.content, /worker-1 \(worker\): completed — acceptance: accepted \(attested\)/);
	assert.match(sent.content, /first done/);
	assert.match(sent.content, /second done/);
	// display:true since master f966088 (renderer collapses the row).
	assert.equal(sent.display, true);
	await waitFor(() => runtime.activeJobs().length === 0, "both released");
});

test("runtime: flush window expiry delivers a partial batch; the straggler flushes alone", async () => {
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.setJoinConfig({ mode: "smart", flushMs: 50 });
	for (const name of ["fast", "slow"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
		});
	}
	runtime.watch("fast");
	runtime.watch("slow");
	resolvers.get("fast")!(joinSnapshot({ output: "fast-out" }));
	await waitFor(() => messages.length === 1, "window flush");
	assert.match(messages[0]!.content, /Background tasks completed \(1 of 2\):/);
	assert.match(messages[0]!.content, /fast/);
	assert.match(messages[0]!.content, /Still running: slow/);
	resolvers.get("slow")!(joinSnapshot({ output: "slow-out" }));
	await waitFor(() => messages.length === 2, "straggler notify");
	assert.match(messages[1]!.content, /Background task completed: \*\*slow \(worker\)\*\*/);
	assert.match(messages[1]!.content, /slow-out/);
});

test("runtime: joinMode each sends one notice per child", async () => {
	const messages: SentMessage[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.setJoinConfig({ mode: "each", flushMs: 10_000 });
	for (const name of ["a", "b"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: async () => joinSnapshot(),
		});
	}
	runtime.watch("a");
	runtime.watch("b");
	await waitFor(() => messages.length === 2, "two individual notices");
	assert.match(messages[0]!.content, /Background task completed: \*\*a/);
	assert.match(messages[1]!.content, /Background task completed: \*\*b/);
});

test("runtime: a blocked sibling does not block the group's flush; resume rejoins it", async () => {
	const messages: SentMessage[] = [];
	let blockedCollects = 0;
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.setJoinConfig({ mode: "smart", flushMs: 50 });
	runtime.track({
		name: "ok-child",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/ok.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "ok-out" }),
	});
	runtime.track({
		name: "blocked-child",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/blocked.jsonl",
		timeoutMs: 1_000,
		collect: async () => {
			blockedCollects += 1;
			if (blockedCollects === 1) {
				return joinSnapshot({
					execution: { status: "running", reason: "blocked" },
					blocked: true,
				});
			}
			return joinSnapshot({ output: "blocked-later" });
		},
		handleBlocked: async () => "hold",
	});
	runtime.watch("ok-child");
	runtime.watch("blocked-child");
	await waitFor(() => blockedCollects === 1, "blocked collect");
	await waitFor(() => messages.length === 1, "group flush excludes blocked");
	assert.match(messages[0]!.content, /ok-child/);
	assert.doesNotMatch(messages[0]!.content, /blocked-child:/);

	// The approved child rewatches and rejoins the group bookkeeping.
	runtime.rewatch("blocked-child");
	await waitFor(() => messages.length === 2, "resumed child notifies alone");
	// The resumed child is its own settled group → legacy single shape, and
	// no stale "Still running: ok-child" row (it was retired at flush time).
	assert.match(messages[1]!.content, /Background task completed: \*\*blocked-child \(worker\)\*\*/);
	assert.doesNotMatch(messages[1]!.content, /Background tasks completed \(/);
	assert.doesNotMatch(messages[1]!.content, /Still running:/);
	assert.match(messages[1]!.content, /blocked-later/);
	assert.equal(resolvers.size, 0);
});

test("runtime: retire runs during the batch window, not after the flush", async () => {
	const messages: SentMessage[] = [];
	let retired = 0;
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.setJoinConfig({ mode: "smart", flushMs: 200 });
	for (const name of ["a", "b"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
			retire: async () => {
				retired += 1;
			},
		});
	}
	runtime.watch("a");
	runtime.watch("b");
	resolvers.get("a")!(joinSnapshot());
	await waitFor(() => retired === 1, "a recycled immediately");
	assert.equal(messages.length, 0, "notice still buffered, pane already gone");
	assert.equal(runtime.activeJobs().length, 1, "a released before the flush");
	resolvers.get("b")!(joinSnapshot());
	await waitFor(() => messages.length === 1, "grouped notify");
	await waitFor(() => retired === 2, "b recycled");
});

// ─────────────────────────── runtime.wait (T5) ───────────────────────────

test("runtime.wait: aggregates both children, retires RPC children, suppresses notify", async () => {
	const messages: SentMessage[] = [];
	let retired = 0;
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	for (const name of ["a", "b"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
			retire: async () => {
				retired += 1;
			},
		});
	}
	runtime.watch("a");
	runtime.watch("b");
	const pending = runtime.wait(["a", "b"], { timeoutMs: 5_000 });
	resolvers.get("a")!(joinSnapshot({ output: "A-done" }));
	resolvers.get("b")!(joinSnapshot({ output: "B-done" }));
	const results = await pending;
	assert.deepEqual(
		results.map((r) => ({ name: r.name, output: r.snapshot?.output })),
		[
			{ name: "a", output: "A-done" },
			{ name: "b", output: "B-done" },
		],
	);
	await waitFor(() => retired === 2, "both RPC children retired");
	assert.equal(runtime.activeJobs().length, 0, "both released");
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(messages.length, 0, "wait consumes the results; no notify");

	// The wait-consumed pair left no join bookkeeping behind: a new child on
	// the same runId starts a clean group and notifies as a settled single.
	runtime.track({
		name: "c",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/c.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "C-done" }),
	});
	runtime.watch("c");
	await waitFor(() => messages.length === 1, "clean group after wait");
	assert.match(messages[0]!.content, /Background task completed: \*\*c \(worker\)\*\*/);
	assert.doesNotMatch(messages[0]!.content, /Still running:/);
});

test("runtime.wait: the hit path itself releases the job (no watch finally to hide it)", async () => {
	// No watch(): only wait() holds a collect. Deleting waitOne's
	// release(name) must be visible here — nothing else would free the job.
	let retired = 0;
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "solo",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/solo.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "solo-done" }),
		retire: async () => {
			retired += 1;
		},
	});
	const results = await runtime.wait(["solo"], { timeoutMs: 5_000 });
	assert.equal(results[0]?.snapshot?.output, "solo-done");
	await waitFor(() => retired === 1, "RPC child retired by the wait hit");
	assert.equal(runtime.activeJobs().length, 0, "released by the wait hit");
	runtime.dispose();
});

test("runtime.wait: timeout yields stillRunning, resets consumedByTool, auto-notify lands", async () => {
	const messages: SentMessage[] = [];
	let resolveCollect!: (s: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.track({
		name: "slow",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/slow.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
	});
	runtime.watch("slow");
	const results = await runtime.wait(["slow"], { timeoutMs: 50 });
	assert.equal(results.length, 1);
	assert.equal(results[0]?.name, "slow");
	assert.equal(results[0]?.stillRunning, true);
	assert.equal(results[0]?.timedOut, true, "timeout path sets timedOut for #179");
	assert.ok(typeof results[0]?.elapsedMs === "number");
	assert.equal(runtime.get("slow")?.consumedByTool, false, "timeout resets the flag");
	// The in-flight watch completes later and the notice is delivered as usual.
	resolveCollect(joinSnapshot({ output: "finally" }));
	await waitFor(() => messages.length === 1, "auto-notify after timeout");
	assert.match(messages[0]!.content, /Background task completed: \*\*slow/);
});

test("runtime.wait: parent abort interrupts promptly, clears its timer, and restores notifications", async () => {
	const messages: SentMessage[] = [];
	let resolveCollect!: (snapshot: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.track({
		name: "slow",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/slow.jsonl",
		timeoutMs: 1_000,
		collect: () => new Promise<CollectSnapshot>((resolve) => {
			resolveCollect = resolve;
		}),
	});
	runtime.watch("slow");

	const controller = new AbortController();
	const timeoutMs = 60_000;
	const scheduledTimers = new Set<ReturnType<typeof setTimeout>>();
	let clearedWaitTimers = 0;
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	try {
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			const timer = originalSetTimeout(...args);
			if (args[1] === timeoutMs) scheduledTimers.add(timer);
			return timer;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((...args: Parameters<typeof clearTimeout>) => {
			if (scheduledTimers.has(args[0] as ReturnType<typeof setTimeout>)) {
				clearedWaitTimers += 1;
			}
			return originalClearTimeout(...args);
		}) as typeof clearTimeout;

		const pending = runtime.wait(["slow"], { timeoutMs, signal: controller.signal });
		controller.abort();
		assert.deepEqual(await pending, [{ name: "slow", interrupted: true }]);
		assert.equal(scheduledTimers.size, 1, "wait must install its timeout guard");
		assert.equal(clearedWaitTimers, 1, "abort must clear the losing timeout");
		assert.equal(runtime.get("slow")?.consumedByTool, false, "abort restores notification ownership");
		assert.equal(runtime.get("slow")?.watching, true, "the existing watch continues after abort");
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}

	resolveCollect(joinSnapshot({ output: "finally" }));
	await waitFor(() => messages.length === 1, "completion notify after parent abort");
	assert.match(messages[0]!.content, /finally/);
	runtime.dispose();
});

test("runtime.wait: an interrupted unwatched job is re-armed so settle still notifies", async () => {
	let resolveCollect!: (snapshot: CollectSnapshot) => void;
	const messages: Array<{ content: string }> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) { messages.push(message as { content: string }); },
	});
	runtime.track({
		name: "unwatched",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/unwatched.jsonl",
		timeoutMs: 1_000,
		collect: () => new Promise<CollectSnapshot>((resolve) => { resolveCollect = resolve; }),
	});
	const controller = new AbortController();
	const pending = runtime.wait(["unwatched"], { timeoutMs: 5_000, signal: controller.signal });
	controller.abort();
	assert.deepEqual(await pending, [{ name: "unwatched", interrupted: true }]);
	assert.equal(runtime.get("unwatched")?.consumedByTool, false, "abort restores notification ownership");
	assert.equal(runtime.get("unwatched")?.watching, true, "waitOne re-arms watch after interrupt (esc-no-retire-v3)");
	resolveCollect(joinSnapshot({ output: "still running after abort" }));
	await waitFor(() => messages.length === 1, "completion notify after re-armed watch");
	assert.match(messages[0]!.content, /still running after abort/);
	runtime.dispose();
});

test("runtime.wait: finished-cache hits return instantly; unknown names are missing", async () => {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "done",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/done.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "cached" }),
	});
	runtime.watch("done");
	await waitFor(() => runtime.activeJobs().length === 0, "watch finished");
	const results = await runtime.wait(["done", "ghost"], { timeoutMs: 50 });
	assert.equal(results[0]?.snapshot?.output, "cached");
	assert.equal(results[1]?.missing, true);
});

test("runtime.wait: a blocked snapshot yields stillRunning, keeps the job, and restarts the orphan watch", async () => {
	const messages: SentMessage[] = [];
	let collectCalls = 0;
	const resolvers: Array<(s: CollectSnapshot) => void> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	let retired = 0;
	runtime.track({
		name: "b",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/b.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				collectCalls += 1;
				resolvers.push(resolve);
			}),
		retire: async () => {
			retired += 1;
		},
		handleBlocked: async () => "hold",
	});
	runtime.watch("b");
	await waitFor(() => collectCalls === 1, "first collect in flight");
	// The watch resolves to a blocked snapshot and goes hold: nobody watches.
	resolvers[0]!(joinSnapshot({ execution: { status: "running" }, blocked: true }));
	await waitFor(
		() => runtime.get("b")?.watching === false,
		"watch went hold",
	);

	// wait() reuses the resolved blocked snapshot → stillRunning, and because
	// no watch is in flight it restarts one (fresh collect) instead of
	// orphaning the child.
	const results = await runtime.wait(["b"], { timeoutMs: 5_000 });
	assert.equal(results[0]?.name, "b");
	assert.equal(results[0]?.stillRunning, true);
	assert.equal(results[0]?.timedOut, undefined, "blocked snapshot is not a wait timeout");
	assert.ok(typeof results[0]?.elapsedMs === "number");
	const job = runtime.get("b");
	assert.ok(job, "job still tracked");
	assert.equal(job.consumedByTool, false, "consumedByTool reset");
	assert.equal(retired, 0, "blocked pane is not retired");
	await waitFor(() => collectCalls === 2, "orphaned watch restarted");

	// Once the child unblocks, the restarted watch collects and notifies.
	resolvers[1]!(joinSnapshot({ output: "unblocked" }));
	await waitFor(() => messages.length === 1, "notify after unblock");
	assert.match(messages[0]!.content, /Background task completed: \*\*b/);
	assert.match(messages[0]!.content, /unblocked/);
	await waitFor(() => runtime.activeJobs().length === 0, "released");
});

test("runtime.wait: a non-terminal (running) snapshot keeps the job active and unretired", async () => {
	const messages: SentMessage[] = [];
	let retired = 0;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.track({
		name: "r",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/r.jsonl",
		timeoutMs: 1_000,
		// collect gives up while the agent is alive: not terminal, not blocked.
		collect: async () =>
			joinSnapshot({ execution: { status: "running", reason: "timed out" } }),
		retire: async () => {
			retired += 1;
		},
	});
	// No watch(): the only collect is the one wait() itself shares.
	const results = await runtime.wait(["r"], { timeoutMs: 5_000 });
	assert.equal(results[0]?.name, "r");
	assert.equal(results[0]?.stillRunning, true);
	assert.equal(results[0]?.timedOut, undefined);
	assert.ok(typeof results[0]?.elapsedMs === "number");
	const job = runtime.get("r");
	assert.ok(job, "job still tracked");
	assert.equal(job.consumedByTool, false, "consumedByTool reset");
	assert.equal(retired, 0, "non-terminal pane is not retired");
	assert.equal(messages.length, 0, "a running snapshot never notifies");
	runtime.dispose();
});

// ────────────── A: watch re-arms on a running snapshot (U1/U2) ──────────────

test("U1: watch re-arms instead of notifying when collect times out on a live child", async () => {
	const messages: SentMessage[] = [];
	const resolves: Array<(s: CollectSnapshot) => void> = [];
	let collectCalls = 0;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.track({
		name: "live",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/live.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				collectCalls += 1;
				resolves.push(resolve);
			}),
	});
	runtime.watch("live");
	await waitFor(() => collectCalls === 1, "first collect in flight");

	// collect gives up while the agent is alive (F29): not a verdict.
	resolves[0]!(
		joinSnapshot({
			execution: { status: "running", reason: "collect timed out; still alive" },
		}),
	);

	// A: the watch must re-arm — a fresh collect starts, nothing is notified,
	// and the child stays on the widget instead of being orphaned by release().
	await waitFor(() => collectCalls === 2, "watch re-armed after the running snapshot");
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(messages.length, 0, "a running snapshot must not notify");
	assert.equal(runtime.activeJobs().length, 1, "the child must stay tracked");
	const job = runtime.get("live");
	assert.ok(job);
	assert.equal(job.state, "working", "still working, not awaiting");
	assert.equal(job.watching, true, "the re-armed watch is in flight");
	assert.equal(job.notified, false, "the notify flag was cleared for the new round");

	// The child truly finishes: the re-armed watch collects and notifies.
	resolves[1]!(joinSnapshot({ output: "finally done" }));
	await waitFor(() => messages.length === 1, "completion after the re-arm");
	assert.match(messages[0]!.content, /Background task completed: \*\*live/);
	assert.match(messages[0]!.content, /finally done/);
	await waitFor(() => runtime.activeJobs().length === 0, "released after the terminal");
});

test("U2: the re-armed watch never treats the same running snapshot as terminal", async () => {
	const messages: SentMessage[] = [];
	let collectCalls = 0;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.track({
		name: "slow",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/slow.jsonl",
		timeoutMs: 1_000,
		collect: async () => {
			collectCalls += 1;
			// First round: the timeout snapshot. Second round: the real answer.
			return collectCalls === 1
				? joinSnapshot({
						execution: { status: "running", reason: "collect timed out" },
					})
				: joinSnapshot({ output: "the real answer" });
		},
	});
	runtime.watch("slow");
	await waitFor(() => collectCalls === 2, "second collect after re-arm");
	await waitFor(() => messages.length === 1, "exactly one notice");
	await new Promise((r) => setTimeout(r, 20));

	assert.equal(collectCalls, 2, "one re-arm, no busy loop");
	assert.equal(messages.length, 1, "exactly one notice — no failed + success pair");
	assert.match(messages[0]!.content, /Background task completed: \*\*slow/);
	assert.doesNotMatch(messages[0]!.content, /failed/);
	assert.doesNotMatch(messages[0]!.content, /still alive/);
});

test("U2: a re-arming watch joins no group until it really finishes", async () => {
	// The re-arm must not look like a terminal to the join coordinator: the
	// member stays pending, so a sibling finishing first does not flush it in.
	const messages: SentMessage[] = [];
	let liveCalls = 0;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.setJoinConfig({ mode: "smart", flushMs: 50 });
	runtime.track({
		name: "live",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/live.jsonl",
		timeoutMs: 1_000,
		collect: async () => {
			liveCalls += 1;
			return liveCalls === 1
				? joinSnapshot({ execution: { status: "running" } })
				: new Promise<CollectSnapshot>(() => {});
		},
	});
	runtime.track({
		name: "quick",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/quick.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "quick-out" }),
	});
	runtime.watch("live");
	runtime.watch("quick");
	await waitFor(() => messages.length === 1, "window flush");
	assert.match(messages[0]!.content, /quick/);
	assert.match(messages[0]!.content, /Still running: live/);
	assert.doesNotMatch(messages[0]!.content, /- live \(worker\)/);
});

// ────────────── C: a running snapshot never enters the finished cache (U5) ──────────────

test("U5: a running snapshot is not cached as a finished result", async () => {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "stale",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/stale.jsonl",
		timeoutMs: 1_000,
		collect: async () =>
			joinSnapshot({
				execution: { status: "running", reason: "collect timed out" },
				output: "half-done",
			}),
	});
	const collected = (await runtime.consumeCollect("stale"))?.snapshot;
	assert.ok(collected);
	assert.equal(collected.execution.status, "running");

	// Drop the job the way a (pre-A) terminal watch would have, leaving only
	// the finished cache behind. A later request must NOT be served the stale
	// "still working" snapshot as if the turn had ended.
	runtime.release("stale");
	assert.equal(
		runtime.consumeCollect("stale"),
		undefined,
		"a running snapshot must not be cached for consumeCollect",
	);
	const results = await runtime.wait(["stale"], { timeoutMs: 50 });
	assert.deepEqual(
		results,
		[{ name: "stale", missing: true }],
		"a released running child has no finished cache to hit",
	);
});

test("U5: a terminal snapshot is still cached (the exclusion is running-only)", async () => {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "done",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/done.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "all good" }),
	});
	const first = (await runtime.consumeCollect("done"))?.snapshot;
	assert.equal(first?.output, "all good");
	runtime.release("done");
	const cached = (await runtime.consumeCollect("done"))?.snapshot;
	assert.equal(cached?.output, "all good", "a terminal snapshot stays cached");
	const results = await runtime.wait(["done"], { timeoutMs: 50 });
	assert.equal(results[0]?.snapshot?.output, "all good", "wait hits the cache too");
});

test("runtime: persisted tree usage flows to status entries and fills missing live session usage", () => {
	const nodes = [
		statusTreeNode("root", null, "root", 0),
		statusTreeNode("root.worker", "root", "worker", 1, 256),
	];
	const runtime = createSessionRuntime({
		sendMessage() {},
		getTreeNodes: () => nodes,
		now: () => 10_000,
	});
	try {
		assert.equal(runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.tokensTotal, 256);
		runtime.track({
			name: "worker",
			runId: "worker-run",
			agent: "worker",
			sessionFile: "",
			nodeId: "root.worker",
			parentId: "root",
			depth: 1,
			timeoutMs: 1_000,
			collect: () => new Promise(() => {}),
		});
		assert.equal(runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.tokensTotal, 256);
	} finally {
		runtime.dispose();
	}
});

test("runtime: treeNodes() keeps the arbitrated spawnMode on the nodes it synthesizes (#209/D5)", () => {
	// `treeNodes()` builds a snapshot of its own when a tracked job has an
	// identity but no DB row yet (`runtime.ts` synthesized branch), and returns
	// that array directly. A merge that only ran inside `snapshotNodes()` left
	// `spawnMode` off those nodes, so the modal footer lost the segment in the
	// plain-session (getTreeNodes -> []) and pre-DB-row windows.
	const runtime = createSessionRuntime({
		sendMessage() {},
		getTreeNodes: () => [],
		now: () => 10_000,
	});
	try {
		runtime.track({
			name: "worker",
			runId: "worker-run",
			agent: "worker",
			sessionFile: "",
			nodeId: "root.worker",
			parentId: "root",
			depth: 1,
			timeoutMs: 1_000,
			spawnMode: "inprocess",
			collect: () => new Promise(() => {}),
		});
		// The DB has no row for this node: the only source is the tracked job.
		const synthesized = runtime.treeNodes().find((node) => node.id === "root.worker");
		assert.ok(synthesized, "the job with identity and no DB row is synthesized into the tree");
		assert.equal(
			synthesized.spawnMode,
			"inprocess",
			"the synthesized node carries the arbitrated backend, not just the DB-backed one",
		);
	} finally {
		runtime.dispose();
	}
});

test("runtime: treeNodes() merges the arbitrated spawnMode onto a job with no explicit nodeId (#209/D5)", () => {
	// `child-row-missing` variant: identity comes from `getTreeIdentity`, the DB
	// row does not exist yet. Same window as above, different identity channel.
	const runtime = createSessionRuntime({
		sendMessage() {},
		getTreeNodes: () => [],
		getTreeIdentity: (name: string) => ({ nodeId: `root.${name}`, parentId: "root", depth: 1 }),
		now: () => 10_000,
	});
	try {
		runtime.track({
			name: "worker",
			runId: "worker-run",
			agent: "worker",
			sessionFile: "",
			timeoutMs: 1_000,
			spawnMode: "rpc",
			collect: () => new Promise(() => {}),
		});
		assert.equal(
			runtime.treeNodes().find((node) => node.id === "root.worker")?.spawnMode,
			"rpc",
			"a mapped identity must not lose the mode either",
		);
	} finally {
		runtime.dispose();
	}
});

test("runtime: treeNodes() merges the job's arbitrated spawnMode onto its snapshot (#209/D5)", () => {
	const nodes = [
		statusTreeNode("root", null, "root", 0),
		statusTreeNode("root.worker", "root", "worker", 1),
	];
	const runtime = createSessionRuntime({
		sendMessage() {},
		getTreeNodes: () => nodes,
		now: () => 10_000,
	});
	try {
		// No column in legion.db: the value comes from the tracked job.
		assert.equal(
			runtime.treeNodes().find((node) => node.id === "root.worker")?.spawnMode,
			undefined,
			"a node with no tracked job has no spawnMode — never a guessed rpc",
		);
		runtime.track({
			name: "worker",
			runId: "worker-run",
			agent: "worker",
			sessionFile: "",
			nodeId: "root.worker",
			parentId: "root",
			depth: 1,
			timeoutMs: 1_000,
			spawnMode: "inprocess",
			collect: () => new Promise(() => {}),
		});
		assert.equal(
			runtime.treeNodes().find((node) => node.id === "root.worker")?.spawnMode,
			"inprocess",
			"the arbitrated backend reaches the tree snapshot",
		);
		// A legacy job (no spawnMode) does not overwrite the snapshot with a guess.
		runtime.track({
			name: "legacy",
			runId: "legacy-run",
			agent: "worker",
			sessionFile: "",
			nodeId: "root",
			parentId: null,
			depth: 0,
			timeoutMs: 1_000,
			collect: () => new Promise(() => {}),
		});
		assert.equal(runtime.treeNodes().find((node) => node.id === "root")?.spawnMode, undefined);
	} finally {
		runtime.dispose();
	}
});

test("runtime: session jsonl fills the live current-turn elapsed", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = join(dir, "worker-0.jsonl");
		writeFileSync(
			sessionFile,
			[
				sessionHeader(),
				modelChange("cb/glm-5.3"),
				userMsg("go", { timestamp: 1_000 }),
				assistantMsg({
					stopReason: "stop",
					text: "done",
					model: "cb/glm-5.3",
					usage: { input: 100, cacheRead: 200, cacheWrite: 300, output: 400 },
					timestamp: 2_000,
				}),
				userMsg("more", { timestamp: 4_000 }),
				assistantMsg({
					stopReason: "toolUse",
					tools: ["bash"],
					model: "cb/glm-5.3",
					usage: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 },
					timestamp: 4_500,
				}),
			].join("\n"),
		);
		const rendered: string[] = [];
		const runtime = createSessionRuntime({
			sendMessage() {},
			now: () => 5_000,
		});
		runtime.bind({
			hasUI: true,
			ui: {
				theme: { fg: (_c, text) => text },
				setStatus() {},
				setWidget(_key, content) {
					if (typeof content === "function") {
						const component = content({ requestRender() {} }, {
							fg: (_c, text) => text,
						});
						rendered.splice(0, rendered.length, ...component.render());
					}
				},
			},
		});
		runtime.track({
			name: "worker-0",
			runId: "r-1",
			agent: "worker",
			sessionFile,
			timeoutMs: 1_000,
			collect: () => new Promise(() => {}),
		});
		// The board renders with the real clock, so assert shape, not a fixed
		// second count: the in-flight turn (started at 4_000) sits beside the total.
		const text = rendered.join("\n");
		assert.match(text, / \/ /);
		assert.match(text, /turn 2 · bash/);
		const live = runtime.statusEntries().find((entry) => entry.name === "worker-0");
		assert.equal(live?.currentTurnStartedAt, 4_000);
		assert.equal(live?.currentTurnEndedAt, undefined);
		assert.equal(live?.tokensTotal, 1_100);
		runtime.dispose();
	});
});

test("watch re-arms a thrown Connection error while the RPC child is alive", async () => {
	const messages: SentMessage[] = [];
	let calls = 0;
	let retired = 0;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.track({
		name: "worker-0",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/worker-0.jsonl",
		timeoutMs: 1_000,
		isAlive: () => true,
		collect: async () => {
			calls += 1;
			if (calls === 1) throw new Error("Connection error.");
			return joinSnapshot({ output: "recovered" });
		},
		retire: async () => {
			retired += 1;
		},
	});
	runtime.watch("worker-0");
	await waitFor(() => messages.length === 1, "completion after the connection re-arm");
	assert.equal(calls, 2);
	assert.match(messages[0]!.content, /Background task completed: \*\*worker-0/);
	assert.doesNotMatch(messages[0]!.content, /Connection error/);
	assert.doesNotMatch(messages[0]!.content, /failed/);
	await waitFor(() => retired === 1, "terminal success still retires");
	runtime.dispose();
});

test("a thrown Connection error is a failure once the child is gone", async () => {
	const messages: SentMessage[] = [];
	let calls = 0;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.track({
		name: "worker-0",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/worker-0.jsonl",
		timeoutMs: 1_000,
		isAlive: () => false,
		collect: async () => {
			calls += 1;
			throw new Error("Connection error.");
		},
	});
	runtime.watch("worker-0");
	await waitFor(() => messages.length === 1, "failure notice");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(calls, 1);
	assert.equal(messages.length, 1);
	assert.match(messages[0]!.content, /Background task failed/);
	assert.match(messages[0]!.content, /child is not alive/);
	assert.doesNotMatch(messages[0]!.content, /RPC child is not alive/);
	runtime.dispose();
});

test("renderLiveChildStatus reports silence and ignores a stale connection failure", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = join(dir, "worker-0.jsonl");
		writeFileSync(sessionFile, "{\"type\":\"message\"}\n");
		const now = Date.now();
		utimesSync(sessionFile, new Date(now - 358_000), new Date(now - 358_000));
		const age = lastJsonlEventAgeMs(sessionFile, now);
		assert.ok(age !== undefined);
		assert.ok(Math.abs(age - 358_000) < 2_000, `age ${age}`);
		const text = renderLiveChildStatus({
			name: "worker-0",
			state: "retired",
			agent: "worker",
			kind: "pi",
			sessionFile,
			execution: { status: "failed", reason: "Connection error." },
			acceptance: { status: "rejected", level: "none" },
			alive: true,
			now,
		});
		assert.match(text, /state=working/);
		assert.equal(text.split("\n")[1], formatAliveQuiet(age));
		assert.match(text.split("\n")[1]!, /\(living\)/, "long quiet marks living");
		assert.ok(text.indexOf("alive · quiet") < text.indexOf("execution snapshot:"), "quiet age leads before execution snapshot");
		assert.match(text, /^execution snapshot: running$/m, "progress-signal reason omitted while alive");
		assert.doesNotMatch(text, /execution snapshot: running \(rpc child alive\)/);
		assert.match(text, /persisted snapshot is stale: state=retired, execution=failed \(Connection error\.\), acceptance=rejected \(none\)/);
		// #209: the meta line is `supervisor=<mode>|unknown`; anchor on the prefix
		// (this fixture carries no spawnMode) so the intent — snapshot before the
		// path meta — survives a truthful backend.
		assert.ok(text.indexOf("execution snapshot:") < text.indexOf("supervisor="), "snapshot before path meta");
		assert.doesNotMatch(text, /^worker-0 — state=retired/m);
		assert.doesNotMatch(text, /^execution: failed/m);
		assert.doesNotMatch(text, /^acceptance: rejected/m);
		assert.doesNotMatch(text, /last event/);
	});
});

test("renderLiveChildStatus keeps a live running snapshot and adds recency", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = join(dir, "worker-0.jsonl");
		writeFileSync(sessionFile, "\n");
		const now = Date.now();
		utimesSync(sessionFile, new Date(now), new Date(now));
		const text = renderLiveChildStatus({
			name: "worker-0",
			state: "working",
			agent: "worker",
			kind: "pi",
			sessionFile,
			execution: { status: "running", reason: "collect deadline (cumulative since launch) exceeded; child still alive" },
			acceptance: { status: "unknown", level: "none" },
			alive: true,
			now,
		});
		assert.match(text, /state=working/);
		assert.match(text, /^alive · quiet 0s$/m);
		assert.doesNotMatch(text, /\(living\)/, "fresh quiet stays compact");
		assert.ok(text.indexOf("alive · quiet 0s") < text.indexOf("execution snapshot:"), "quiet age leads before execution snapshot");
		assert.match(text, /^execution snapshot: running$/m, "collect-deadline reason omitted while alive");
		assert.doesNotMatch(text, /collect deadline/);
		assert.match(text, /acceptance snapshot: unknown \(none\)/);
		assert.doesNotMatch(text, /persisted snapshot is stale/);
		assert.doesNotMatch(text, /last event/);
	});
});

test("renderLiveChildStatus leaves a dead child's terminal snapshot alone", () => {
	const text = renderLiveChildStatus({
		name: "worker-0",
		state: "retired",
		agent: "worker",
		kind: "pi",
		sessionFile: "/tmp/does-not-exist.jsonl",
		execution: { status: "failed", reason: "Connection error." },
		acceptance: { status: "rejected", level: "none" },
		alive: false,
		now: 0,
	});
	assert.match(text, /state=retired/);
	assert.match(text, /^execution: failed \(Connection error\.\)$/m);
	assert.match(text, /^acceptance: rejected \(none\)$/m);
	assert.doesNotMatch(text, /alive · quiet/);
	assert.doesNotMatch(text, /last event/);
	assert.doesNotMatch(text, /snapshot/);
	assert.doesNotMatch(text, /stale/);
});

test("renderLiveChildStatus leads with alive · quiet when session is missing", () => {
	const text = renderLiveChildStatus({
		name: "worker-0",
		state: "working",
		agent: "worker",
		kind: "pi",
		sessionFile: "",
		execution: { status: "running" },
		alive: true,
		now: 0,
	});
	const lines = text.split("\n");
	assert.equal(lines[1], "alive · quiet unknown");
	assert.match(text, /execution snapshot: running/);
	assert.ok(text.indexOf("alive · quiet unknown") < text.indexOf("execution snapshot:"));
});

test("renderLiveChildStatus prints the arbitrated spawnMode, and unknown when absent (#209)", () => {
	const base = {
		name: "worker-0",
		state: "working",
		agent: "worker",
		kind: "pi",
		sessionFile: "/tmp/does-not-exist.jsonl",
		alive: false,
		now: 0,
	};
	const inprocess = renderLiveChildStatus({ ...base, spawnMode: "inprocess" });
	assert.match(inprocess, /^supervisor=inprocess$/m, "the real backend is rendered, not a literal rpc");
	assert.doesNotMatch(inprocess, /supervisor=rpc/);
	// The session path stays on the line right after supervisor=, in that order.
	const inprocessLines = inprocess.split("\n");
	assert.equal(inprocessLines.indexOf("supervisor=inprocess"), inprocessLines.indexOf("session=/tmp/does-not-exist.jsonl") - 1);

	// A legacy record (or a tree-only fallback) has no spawnMode: say unknown
	// rather than claim the RPC backend the bug reported.
	const unknown = renderLiveChildStatus(base);
	assert.match(unknown, /^supervisor=unknown$/m);
	assert.doesNotMatch(unknown, /supervisor=rpc/);

	const rpc = renderLiveChildStatus({ ...base, spawnMode: "rpc" });
	assert.match(rpc, /^supervisor=rpc$/m);
});

test("renderLiveChildStatus appends a context line from the child's own session (D4)", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = join(dir, "worker-0.jsonl");
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } }),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						stopReason: "stop",
						usage: { input: 24_000, output: 300, cacheRead: 300, cacheWrite: 0, cost: { total: 0.02 } },
					},
				}),
			].join("\n") + "\n",
		);
		const text = renderLiveChildStatus({
			name: "worker-0",
			state: "working",
			agent: "worker",
			kind: "pi",
			sessionFile,
			alive: false,
			now: 0,
		});
		// 24000 + 300 + 0 → 24.3K. Absolute tokens: JSONL has no contextWindow,
		// so any percentage here would be fabricated.
		assert.match(text, /^context: ctx=24\.3K tok$/m);
		assert.doesNotMatch(text, /%/);
		// Appended after the snapshots, before the path meta: every pre-existing
		// line keeps its text and order.
		assert.ok(text.indexOf("context:") < text.indexOf("supervisor="), "context before path meta");
		assert.match(text, /^supervisor=unknown$/m);

		// No assistant message yet → no line at all (unknown, not zero).
		const emptyFile = join(dir, "empty.jsonl");
		writeFileSync(emptyFile, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`);
		const noContext = renderLiveChildStatus({
			name: "worker-0",
			state: "working",
			agent: "worker",
			kind: "pi",
			sessionFile: emptyFile,
			alive: false,
			now: 0,
		});
		assert.doesNotMatch(noContext, /^context: /m);
	});
});

test("formatContextTokens prints absolute token counts, never a percentage", () => {
	assert.equal(formatContextTokens(0), "0");
	assert.equal(formatContextTokens(950), "950");
	assert.equal(formatContextTokens(24_300), "24.3K");
	assert.equal(formatContextTokens(1_400_000), "1.4M");
});

test("renderLiveChildStatus: an rpc child reports its own rss, an inprocess child never does (D2)", () => {
	const base = {
		name: "worker-0",
		state: "working",
		agent: "worker",
		kind: "pi",
		sessionFile: "",
		alive: false,
		now: 0,
	};
	// This host process is the one pid guaranteed to have a readable status file.
	// `alive: true` is the precondition for reading a child pid at all (§6), and
	// picks up no extra line beyond the rss one that this test asserts on.
	const rpc = renderLiveChildStatus({ ...base, spawnMode: "rpc", pid: process.pid, alive: true });
	if (process.platform !== "linux") {
		// Non-Linux degrades to no memory line rather than a wrong number.
		assert.doesNotMatch(rpc, /^memory: /m);
	} else {
		assert.match(rpc, /^memory: rss=\d+m( peak=\d+m)?$/m, `expected a per-child rss line:\n${rpc}`);
	}

	// An inprocess child shares this process: it must NOT be handed a per-child
	// rss (D2 forbids apportioning the host figure across children). It reports
	// the host number once, and says it is shared.
	const inprocess = renderLiveChildStatus({ ...base, spawnMode: "inprocess", alive: true });
	if (process.platform !== "linux") {
		assert.doesNotMatch(inprocess, /^memory: /m);
	} else {
		assert.match(inprocess, /^memory: host rss=\d+m \(shared by inprocess children\)$/m);
		assert.doesNotMatch(inprocess, /^memory: rss=/m);
	}

	// No pid and no mode: nothing honest to say, so no line at all.
	assert.doesNotMatch(renderLiveChildStatus(base), /^memory: /m);
});

test("renderLiveChildStatus: a pid is only read while the child still owns it (pid-reuse race, §6)", () => {
	const base = {
		name: "worker-0",
		state: "working",
		agent: "worker",
		kind: "pi",
		sessionFile: "",
		now: 0,
	};
	// alive=false + a pid: the kernel may already have handed this pid to an
	// unrelated process, so any /proc read would report SOMEONE ELSE's rss as
	// this child's memory — fabricated attribution, which D2 forbids.
	for (const spawnMode of ["rpc", "inprocess"] as const) {
		const dead = renderLiveChildStatus({ ...base, spawnMode, pid: process.pid, alive: false });
		assert.doesNotMatch(dead, /^memory: /m, `a dead ${spawnMode} child must print no memory line:\n${dead}`);
	}

	// alive=true + a live pid: the number belongs to this child, so it is honest.
	const live = renderLiveChildStatus({ ...base, spawnMode: "rpc", pid: process.pid, alive: true });
	if (process.platform !== "linux") {
		assert.doesNotMatch(live, /^memory: /m);
	} else {
		assert.match(live, /^memory: rss=\d+m( peak=\d+m)?$/m, `expected a per-child rss line:\n${live}`);
	}
});

test("runtime: status entries keep rss only for a job whose process is still alive (§6)", () => {
	const runtime = createSessionRuntime({ sendMessage() {}, now: () => 10_000 });
	const job = (name: string, extra: { isAlive?: () => boolean }) => ({
		name,
		runId: `${name}-run`,
		agent: "worker",
		sessionFile: "",
		timeoutMs: 1_000,
		spawnMode: "rpc" as const,
		pid: process.pid,
		collect: () => new Promise<never>(() => {}),
		...extra,
	});
	try {
		// A live job: its own pid is still its own, so the rss is a real number.
		runtime.track(job("live", { isAlive: () => true }));
		// Reported gone by the RPC liveness check: never read its pid again.
		runtime.track(job("dead", { isAlive: () => false }));
		// Legacy job with no isAlive hook: unreadable liveness, so stay blank.
		runtime.track(job("legacy", {}));

		const byName = new Map(runtime.statusEntries().map((entry) => [entry.name, entry]));
		if (process.platform === "linux") {
			assert.equal(typeof byName.get("live")?.rss, "number", "a live job reports its own rss");
		}
		assert.equal(byName.get("dead")?.rss, undefined, "a pid whose process is gone must never be read");
		assert.equal(byName.get("legacy")?.rss, undefined, "unknown liveness is not a licence to read /proc");
		assert.equal(byName.get("dead")?.pid, process.pid, "the pid itself still surfaces (D3): only the probe is withheld");
	} finally {
		runtime.dispose();
	}
});

test("renderLiveChildStatus keeps the supervisor meta after every snapshot line", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = join(dir, "worker-0.jsonl");
		writeFileSync(sessionFile, "{\"type\":\"message\"}\n");
		const now = Date.now();
		utimesSync(sessionFile, new Date(now - 90_000), new Date(now - 90_000));
		const text = renderLiveChildStatus({
			name: "worker-0",
			state: "working",
			agent: "worker",
			kind: "pi",
			sessionFile,
			execution: { status: "running" },
			acceptance: { status: "unknown", level: "none" },
			spawnMode: "inprocess",
			alive: true,
			now,
		});
		assert.match(text, /^supervisor=inprocess$/m);
		assert.ok(text.indexOf("execution snapshot:") < text.indexOf("supervisor=inprocess"));
		assert.ok(text.indexOf("acceptance snapshot:") < text.indexOf("supervisor=inprocess"));
	});
});

test("renderLiveChildStatus long-quiet alive worker: (living) leads; collect-deadline reason stays off the snapshot", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = join(dir, "worker-0.jsonl");
		writeFileSync(sessionFile, "{\"type\":\"message\"}\n");
		const now = Date.now();
		utimesSync(sessionFile, new Date(now - 90_000), new Date(now - 90_000));
		const text = renderLiveChildStatus({
			name: "worker-0",
			state: "working",
			agent: "worker",
			kind: "pi",
			sessionFile,
			execution: {
				status: "running",
				reason: "collect deadline (cumulative since launch) exceeded; child still alive",
			},
			acceptance: { status: "unknown", level: "none" },
			alive: true,
			now,
		});
		const lines = text.split("\n");
		assert.equal(lines[0], "worker-0 — state=working agent=worker kind=pi");
		assert.match(lines[1]!, /^alive · quiet \d+s \(living\)$/);
		assert.equal(lines[2], "execution snapshot: running");
		assert.ok(text.indexOf("alive · quiet") < text.indexOf("execution snapshot:"));
		assert.ok(text.indexOf("execution snapshot:") < text.indexOf("supervisor="));
		assert.doesNotMatch(text, /collect deadline|child still alive/);
		assert.match(text, /acceptance snapshot: unknown \(none\)/);
	});
});

test("runtime: a settled session turn freezes, and the next user message resets it", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = join(dir, "worker-0.jsonl");
		writeFileSync(
			sessionFile,
			[
				sessionHeader(),
				userMsg("go", { timestamp: 1_000 }),
				assistantMsg({ stopReason: "stop", text: "done", timestamp: 9_000 }),
			].join("\n") + "\n",
		);
		const runtime = createSessionRuntime({
			sendMessage() {},
			now: () => 20_000,
		});
		try {
			runtime.track({
				name: "worker-0",
				runId: "r-1",
				agent: "worker",
				sessionFile,
				timeoutMs: 1_000,
				collect: () => new Promise(() => {}),
			});
			const frozen = runtime.statusEntries().find((entry) => entry.name === "worker-0");
			assert.equal(frozen?.currentTurnStartedAt, 1_000);
			assert.equal(frozen?.currentTurnEndedAt, 9_000);

			appendFileSync(sessionFile, userMsg("again", { timestamp: 30_000 }) + "\n");
			const reset = runtime.statusEntries().find((entry) => entry.name === "worker-0");
			assert.equal(reset?.currentTurnStartedAt, 30_000);
			assert.equal(reset?.currentTurnEndedAt, undefined);
			assert.equal(reset?.turns, 2);
		} finally {
			runtime.dispose();
		}
	});
});

test("runtime: turn_start resets a frozen current turn on tree nodes", () => {
	const nodes = [
		statusTreeNode("root", null, "root", 0),
		statusTreeNode("root.worker", "root", "worker", 1),
	];
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: () => nodes,
		now: () => 50_000,
	});
	try {
		const entry = () => runtime.statusEntries().find((item) => item.nodeId === "root.worker");
		eventBus.emit({ nodeId: "root.worker", type: "turn_start", data: { turn: 2 }, ts: 40_000 });
		assert.equal(entry()?.turns, 2);
		assert.equal(entry()?.currentTurnStartedAt, 40_000);
		assert.equal(entry()?.currentTurnEndedAt, undefined);

		eventBus.emit({ nodeId: "root.worker", type: "agent_settled", data: null, ts: 46_000 });
		assert.equal(entry()?.currentTurnStartedAt, 40_000);
		assert.equal(entry()?.currentTurnEndedAt, 46_000);
		// A second settle must not move the frozen endpoint.
		eventBus.emit({ nodeId: "root.worker", type: "agent_settled", data: null, ts: 49_000 });
		assert.equal(entry()?.currentTurnEndedAt, 46_000);

		eventBus.emit({ nodeId: "root.worker", type: "turn_start", data: { turn: 3 }, ts: 48_000 });
		assert.equal(entry()?.turns, 3);
		assert.equal(entry()?.currentTurnStartedAt, 48_000);
		assert.equal(entry()?.currentTurnEndedAt, undefined);
	} finally {
		runtime.dispose();
	}
});

test("runtime: Esc/wait interrupt does not clear busy activity", async () => {
	const busy: Array<{ active: boolean; label?: string; children?: readonly string[] }> = [];
	let resolveCollect!: (snapshot: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage() {},
		emitBusy(active, label, children) {
			busy.push({ active, label, children });
		},
		now: () => 1_000,
	});
	runtime.track({
		name: "scout",
		runId: "r-1",
		agent: "scout",
		sessionFile: "/tmp/scout.jsonl",
		timeoutMs: 1_000,
		collect: () => new Promise<CollectSnapshot>((resolve) => { resolveCollect = resolve; }),
	});
	assert.equal(busy.at(-1)?.active, true);
	assert.deepEqual(busy.at(-1)?.children, ["scout"]);
	assert.equal(busy.at(-1)?.label, "1 subagent (scout)");

	const controller = new AbortController();
	const pending = runtime.wait(["scout"], { timeoutMs: 5_000, signal: controller.signal });
	controller.abort();
	assert.deepEqual(await pending, [{ name: "scout", interrupted: true }]);
	assert.equal(busy.at(-1)?.active, true, "Esc must not clear legion activity");
	assert.deepEqual(busy.at(-1)?.children, ["scout"]);

	resolveCollect(snapshot());
	await waitFor(() => busy.some((entry) => entry.active === false), "busy clears after settle");
	runtime.dispose();
});

test("runtime: emitBusy passes live child slugs for OSC id=legion/<slug>", () => {
	const busy: Array<{ active: boolean; children?: readonly string[] }> = [];
	const runtime = createSessionRuntime({
		sendMessage() {},
		emitBusy(active, _label, children) {
			busy.push({ active, children });
		},
		now: () => 1_000,
	});
	runtime.track({
		name: "worker",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => snapshot(),
	});
	runtime.track({
		name: "reviewer",
		runId: "r-1",
		agent: "reviewer",
		sessionFile: "/tmp/r.jsonl",
		timeoutMs: 1_000,
		collect: async () => snapshot(),
	});
	assert.deepEqual([...(busy.at(-1)?.children ?? [])].sort(), ["reviewer", "worker"]);
	runtime.dispose();
	assert.equal(busy.at(-1)?.active, false);
	assert.deepEqual(busy.at(-1)?.children, []);
});

// ── #209-3: run-dir owner liveness in status ────────────────────────────

test("renderLiveChildStatus: owner dead + not alive turns a persisted working into failed", () => {
	const text = renderLiveChildStatus({
		name: "worker-2",
		state: "working",
		agent: "worker",
		kind: "pi",
		sessionFile: "/tmp/does-not-exist.jsonl",
		execution: { status: "running" },
		alive: false,
		owner: "dead",
		now: 0,
	});
	const lines = text.split("\n");
	assert.equal(lines[0], "worker-2 — state=failed agent=worker kind=pi");
	assert.ok(
		lines.includes("owner: dead (pid gone)"),
		`owner explanation line missing:\n${text}`,
	);
	// The owner line sits after the state lead and before path metadata.
	assert.ok(text.indexOf("owner: dead (pid gone)") > text.indexOf("state=failed"));
	// #209-2: omitted spawnMode renders unknown, never a guessed rpc.
	assert.ok(text.indexOf("owner: dead (pid gone)") < text.indexOf("supervisor=unknown"));
	// Dead is a verdict, not a stale-snapshot rewrite: no stale re-classification.
	assert.doesNotMatch(text, /persisted snapshot is stale/);
	// A dead child has no quiet-age lead.
	assert.doesNotMatch(text, /alive · quiet/);
});

test("renderLiveChildStatus: owner unknown keeps state=working (no false verdict)", () => {
	const text = renderLiveChildStatus({
		name: "worker-2",
		state: "working",
		agent: "worker",
		kind: "pi",
		sessionFile: "/tmp/does-not-exist.jsonl",
		execution: { status: "running" },
		alive: false,
		owner: "unknown",
		now: 0,
	});
	assert.match(text, /^worker-2 — state=working /m);
	assert.doesNotMatch(text, /state=failed/);
	assert.match(text, /^owner: unknown$/m);
});

test("renderLiveChildStatus: alive child ignores owner (in-memory liveness wins)", () => {
	const text = renderLiveChildStatus({
		name: "worker-0",
		state: "working",
		agent: "worker",
		kind: "pi",
		sessionFile: "",
		execution: { status: "running" },
		alive: true,
		owner: "dead",
		now: 0,
	});
	assert.match(text, /^worker-0 — state=working /m);
	assert.doesNotMatch(text, /state=failed/);
});

test("renderLiveChildStatus: owner dead leaves a terminal state alone", () => {
	const text = renderLiveChildStatus({
		name: "worker-0",
		state: "retired",
		agent: "worker",
		kind: "pi",
		sessionFile: "/tmp/does-not-exist.jsonl",
		execution: { status: "success" },
		alive: false,
		owner: "dead",
		now: 0,
	});
	assert.match(text, /^worker-0 — state=retired /m);
	assert.doesNotMatch(text, /state=failed/);
});

test("renderLiveChildStatus: no owner field emits no owner line", () => {
	const text = renderLiveChildStatus({
		name: "worker-0",
		state: "working",
		agent: "worker",
		kind: "pi",
		sessionFile: "/tmp/does-not-exist.jsonl",
		alive: false,
		now: 0,
	});
	assert.doesNotMatch(text, /^owner: /m);
	assert.match(text, /^worker-0 — state=working /m);
});

// ═════════ run-scoped completion outbox: hold until agent_settled (D-A…D-G) ═════════

/** Manual overflow timer: the test fires it itself (never a real 80s wait). */
function manualOverflow() {
	const timers: Array<{ ms: number; fn: () => void; canceled: boolean }> = [];
	const scheduleNoticeOverflow = (ms: number, fn: () => void) => {
		const slot = { ms, fn, canceled: false };
		timers.push(slot);
		return {
			cancel: () => {
				slot.canceled = true;
			},
		};
	};
	return { timers, scheduleNoticeOverflow };
}

test("T1: runtime — a completion during the parent run is held until agent_settled, then sent", async () => {
	const messages: unknown[] = [];
	let resolveCollect!: (value: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message, options) {
			messages.push({ message, options });
		},
		now: () => 1_000,
	});

	runtime.notifyParentRunStart();
	runtime.track({
		name: "held",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/held.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
	});
	runtime.watch("held");
	resolveCollect(joinSnapshot({ output: "held output" }));

	await waitFor(() => runtime.noticeQueueStats().pending === 1, "notice held in the outbox");
	// The whole point: nothing reaches the host while the run is live, because
	// the host only drains followUp inside a live run.
	assert.equal(messages.length, 0, "a live parent run holds the notice");
	assert.equal(runtime.noticeQueueStats().forcedFlushes, 0);

	runtime.notifyParentSettled();
	assert.equal(messages.length, 1, "settle flushes the held notice");
	const sent = messages[0] as {
		message: { customType: string; content: string };
		options: { triggerTurn: boolean; deliverAs: string };
	};
	assert.equal(sent.message.customType, SUBAGENT_NOTIFY_TYPE);
	assert.equal(sent.options.triggerTurn, true);
	assert.equal(sent.options.deliverAs, "followUp");
	assert.match(sent.message.content, /Background task completed/);
	assert.match(sent.message.content, /held output/);
	assert.equal(runtime.noticeQueueStats().pending, 0, "outbox drained");
	runtime.dispose();
});

test("T2: runtime — two runIds finishing in one parent run flush as a FIFO burst at settle", async () => {
	const messages: Array<{ content: string }> = [];
	const resolvers = new Map<string, (value: CollectSnapshot) => void>();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as { content: string });
		},
	});

	runtime.notifyParentRunStart();
	for (const [name, runId] of [["first", "r-1"], ["second", "r-2"]] as const) {
		runtime.track({
			name,
			runId,
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
		});
		runtime.watch(name);
	}
	resolvers.get("first")!(joinSnapshot({ output: "first-out" }));
	resolvers.get("second")!(joinSnapshot({ output: "second-out" }));

	await waitFor(() => runtime.noticeQueueStats().pending === 2, "both notices held");
	assert.equal(messages.length, 0, "no notice escapes a live run");

	runtime.notifyParentSettled();
	assert.equal(messages.length, 2, "both survive the burst");
	assert.match(messages[0]!.content, /first/);
	assert.match(messages[0]!.content, /first-out/);
	assert.match(messages[1]!.content, /second/);
	assert.match(messages[1]!.content, /second-out/);
	assert.equal(runtime.noticeQueueStats().pending, 0);
	// FIFO, one message per notice: the grouped shape belongs to the join layer.
	assert.notEqual(messages[0]!.content, messages[1]!.content);
	runtime.dispose();
});

test("T3: runtime — a notice held past MAX_PENDING_AGE_MS is force-sent while the run is still active", async () => {
	const messages: unknown[] = [];
	const overflow = manualOverflow();
	// B4: an ADVANCEABLE fake clock, not a frozen `() => 1_000`. A frozen clock
	// makes `Math.max(0, enqueuedAt + MAX_PENDING_AGE_MS - now())` a constant, so
	// an arithmetic bug would go unnoticed. T3b below asserts the REMAINING age.
	let t = 1_000;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
		now: () => t,
		scheduleNoticeOverflow: overflow.scheduleNoticeOverflow,
	});

	runtime.notifyParentRunStart();
	runtime.track({
		name: "stuck",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/stuck.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "stuck-out" }),
	});
	runtime.watch("stuck");

	await waitFor(() => runtime.noticeQueueStats().pending === 1, "notice held");
	assert.equal(overflow.timers.length, 1, "exactly one overflow timer armed");
	assert.equal(overflow.timers[0]!.ms, MAX_PENDING_AGE_MS, "delay is the hard cap from enqueue");
	assert.equal(messages.length, 0);

	// The arm fires when the notice actually reaches the cap.
	t += MAX_PENDING_AGE_MS;
	overflow.timers[0]!.fn();
	assert.equal(messages.length, 1, "the cap force-sends even during a live run");
	assert.equal(runtime.noticeQueueStats().forcedFlushes, 1, "the overflow is counted");
	assert.equal(runtime.noticeQueueStats().pending, 0);
	runtime.dispose();
});

test("T3b: runtime — an early-firing arm re-arms for the remaining age instead of force-sending", async () => {
	const messages: unknown[] = [];
	const overflow = manualOverflow();
	let t = 1_000;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
		now: () => t,
		scheduleNoticeOverflow: overflow.scheduleNoticeOverflow,
	});

	runtime.notifyParentRunStart();
	runtime.track({
		name: "aged",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/aged.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "aged-out" }),
	});
	runtime.watch("aged");
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "notice held");
	assert.equal(overflow.timers[0]!.ms, MAX_PENDING_AGE_MS);

	// 30s elapsed, then the arm fires even though it was scheduled for 80s. The
	// fancier case a real timer exhibits after a coarse wake-up / clock step: it
	// must NOT force-send early, and it must re-arm for the age REMAINING.
	t += 30_000;
	overflow.timers[0]!.fn();
	assert.equal(messages.length, 0, "an early fire must not force-send");
	assert.equal(runtime.noticeQueueStats().forcedFlushes, 0, "nothing was force-flushed");
	assert.equal(overflow.timers.length, 2, "the arm re-armed");
	assert.equal(
		overflow.timers[1]!.ms,
		MAX_PENDING_AGE_MS - 30_000,
		"the re-arm carries the REMAINING age, not the full cap",
	);

	const oldestAge = runtime.noticeQueueStats().oldestAgeMs;
	assert.equal(oldestAge, 30_000, "the held notice is 30s old");

	// At the cap the live arm force-sends exactly once.
	t += MAX_PENDING_AGE_MS - 30_000;
	overflow.timers[1]!.fn();
	assert.equal(messages.length, 1, "at the cap the notice is force-sent");
	assert.equal(runtime.noticeQueueStats().forcedFlushes, 1);
	assert.equal(runtime.noticeQueueStats().pending, 0);
	runtime.dispose();
});

test("T3d: runtime — the arm and oldestAgeMs are driven by the OLDEST notice in the outbox", async () => {
	// Reviewer-4 minor: nothing pinned 「outbox[0] is the oldest」. Swapping both
	// `outbox[0]` reads in `runtime.ts` (`armOutboxTimer` and
	// `noticeQueueStats`) for `at(-1)` stayed fully green, i.e. a regression to
	// 「newest-first」 was undetectable. Two notices enqueued 30s apart make the
	// two ends disagree: the arm must carry the FIRST notice's full cap and
	// `oldestAgeMs` must report the FIRST notice's age.
	const messages: unknown[] = [];
	const overflow = manualOverflow();
	let t = 1_000;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
		now: () => t,
		scheduleNoticeOverflow: overflow.scheduleNoticeOverflow,
	});

	runtime.notifyParentRunStart();
	// First notice: enqueued at t=1000, arming the cap for the full window.
	runtime.track({
		name: "older",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/older.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "older-out" }),
	});
	runtime.watch("older");
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "first notice held");
	assert.equal(overflow.timers.length, 1);
	assert.equal(overflow.timers[0]!.ms, MAX_PENDING_AGE_MS, "armed off the first notice");

	// 30s later a SECOND notice joins the queue while the arm is already live.
	// `armOutboxTimer` is a no-op now (a live handle exists), so the arm keeps the
	// FIRST notice's deadline — the correct behaviour, and what pins 「oldest」.
	t += 30_000;
	runtime.track({
		name: "newer",
		runId: "r-2",
		agent: "worker",
		sessionFile: "/tmp/newer.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "newer-out" }),
	});
	runtime.watch("newer");
	await waitFor(() => runtime.noticeQueueStats().pending === 2, "second notice held");
	assert.equal(overflow.timers.length, 1, "the live arm is not re-armed by a later notice");
	assert.equal(
		overflow.timers[0]!.ms,
		MAX_PENDING_AGE_MS,
		"the arm still carries the FIRST notice's full cap, not the newer one's",
	);
	assert.equal(
		runtime.noticeQueueStats().oldestAgeMs,
		30_000,
		"oldestAgeMs reports the FIRST notice (30s), not the second (0s)",
	);

	// At the first notice's cap the whole queue is force-flushed in FIFO order.
	t += MAX_PENDING_AGE_MS - 30_000;
	overflow.timers[0]!.fn();
	assert.equal(messages.length, 2, "the cap flushes both notices");
	assert.match((messages[0] as { content: string }).content, /older/);
	assert.match((messages[1] as { content: string }).content, /newer/);
	assert.equal(runtime.noticeQueueStats().forcedFlushes, 1, "one flush for the queue");
	assert.equal(runtime.noticeQueueStats().pending, 0);
	runtime.dispose();
});

test("T3c: runtime — a stale arm that fires after its cancel is a no-op (B2 zombie guard)", async () => {
	const messages: unknown[] = [];
	const overflow = manualOverflow();
	// T3c (reviewer-4): an ADVANCEABLE clock, not `() => 1_000`. With a frozen
	// clock the age branch (`now() < next.enqueuedAt + MAX`) always re-arms and
	// soaks up the zombie's mistake, which is why deleting the live-handle guard
	// at runtime.ts kept this test green. Pushing `t` past the cap before the
	// zombie fires removes that safety net: only the handle identity check can
	// keep the zombie inert now.
	let t = 1_000;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
		now: () => t,
		scheduleNoticeOverflow: overflow.scheduleNoticeOverflow,
	});

	runtime.notifyParentRunStart();
	runtime.track({
		name: "zombie",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/zombie.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "zombie-out" }),
	});
	runtime.watch("zombie");
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "notice held");
	assert.equal(overflow.timers.length, 1);

	// Settle: cancels the arm and delivers the notice.
	runtime.notifyParentSettled();
	assert.equal(overflow.timers[0]!.canceled, true, "settle cancelled the arm");
	assert.equal(messages.length, 1);
	assert.equal(runtime.noticeQueueStats().pending, 0);

	// The cancelled callback fires anyway (a real timer can be queued before the
	// cancel lands). It must not re-send, and it must not increment the counter.
	overflow.timers[0]!.fn();
	assert.equal(messages.length, 1, "a zombie arm never double-delivers");
	assert.equal(runtime.noticeQueueStats().forcedFlushes, 0, "a zombie arm is not counted");

	// A second notice must arm a FRESH timer; if the zombie had clobbered the
	// handle, this arm would be skipped and the notice would hang forever.
	runtime.notifyParentRunStart();
	runtime.track({
		name: "second",
		runId: "r-2",
		agent: "worker",
		sessionFile: "/tmp/second.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "second-out" }),
	});
	runtime.watch("second");
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "second notice held");
	assert.equal(overflow.timers.length, 2, "a fresh arm is scheduled after the zombie fired");

	// The discriminating part: fire the ZOMBIE arm again now that the outbox is
	// NON-empty AND the fresh notice is past its cap. An unguarded callback would
	// force-send a notice that belongs to a later wave and count a bogus flush —
	// neither the empty-outbox guard (the outbox is non-empty) nor the age branch
	// (the age is now past the cap) can absorb it. The live-handle check must.
	t += MAX_PENDING_AGE_MS;
	overflow.timers[0]!.fn();
	assert.equal(messages.length, 1, "the zombie must not flush the fresh notice");
	assert.equal(runtime.noticeQueueStats().forcedFlushes, 0, "a zombie is never counted");
	assert.equal(runtime.noticeQueueStats().pending, 1, "the fresh notice is still held");
	runtime.dispose();
});

test("T4: runtime — agent_settled cancels the overflow timer and does not double-send", async () => {
	const messages: unknown[] = [];
	const overflow = manualOverflow();
	// B2: the send is counted by CALLS, and the settle→late-fire window is a real
	// macrotask tick. With a no-op `cancel()` and no tick, the old assertion
	// (`messages.length === 1`) was satisfied by the empty-outbox guard alone and
	// could never go red. Here delivery is counted per host call, so a second
	// delivery would be visible even if the outbox were re-populated.
	let sends = 0;
	let resolveCollect!: (value: CollectSnapshot) => void;
	// An advanceable clock: the B2 tail below pushes it past the cap so the age
	// re-arm branch cannot mask a broken cancel.
	let t = 1_000;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			sends += 1;
			messages.push(message);
		},
		now: () => t,
		scheduleNoticeOverflow: overflow.scheduleNoticeOverflow,
	});

	runtime.notifyParentRunStart();
	runtime.track({
		name: "raced",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/raced.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
	});
	runtime.watch("raced");
	resolveCollect(joinSnapshot());
	await waitFor(() => overflow.timers.length === 1, "overflow armed");

	runtime.notifyParentSettled();
	assert.equal(overflow.timers[0]!.canceled, true, "settle cancels the pending cap");
	assert.equal(sends, 1, "settle delivered it once");

	// Let a real macrotask pass so any deferred duplicate would have landed,
	// then fire the (cancelled) arm. Both together must leave exactly one send.
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(sends, 1, "no deferred duplicate after the settle macrotask");
	overflow.timers[0]!.fn();
	assert.equal(sends, 1, "no duplicate delivery after the settle");
	assert.equal(runtime.noticeQueueStats().forcedFlushes, 0, "the cap never counted");

	// B2 (reviewer-4): refill the outbox AFTER the settle, then fire the OLD
	// zombie arm again. With a NO-OP `cancel()` the zombie clears the handle of
	// the fresh arm and force-sends a notice that should still be waiting — the
	// empty-outbox guard cannot save us here, because the outbox is non-empty.
	// The clock is advanced past the cap first: with a frozen clock the age
	// re-arm branch would absorb the zombie and this tail would stay green even
	// with `cancel()` disabled (verified — that is exactly T3c's old hole, and
	// adding it here without the clock would just repeat the bug).
	let sendSecond!: (value: CollectSnapshot) => void;
	runtime.notifyParentRunStart();
	runtime.track({
		name: "second-wave",
		runId: "r-2",
		agent: "worker",
		sessionFile: "/tmp/second-wave.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				sendSecond = resolve;
			}),
	});
	runtime.watch("second-wave");
	sendSecond(joinSnapshot({ output: "second-wave-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "second notice held");
	assert.equal(overflow.timers.length, 2, "the fresh notice armed a new timer");

	// Fire the stale arm from the settled wave, now that the fresh notice is PAST
	// its cap. It must be inert: no send, no forced flush, and the fresh notice
	// must still be pending.
	t += MAX_PENDING_AGE_MS;
	overflow.timers[0]!.fn();
	assert.equal(sends, 1, "the zombie arm must not deliver the fresh notice");
	assert.equal(runtime.noticeQueueStats().forcedFlushes, 0, "the zombie is never counted as a flush");
	assert.equal(runtime.noticeQueueStats().pending, 1, "the fresh notice is still held");
	runtime.dispose();
});

test("T4b: runtime — cap fires FIRST, then agent_settled arrives: exactly one send, one forced flush (B3)", async () => {
	// The D-B × D-D crossing that nothing covered: the hard cap wins the race
	// against `agent_settled`. Both paths run; the notice must be delivered once
	// (by the cap) and the later settle must find an empty outbox.
	const messages: unknown[] = [];
	const overflow = manualOverflow();
	let t = 1_000;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
		now: () => t,
		scheduleNoticeOverflow: overflow.scheduleNoticeOverflow,
	});

	runtime.notifyParentRunStart();
	runtime.track({
		name: "capped",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/capped.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "capped-out" }),
	});
	runtime.watch("capped");
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "notice held");
	assert.equal(messages.length, 0, "held while the run is live");

	// 1) cap fires (at the cap) while the run is STILL active → force-send.
	t += MAX_PENDING_AGE_MS;
	overflow.timers[0]!.fn();
	assert.equal(messages.length, 1, "the cap delivers during the live run");
	assert.equal(runtime.noticeQueueStats().forcedFlushes, 1, "counted as a forced flush");
	assert.equal(runtime.noticeQueueStats().pending, 0);

	// 2) settle arrives afterwards → nothing left to flush, no second send.
	runtime.notifyParentSettled();
	assert.equal(messages.length, 1, "the later settle must not re-deliver");
	assert.equal(runtime.noticeQueueStats().forcedFlushes, 1, "still exactly one forced flush");
	assert.equal(runtime.noticeQueueStats().pending, 0);
	runtime.dispose();
});

test("T5: runtime — a cancelled watch whose collect lands later stays tracked; stop owns the release", async () => {
	// Baseline semantics, pinned deliberately. `cancelWatch` bumps the generation
	// and clears `watching` WITHOUT releasing, because it exists for exactly one
	// caller: `stopAction`, which releases on a successful retire and `rewatch`es
	// on a failed one. So a continuation that lands after the cancel must be a
	// no-op: the release belongs to `stop`, not to the stale continuation. This
	// test pins that contract, so a future "clean up the orphan" change has to
	// argue with a red test first.
	let resolveCollect!: (value: CollectSnapshot) => void;
	const runtime = createSessionRuntime({ sendMessage() {} });

	runtime.track({
		name: "ghost",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/ghost.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
	});
	runtime.watch("ghost");
	assert.equal(runtime.activeJobs().length, 1);

	// cancelWatch bumps the generation and clears `watching` but never releases
	// (stop() semantics).
	runtime.cancelWatch("ghost");
	assert.equal(runtime.get("ghost")?.watching, false);

	// The in-flight collect still resolves, but its generation is stale.
	resolveCollect(joinSnapshot());
	await drainContinuations();
	const survivor = runtime.get("ghost");
	assert.ok(survivor, "the job is still tracked: releasing is stop()'s job, not the watch's");
	assert.equal(
		runtime.activeJobs().length,
		1,
		"a stale continuation must not release the job behind stop()'s back",
	);
	assert.equal(survivor.watching, false, "the watcher stays dropped");
	runtime.dispose();
});

test("T6: runtime — a stale continuation never touches a job a newer watch owns", async () => {
	const messages: Array<{ content: string }> = [];
	const resolvers: Array<(value: CollectSnapshot) => void> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as { content: string });
		},
	});

	runtime.track({
		name: "owned",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/owned.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolvers.push(resolve);
			}),
	});
	runtime.watch("owned");
	// A newer watch takes the job over (generation 2) — this is the `rewatch`
	// path: the old generation's continuation must not release it (the `finally`
	// release is generation-guarded) and must not notify.
	runtime.rewatch("owned");
	const job = runtime.get("owned");
	assert.ok(job);
	assert.equal(job.generation, 2, "rewatch bumped the generation");
	assert.equal(job.watching, true);

	resolvers[0]!(joinSnapshot({ output: "stale" }));
	// B5: a happens-before drain, not a fixed 20ms sleep. Resolving the stale
	// collect queues its continuations as microtasks; one setImmediate turn
	// guarantees they have all run, on any machine speed. A fixed sleep is only
	// "probably enough" — which is exactly how the old guard stayed fake-green.
	await drainContinuations();
	assert.equal(runtime.activeJobs().length, 1, "the stale continuation must not release the job");
	assert.equal(runtime.get("owned")?.watching, true, "the newer watch still owns it");
	assert.equal(messages.length, 0, "the stale snapshot is never notified");

	resolvers[1]!(joinSnapshot({ output: "live" }));
	await waitFor(() => messages.length === 1, "the live watch notifies");
	assert.match(messages[0]!.content, /live/);
	assert.equal(messages.length, 1, "exactly one notice from the owning watch");
	runtime.dispose();
});

test("T7: runtime — without a run-start signal a completion is still sent immediately", async () => {
	const messages: Array<{ content: string }> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as { content: string });
		},
	});

	// D-H: `parentRunActive` defaults to false, so a host (or test) that never
	// announces a run keeps today's immediate-send behaviour. Flip this default
	// and every existing caller silently stops delivering.
	runtime.track({
		name: "immediate",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/immediate.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "no-run-signal" }),
	});
	runtime.watch("immediate");
	await waitFor(() => messages.length === 1, "immediate notify without a run signal");
	assert.match(messages[0]!.content, /Background task completed/);
	assert.equal(runtime.noticeQueueStats().pending, 0, "nothing was held");
	runtime.dispose();
});

test("C4: runtime — dispose() drops the held outbox without sending", async () => {
	const messages: unknown[] = [];
	const overflow = manualOverflow();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
		scheduleNoticeOverflow: overflow.scheduleNoticeOverflow,
	});

	runtime.notifyParentRunStart();
	runtime.track({
		name: "held-at-shutdown",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/held.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "never-sent" }),
	});
	runtime.watch("held-at-shutdown");

	await waitFor(() => runtime.noticeQueueStats().pending === 1, "notice held");
	assert.equal(messages.length, 0, "nothing was sent during the live run");

	runtime.dispose();
	assert.equal(runtime.noticeQueueStats().pending, 0, "dispose discards the outbox");
	assert.equal(messages.length, 0, "dispose must not deliver a dropped notice");
	// The cancelled arm is a real timer in production; dispose must cancel it
	// rather than leave it to fire after the session is gone.
	assert.equal(overflow.timers[0]!.canceled, true, "dispose cancels the pending overflow arm");
});

// ═════ D-D①②③ repaint guards: the pinned defence against a stuck "working" row ═════
//
// After the D-D④ revert these three `refreshUi()` calls are the pinned code
// defence against the 「界面一直 working」 symptom: the watch continuation flips
// the job to a terminal state, and nothing else repaints until the sampler ticks
// (500ms default) — long enough for a phantom row to be the thing the user sees.
// Each test below therefore pins the repaint AT the flip, and each was verified
// to go RED when its own `refreshUi()` is deleted (see the report).
//
// Scope note: three of the terminal-flip repaints are pinned here, not all of
// them. Two same-family repaints remain uncovered on purpose-of-time, not by
// design: the transient-connection re-arm repaint and the catch-path flip that
// also lands on `awaiting`. Deleting either one keeps the suite green today, so
// do not read these guards as "every flip is covered".

/** A UI double that stores the widget factory and counts repaint requests. */
function captureBoard(): {
	ui: StatusUi;
	requestRenderCount: () => number;
	lastRender: () => string;
} {
	let component: { render(width?: number): string[] } | undefined;
	let renders = 0;
	const rendered: string[] = [];
	const ui: StatusUi = {
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus() {},
			setWidget: (_key, content) => {
				if (typeof content === "function") {
					component = content(
						{
							requestRender() {
								renders += 1;
								rendered.push(component!.render().join("\n"));
							},
						},
						{ fg: (_color: string, text: string) => text },
					);
				}
			},
		},
	};
	return {
		ui,
		requestRenderCount: () => renders,
		lastRender: () => rendered.at(-1) ?? "",
	};
}

test("T-R1: an awaiting flip repaints AT the flip, before the notice and before the release", async () => {
	// The discriminator is NOT "busy eventually goes false" — `release()` repaints
	// too, so a deleted guard still ends up clearing the row a few microtasks
	// later. Three independent facts pin the repaint to the flip itself:
	//   1. it fires BEFORE the completion notice (the notice is delivered further
	//      down the same synchronous block, after the flip's refreshUi),
	//   2. at that moment the job is still tracked, still in state "awaiting"
	//      (release() repaints only after `jobs.delete`, so it cannot fake this),
	//   3. `refreshMs` is 700s, so the sampler cannot have supplied either.
	const timeline: string[] = [];
	const seen: Array<{ active: boolean; label?: string; state?: string; tracked: boolean }> = [];
	let resolveCollect!: (value: CollectSnapshot) => void;
	let runtimeRef: { get(name: string): { state: string } | undefined } | undefined;
	const runtime = createSessionRuntime({
		sendMessage() {
			timeline.push("send");
		},
		emitBusy(active, label) {
			timeline.push(active ? "busy" : "idle");
			const job = runtimeRef?.get("worker-0");
			seen.push({ active, label, state: job?.state, tracked: job !== undefined });
		},
		getTreeIdentity: (name) => ({ nodeId: `root.${name}`, parentId: "root", depth: 1 }),
		now: () => 1_000,
		// 1400× the 500ms sampler: the interval cannot fire inside this test, so
		// anything observed here came from the watch flow, not the sampler.
		refreshMs: 700_000,
	});
	runtimeRef = runtime;

	runtime.track({
		name: "worker-0",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
	});
	runtime.watch("worker-0");
	assert.deepEqual(
		{ last: timeline.at(-1), label: seen.at(-1)?.label },
		{ last: "busy", label: "1 subagent (worker-0)" },
		"a working child raises busy before the flip",
	);

	resolveCollect(snapshot());
	await waitFor(() => timeline.includes("send"), "completion delivered");

	const idle = seen.find((entry) => entry.active === false);
	assert.ok(idle, "the terminal flip cleared busy");
	assert.ok(
		timeline.indexOf("idle") < timeline.indexOf("send"),
		`the repaint must land at the flip, before the notice (timeline: ${timeline.join(" → ")})`,
	);
	assert.equal(
		idle.state,
		"awaiting",
		"the repaint ran while the job was still tracked in `awaiting`; a release-time repaint would see the job already gone",
	);
	assert.equal(idle.tracked, true, "the flip repaint sees the job, the release repaint does not");
	assert.equal(
		timeline.filter((event) => event === "idle").length,
		1,
		"exactly one busy-clear: the flip's repaint does the work and release has nothing left to say",
	);
	runtime.dispose();
});

test("T-R4: a collect FAILURE repaints at its awaiting flip too (catch path, not the success path)", async () => {
	// T-R1 exercises the success branch's flip. The catch branch has its own
	// `refreshUi()` (a rejected collect is a terminal failure), and it used to be
	// completely uncovered: deleting it left the whole suite green. Same three
	// discriminators as T-R1, applied to a rejecting collect.
	const timeline: string[] = [];
	const seen: Array<{ active: boolean; label?: string; state?: string; tracked: boolean }> = [];
	let rejectCollect!: (error: Error) => void;
	let runtimeRef: { get(name: string): { state: string } | undefined } | undefined;
	const runtime = createSessionRuntime({
		sendMessage() {
			timeline.push("send");
		},
		emitBusy(active, label) {
			timeline.push(active ? "busy" : "idle");
			const job = runtimeRef?.get("worker-0");
			seen.push({ active, label, state: job?.state, tracked: job !== undefined });
		},
		getTreeIdentity: (name) => ({ nodeId: `root.${name}`, parentId: "root", depth: 1 }),
		now: () => 1_000,
		refreshMs: 700_000,
	});
	runtimeRef = runtime;

	runtime.track({
		name: "worker-0",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((_resolve, reject) => {
				rejectCollect = reject;
			}),
	});
	runtime.watch("worker-0");
	assert.equal(timeline.at(-1), "busy", "a working child raises busy before the failure");

	rejectCollect(new Error("collect exploded"));
	await waitFor(() => timeline.includes("send"), "failure notice delivered");

	const idle = seen.find((entry) => entry.active === false);
	assert.ok(idle, "the failure flip cleared busy");
	assert.ok(
		timeline.indexOf("idle") < timeline.indexOf("send"),
		`the failure repaint must land at the flip, before the notice (timeline: ${timeline.join(" → ")})`,
	);
	assert.equal(idle.state, "awaiting", "the repaint ran while the job was still tracked in `awaiting`");
	assert.equal(idle.tracked, true, "the catch-path flip repaint sees the job, a release repaint would not");
	runtime.dispose();
});

test("T-R2: a blocked flip repaints immediately (blocked stays busy, so the paint is the only signal)", async () => {
	// `blocked` ∈ ACTIVE_STATES, so the busy label is identical before and after
	// the flip — an emitBusy-only assertion cannot distinguish "repainted" from
	// "never repainted". The observable that CAN is the board: the flip's
	// `refreshUi()` asks the TUI to render, and that render shows `blocked`.
	// Without the guard, nothing asks for a render (the held job keeps the same
	// busy label, and the `hold` path skips the finally release), so the row
	// stays on the pre-blocked frame until the sampler ticks.
	const board = captureBoard();
	const busy: Array<{ active: boolean; label?: string }> = [];
	let resolveCollect!: (value: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage() {},
		emitBusy(active, label) {
			busy.push({ active, label });
		},
		getTreeIdentity: (name) => ({ nodeId: `root.${name}`, parentId: "root", depth: 1 }),
		now: () => 1_000,
		refreshMs: 700_000,
	});
	runtime.bind(board.ui);
	runtime.track({
		name: "waiting",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/waiting.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
		// Never answers: the job holds in `blocked`, which is exactly the state
		// the row must show while the parent decides.
		handleBlocked: () => new Promise<"resume" | "hold">(() => {}),
	});
	runtime.watch("waiting");
	// track() registers the widget; watch()'s repaint is the first requestRender.
	const repaintsBeforeFlip = board.requestRenderCount();
	const busyBeforeFlip = busy.length;

	resolveCollect(joinSnapshot({ execution: { status: "running", reason: "blocked" }, blocked: true }));
	await waitFor(() => runtime.get("waiting")?.state === "blocked", "job flipped to blocked");

	assert.equal(
		board.requestRenderCount(),
		repaintsBeforeFlip + 1,
		"the blocked flip must request exactly one repaint",
	);
	assert.match(board.lastRender(), /blocked/, "the repaint carries the blocked status");
	assert.equal(
		busy.length,
		busyBeforeFlip + 1,
		"the blocked flip re-emits busy (same label — which is why the label alone cannot discriminate)",
	);
	assert.equal(busy.at(-1)?.active, true, "blocked is an active state");
	assert.equal(busy.at(-1)?.label, "1 subagent (waiting)", "label reflects the held child");
	runtime.dispose();
});

test("T-R3: notifyParentSettled repaints synchronously inside the settle call", async () => {
	// The settle burst is the end of the hidden-notice window: the same call must
	// also repaint, or the panel keeps whatever frame it had while the run was
	// live. A live sibling keeps `busyRaised` true across the finished child's
	// release, so the repaint is observable; the label proves it re-read the
	// roster (the finished child is gone, the live one remains).
	const messages: unknown[] = [];
	const busy: Array<{ active: boolean; label?: string }> = [];
	let resolveCollect!: (value: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
		emitBusy(active, label) {
			busy.push({ active, label });
		},
		getTreeIdentity: (name) => ({ nodeId: `root.${name}`, parentId: "root", depth: 1 }),
		now: () => 1_000,
		refreshMs: 700_000,
	});

	runtime.notifyParentRunStart();
	runtime.track({
		name: "held",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/held.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
	});
	runtime.track({
		name: "live",
		runId: "r-2",
		agent: "worker",
		sessionFile: "/tmp/live.jsonl",
		timeoutMs: 1_000,
		collect: () => new Promise<CollectSnapshot>(() => {}),
	});
	runtime.watch("held");
	runtime.watch("live");
	resolveCollect(joinSnapshot({ output: "held-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "notice held in the outbox");
	assert.equal(messages.length, 0, "a live parent run holds the notice");
	assert.equal(busy.at(-1)?.label, "1 subagent (live)", "only the live sibling is active");

	const before = busy.length;
	runtime.notifyParentSettled();
	const after = busy.length;

	assert.equal(messages.length, 1, "the settle flushed the held notice");
	assert.ok(
		after > before,
		"notifyParentSettled must repaint synchronously — a repaint left to the sampler is the 「界面一直 working」 bug",
	);
	assert.equal(
		busy.at(-1)?.label,
		"1 subagent (live)",
		"the settle repaint re-read the roster instead of replaying the pre-settle frame",
	);
	runtime.dispose();
});

test("F1: track() reuses the live job object in place, so a name never holds two generations", async () => {
	// Reviewer-5 probe: `track()` on a live name returns the SAME object
	// (`diff objects: false`) and never resets `generation`. That is what makes
	// the original F1 failure mode — a stale continuation releasing a job the map
	// no longer owns — structurally unreachable: two objects can never share one
	// name, so the numeric generation comparison cannot collide across objects.
	// Nothing tested it, so a "new object per track()" refactor would revive F1
	// silently. This test is that argument.
	const messages: SentMessage[] = [];
	const resolvers: Array<(value: CollectSnapshot) => void> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	const input = (runId: string) => ({
		name: "w",
		runId,
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolvers.push(resolve);
			}),
	});

	const first = runtime.track(input("r-1"));
	const second = runtime.track(input("r-1"));
	assert.equal(second, first, "track() must reuse the live object, not mint a second one under the same name");
	assert.equal(runtime.get("w"), first, "the map still points at the original object");
	assert.equal(runtime.activeJobs().length, 1, "one name = one job object");
	assert.equal(second.generation, first.generation, "track() must not reset the generation counter");

	runtime.watch("w");
	assert.equal(runtime.get("w")!.generation, 1, "watch() bumped the generation on the reused object");
	runtime.track(input("r-1"));
	assert.equal(
		runtime.get("w")!.generation,
		1,
		"re-tracking a live name preserves the bumped generation (a reset would let a stale continuation look current)",
	);

	// A stale continuation must not misfire: cancel bumps the generation, so the
	// in-flight collect that lands afterwards is silent.
	runtime.cancelWatch("w");
	resolvers[0]!(joinSnapshot({ output: "stale" }));
	await drainContinuations();
	assert.equal(messages.length, 0, "the stale generation's continuation must not notify");
	assert.equal(runtime.get("w"), first, "and it must not release the object either");
	runtime.dispose();
});

// ═════ C2b restored: stopAction's retire-failure compensation (baseline contract) ═════
//
// This test was deleted together with D-D④, but it asserts a BASELINE contract
// (d5b9d74 `index.ts` stop loop: `catch { if (runtime.get(name)) runtime.rewatch(name) }`),
// not the reverted mechanism. It is also end-to-end on purpose: the real
// `stopAction` export drives cancelWatch → failed retire → compensation, so a
// regression anywhere in that chain is visible here, which a hand-rolled
// track/watch test cannot claim.

test("C2b: stopAction — a failed retire leaves the child tracked and watching", async () => {
	const { stopAction } = await import("../../index.ts");
	let resolveCollect!: (value: CollectSnapshot) => void;
	const runtime = createSessionRuntime({ sendMessage() {} });

	runtime.track({
		name: "stubborn",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/stubborn.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
	});
	runtime.watch("stubborn");
	assert.equal(runtime.get("stubborn")?.watching, true, "the child starts out watched");

	const result = await stopAction({
		params: { name: "stubborn" },
		runtime,
		retire: async () => {
			// The in-flight collect lands inside the retire window: the stale
			// continuation must not tidy the job away behind stop's back.
			resolveCollect(joinSnapshot({ output: "late" }));
			await new Promise((resolve) => setTimeout(resolve, 0));
			throw new Error("retire failed: child did not respond");
		},
	});

	const text = (result.content as Array<{ text?: string }>)
		.map((part) => part.text ?? "")
		.join("\n");
	assert.match(text, /No children were stopped/, "the stop reports the failure");
	assert.match(text, /retire failed: child did not respond/);

	// HARD ACCEPTANCE: the failed retire must not orphan a live child.
	const survivor = runtime.get("stubborn");
	assert.ok(
		survivor,
		"the live child must remain tracked after a failed retire (an orphan here is invisible to stop and session_shutdown)",
	);
	assert.equal(
		survivor.watching,
		true,
		"stopAction's rewatch compensation restored the watcher, so the eventual completion still surfaces",
	);
	runtime.dispose();
});

// ── #238: one snapshot per event burst, not two per event ────────────────

/** A `getTreeNodes` double that counts reads, so a burst's snapshot cost is observable. */
function countingTree(nodes: TreeNodeSnapshot[]): {
	getTreeNodes: () => TreeNodeSnapshot[];
	calls: () => number;
} {
	let calls = 0;
	return {
		getTreeNodes: () => {
			calls += 1;
			return nodes;
		},
		calls: () => calls,
	};
}

/** Single drain point for a coalesced flush: longer than the microtask queue. */
async function settleFlush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

test("#238: a burst of events in one tick costs ONE tree snapshot, not 2 per event", async () => {
	// The core regression: `onWidgetEvent` used to call `snapshotNodes()`
	// directly and then `refreshUi()` → `statusEntries()` → `snapshotNodes()`
	// again, so N back-to-back events cost 2N recursive-CTE subtree scans plus
	// 2N usage batch queries. `legion-tools.ts` emits N `mail_sent` events in a
	// synchronous loop, which is exactly this shape.
	//
	// Deliberately asserted on the call COUNT, not on elapsed time: a wall-clock
	// assertion would be flaky on a busy box, and the snapshot count IS the cost.
	const nodes = [statusTreeNode("root", null, "root", 0), statusTreeNode("root.worker", "root", "worker", 1)];
	const counting = countingTree(nodes);
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: counting.getTreeNodes,
		now: () => 50_000,
	});
	try {
		const atBurstStart = counting.calls();
		// One synchronous tick: 20 events, no await between them.
		for (let i = 0; i < 20; i += 1) {
			eventBus.emit({ nodeId: "root.worker", type: "phase_change", data: { from: "planning", to: i % 2 === 0 ? "implementing" : "planning" }, ts: 40_000 + i });
		}
		// Leading snapshot only: the flush is still pending, so no paint path ran.
		assert.equal(
			counting.calls() - atBurstStart,
			1,
			"the burst start takes exactly one snapshot (for applyTreeEvent's `tree` read), not one per event",
		);
		await settleFlush();
		assert.equal(
			counting.calls() - atBurstStart,
			2,
			"the flushed burst costs 2 snapshots total (leading + one paint) — master cost 40 for these 20 events",
		);
		assert.ok(
			counting.calls() - atBurstStart < 20,
			"a burst must be cheaper than one snapshot per event, which is the whole point of the coalescing",
		);
	} finally {
		runtime.dispose();
	}
});

test("#238: coalescing does not mean 'never refresh' — a single event still snapshots and paints", async () => {
	// Control for the test above: an implementation that batched and then never
	// flushed would satisfy "few snapshots" while breaking the widget.
	const nodes = [statusTreeNode("root", null, "root", 0), statusTreeNode("root.worker", "root", "worker", 1)];
	const counting = countingTree(nodes);
	const board = captureBoard();
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: counting.getTreeNodes,
		now: () => 50_000,
	});
	runtime.bind(board.ui);
	try {
		const atBurstStart = counting.calls();
		const repaintsBefore = board.requestRenderCount();
		eventBus.emit({ nodeId: "root.worker", type: "phase_change", data: { from: "planning", to: "implementing" }, ts: 40_000 });
		await settleFlush();
		assert.equal(
			counting.calls() - atBurstStart,
			2,
			"a lone event behaves exactly like a lone burst: one leading snapshot + one paint snapshot",
		);
		assert.ok(
			board.requestRenderCount() > repaintsBefore,
			"the flush must actually paint, not just snapshot",
		);
		// The paint carries the event's fact: the flush re-read the ledger snapshot
		// that `applyTreeEvent` overrode, so the phase reaches the board.
		assert.equal(
			runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.phase,
			"implementing",
			"the flushed snapshot carries the event's phase override",
		);
	} finally {
		runtime.dispose();
	}
});

test("#238: a burst keeps applyTreeEvent's per-event order, so turn_start/agent_settled still compute the same state", async () => {
	// D2: `applyTreeEvent` is a state machine, not a render. `turn_start` bumps
	// the turn and clears the frozen endpoint; `agent_settled` freezes it; a
	// second settle must not move it; the next turn_start clears it again. The
	// coalescing defers ONLY the snapshot/paint, so all of it must still hold —
	// and it must hold for events arriving inside ONE tick, which is the case
	// the old per-event flush happened to cover by accident.
	const nodes = [statusTreeNode("root", null, "root", 0), statusTreeNode("root.worker", "root", "worker", 1)];
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: () => nodes,
		now: () => 50_000,
	});
	try {
		const entry = () => runtime.statusEntries().find((item) => item.nodeId === "root.worker");
		// Same sequence as the pre-existing "turn_start resets a frozen current
		// turn" test, but with every emit inside one synchronous burst.
		eventBus.emit({ nodeId: "root.worker", type: "turn_start", data: { turn: 2 }, ts: 40_000 });
		eventBus.emit({ nodeId: "root.worker", type: "agent_settled", data: null, ts: 46_000 });
		eventBus.emit({ nodeId: "root.worker", type: "agent_settled", data: null, ts: 49_000 });
		await settleFlush();
		assert.equal(entry()?.turns, 2, "turn_start's increment survived the coalesced flush");
		assert.equal(entry()?.currentTurnStartedAt, 40_000);
		assert.equal(
			entry()?.currentTurnEndedAt,
			46_000,
			"the FIRST settle froze the endpoint and the second (later, ts=49_000) did not move it",
		);

		// A later turn_start clears the frozen endpoint again, in its own tick.
		eventBus.emit({ nodeId: "root.worker", type: "turn_start", data: { turn: 3 }, ts: 48_000 });
		await settleFlush();
		assert.equal(entry()?.turns, 3);
		assert.equal(entry()?.currentTurnStartedAt, 48_000);
		assert.equal(entry()?.currentTurnEndedAt, undefined, "a new turn clears the frozen endpoint");
	} finally {
		runtime.dispose();
	}
});

test("#238: the burst-start snapshot is what applyTreeEvent reads — a node created mid-cycle is visible to its first event", async () => {
	// D2's trap, isolated. `applyTreeEvent` guards on `tree.get(event.nodeId)`,
	// and `tree` is populated ONLY by `snapshotNodes()`. If the implementation
	// deferred the snapshot to the end of the burst, the first event of a tick
	// would be applied against the previous tick's tree: a node launched since
	// then is absent, so its launch event is silently dropped. This pins the
	// leading snapshot: the tree grows between two ticks, and the very first
	// event of the second tick must still land.
	let nodes = [statusTreeNode("root", null, "root", 0)];
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: () => nodes,
		now: () => 50_000,
	});
	try {
		// Tick 1 establishes the one-node tree.
		eventBus.emit({ nodeId: "root", type: "phase_change", data: { from: "planning", to: "implementing" }, ts: 40_000 });
		await settleFlush();
		// The ledger row starts non-running, so "the event landed" is distinguishable
		// from the fixture's default. (`statusTreeNode()` defaults to "running", which
		// would make a "running" assertion pass even if the event were dropped.)
		nodes = [...nodes, { ...statusTreeNode("root.worker", "root", "worker", 1), status: "starting" }];
		// Tick 2, event #1 targets the node that did not exist at the last snapshot.
		eventBus.emit({ nodeId: "root.worker", type: "node_launched", data: null, ts: 41_000 });
		eventBus.emit({ nodeId: "root.worker", type: "phase_change", data: { from: "planning", to: "implementing" }, ts: 42_000 });
		await settleFlush();
		const worker = runtime.treeNodes().find((node) => node.id === "root.worker");
		assert.equal(
			worker?.status,
			"running",
			"node_launched applied (the row said starting; a dropped event would leave it starting)",
		);
		assert.equal(worker?.phase, "implementing", "the later event of the same burst also landed");
	} finally {
		runtime.dispose();
	}
});

test("#238: within one burst the LAST forward event wins and a stale one is still vetoed", async () => {
	// NOTE the scope: this covers a burst with NO mid-burst ledger write, where the
	// coalesced paint does equal a per-event re-read. It is NOT a claim that any
	// burst converges — the mid-burst-write case is pinned (and deliberately shown
	// to diverge) by the "KNOWN LIMITATION" test below.
	//
	// Events 2..N are vetted against the tree as of burst start. Events that go
	// backwards in time must still be vetoed — that is `applyTreeEvent`'s own
	// guard, untouched here.
	const nodes = [statusTreeNode("root", null, "root", 0), statusTreeNode("root.worker", "root", "worker", 1)];
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: () => nodes,
		now: () => 50_000,
	});
	try {
		eventBus.emit({ nodeId: "root.worker", type: "phase_change", data: { from: "planning", to: "implementing" }, ts: 40_000 });
		eventBus.emit({ nodeId: "root.worker", type: "phase_change", data: { from: "implementing", to: "verifying" }, ts: 41_000 });
		eventBus.emit({ nodeId: "root.worker", type: "phase_change", data: { from: "verifying", to: "done" }, ts: 42_000 });
		await settleFlush();
		assert.equal(
			runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.phase,
			"done",
			"the flush paints the last event's state, not the first",
		);

		// A stale event (ts older than what already landed) must not win.
		eventBus.emit({ nodeId: "root.worker", type: "phase_change", data: { from: "done", to: "failed" }, ts: 30_000 });
		await settleFlush();
		assert.equal(
			runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.phase,
			"done",
			"an event older than the applied override is vetoed, burst or not",
		);
	} finally {
		runtime.dispose();
	}
});

test("#238: dispose() during the pending flush window neither reads the ledger nor repaints", async () => {
	// The flush is deferred, so `dispose()` can land in between — that window is
	// reachable (a burst opened, dispose called before the microtask drains).
	// `refreshUi()`'s own `if (disposed) return` is the single source of truth for
	// it; `scheduleTreeFlush` deliberately carries no second guard. Both halves are
	// asserted because they are guarded at different points: the snapshot happens
	// INSIDE `refreshUi()` after its guard, and the paint happens after that, so
	// dropping the guard is caught by the read count and by the repaint count.
	const nodes = [statusTreeNode("root", null, "root", 0), statusTreeNode("root.worker", "root", "worker", 1)];
	const counting = countingTree(nodes);
	const board = captureBoard();
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: counting.getTreeNodes,
		now: () => 50_000,
	});
	runtime.bind(board.ui);
	eventBus.emit({ nodeId: "root.worker", type: "node_launched", data: null, ts: 40_000 });
	const readsAtDispose = counting.calls();
	const repaintsAtDispose = board.requestRenderCount();
	runtime.dispose();
	await settleFlush();
	assert.equal(
		counting.calls(),
		readsAtDispose,
		"the pending flush was dropped after dispose instead of reading the ledger",
	);
	assert.equal(
		board.requestRenderCount(),
		repaintsAtDispose,
		"and it did not repaint a torn-down board",
	);
});

test("#238: only the paint is deferred — applyTreeEvent's state is readable synchronously after emit", async () => {
	// This is the guarantee that lets the two pre-existing synchronous tests
	// (runtime.test.ts "turn_start resets a frozen current turn", and
	// legion-integration.test.ts "session runtime paints injected machine facts")
	// stay byte-for-byte unchanged. Stating it as a test keeps it from being
	// weakened later by someone who reads "coalesced" as "deferred".
	//
	// The boundary is exact: `applyTreeEvent` runs inside the emit (so `tree`,
	// `eventOverrides` and `activity` are already updated), while the board paint
	// — the only thing `refreshUi()` does beyond re-reading those — is deferred.
	const nodes = [statusTreeNode("root", null, "root", 0), statusTreeNode("root.worker", "root", "worker", 1)];
	const board = captureBoard();
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: () => nodes,
		now: () => 50_000,
	});
	runtime.bind(board.ui);
	try {
		const repaintsBefore = board.requestRenderCount();
		eventBus.emit({ nodeId: "root.worker", type: "phase_change", data: { from: "planning", to: "implementing" }, ts: 40_000 });
		// NO await: exactly how both pre-existing tests read state.
		assert.equal(
			runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.phase,
			"implementing",
			"statusEntries() reflects the event synchronously — the state machine is not deferred",
		);
		assert.equal(
			runtime.treeNodes().find((node) => node.id === "root.worker")?.phase,
			"implementing",
			"treeNodes() reflects the event synchronously too",
		);
		assert.equal(
			board.requestRenderCount(),
			repaintsBefore,
			"only the board paint is deferred — that is the half the coalescing is allowed to touch",
		);
		await settleFlush();
		assert.ok(
			board.requestRenderCount() > repaintsBefore,
			"and the deferred paint does happen",
		);
	} finally {
		runtime.dispose();
	}
});

test("#238: a throw on the deferred paint is isolated like a bus handler error, not an uncaught crash", async () => {
	// The coalescing moved `refreshUi()` out of the bus handler's synchronous
	// dispatch window — and therefore out of the per-subscriber try/catch that
	// `createLegionEventBus` wraps around each handler. Before this guard, a
	// `getTreeNodes()` failure on the paint read (a real SQLITE_IOERR shape)
	// escaped the microtask as an uncaught exception and killed the host process,
	// where the inline `master` shape delivered it to `onHandlerError` and kept
	// running. A perf change must not upgrade a contained error to a crash.
	const nodes = [statusTreeNode("root", null, "root", 0), statusTreeNode("root.worker", "root", "worker", 1)];
	const failures: unknown[] = [];
	const eventBus = createLegionEventBus({ onHandlerError: (error) => { failures.push(error); } });
	let reads = 0;
	let failPaintRead = false;
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: () => {
			reads += 1;
			// Throw only on the flush read, i.e. the read the coalescing deferred.
			if (failPaintRead) throw new Error("SQLITE_IOERR: disk I/O error (paint read)");
			return nodes;
		},
		now: () => 50_000,
	});
	let uncaught: unknown;
	const onUncaught = (error: unknown) => { uncaught = error; };
	process.once("uncaughtException", onUncaught);
	try {
		eventBus.emit({ nodeId: "root.worker", type: "node_launched", data: null, ts: 40_000 });
		failPaintRead = true;
		// If the error escaped, this await would reject the process instead.
		await settleFlush();
		assert.equal(uncaught, undefined, "the deferred paint's throw must not reach the microtask queue as uncaught");
		assert.equal(failures.length, 1, "the throw is reported through the bus's own error channel");
		assert.match(
			String((failures[0] as Error).message),
			/SQLITE_IOERR/,
			"the original error reaches the reporter unreplaced",
		);
		// The runtime survives: a later event still paints normally.
		failPaintRead = false;
		reads = 0;
		eventBus.emit({ nodeId: "root.worker", type: "node_settled", data: null, ts: 41_000 });
		await settleFlush();
		assert.ok(reads > 0, "the board keeps refreshing after a failed paint");
		assert.equal(
			runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.state,
			"settled",
			"state still advances after the contained failure",
		);
	} finally {
		process.removeListener("uncaughtException", onUncaught);
		runtime.dispose();
	}
});

test("#266-liveness A6: a mid-burst ledger write no longer forks the painted status", async () => {
	// Replaces #238's "KNOWN LIMITATION pinned" test. That one asserted a measured
	// DIVERGENCE: the coalesced path could paint `settled` where a per-event re-read
	// would paint `retired`, because events 2..N were vetted against burst-start
	// facts and `snapshotNodes()` then DELETED an override that looked older than
	// the ledger row.
	//
	// display-liveness-v1 D3/D8 removes the race instead of documenting it: an
	// override is never judged against `node.updatedAt` (a different writer's
	// clock), and the trailing snapshot projects the row through `liveness()`
	// rather than ranking timestamps. So the painted status is a function of the
	// FACTS at paint time, not of the read sequence — which is the property this
	// case now pins.
	//
	// The scenario is unchanged, so the contrast with the old test is exact: a
	// sibling subscriber commits a newer row mid-burst.
	let row: TreeNodeSnapshot = { ...statusTreeNode("root.worker", "root", "worker", 1), status: "starting", updatedAt: 5 };
	const nodes = () => [statusTreeNode("root", null, "root", 0), row];
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: nodes,
		now: () => 50_000,
	});
	eventBus.on("node_settled", () => { row = { ...row, updatedAt: 20 }; });
	try {
		eventBus.emit({ nodeId: "root.worker", type: "node_settled", data: null, ts: 10 });
		eventBus.emit({ nodeId: "root.worker", type: "node_retired", data: null, ts: 30 });
		await settleFlush();

		// The child ENDED (`node_settled`). `node_retired` arriving after it must not
		// relabel an ended child as retired — the same rule #238 pinned, now for a
		// stated reason rather than as an accident of read order.
		assert.equal(
			runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.state,
			"settled",
			"a settled child stays settled: a later retire event may not relabel it",
		);

		// A6 (the property that replaced the limitation): reading the same facts
		// again gives the same answer, however many times, and a further event does
		// not resurrect the ended child.
		const first = runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.state;
		for (let i = 0; i < 100; i += 1) {
			assert.equal(
				runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.state,
				first,
				`projection is stable (§A6): read ${i + 2} disagreed with read 1`,
			);
		}
		eventBus.emit({ nodeId: "root.worker", type: "node_retired", data: null, ts: 31 });
		await settleFlush();
		assert.equal(
			runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.state,
			"settled",
			"still settled after another retire: the projection never promotes an ended child",
		);
	} finally {
		runtime.dispose();
	}
});

test("#238: a node whose ledger row lands MID-burst still gets its first event applied (leading snapshot alone is not enough)", async () => {
	// The leading snapshot closes the trap only at BURST START. A row that appears
	// between two events of ONE synchronous tick was still absent from `tree`, and
	// `applyTreeEvent` returns early on a `tree.get()` miss — and because
	// `node_launched` is a process-only event with no ledger row, the trailing
	// flush can never repair it.
	//
	// The insert has to happen INSIDE the burst to be a real mid-burst case: a row
	// that lands before the first emit is picked up by the leading snapshot and
	// proves nothing. A sibling bus subscriber doing the writing is the production
	// shape (another consumer of the same bus, e.g. an orchestrator that inserts a
	// node then emits its launch).
	const rootNode = statusTreeNode("root", null, "root", 0);
	let nodes = [rootNode];
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: () => nodes,
		now: () => 50_000,
	});
	// Registered AFTER the runtime's own subscription, so it runs after the
	// runtime handled event #1 — i.e. strictly inside the same burst.
	eventBus.on("mail_sent", () => {
		nodes = [...nodes, { ...statusTreeNode("root.worker", "root", "worker", 1), status: "starting" }];
	});
	try {
		// Event #1 opens the burst and, as a side effect, the row appears.
		eventBus.emit({ nodeId: "root", type: "mail_sent", data: null, ts: 40_000 });
		// Event #2, same tick, targets a node `tree` has never seen.
		eventBus.emit({ nodeId: "root.worker", type: "node_launched", data: null, ts: 41_000 });
		await settleFlush();
		assert.equal(
			runtime.treeNodes().find((node) => node.id === "root.worker")?.status,
			"running",
			"the unknown-node snapshot let node_launched apply; without it the event is dropped and the row stays 'starting'",
		);
	} finally {
		runtime.dispose();
	}
});

test("#238: a foreign-subtree burst costs no extra snapshots (shared-ledger poll batches are the normal case)", async () => {
	// `getTreeNodes()` is per-subtree (`getSubtree(db, identity.nodeId)`), but the
	// DbEventSource emits EVERY row on the shared legion.db. So a sibling
	// subtree's poll batch routinely delivers events whose `nodeId` this session
	// can never render — and that batch is exactly the "one synchronous emit loop"
	// this optimisation exists for.
	//
	// Paying an extra snapshot per unknown node made that shape cost 1 read per
	// event (41 reads for a 40-event foreign batch, vs master's 80): worse than the
	// per-event behaviour it replaced. The gate is subtree ownership, so an event
	// that can never create a node here costs zero extra reads.
	const ownNodes = [
		{ ...statusTreeNode("root.a", null, "a", 0), status: "running" as const },
		{ ...statusTreeNode("root.a.w0", "root.a", "w0", 1), status: "running" as const },
	];
	const counting = countingTree(ownNodes);
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: counting.getTreeNodes,
		now: () => 50_000,
	});
	try {
		const atBurstStart = counting.calls();
		// 40 events from a sibling subtree (root.b.*), all unknown to this runtime.
		for (let i = 0; i < 40; i += 1) {
			eventBus.emit({ nodeId: `root.b.w${i % 4}`, type: "mail_sent", data: { i }, ts: 40_000 + i });
		}
		assert.equal(
			counting.calls() - atBurstStart,
			1,
			"a foreign-subtree burst takes the leading snapshot only — NOT one extra read per foreign event",
		);
		await settleFlush();
		assert.equal(
			counting.calls() - atBurstStart,
			2,
			"and one flush: a 40-event foreign batch costs 2 reads (master cost 80, the buggy gate cost 41)",
		);
	} finally {
		runtime.dispose();
	}
});

test("#238: an in-subtree mid-burst node still gets created (the gate must not regress the trap)", async () => {
	// The complement of the test above: gating on ownership must keep the original
	// trap closed for nodes that ARE ours. A sibling subscriber inserts the row
	// between two events of ONE synchronous burst, so the leading snapshot cannot
	// have seen it; only the ownership check can admit the extra read.
	const rootNode = { ...statusTreeNode("root.a", null, "a", 0), status: "running" as const };
	let nodes: TreeNodeSnapshot[] = [rootNode];
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: () => nodes,
		now: () => 50_000,
	});
	// Registered after the runtime's own subscription, so it runs after the runtime
	// handled event #1 — i.e. strictly inside the same burst.
	eventBus.on("mail_sent", () => {
		nodes = [...nodes, { ...statusTreeNode("root.a.worker", "root.a", "worker", 1), status: "starting" }];
	});
	try {
		eventBus.emit({ nodeId: "root.a", type: "mail_sent", data: null, ts: 40_000 });
		// Same tick, and a STRICT DESCENDANT of this runtime's subtree root.
		eventBus.emit({ nodeId: "root.a.worker", type: "node_launched", data: null, ts: 41_000 });
		await settleFlush();
		assert.equal(
			runtime.treeNodes().find((node) => node.id === "root.a.worker")?.status,
			"running",
			"node_launched applied to the mid-burst row (it would stay 'starting' if the event were dropped)",
		);
	} finally {
		runtime.dispose();
	}
});

test("#238: a foreign-subtree event that merely looks similar is still rejected (prefix, not substring)", async () => {
	// Guards the gate itself: `root.a2` must not be treated as inside `root.a`.
	// A naive `includes`/`startsWith(rootId)` without the separator would admit it
	// and buy a pointless read per event on a same-prefixed sibling subtree.
	const nodes = [{ ...statusTreeNode("root.a", null, "a", 0), status: "running" as const }];
	const counting = countingTree(nodes);
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: counting.getTreeNodes,
		now: () => 50_000,
	});
	try {
		const atBurstStart = counting.calls();
		eventBus.emit({ nodeId: "root.a2", type: "node_launched", data: null, ts: 40_000 });
		eventBus.emit({ nodeId: "root.ab", type: "node_launched", data: null, ts: 41_000 });
		await settleFlush();
		assert.equal(
			counting.calls() - atBurstStart,
			2,
			"same-prefixed sibling subtrees are foreign: leading + flush only, no per-event reads",
		);
	} finally {
		runtime.dispose();
	}
});

test("#238: a bus stand-in WITHOUT reportError still cannot kill the process from the deferred paint", async () => {
	// `reportError` is optional so structural stand-ins keep working. A runtime
	// that rethrew when the channel was absent would hand such a stand-in exactly
	// the host-killing crash this whole guard exists to prevent — on the microtask
	// queue, where nothing can catch it. Containment must not depend on the bus
	// implementing the optional member.
	const nodes = [statusTreeNode("root", null, "root", 0), statusTreeNode("root.worker", "root", "worker", 1)];
	const real = createLegionEventBus();
	// Structural stand-in: same surface the runtime needs, minus `reportError`.
	const bus = { on: real.on, emit: real.emit } as unknown as LegionEventBus;
	let failPaintRead = false;
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus: bus,
		getTreeNodes: () => {
			if (failPaintRead) throw new Error("SQLITE_IOERR: paint read");
			return nodes;
		},
		now: () => 50_000,
	});
	let uncaught: unknown;
	const onUncaught = (error: unknown) => { uncaught = error; };
	process.once("uncaughtException", onUncaught);
	try {
		bus.emit({ nodeId: "root.worker", type: "node_launched", data: null, ts: 40_000 });
		failPaintRead = true;
		await settleFlush();
		assert.equal(
			uncaught,
			undefined,
			"with no reportError channel the failure is swallowed, not rethrown onto the microtask queue",
		);
	} finally {
		process.removeListener("uncaughtException", onUncaught);
		runtime.dispose();
	}
});

// ── display-liveness-v1: D3 static guard + R2 regression ─────────────────

test("display-liveness A7: no cross-writer timestamp comparison survives in runtime.ts", async () => {
	// D3 is a code-shape rule that no behavioural test can pin: the failure mode is
	// a comparison that only misbehaves when one of the two writers is dead. So read
	// the source and forbid the shape outright.
	//
	// Why it is a bug and not a style choice: `event.ts` is stamped by this
	// process's bus, `node.updatedAt` by the child's heartbeat. `legion-tools.ts`
	// heartbeats only `isAlive` children, so a dead child's `updatedAt` FREEZES.
	// Ranking the two ranked different clocks, and the old code deleted an
	// "older-looking" override and trusted the frozen row — which is exactly how a
	// finished node got painted back to `running`.
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../../src/extension/runtime.ts", import.meta.url), "utf8");
	// Strip comments so the documentation about the removed shape cannot trip this.
	const code = source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^[ \t]*\/\/.*$/gm, "");
	const offenders = code
		.split("\n")
		.map((line, index) => ({ line: line.trim(), number: index + 1 }))
		.filter(({ line }) => /(event|override)\.ts\s*[<>]=?\s*(node\.)?updatedAt/.test(line));
	assert.deepEqual(
		offenders,
		[],
		`D3 forbids comparing a bus timestamp with a ledger heartbeat; found: ${JSON.stringify(offenders)}`,
	);
});

test("display-liveness A2: a finished child is not pulled back to running by a frozen ledger row", async () => {
	// The reported bug, in the order it really happens:
	//   1. the child is alive and settles; the settle event is honoured;
	//   2. its process dies, so its ledger row keeps the last heartbeat it managed
	//      — `starting` — and `updatedAt` never advances again;
	//   3. later refreshes must NOT paint it back to `running`.
	//
	// Under the old timestamp race step 3 was fatal: the settled override looked
	// older than the frozen row, `snapshotNodes()` deleted it, and the panel showed
	// `running` forever. Under D3 the verdict comes from `liveness()` (expired
	// heartbeat ⇒ dead), so the stale row can never win.
	let now = 1_000;
	const row: TreeNodeSnapshot = {
		...statusTreeNode("root.worker", "root", "worker", 1),
		status: "starting",
		updatedAt: 1_000,
	};
	const eventBus = createLegionEventBus();
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus,
		getTreeNodes: () => [statusTreeNode("root", null, "root", 0), row],
		now: () => now,
	});
	try {
		// 1. alive and settling: the heartbeat is still fresh, and the event lands.
		eventBus.emit({ nodeId: "root.worker", type: "node_settled", data: null, ts: 1_000 });
		await settleFlush();
		assert.equal(
			runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.state,
			"settled",
			"the settle event is honoured while the child is alive",
		);

		// 2. the process dies: the row is frozen at `starting` and its heartbeat
		//    expires (the 90s orphan horizon passes).
		now = 1_000 + 91_000;

		// 3. every later read must still say the child ENDED, never `running`.
		for (let i = 0; i < 3; i += 1) {
			const state = runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.state;
			assert.notEqual(
				state,
				"running",
				`refresh ${i + 1}: a dead child's frozen row must never be painted back to running`,
			);
			assert.ok(
				state === "settled" || state === "failed",
				`refresh ${i + 1}: the child ended, so it renders as an ending (saw ${state})`,
			);
		}
	} finally {
		runtime.dispose();
	}
});

// ═══════════════ completion claim-once: one result, one route (notice-claim-v1) ═══════════════
//
// The two routes that carry a child's terminal result — the tool result
// (`wait` / `collect`) and the pushed notice (watch → join → outbox → deliver) —
// share ONE claim per `(runId, name)`. Whatever reaches the parent first wins;
// the other route goes quiet. These cases pin each window in which the notice
// used to arrive twice.

test("claim W1: a buffered entry claimed by wait() never reaches the window flush", async () => {
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.setJoinConfig({ mode: "smart", flushMs: 150 });
	for (const name of ["a", "b"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
		});
		runtime.watch(name);
	}

	// W1 window: a finishes first, so its entry waits in the join buffer while b
	// is still pending. Its watch releases the child right after.
	resolvers.get("a")!(joinSnapshot({ output: "a-out" }));
	await waitFor(() => runtime.get("a") === undefined, "a's watch released it");

	// The parent reads a's result explicitly: from here on a has been reported.
	const waited = await runtime.wait(["a"], { timeoutMs: 500 });
	assert.equal(waited[0]?.snapshot?.output, "a-out");
	assert.equal(messages.length, 0, "a was read, not announced");

	// The window expires with b still pending. The claimed entry must not fire.
	// 2x the window: the expiry has certainly happened, and the claimed entry still
	// must not have produced anything.
	await new Promise((resolve) => setTimeout(resolve, 320));
	assert.equal(messages.length, 0, "the window must not deliver the claimed entry");

	// b is now the only child the parent has not read.
	resolvers.get("b")!(joinSnapshot({ output: "b-out" }));
	await waitFor(() => messages.length === 1, "only b notifies");
	// Shape-agnostic on purpose: whether b flushes alone (legacy single) or the
	// expired window already happened to be mid-flight (grouped entry) is timing,
	// not contract. What matters is that b is there and a is not.
	assert.match(messages[0]!.content, /\*\*b \(worker\)\*\*|^- b \(worker\): completed/m);
	assert.doesNotMatch(messages[0]!.content, /a \(worker\)/, "a never appears in the notice");
	assert.doesNotMatch(messages[0]!.content, /a-out/, "a's output is never repeated");
	// Strict: a second message would land in messages[1] and go unnoticed otherwise.
	assert.equal(messages.length, 1, "exactly one message for the whole scenario");
	runtime.dispose();
});

test("claim W2: a held outbox entry claimed by wait() is dropped; its sibling still arrives", async () => {
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});

	// The parent run is live, so the notice is held (D-A) instead of sent.
	runtime.notifyParentRunStart();
	// Two children, ONE held batch. `held` is the member the tool route takes;
	// `free` is the positive control the contract demands (hard requirement 7) —
	// without it this case passes even if the flush never delivers anything at all.
	for (const name of ["held", "free"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
		});
		runtime.watch(name);
	}

	// W2 window: the children finish first, so the batch is enqueued for the live
	// run — this is the deferral the outbox exists for.
	resolvers.get("held")!(joinSnapshot({ output: "held-out" }));
	resolvers.get("free")!(joinSnapshot({ output: "free-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "batch held in the outbox");
	assert.equal(messages.length, 0, "a live run holds the notice");

	// The same turn then reads one member explicitly. The batch is held as ENTRIES
	// (D4) and only formatted at flush, which is exactly why a claim taken after
	// enqueue still wins.
	const waited = await runtime.wait(["held"], { timeoutMs: 500 });
	assert.equal(waited[0]?.snapshot?.output, "held-out");

	// The item is still pending, but now only for `free`: the claim removed the
	// `held` member at the filter, it did not throw the batch away.
	assert.equal(runtime.noticeQueueStats().pending, 1, "the batch still owes the unread sibling");
	assert.equal(messages.length, 0, "claiming never sends anything");

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "the sibling's notice is delivered at settle");
	assert.match(messages[0]!.content, /free-out/, "positive control: settle really flushed");
	assert.doesNotMatch(messages[0]!.content, /held-out/, "the read member is dropped from the body");
	assert.equal(messages.length, 1, "exactly one message: the read result is never re-announced");
	assert.equal(runtime.noticeQueueStats().pending, 0, "the outbox is drained");
	runtime.dispose();
});

test("claim D6: a notice sent first does not shorten the collect the parent asks for next", async () => {
	const messages: SentMessage[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.track({
		name: "fast",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/fast.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "fast-out" }),
	});
	runtime.watch("fast");

	// Reverse order: the notice wins the race...
	await waitFor(() => messages.length === 1, "notice delivered first");
	assert.match(messages[0]!.content, /Background task completed: \*\*fast \(worker\)\*\*/);

	// ...and the tool route that follows still returns the FULL result (D6).
	const collected = (await runtime.consumeCollect("fast"))?.snapshot;
	assert.equal(collected?.output, "fast-out", "the collect text is never suppressed");
	const waited = await runtime.wait(["fast"], { timeoutMs: 50 });
	assert.equal(waited[0]?.snapshot?.output, "fast-out", "the wait text is never suppressed");
	assert.equal(messages.length, 1, "still exactly one message: the claim stayed taken");
	runtime.dispose();
});

test("claim a wait timeout claims nothing, so the real completion still notifies", async () => {
	const messages: SentMessage[] = [];
	let resolveCollect!: (s: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.track({
		name: "slow",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/slow.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
	});
	runtime.watch("slow");

	const results = await runtime.wait(["slow"], { timeoutMs: 30 });
	assert.equal(results[0]?.timedOut, true, "the wait gave up instead of delivering");
	assert.equal(results[0]?.snapshot, undefined, "no snapshot was handed over");
	assert.equal(messages.length, 0, "a timeout is not a delivery");

	// The child settles afterwards: the still-unclaimed completion must arrive.
	resolveCollect(joinSnapshot({ output: "slow-out" }));
	await waitFor(() => messages.length === 1, "the real completion still notifies");
	assert.match(messages[0]!.content, /slow-out/);
	runtime.dispose();
});

test("claim D7: a fresh track after release reports again — the claim never leaks into round 2", async () => {
	const messages: SentMessage[] = [];
	let collects = 0;
	let resolveRound!: (s: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	const track = () =>
		runtime.track({
			name: "phoenix",
			runId: "r-1",
			agent: "worker",
			sessionFile: "/tmp/phoenix.jsonl",
			timeoutMs: 1_000,
			collect: () => {
				collects += 1;
				return new Promise<CollectSnapshot>((resolve) => {
					resolveRound = resolve;
				});
			},
		});

	// Round 1: a normal completion, which claims the result.
	track();
	runtime.watch("phoenix");
	await waitFor(() => collects === 1, "round 1 collect in flight");
	resolveRound(joinSnapshot({ output: "round-1" }));
	await waitFor(() => messages.length === 1, "round 1 notified");
	assert.match(messages[0]!.content, /round-1/);

	// Round 2: round 1's watch RELEASED the job, so this `track()` takes the
	// NEW-job branch. Round 2 draws a fresh round number, so its claim key is its own
	// (D10) and its notice cannot be swallowed as "already reported" — that is the
	// property this case pins. The `existing` branch (steer / continue on a still-live
	// job) is deliberately NOT covered here: it never resets `notified` on master, so
	// round 2 is already gated by the legacy flag.
	track();
	runtime.watch("phoenix");
	await waitFor(() => collects === 2, "round 2 collect in flight");
	resolveRound(joinSnapshot({ output: "round-2" }));
	await waitFor(() => messages.length === 2, "round 2 notifies again");
	assert.match(messages[1]!.content, /round-2/);
	assert.equal(messages.length, 2, "one notice per round, never two for one");
	runtime.dispose();
});

test("claim D7: rewatch un-claims a result the tool route already took", async () => {
	// The other re-arm site: the claim came from `consumeCollect` (the tool route)
	// while the job is still tracked, and the parent then explicitly asks to be
	// told again. Without the unclaim in `rewatch` the second round is filtered out
	// and the parent hears nothing at all.
	const messages: SentMessage[] = [];
	let collects = 0;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.track({
		name: "re",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/re.jsonl",
		timeoutMs: 1_000,
		collect: async () => {
			collects += 1;
			return joinSnapshot({ output: `round-${collects}` });
		},
	});

	const first = (await runtime.consumeCollect("re"))?.snapshot;
	assert.equal(first?.output, "round-1", "the tool route read round 1");
	assert.equal(runtime.get("re") !== undefined, true, "collect does not release the job");
	assert.equal(messages.length, 0, "reading a result is not a notice");

	runtime.rewatch("re");
	await waitFor(() => messages.length === 1, "the rewatch round notifies");
	assert.match(messages[0]!.content, /round-2/);
	runtime.dispose();
});

test("claim D4: a grouped outbox entry drops the claimed member and recomputes its header", async () => {
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.setJoinConfig({ mode: "smart", flushMs: 60 });

	runtime.notifyParentRunStart();
	for (const name of ["a", "b", "c"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
		});
		runtime.watch(name);
	}

	// a and b settle, c is still running: the window flushes a + b as ONE grouped
	// entry, which is then held for the live parent run.
	resolvers.get("a")!(joinSnapshot({ output: "a-out" }));
	resolvers.get("b")!(joinSnapshot({ output: "b-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "grouped entry held");
	assert.equal(messages.length, 0, "held for the live run");

	// The parent reads a before the run settles.
	const waited = await runtime.wait(["a"], { timeoutMs: 500 });
	assert.equal(waited[0]?.snapshot?.output, "a-out");

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "one message at settle");
	const content = messages[0]!.content;
	assert.match(content, /b \(worker\): completed/);
	assert.match(content, /b-out/);
	assert.doesNotMatch(content, /- a \(worker\)/, "the claimed member is gone from the batch");
	assert.doesNotMatch(content, /a-out/, "its output is gone with it");
	// The header and footer are recomputed from what survives (D4): one entry out
	// of the two that were pending, and c — still unread, still alive — remains.
	assert.match(content, /^Background tasks completed \(1 of 2\):$/m);
	assert.match(content, /^Still running: c( |$)/m);
	runtime.dispose();
});

test("claim D2(a)/D9: a CACHED collect-claim is filtered out of the join window", async () => {
	// `consumeCollect` is the seam index.ts's collectChild awaits, so a terminal
	// snapshot returned there is a delivery like any other.
	//
	// Branch honesty: the watch's `finally` already released the child by the time
	// `consumeCollect` runs, so this exercises the FINISHED-CACHE claim
	// (`claimCachedResult`, keyed with D9's snapshot run id) — not the job branch.
	// Sibling c is the POSITIVE CONTROL: it proves the window really flushed, so a
	// green result here cannot be a window that simply never fired.
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.setJoinConfig({ mode: "smart", flushMs: 120 });
	for (const name of ["a", "c", "b"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
		});
		runtime.watch(name);
	}
	resolvers.get("a")!(joinSnapshot({ output: "a-out" }));
	await waitFor(() => runtime.get("a") === undefined, "job released ⇒ cache branch");
	resolvers.get("c")!(joinSnapshot({ output: "c-out" }));
	await waitFor(() => runtime.get("c") === undefined, "c released");

	// b keeps the group pending, so both entries wait for the window.
	const collected = (await runtime.consumeCollect("a"))?.snapshot;
	assert.equal(collected?.output, "a-out");

	await waitFor(() => messages.length === 1, "the window flushed the batch");
	const content = messages[0]!.content;
	assert.match(content, /^- c \(worker\): completed/m, "positive control: the flush really ran");
	assert.match(content, /c-out/);
	assert.doesNotMatch(content, /- a \(worker\)/, "a was claimed through the cache branch");
	assert.doesNotMatch(content, /a-out/);
	runtime.dispose();
});

test("claim D7b: re-tracking the same name drops the one-round cache (no stale read)", async () => {
	// `runId` is the PARENT run id, so every round of the same child shares it — a
	// surviving cache entry would hand the new round the previous round's snapshot.
	// ANY (re)track starts a new round and must drop the cache (D7b).
	const messages: SentMessage[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	let resolveR1!: (s: CollectSnapshot) => void;
	runtime.track({
		name: "a",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/a.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveR1 = resolve;
			}),
	});
	runtime.watch("a");
	resolveR1(joinSnapshot({ output: "r1-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "R1 notice held");
	await waitFor(() => runtime.get("a") === undefined, "R1 released");
	runtime.track({
		name: "a",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/a2.jsonl",
		timeoutMs: 1_000,
		collect: () => new Promise<CollectSnapshot>(() => {}),
	});
	// D7 revokes the copies of a result that was ALREADY DELIVERED. Nobody read this
	// one, so there is no claim to revoke and the notice must survive the new round
	// (see "claim D7: an UNREAD queued notice survives a same-name re-track").
	assert.equal(
		runtime.noticeQueueStats().pending,
		1,
		"an unread copy is not dead weight: it survives the re-track",
	);
	runtime.release("a");

	// With no job and no cache, the tool route must report a MISS — never a stale
	// snapshot from a round the parent did not ask for.
	const waited = await runtime.wait(["a"], { timeoutMs: 200 });
	assert.deepEqual(
		waited,
		[{ name: "a", missing: true }],
		"no stale round-1 snapshot may survive the re-track",
	);

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "the unread round-1 notice is still delivered");
	assert.match(messages[0]!.content, /r1-out/);
	assert.equal(messages.length, 1, "exactly once");
	runtime.dispose();
});

test("claim D7b: the same child's next-round failure is not swallowed by the old cache", async () => {
	// The critical direction: round 1 succeeded and its snapshot was cached; round 2
	// throws. Serving (and claiming) that stale snapshot told the parent "success"
	// AND claimed exactly the key of round 2's failure notice, so the failure was
	// lost. `runId` is the same in both rounds — a parent run id, not a round id.
	//
	// Notices are delivered immediately here (no live parent run), so each round
	// speaks for itself: round 1's claim is revoked by round 2's track (D7), and
	// round 2's failure must reach the parent.
	const messages: SentMessage[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});

	// Round 1: success, delivered at once.
	let resolveR1!: (s: CollectSnapshot) => void;
	runtime.track({
		name: "a",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/a.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveR1 = resolve;
			}),
	});
	runtime.watch("a");
	resolveR1(joinSnapshot({ output: "out-success" }));
	await waitFor(() => messages.length === 1, "round 1 announced");
	await waitFor(() => runtime.get("a") === undefined, "round 1 released");

	// Round 2 on the SAME (parent run id, name): the collect throws.
	runtime.track({
		name: "a",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/a.jsonl",
		timeoutMs: 1_000,
		collect: async () => {
			throw new Error("r2 boom");
		},
	});
	runtime.watch("a");
	await waitFor(() => messages.length === 2, "round 2's failure reaches the parent");
	// `collectFailureInput` carries no agent, so the label is the bare name.
	assert.match(messages[1]!.content, /Background task failed: \*\*a\*\*/);
	assert.match(messages[1]!.content, /r2 boom/);

	// The parent asks for the result afterwards: no cache survives the re-track, so
	// this is a miss — never round 1's stale success.
	const waited = await runtime.wait(["a"], { timeoutMs: 200 });
	assert.notEqual(waited[0]?.snapshot?.output, "out-success", "no stale success is served");
	assert.equal(waited[0]?.missing, true, "the round-2 job is gone and the cache was dropped");
	assert.equal(messages.length, 2, "one notice per round, nothing repeated");
	runtime.dispose();
});

test("claim D2(a): waitOne claims BEFORE the retire await, so the window cannot fire in between", async () => {
	// A pending `retire` is the only way to reach waitOne's terminal branch while the
	// job (and its buffered entry) is still alive: the claim must already be taken by
	// then, or a join flush landing inside the retire await delivers the same result
	// a second time.
	//
	// Sibling z is the POSITIVE CONTROL: its unclaimed entry rides in the same batch,
	// so "z arrived, a did not" proves the window really expired DURING the park —
	// no bare sleep is load-bearing here.
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const retires: Array<{ name: string; release: () => void }> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.setJoinConfig({ mode: "smart", flushMs: 150 });
	for (const name of ["a", "z", "b"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
			retire: () =>
				new Promise<void>((resolve) => {
					retires.push({ name, release: resolve });
				}),
		});
		runtime.watch(name);
	}

	// a and z finish: the window opens (b is still pending) and both watches park in
	// the retire await, so both jobs keep their buffered entries.
	resolvers.get("a")!(joinSnapshot({ output: "a-out" }));
	await waitFor(() => retires.length === 1, "a's watch is awaiting retire");
	assert.ok(runtime.get("a"), "the job survives a pending retire");
	resolvers.get("z")!(joinSnapshot({ output: "z-out" }));
	await waitFor(() => retires.length === 2, "z's watch is awaiting retire");

	// The explicit wait reaches the terminal branch and parks in its own retire
	// await — the exact window the claim has to cover.
	const pendingWait = runtime.wait(["a"], { timeoutMs: 5_000 });
	await waitFor(() => retires.length === 3, "the wait is parked in the retire await");

	// The window expires while the wait is parked. Positive control: z is delivered.
	await waitFor(() => messages.length === 1, "the window expired during the retire await");
	const content = messages[0]!.content;
	assert.match(content, /^- z \(worker\): completed/m, "positive control: the flush really ran");
	assert.match(content, /z-out/);
	assert.doesNotMatch(content, /- a \(worker\)/, "a's claim was taken before the retire await");
	assert.doesNotMatch(content, /a-out/);

	// Release the wait's park: it returns the snapshot, and still nothing for a.
	retires[2]!.release();
	const waited = await pendingWait;
	assert.equal(waited[0]?.snapshot?.output, "a-out");
	assert.equal(messages.length, 1, "still exactly one message: z only");
	for (const gate of retires) gate.release();
	await drainContinuations();
	runtime.dispose();
});

test("claim D2(b): a collect-claimed member is dropped from the batch that flushes right now", async () => {
	// `consumeCollect` really takes the JOB branch here (a pending retire keeps the
	// job tracked), so the claim comes from `claimIfTerminal`, not from the finished
	// cache. The sibling entry d in the same batch is the positive control: it proves
	// the window actually flushed while a demonstrably stayed out.
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const retires: Array<() => void> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.setJoinConfig({ mode: "smart", flushMs: 300 });
	for (const name of ["a", "d", "b"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
			retire: () =>
				new Promise<void>((resolve) => {
					retires.push(resolve);
				}),
		});
		runtime.watch(name);
	}
	resolvers.get("a")!(joinSnapshot({ output: "a-out" }));
	resolvers.get("d")!(joinSnapshot({ output: "d-out" }));
	await waitFor(() => retires.length === 2, "a and d are parked in retire");
	assert.ok(runtime.get("a"), "a is still TRACKED — this is the job branch");

	const collected = (await runtime.consumeCollect("a"))?.snapshot;
	assert.equal(collected?.output, "a-out");

	await waitFor(() => messages.length === 1, "the window flushed the batch");
	const content = messages[0]!.content;
	assert.match(content, /^- d \(worker\): completed/m, "positive control: the flush really ran");
	assert.match(content, /d-out/);
	assert.doesNotMatch(content, /- a \(worker\)/, "a was claimed through the job branch");
	assert.doesNotMatch(content, /a-out/);
	runtime.dispose();
});

test("claim D4: the grouped header collapses to (1) when the only other member was read", async () => {
	// The `N of 1` shape: the batch is still the grouped notice (it was built from
	// two members), but after the claim only one survives and nothing is still
	// running — so the header must say exactly `(1)`.
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	for (const name of ["a", "b"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
		});
		runtime.watch(name);
	}
	// Both settle → ONE grouped entry (2 members) held for the live run.
	resolvers.get("a")!(joinSnapshot({ output: "a-out" }));
	resolvers.get("b")!(joinSnapshot({ output: "b-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "grouped entry held");

	const waited = await runtime.wait(["a"], { timeoutMs: 500 });
	assert.equal(waited[0]?.snapshot?.output, "a-out");

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "one message at settle");
	const content = messages[0]!.content;
	assert.match(content, /^Background tasks completed \(1\):$/m, "N of 1: one survivor, nothing still running");
	assert.doesNotMatch(content, /\d+ of \d+/, "no stale `N of M` header");
	assert.match(content, /^- b \(worker\): completed/m);
	assert.doesNotMatch(content, /- a \(worker\)/);
	runtime.dispose();
});

// ═════ D7 atomicity (revoked copies) · consumeCollectInterruptible (the real seam) ═════

test("claim D10: a same-name re-track after a read does not revive the OLD round's notice", async () => {
	// Scope, stated plainly: this case is about the ROUND-KEYED FILTER in
	// `deliverBatch`, not about the D7 revoke. The parent read round 1 (claim on
	// `(runId, held, 1)`), then `continue`d the child before the run settled, which
	// takes `track()`'s NEW-job branch and starts round 2. That branch's revoke
	// targets round 2 — a key with no claim yet — so nothing is unclaimed here on
	// purpose (D7/D10: an unread copy must not be dropped), and the queued round-1
	// entry is killed by its own claim at flush time.
	//
	// The genuine revoke paths (rewatch / rearm with a live job) are pinned
	// separately, where the claim and the copy actually coexist.
	//
	// `free` is the positive control (hard requirement 7): the flush must deliver
	// its notice, so a dead `flushOutbox` cannot make this case green.
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	for (const name of ["held", "free"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
		});
		runtime.watch(name);
	}
	resolvers.get("held")!(joinSnapshot({ output: "held-out" }));
	resolvers.get("free")!(joinSnapshot({ output: "free-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "batch held in the outbox");

	const waited = await runtime.wait(["held"], { timeoutMs: 500 });
	assert.equal(waited[0]?.snapshot?.output, "held-out");
	assert.equal(
		runtime.noticeQueueStats().pending,
		1,
		"the round-1 member is claimed; the batch survives for the unread one",
	);

	// The parent continues the same child before the run settles: a new round.
	runtime.track({
		name: "held",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/held.jsonl",
		timeoutMs: 1_000,
		collect: () => new Promise<CollectSnapshot>(() => {}),
	});
	runtime.release("held");

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "the unread sibling still arrives");
	assert.match(messages[0]!.content, /free-out/, "positive control: settle really flushed");
	assert.doesNotMatch(
		messages[0]!.content,
		/held-out/,
		"a read result is never re-announced, not even for the round that succeeded it",
	);
	assert.equal(messages.length, 1, "exactly one message");
	runtime.dispose();
});

test("claim D2(b): consumeCollectInterruptible claims on the JOB branch", async () => {
	// Production always passes a signal, so THIS seam — not plain consumeCollect — is
	// what collectChild actually awaits. A pending retire keeps the job tracked so the
	// claim is the job-branch one; sibling d is the positive control for the flush.
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const retires: Array<() => void> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.setJoinConfig({ mode: "smart", flushMs: 150 });
	for (const name of ["a", "d", "b"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
			retire: () =>
				new Promise<void>((resolve) => {
					retires.push(resolve);
				}),
		});
		runtime.watch(name);
	}
	resolvers.get("a")!(joinSnapshot({ output: "a-out" }));
	resolvers.get("d")!(joinSnapshot({ output: "d-out" }));
	await waitFor(() => retires.length === 2, "a and d are parked in retire");
	assert.ok(runtime.get("a"), "a is still TRACKED — this is the job branch");

	const collected = (await runtime.consumeCollectInterruptible("a", new AbortController().signal))?.snapshot;
	assert.equal(collected?.output, "a-out");

	await waitFor(() => messages.length === 1, "the window flushed the batch");
	const content = messages[0]!.content;
	assert.match(content, /^- d \(worker\): completed/m, "positive control: the flush really ran");
	assert.match(content, /d-out/);
	assert.doesNotMatch(content, /- a \(worker\)/, "a was claimed through the job branch");
	assert.doesNotMatch(content, /a-out/);
	runtime.dispose();
});

test("claim D2(a)/D9: consumeCollectInterruptible claims on the CACHE branch", async () => {
	// The other half of the same seam: the watch already released the child, so the
	// snapshot comes from the finished cache and the claim is `claimCachedResult`.
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.setJoinConfig({ mode: "smart", flushMs: 150 });
	for (const name of ["a", "c", "b"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
		});
		runtime.watch(name);
	}
	resolvers.get("a")!(joinSnapshot({ output: "a-out" }));
	await waitFor(() => runtime.get("a") === undefined, "job released ⇒ cache branch");
	resolvers.get("c")!(joinSnapshot({ output: "c-out" }));
	await waitFor(() => runtime.get("c") === undefined, "c released");

	const collected = (await runtime.consumeCollectInterruptible("a", new AbortController().signal))?.snapshot;
	assert.equal(collected?.output, "a-out");

	await waitFor(() => messages.length === 1, "the window flushed the batch");
	const content = messages[0]!.content;
	assert.match(content, /^- c \(worker\): completed/m, "positive control: the flush really ran");
	assert.match(content, /c-out/);
	assert.doesNotMatch(content, /- a \(worker\)/, "a was claimed through the cache branch");
	assert.doesNotMatch(content, /a-out/);
	runtime.dispose();
});

test("claim D7b: a revive (existing branch) also drops the one-round cache", async () => {
	// Both `track()` branches must drop the cache. Here the job is still live
	// (`consumeCollect` does not release), so the second track takes the EXISTING
	// branch — the one a `notified`-based reading of D7 leaves alone. If the cached
	// round-1 snapshot survived, a later read would be served it.
	const runtime = createSessionRuntime({ sendMessage() {} });
	let collects = 0;
	const track = () =>
		runtime.track({
			name: "a",
			runId: "r-1",
			agent: "worker",
			sessionFile: "/tmp/a.jsonl",
			timeoutMs: 1_000,
			collect: async () => {
				collects += 1;
				return joinSnapshot({ output: `round-${collects}` });
			},
		});

	track();
	const first = (await runtime.consumeCollect("a"))?.snapshot;
	assert.equal(first?.output, "round-1");
	assert.ok(runtime.get("a"), "collect does not release ⇒ the revive branch is reachable");

	track(); // EXISTING branch: the child starts a new round
	runtime.release("a");
	const waited = await runtime.wait(["a"], { timeoutMs: 200 });
	assert.deepEqual(
		waited,
		[{ name: "a", missing: true }],
		"no round-1 snapshot may survive the revive",
	);
	runtime.dispose();
});

test("claim D-B: a cap flush that delivers nothing is not counted as a forced send", async () => {
	// `forcedFlushes` documents forced SENDS. A cap that fires on a batch whose only
	// member was already read claims nothing and sends nothing, so counting it would
	// report a message that never existed.
	const messages: SentMessage[] = [];
	const overflow = manualOverflow();
	let t = 1_000;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
		now: () => t,
		scheduleNoticeOverflow: overflow.scheduleNoticeOverflow,
	});
	runtime.notifyParentRunStart();
	runtime.track({
		name: "stuck",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/stuck.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "stuck-out" }),
	});
	runtime.watch("stuck");
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "notice held");

	// The parent reads it before the cap fires; the queued copy is now dead weight.
	const waited = await runtime.wait(["stuck"], { timeoutMs: 500 });
	assert.equal(waited[0]?.snapshot?.output, "stuck-out");
	assert.equal(overflow.timers.length, 1, "the cap arm is still live");

	t += MAX_PENDING_AGE_MS;
	overflow.timers[0]!.fn();
	assert.equal(messages.length, 0, "a fully claimed batch sends nothing");
	assert.equal(
		runtime.noticeQueueStats().forcedFlushes,
		0,
		"a forced flush that sent nothing is not a forced send",
	);

	// Positive control (hard requirement 7). "Zero messages" is also what a dead
	// `flushOutbox` produces, so the very same arm → flush → deliver path must now
	// send an UNCLAIMED notice: one real forced send, one message.
	runtime.track({
		name: "late",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/late.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "late-out" }),
	});
	runtime.watch("late");
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "the control notice is held");
	assert.equal(overflow.timers.length, 2, "a fresh cap arm for the surviving batch");
	t += MAX_PENDING_AGE_MS;
	overflow.timers[1]!.fn();
	await waitFor(() => messages.length === 1, "the control notice is force-sent");
	assert.match(messages[0]!.content, /late-out/, "the cap machinery really delivers");
	assert.equal(
		runtime.noticeQueueStats().forcedFlushes,
		1,
		"a forced flush that DID send is counted",
	);
	runtime.dispose();
});

test("claim D7: an UNREAD queued notice survives a same-name re-track", async () => {
	// D7 revokes the copies of a result the parent ALREADY READ. A notice nobody read
	// has no claim to revoke, so `stop` + `continue` of the same child must not
	// silently drop it: `release()` does not unclaim, and the next `track()` takes the
	// NEW-job branch, whose revoke targets the NEW round and is therefore a no-op —
	// D10's "one round = one deliverable result".
	const messages: SentMessage[] = [];
	let resolveCollect!: (s: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	runtime.track({
		name: "A",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/A.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
	});
	runtime.watch("A");
	resolveCollect(joinSnapshot({ output: "unread-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "notice queued while unread");
	await waitFor(() => runtime.get("A") === undefined, "A released (the `stop` path)");

	// `continue` / resume the same child: new job, same (runId, name).
	runtime.track({
		name: "A",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/A.jsonl",
		timeoutMs: 1_000,
		collect: () => new Promise<CollectSnapshot>(() => {}),
	});

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "the unread notice still arrives");
	assert.match(messages[0]!.content, /unread-out/);
	assert.equal(messages.length, 1, "exactly once: not dropped, not duplicated");
	runtime.dispose();
});

test("claim D4: a terminal sibling parked in retire is not listed as `Still running`", async () => {
	// `awaiting` is a TERMINAL marker: the completion is already buffered/announced and
	// the watch is only parked in `retire`. Listing that sibling under `Still running:`
	// contradicts the completed entry the same burst delivered — and D4 recomputes the
	// footer at delivery, so the window can be up to 80s wide.
	//
	// The reachable shape is a sibling that ended but whose notice was never delivered:
	// here the host REJECTS alpha's send (the documented "dropped, not requeued"
	// path), so alpha stays tracked in `awaiting` and unclaimed.
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	let rejectAlpha = true;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			const content = (message as SentMessage).content;
			if (rejectAlpha && /alpha-out/.test(content)) {
				rejectAlpha = false;
				throw new Error("host rejected the alpha notice");
			}
			messages.push(message as SentMessage);
		},
	});
	runtime.setJoinConfig({ mode: "smart", flushMs: 80 });
	for (const name of ["alpha", "beta", "gamma"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
			// Never resolves: a finished child stays tracked in `awaiting`.
			retire: () => new Promise<void>(() => {}),
		});
		runtime.watch(name);
	}

	// Window 1 tries to announce alpha alone; the host rejects it, so alpha keeps no
	// claim and stays in `awaiting` (its retire never lands).
	resolvers.get("alpha")!(joinSnapshot({ output: "alpha-out" }));
	await waitFor(() => rejectAlpha === false, "window 1 attempted alpha");
	assert.equal(messages.length, 0, "the rejected notice is dropped, not requeued");
	assert.ok(runtime.get("alpha"), "alpha is still tracked (retire is in flight)");

	// Window 2 announces beta. alpha ended a message ago and gamma is genuinely alive,
	// so the footer may name gamma only.
	resolvers.get("beta")!(joinSnapshot({ output: "beta-out" }));
	await waitFor(() => messages.length === 1, "window 2 flushed beta");
	const second = messages[0]!.content;
	assert.match(second, /^- beta \(worker\): completed/m);
	assert.match(second, /^Still running: gamma \(notifies separately/m, "gamma is genuinely still running");
	assert.doesNotMatch(
		second,
		/Still running:[^\n]*alpha/,
		"a terminal sibling parked in retire is not `still running`",
	);
	runtime.dispose();
});

// ═══════════════ D10: one round = one deliverable result (claim key has a round) ═══════════════

test("claim D10: two unread rounds of one child are both delivered, FIFO", async () => {
	// `runId` is the PARENT run id, so two rounds of the same child share it. Without
	// the round in the claim key the first delivery claimed the key and the second
	// round's notice was filtered — the parent saw the OLD result and never the new one.
	const messages: SentMessage[] = [];
	const resolvers: Array<(s: CollectSnapshot) => void> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	const track = () =>
		runtime.track({
			name: "A",
			runId: "r-1",
			agent: "worker",
			sessionFile: "/tmp/A.jsonl",
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.push(resolve);
				}),
		});

	// Round 1 completes; its notice is held for the live run (never read).
	track();
	runtime.watch("A");
	resolvers[0]!(joinSnapshot({ output: "round-1-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "round 1 held");
	await waitFor(() => runtime.get("A") === undefined, "round 1 released");

	// Round 2 on the same (parent run id, name): another unread result, held too.
	track();
	runtime.watch("A");
	resolvers[1]!(joinSnapshot({ output: "round-2-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 2, "both rounds held");

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 2, "both rounds are delivered");
	assert.match(messages[0]!.content, /round-1-out/, "FIFO: round 1 first");
	assert.match(messages[1]!.content, /round-2-out/, "round 2 is not swallowed by round 1's claim");
	assert.equal(messages.length, 2, "one notice per round, no duplicates");
	runtime.dispose();
});

test("claim D10: a read round does not suppress the next round's notice", async () => {
	// The reverse direction of the same key problem: round 1 was READ (so its claim is
	// legitimate), and round 2 must still be announced — the claim belongs to round 1,
	// not to the child forever.
	const messages: SentMessage[] = [];
	const resolvers: Array<(s: CollectSnapshot) => void> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	const track = () =>
		runtime.track({
			name: "A",
			runId: "r-1",
			agent: "worker",
			sessionFile: "/tmp/A.jsonl",
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.push(resolve);
				}),
		});

	// Round 1: completes, and the parent reads it before the run settles.
	track();
	runtime.watch("A");
	resolvers[0]!(joinSnapshot({ output: "round-1-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "round 1 held");
	const first = await runtime.wait(["A"], { timeoutMs: 500 });
	assert.equal(first[0]?.snapshot?.output, "round-1-out");
	assert.equal(runtime.noticeQueueStats().pending, 0, "round 1's copy is dead weight now");

	// Round 2: completes unread.
	track();
	runtime.watch("A");
	resolvers[1]!(joinSnapshot({ output: "round-2-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "round 2 held");

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "only round 2 is announced");
	assert.match(messages[0]!.content, /round-2-out/);
	assert.doesNotMatch(messages[0]!.content, /round-1-out/, "round 1 stays suppressed");
	assert.equal(messages.length, 1, "exactly one message");
	runtime.dispose();
});

// ═══════════ F1/F2: the round travels with the snapshot, and survives `persist` ═══════════

test("claim F2: a re-track during `persist` keeps the one-round cache invalid", async () => {
	// `current` is computed BEFORE `await job.persist()`, and `track()` does not bump
	// `generation` — so without a re-check the stale round-1 collect writes its snapshot
	// back over the invalidation `track()` just performed (D7b), and the next `wait`
	// serves the PREVIOUS round's result.
	const messages: SentMessage[] = [];
	let releasePersist!: () => void;
	let resolveCollect!: (s: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	const track = () =>
		runtime.track({
			name: "A",
			runId: "r-1",
			agent: "worker",
			sessionFile: "/tmp/A.jsonl",
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolveCollect = resolve;
				}),
			persist: () =>
				new Promise<void>((resolve) => {
					releasePersist = resolve;
				}),
		});

	// Round 1 lands but is stuck in `persist`.
	track();
	runtime.watch("A");
	resolveCollect(joinSnapshot({ output: "round-1-out" }));
	await waitFor(() => typeof releasePersist === "function", "round 1 is persisting");

	// Re-track WHILE persist is still in flight, then let it finish.
	track();
	releasePersist();
	await waitFor(() => runtime.get("A") === undefined, "round 1's watch released the job");

	// The cache must not have been repopulated with round 1's snapshot.
	const waited = await runtime.wait(["A"], { timeoutMs: 200 });
	assert.deepEqual(
		waited,
		[{ name: "A", missing: true }],
		"no previous-round snapshot may survive the re-track",
	);
	assert.equal("snapshot" in waited[0]!, false, "no stale output was served");

	// Nothing read it, so the notice is the only route — and it must arrive once.
	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "the unread round-1 notice still arrives");
	assert.match(messages[0]!.content, /round-1-out/);
	assert.equal(messages.length, 1, "exactly once: neither swallowed nor duplicated");
	runtime.dispose();
});

test("claim F1: a notice carries the round its snapshot was COLLECTED in", async () => {
	// `track()` on a live job bumps the round mid-collect. The snapshot that lands
	// afterwards belongs to the OLD round: if its notice is labelled with the live
	// round instead, that entry's claim steals the NEW round's key and the new round's
	// real result is filtered out (the parent never sees it).
	const messages: SentMessage[] = [];
	const resolvers: Array<(s: CollectSnapshot) => void> = [];
	const retires: Array<() => void> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	let started = 0;
	const track = () =>
		runtime.track({
			name: "A",
			runId: "r-1",
			agent: "worker",
			sessionFile: "/tmp/A.jsonl",
			timeoutMs: 1_000,
			collect: () => {
				const index = started;
				started += 1;
				return new Promise<CollectSnapshot>((resolve) => {
					resolvers[index] = resolve;
				});
			},
			// Never resolves: a finished child stays tracked while parked in retire.
			retire: () =>
				new Promise<void>((resolve) => {
					retires.push(resolve);
				}),
		});

	// Round 1 starts collecting, then the child is re-tracked (round 2).
	track();
	runtime.watch("A");
	await waitFor(() => resolvers.length === 1, "round 1 is collecting");
	track();

	// Round 1's snapshot lands now, AFTER the round bump.
	resolvers[0]!(joinSnapshot({ output: "round-1-out" }));
	await waitFor(() => retires.length === 1, "round 1's watch is parked in retire");
	assert.equal(runtime.noticeQueueStats().pending, 1, "round 1's notice is queued unread");

	// Round 2's own collect lands too (via rewatch: same round label, fresh snapshot).
	runtime.rewatch("A");
	await waitFor(() => resolvers.length === 2, "round 2 is collecting");
	resolvers[1]!(joinSnapshot({ output: "round-2-out" }));
	await waitFor(() => retires.length === 2, "round 2's watch is parked in retire");
	await waitFor(() => runtime.noticeQueueStats().pending === 2, "both notices queued");

	// The parent reads A: the live collect is round 2's, so it claims round 2.
	const pendingWait = runtime.wait(["A"], { timeoutMs: 5_000 });
	await waitFor(() => retires.length === 3, "the wait is parked in retire");
	retires[2]!();
	const waited = await pendingWait;
	assert.equal(waited[0]?.snapshot?.output, "round-2-out");
	assert.equal(runtime.noticeQueueStats().pending, 1, "only round 1's notice is still live");

	// Round 2 was read through the tool route, so only ROUND 1's notice may arrive.
	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "round 1's unread notice is delivered");
	assert.match(messages[0]!.content, /round-1-out/);
	assert.doesNotMatch(messages[0]!.content, /round-2-out/, "round 2 was read, not announced");
	assert.equal(messages.length, 1, "the old round's entry did not steal the new round's key");
	for (const release of retires) release();
	await drainContinuations();
	runtime.dispose();
});

test("claim F1: the wait claims the round its snapshot was collected in (no duplicate)", async () => {
	// The duplicate direction of F1: a `track()` bumps the live round while round 1's
	// collect is still pending, and the parent then reads that very snapshot through the
	// tool route. The claim must land on the round the NOTICE carries — i.e. the
	// snapshot's origin — or the same output is announced on top of the tool result.
	const messages: SentMessage[] = [];
	const resolvers: Array<(s: CollectSnapshot) => void> = [];
	const retires: Array<() => void> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	let started = 0;
	const track = () =>
		runtime.track({
			name: "A",
			runId: "r-1",
			agent: "worker",
			sessionFile: "/tmp/A.jsonl",
			timeoutMs: 1_000,
			collect: () => {
				const index = started;
				started += 1;
				return new Promise<CollectSnapshot>((resolve) => {
					resolvers[index] = resolve;
				});
			},
			// Never resolves: a finished child stays tracked while parked in retire.
			retire: () =>
				new Promise<void>((resolve) => {
					retires.push(resolve);
				}),
		});

	// Round 1 starts collecting, then the child is re-tracked (round 2).
	track();
	runtime.watch("A");
	await waitFor(() => resolvers.length === 1, "round 1 is collecting");
	track();

	// Round 1's snapshot lands after the bump: its notice is queued (unread).
	resolvers[0]!(joinSnapshot({ output: "round-1-out" }));
	await waitFor(() => retires.length === 1, "round 1's watch is parked in retire");
	assert.equal(runtime.noticeQueueStats().pending, 1, "round 1's notice is queued unread");

	// The live collect promise is still round 1's, so this tool result IS round 1's
	// output — and it must claim exactly the round that notice carries.
	const pendingWait = runtime.wait(["A"], { timeoutMs: 5_000 });
	await waitFor(() => retires.length === 2, "the wait is parked in retire");
	retires[1]!();
	const waited = await pendingWait;
	assert.equal(waited[0]?.snapshot?.output, "round-1-out");

	runtime.notifyParentSettled();
	assert.equal(messages.length, 0, "the result was read: its notice must not arrive too");
	runtime.dispose();
});

test("claim F1: an interruptible collect claims the round its snapshot was collected in", async () => {
	// Same seam the production `collect` tool uses (`consumeCollectInterruptible`), with
	// the round bumped mid-collect: the job-branch claim goes through `claimIfTerminal`,
	// which must read the SNAPSHOT's origin — otherwise the unread notice it should
	// suppress is delivered next to the tool result.
	const messages: SentMessage[] = [];
	const resolvers: Array<(s: CollectSnapshot) => void> = [];
	const retires: Array<() => void> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	let started = 0;
	const track = () =>
		runtime.track({
			name: "A",
			runId: "r-1",
			agent: "worker",
			sessionFile: "/tmp/A.jsonl",
			timeoutMs: 1_000,
			collect: () => {
				const index = started;
				started += 1;
				return new Promise<CollectSnapshot>((resolve) => {
					resolvers[index] = resolve;
				});
			},
			retire: () =>
				new Promise<void>((resolve) => {
					retires.push(resolve);
				}),
		});

	track();
	runtime.watch("A");
	await waitFor(() => resolvers.length === 1, "round 1 is collecting");
	track(); // round 2 while round 1's collect is pending

	resolvers[0]!(joinSnapshot({ output: "round-1-out" }));
	await waitFor(() => retires.length === 1, "round 1's watch is parked in retire");
	assert.equal(runtime.noticeQueueStats().pending, 1, "round 1's notice is queued unread");

	// Positive control (hard requirement 7): an UNCLAIMED sibling in the same outbox.
	// Without it, "zero messages" is also what a flush that never runs produces.
	let resolveB!: (s: CollectSnapshot) => void;
	runtime.track({
		name: "B",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/B.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveB = resolve;
			}),
	});
	runtime.watch("B");
	resolveB(joinSnapshot({ output: "B-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 2, "the sibling's notice is queued too");

	const collected = (await runtime.consumeCollectInterruptible("A", new AbortController().signal))?.snapshot;
	assert.equal(collected?.output, "round-1-out", "the cache-free job branch served round 1");

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "the unread sibling still arrives");
	assert.match(messages[0]!.content, /B-out/, "positive control: settle really flushed");
	assert.doesNotMatch(messages[0]!.content, /round-1-out/, "the read result's notice must not arrive too");
	assert.equal(messages.length, 1, "exactly one message");
	runtime.dispose();
});

// ═════ D10 round scoping on the release path · the genuine D7 revoke paths ═════

test("claim D10: release() drops only the round the parent read; an older unread round still arrives", async () => {
	// D10: one round = one deliverable result. `release()` acts on ONE tracked job,
	// and a job owns one round — but it dropped buffered copies by NAME, so the
	// release that follows a `wait()` hit also deleted an EARLIER round's unread
	// notice. Reachable sequence, reproduced here:
	//   round 1 finishes while `s` is pending → buffered, unread
	//   re-track (round 2) → round 2 finishes → buffered too
	//   `wait(["x"])` claims round 2 → its release wipes the buffer by name
	const messages: SentMessage[] = [];
	const collectResolvers: Array<(s: CollectSnapshot) => void> = [];
	const retires: Array<() => void> = [];
	let resolveS!: (s: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	// Long window on purpose: the batch must be flushed by the last member coming
	// home, never by a timer that could fire halfway through the sequence.
	runtime.setJoinConfig({ mode: "smart", flushMs: 60_000 });
	const trackX = () =>
		runtime.track({
			name: "x",
			runId: "r-1",
			agent: "worker",
			sessionFile: "/tmp/x.jsonl",
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					collectResolvers.push(resolve);
				}),
			retire: () =>
				new Promise<void>((resolve) => {
					retires.push(resolve);
				}),
		});

	// `s` keeps the group open so x's terminal entries stay in the window buffer.
	runtime.track({
		name: "s",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/s.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveS = resolve;
			}),
	});

	// ── round 1: buffered, never read
	trackX();
	runtime.watch("x");
	runtime.watch("s");
	await waitFor(() => collectResolvers.length === 1, "round 1 is collecting");
	collectResolvers[0]!(joinSnapshot({ output: "round-1-out" }));
	await waitFor(() => retires.length === 1, "round 1's watch is parked in retire");
	assert.equal(messages.length, 0, "round 1 waits in the window");
	retires[0]!();
	await waitFor(() => runtime.get("x") === undefined, "round 1's watch released the child");

	// ── round 2: a fresh job (so `track()` takes the NEW-job branch) buffered too
	trackX();
	runtime.watch("x");
	await waitFor(() => collectResolvers.length === 2, "round 2 is collecting");
	collectResolvers[1]!(joinSnapshot({ output: "round-2-out" }));
	await waitFor(() => retires.length === 2, "round 2's watch is parked in retire");

	// ── the parent reads round 2 through the tool route, which claims it
	const pendingWait = runtime.wait(["x"], { timeoutMs: 5_000 });
	await waitFor(() => retires.length === 3, "the wait is parked in its retire await");
	retires[2]!();
	const waited = await pendingWait;
	assert.equal(waited[0]?.snapshot?.output, "round-2-out");
	assert.equal(runtime.get("x"), undefined, "the wait released x");

	// ── everyone home: the batch flushes
	resolveS(joinSnapshot({ output: "s-out" }));
	await waitFor(() => messages.length === 1, "one notice for the whole group");
	const content = messages[0]!.content;
	assert.match(content, /round-1-out/, "round 1 was never read: its notice must still arrive");
	assert.match(content, /s-out/, "positive control: the flush really ran");
	assert.doesNotMatch(content, /round-2-out/, "round 2 was the tool result, never a notice");
	assert.equal(messages.length, 1, "exactly one message");
	runtime.dispose();
});

test("claim D7: rewatch revokes the HELD OUTBOX copy of a read result (the sibling still arrives)", async () => {
	// The genuine revoke path, i.e. the one where the claim and an undelivered copy
	// (here: an outbox entry) actually coexist. `rewatch` is the parent explicitly
	// asking to be told again while the result has ALREADY been read: D7 says the
	// claim and every pending copy of it go together. Delete the `dropQueued` call
	// in `unclaimReported` and the already-read notice is resurrected into the next
	// settle — this case goes red.
	//
	// `free` is the positive control (hard requirement 7): an unclaimed entry in the
	// same held batch must arrive, so a dead flush cannot make this green.
	const messages: SentMessage[] = [];
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const retires: Array<() => void> = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	runtime.track({
		name: "held",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/held.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolvers.set("held", resolve);
			}),
		// Keeps the job tracked so `rewatch` has something to act on: a released
		// child has no claim to revoke and no round to re-arm.
		retire: () =>
			new Promise<void>((resolve) => {
				retires.push(resolve);
			}),
	});
	runtime.track({
		name: "free",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/free.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolvers.set("free", resolve);
			}),
	});
	runtime.watch("held");
	runtime.watch("free");
	resolvers.get("held")!(joinSnapshot({ output: "held-out" }));
	resolvers.get("free")!(joinSnapshot({ output: "free-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "the batch is held for the live run");
	assert.equal(messages.length, 0, "a live run holds the notice");

	const pendingWait = runtime.wait(["held"], { timeoutMs: 5_000 });
	await waitFor(() => retires.length === 2, "the wait is parked in its retire await");
	assert.equal(runtime.noticeQueueStats().pending, 1, "still one item — now only for `free`");

	runtime.rewatch("held");
	assert.equal(
		runtime.noticeQueueStats().pending,
		1,
		"the revoked copy left the outbox without taking the sibling with it",
	);

	retires[1]!();
	const waited = await pendingWait;
	assert.equal(waited[0]?.snapshot?.output, "held-out");

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "the unclaimed sibling is delivered");
	assert.match(messages[0]!.content, /free-out/, "positive control: the flush really ran");
	assert.doesNotMatch(messages[0]!.content, /held-out/, "the revoked copy was not resurrected");
	assert.equal(messages.length, 1, "exactly one message");
	runtime.dispose();
});

test("claim D7: rewatch also drops the copy still sitting in the join window", async () => {
	// The second copy the revoke has to reach: the join window. Here the entry never
	// enters the outbox (a sibling is still pending), so `dropQueued` cannot help —
	// only `join.dropBuffered` can. Delete that call and the read result's buffered
	// notice fires when the group finally flushes.
	const messages: SentMessage[] = [];
	const collectResolvers: Array<(s: CollectSnapshot) => void> = [];
	const retires: Array<() => void> = [];
	let resolveS!: (s: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	// Nothing flushes mid-scenario: `s` is the only thing that can close the group.
	runtime.setJoinConfig({ mode: "smart", flushMs: 60_000 });
	runtime.track({
		name: "s",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/s.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveS = resolve;
			}),
	});
	runtime.track({
		name: "x",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/x.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				collectResolvers.push(resolve);
			}),
		retire: () =>
			new Promise<void>((resolve) => {
				retires.push(resolve);
			}),
	});
	runtime.watch("x");
	runtime.watch("s");
	await waitFor(() => collectResolvers.length === 1, "x is collecting");
	collectResolvers[0]!(joinSnapshot({ output: "x-out" }));
	await waitFor(() => retires.length === 1, "x's watch is parked in retire");
	assert.equal(runtime.noticeQueueStats().pending, 0, "buffered, not queued: the outbox is untouched");

	const pendingWait = runtime.wait(["x"], { timeoutMs: 5_000 });
	await waitFor(() => retires.length === 2, "the wait is parked in its retire await");
	runtime.rewatch("x");
	retires[1]!();
	const waited = await pendingWait;
	assert.equal(waited[0]?.snapshot?.output, "x-out", "the tool route still delivers the full result");

	resolveS(joinSnapshot({ output: "s-out" }));
	await waitFor(() => messages.length === 1, "the sibling flushes alone");
	assert.match(messages[0]!.content, /s-out/, "positive control: the flush really ran");
	assert.doesNotMatch(messages[0]!.content, /x-out/, "the revoked buffered copy is gone");
	assert.equal(messages.length, 1, "exactly one message");
	runtime.dispose();
});

test("claim D2: a collect that bails before delivering hands its claim back (minor 4)", async () => {
	// The seam claims a terminal snapshot on the way out, because a join/outbox flush
	// in that same tick would otherwise repeat it. But `collectChild` may still bail
	// AFTER that point — persisting the child can fail, which the tool turns into
	// `fail("collect failed: …")` — and then the text never reaches the parent.
	// Keeping the claim would suppress the one route that is left (the pushed notice)
	// forever, which is worse than the duplicate it was defending against.
	const messages: SentMessage[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	runtime.track({
		name: "x",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/x.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "x-out" }),
	});
	runtime.watch("x");
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "the notice is held");
	await waitFor(() => runtime.get("x") === undefined, "the watch released the child");

	// `childrenSnapshot` throws before the child is persisted or rendered, so the tool
	// call fails the way a real store error would (persistChild swallows only
	// competing-lifecycle write failures, not this).
	const ctx = {
		name: "x",
		found: { runId: "r-1" },
		runtime,
		store: {},
		orchestrator: {
			childrenSnapshot() {
				throw new Error("store unreachable");
			},
		},
	} as unknown as Parameters<typeof collectChild>[0];
	const result = await collectChild(ctx, new AbortController().signal);
	const text = (result.content as Array<{ text?: string }>)
		.map((part) => part.text ?? "")
		.join("\n");
	assert.match(text, /collect failed/, "the tool call failed, so the snapshot reached nobody");

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "the unread notice is the only route left, and it arrives");
	assert.match(messages[0]!.content, /x-out/);
	assert.equal(messages.length, 1, "exactly once");
	runtime.dispose();
});

test("claim D2/#320-2: a bail AFTER the job-branch claim still lands the notice (watch in flight)", async () => {
	// #320 finding 2, in the PRODUCTION shape: every child is watched (`followChild` with
	// `watch: true`), `collect` never cancels that watch, and both await the same
	// `job.collectPromise`. So the watch's continuation runs FIRST — its gate
	// (`!consumedByTool && !notified`) sees the flag the seam just set and skips
	// `onTerminal` — and by the time `collectChild` bails the watch is already parked in
	// `retire` with `job.watching === true`. That is why the repair may not be gated on
	// "nobody is watching": there is always somebody watching, so the re-arm is
	// unconditional and the generation bump makes the old watch skip its `release`.
	//
	// Delete any of the three repairs in `unclaimUndelivered` and this goes red: the
	// `consumedByTool` reset (the re-armed gate would skip), the re-arm (nothing is left
	// to deliver), or the claim rollback (`deliverBatch` filters the notice out).
	const messages: SentMessage[] = [];
	const retires: Array<() => void> = [];
	let resolveCollect!: (s: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.track({
		name: "x",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/x.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
		// An async retire is what production has (an RPC round trip): the watch's
		// `finally` parks here, which is the window the rollback runs in.
		retire: () =>
			new Promise<void>((resolve) => {
				retires.push(resolve);
			}),
	});
	runtime.watch("x");

	const controller = new AbortController();
	const pending = runtime.consumeCollectInterruptible("x", controller.signal);
	assert.ok(pending, "the tracked job answers on the JOB branch");
	assert.equal(runtime.get("x")?.consumedByTool, true, "the tool call owns the notice route");

	resolveCollect(joinSnapshot({ output: "x-out" }));
	// The watch got there first and is parked in retire: its gate already skipped.
	await waitFor(() => retires.length === 1, "the watch is parked in retire");
	assert.ok(runtime.get("x"), "still tracked ⇒ job branch, not the finished cache");
	assert.equal(messages.length, 0, "the gate skipped onTerminal, as expected");

	const collected = await pending;
	assert.equal(collected?.snapshot.output, "x-out", "the seam handed the claimed snapshot out");
	assert.equal(collected?.claimedNow, true, "this call is the one that took the claim");

	// …and NOW the parent turn aborts: after the claim, before the snapshot is rendered.
	controller.abort();
	runtime.unclaimUndelivered("x", collected!.snapshot, collected!.claimedNow);
	assert.equal(runtime.get("x")?.consumedByTool, false, "the bail hands the notice route back");
	assert.ok(
		runtime.get("x"),
		"the old watch's release is skipped (generation bumped), so the re-arm has a job to run",
	);

	await waitFor(() => messages.length === 1, "the re-armed watch delivers the notice");
	assert.match(messages[0]!.content, /x-out/);
	assert.equal(messages.length, 1, "exactly one notice, never two");
	// The result was never delivered, so it must also still be readable.
	const again = (await runtime.consumeCollect("x"))?.snapshot;
	assert.equal(again?.output, "x-out", "the result survives the bail");
	runtime.dispose();
});

test("claim D2/#320-1: a bail never erases a claim a real delivery already took", async () => {
	// #320 finding 1. `unclaimUndelivered` used to delete the key unconditionally, so a
	// bail on a `(runId, name, round)` that a REAL delivery had already claimed erased the
	// evidence and resurrected a result the parent had read. `claimedNow` travels with the
	// seam's return value (per CALL, not per snapshot), and only a `true` comes back.
	//
	// Phase A (job branch): the round's notice is still held in the outbox when the first
	// collect delivers it, so master's "delete the claim anyway" resurrects it into the
	// next flush — an observable consequence, not just a flag assertion.
	// Phase B (cache branch): same question one layer down, where the delivery claim comes
	// from the finished cache (D9). An unread sibling is the positive control in both.
	const messages: SentMessage[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});

	// ── Phase A: job branch with the notice still held.
	runtime.notifyParentRunStart();
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const retires: Array<() => void> = [];
	for (const name of ["held", "mate"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
			// Keeps both jobs TRACKED after their terminal snapshot, so `held` is read on
			// the job branch while its unread notice is still queued.
			retire: () =>
				new Promise<void>((resolve) => {
					retires.push(resolve);
				}),
		});
		runtime.watch(name);
	}
	resolvers.get("held")!(joinSnapshot({ output: "held-out" }));
	resolvers.get("mate")!(joinSnapshot({ output: "mate-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "both notices held as one batch");
	await waitFor(() => retires.length === 2, "both jobs parked in retire ⇒ still tracked");

	const delivered = await runtime.consumeCollect("held");
	assert.equal(delivered?.snapshot.output, "held-out", "the tool route delivered this round");
	assert.equal(delivered?.claimedNow, true, "the delivery took the claim");
	const second = await runtime.consumeCollect("held");
	assert.equal(second?.snapshot.output, "held-out", "the seam still hands the same snapshot out");
	assert.equal(second?.claimedNow, false, "a second call does NOT own that claim");
	// The bail of the second call: the claim belongs to the first one, so this is a no-op —
	// not even `consumedByTool` may be reset.
	runtime.unclaimUndelivered("held", second!.snapshot, second!.claimedNow);
	assert.equal(
		runtime.get("held")?.consumedByTool,
		true,
		"a claim this call did not take is left alone — the whole rollback is a no-op",
	);

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "the unread sibling still arrives");
	assert.match(messages[0]!.content, /mate-out/, "positive control: the flush really ran");
	assert.doesNotMatch(
		messages[0]!.content,
		/held-out/,
		"the read result keeps its claim: no second announcement",
	);
	assert.equal(messages.length, 1, "exactly one message");

	// ── Phase B: the same question on the cache branch.
	runtime.notifyParentRunStart();
	const cache = new Map<string, (s: CollectSnapshot) => void>();
	for (const name of ["x", "y"]) {
		runtime.track({
			name,
			runId: "r-2",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					cache.set(name, resolve);
				}),
		});
		runtime.watch(name);
	}
	cache.get("x")!(joinSnapshot({ output: "x-out" }));
	cache.get("y")!(joinSnapshot({ output: "y-out" }));
	await waitFor(
		() => runtime.get("x") === undefined && runtime.get("y") === undefined,
		"both released ⇒ the cache branch",
	);
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "the second batch is held too");

	// The parent reads x: a real delivery, claimed from the cache (D9).
	const read = await runtime.consumeCollect("x");
	assert.equal(read?.snapshot.output, "x-out");
	assert.equal(read?.claimedNow, true);
	// A LATER collect on the same name bails (abort / persist failure). The key is already
	// claimed, so the rollback must leave it alone…
	const bailed = await runtime.consumeCollect("x");
	assert.equal(bailed?.snapshot.output, "x-out");
	assert.equal(bailed?.claimedNow, false, "nobody else may spend that claim");
	runtime.unclaimUndelivered("x", bailed!.snapshot, bailed!.claimedNow);

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 2, "the sibling still arrives");
	assert.match(messages[1]!.content, /y-out/, "positive control: the flush really ran");
	assert.doesNotMatch(
		messages[1]!.content,
		/x-out/,
		"the read result keeps its claim: no second announcement",
	);
	assert.equal(messages.length, 2, "exactly one message per batch");
	runtime.dispose();
});

test("claim D2/#320-1: the rollback follows the CALL that took the claim, never the snapshot", async () => {
	// The distinguishing case between "per call" and "per snapshot" bookkeeping (#327).
	// A and B collect the SAME `job.collectPromise`, so they get the same snapshot
	// OBJECT: A takes the claim (`claimedNow === true`) and B does not (`false`). A
	// table keyed by the snapshot therefore has exactly one slot for the two calls —
	// B's `false` overwrites A's `true` — and A's bail, the only one that may spend
	// that claim, reads back `false` and returns early. The claim then outlives a
	// delivery that never happened and the queued notice is filtered out for good:
	// one result, delivered zero times. Carrying the flag home in the return value
	// keeps the two calls apart, so the notice still lands — exactly once.
	const messages: SentMessage[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	const resolvers = new Map<string, (s: CollectSnapshot) => void>();
	const retires: Array<() => void> = [];
	for (const name of ["held", "mate"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((resolve) => {
					resolvers.set(name, resolve);
				}),
			// Keeps both jobs TRACKED after their terminal snapshot (the job branch) while
			// the batch sits unread in the outbox.
			retire: () =>
				new Promise<void>((resolve) => {
					retires.push(resolve);
				}),
		});
		runtime.watch(name);
	}
	resolvers.get("held")!(joinSnapshot({ output: "held-out" }));
	resolvers.get("mate")!(joinSnapshot({ output: "mate-out" }));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "both notices held as one batch");
	await waitFor(() => retires.length === 2, "both jobs parked in retire ⇒ still tracked");

	// Two collects, one shared promise: A owns the claim, B does not.
	const a = await runtime.consumeCollect("held");
	assert.equal(a?.claimedNow, true, "the first call takes this round's claim");
	const b = await runtime.consumeCollect("held");
	assert.equal(b?.claimedNow, false, "the second call gets the result without a claim");
	assert.equal(
		a?.snapshot,
		b?.snapshot,
		"one job ⇒ one collect promise ⇒ the two calls share the snapshot object",
	);

	// The bail comes from A — the call that took the claim. It reached nobody, so the
	// claim goes back and the held notice becomes deliverable.
	runtime.unclaimUndelivered("held", a!.snapshot, a!.claimedNow);
	assert.equal(
		runtime.get("held")?.consumedByTool,
		false,
		"the owning call's bail hands the notice route back",
	);

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "the held batch is flushed");
	assert.match(messages[0]!.content, /mate-out/, "positive control: the flush really ran");
	assert.equal(
		(messages[0]!.content.match(/held-out/g) ?? []).length,
		1,
		"the bailed call's result is delivered exactly once — never zero, never twice",
	);
	assert.equal(messages.length, 1, "one batch, one message");
	runtime.dispose();
});

test("claim D2/#320: collectChild's OWN abort bail hands the claim back (index wiring)", async () => {
	// `collectChild` has two bail doors and the claim is only restored if the closed one is
	// wired: `!collected || signal?.aborted` (this case) and a throwing `persistChild`
	// (minor 4, above). Here the abort lands after the seam's promise is already resolved —
	// the cache branch answers synchronously, so aborting in the same tick still passes the
	// function's first `signal.aborted` gate — which is the only way into the
	// `collected && signal.aborted` combination.
	//
	// Delete the `ctx.runtime.unclaimUndelivered(...)` call in that branch and the held
	// notice stays filtered out forever: red.
	const messages: SentMessage[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.notifyParentRunStart();
	runtime.track({
		name: "x",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/x.jsonl",
		timeoutMs: 1_000,
		collect: async () => joinSnapshot({ output: "x-out" }),
	});
	runtime.watch("x");
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "the notice is held");
	await waitFor(() => runtime.get("x") === undefined, "the watch released the child");

	const ctx = {
		name: "x",
		found: { runId: "r-1" },
		runtime,
		store: {},
		orchestrator: {},
	} as unknown as Parameters<typeof collectChild>[0];
	const controller = new AbortController();
	const pending = collectChild(ctx, controller.signal);
	// The seam answered from the finished cache in this same tick; the abort therefore
	// lands after `await pending` resolved but before `collectChild` looks at the signal.
	controller.abort();
	const result = await pending;
	const text = (result.content as Array<{ text?: string }>)
		.map((part) => part.text ?? "")
		.join("\n");
	assert.match(text, /interrupted/, "the tool call delivered nothing");

	runtime.notifyParentSettled();
	await waitFor(() => messages.length === 1, "the rollback put the notice back on the wire");
	assert.match(messages[0]!.content, /x-out/);
	assert.equal(messages.length, 1, "exactly once");
	runtime.dispose();
});

test("claim D2/#320-2: collectChild's JOB-branch bail still lands the notice (live job, retire pending)", async () => {
	// The end-to-end shape of #320/2 through the real caller (#327), on the branch that
	// production actually takes: the job is STILL TRACKED and its watch is parked in an
	// unresolved `retire`, so the watch's gate has already skipped `onTerminal` and the
	// re-arm is the only thing that can deliver. The cache-branch case above starts from
	// a released child and never exercises that window.
	//
	// The abort has to land in one specific window — after the seam answered with the
	// claim, before `collectChild` reads `signal?.aborted` — which is exactly one
	// microtask hop wide. Registering the abort on the seam's promise here (ahead of
	// `collectChild`'s own `await`) puts it there deterministically instead of relying on
	// a sleep: the handler is queued first, flips `aborted`, and only then does
	// `collectChild` resume and bail. Delete the rollback in that branch and this goes
	// red with zero messages: the claim keeps filtering the notice out forever.
	const messages: SentMessage[] = [];
	const retires: Array<() => void> = [];
	let resolveCollect!: (s: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	runtime.track({
		name: "x",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/x.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
		// An async retire is what production has (an RPC round trip): the watch parks
		// here, which keeps the job tracked and the notice route in flight.
		retire: () =>
			new Promise<void>((resolve) => {
				retires.push(resolve);
			}),
	});
	runtime.watch("x");

	const controller = new AbortController();
	const seam = {
		...runtime,
		consumeCollectInterruptible(name: string, signal: AbortSignal) {
			const answered = runtime.consumeCollectInterruptible(name, signal);
			// Queued before `collectChild` awaits the same promise ⇒ the abort lands
			// right after the claim, right before the bail check.
			answered?.then(
				() => controller.abort(),
				() => {},
			);
			return answered;
		},
	};
	const ctx = {
		name: "x",
		found: { runId: "r-1" },
		runtime: seam,
		store: {},
		orchestrator: {},
	} as unknown as Parameters<typeof collectChild>[0];

	const pending = collectChild(ctx, controller.signal);
	assert.equal(runtime.get("x")?.consumedByTool, true, "the tool call owns the notice route");
	resolveCollect(joinSnapshot({ output: "x-out" }));
	const result = await pending;
	const text = (result.content as Array<{ text?: string }>)
		.map((part) => part.text ?? "")
		.join("\n");
	assert.match(text, /interrupted/, "the tool call delivered nothing");

	// The bail happened on the JOB branch: the job is still live, its watch is still
	// parked in retire, and the rollback handed the notice route back.
	assert.ok(runtime.get("x"), "the job is still tracked (job branch, not the finished cache)");
	assert.equal(runtime.get("x")?.consumedByTool, false, "the bail restored the notice route");
	// Two watches have reached retire: the one whose gate skipped (generation bump kept
	// it from releasing) and the re-armed one. Neither resolving is the point — the job
	// is still the same live job the notice has to come from.
	assert.equal(retires.length, 2, "the original watch parked in retire, then the re-armed one");
	assert.equal(runtime.get("x")?.watching, true, "the re-armed watch is live on the same job");

	await waitFor(() => messages.length === 1, "the re-armed watch delivers the notice");
	assert.match(messages[0]!.content, /x-out/);
	assert.equal(messages.length, 1, "exactly one notice, never two");
	runtime.dispose();
});
