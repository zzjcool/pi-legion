import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createSessionRuntime,
	formatAliveQuiet,
	lastJsonlEventAgeMs,
	renderLiveChildStatus,
	shouldRecycleAfterCollect,
} from "../../src/extension/runtime.ts";
import { SUBAGENT_NOTIFY_TYPE } from "../../src/extension/notify.ts";
import type { CollectSnapshot } from "../../src/extension/runtime.ts";
import { withTempDir } from "../helpers/tmp.ts";
import { assistantMsg, modelChange, sessionHeader, userMsg } from "../helpers/fixtures.ts";
import type { TreeNodeSnapshot } from "../../src/tui/tree-view.ts";
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
	assert.deepEqual(results, [{ name: "slow", stillRunning: true }]);
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

test("runtime.wait: an interrupted unwatched job is not re-armed before the session cascade", async () => {
	let resolveCollect!: (snapshot: CollectSnapshot) => void;
	const messages: unknown[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) { messages.push(message); },
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
	assert.equal(runtime.get("unwatched")?.watching, false, "the session cascade, not waitOne, owns post-abort cleanup");
	resolveCollect(joinSnapshot({ output: "retired by cascade" }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(messages.length, 0, "aborted waits do not arm a completion notification");
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
	assert.deepEqual(results, [{ name: "b", stillRunning: true }]);
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
	assert.deepEqual(results, [{ name: "r", stillRunning: true }]);
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
		assert.ok(text.indexOf("execution snapshot:") < text.indexOf("supervisor=rpc"), "snapshot before path meta");
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
		assert.ok(text.indexOf("execution snapshot:") < text.indexOf("supervisor=rpc"));
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
