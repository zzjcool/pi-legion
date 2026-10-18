import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createSessionRuntime,
	formatAliveQuiet,
	lastJsonlEventAgeMs,
	MAX_PENDING_AGE_MS,
	renderLiveChildStatus,
	shouldRecycleAfterCollect,
} from "../../src/extension/runtime.ts";
import { SUBAGENT_NOTIFY_TYPE } from "../../src/extension/notify.ts";
import type { CollectSnapshot } from "../../src/extension/runtime.ts";
import { withTempDir } from "../helpers/tmp.ts";
import { assistantMsg, modelChange, sessionHeader, userMsg } from "../helpers/fixtures.ts";
import type { TreeNodeSnapshot } from "../../src/tui/tree-view.ts";
import type { StatusUi } from "../../src/tui/status.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";

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
	const collected = await pending;
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
	const collected = await pending;
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
	const collected = await runtime.consumeCollect("stale");
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
	const first = await runtime.consumeCollect("done");
	assert.equal(first?.output, "all good");
	runtime.release("done");
	const cached = await runtime.consumeCollect("done");
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

test("a thrown Connection error is a failure once the RPC child is gone", async () => {
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
	assert.match(messages[0]!.content, /RPC child is not alive/);
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
