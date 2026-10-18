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
});

test("T3: runtime — a notice held past MAX_PENDING_AGE_MS is force-sent while the run is still active", async () => {
	const messages: unknown[] = [];
	const overflow = manualOverflow();
	let resolveCollect!: (value: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
		now: () => 1_000,
		scheduleNoticeOverflow: overflow.scheduleNoticeOverflow,
	});

	runtime.notifyParentRunStart();
	runtime.track({
		name: "stuck",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/stuck.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
	});
	runtime.watch("stuck");
	resolveCollect(joinSnapshot({ output: "stuck-out" }));

	await waitFor(() => runtime.noticeQueueStats().pending === 1, "notice held");
	assert.equal(overflow.timers.length, 1, "exactly one overflow timer armed");
	assert.equal(overflow.timers[0]!.ms, MAX_PENDING_AGE_MS, "delay is the hard cap from enqueue");
	assert.equal(messages.length, 0);

	overflow.timers[0]!.fn();
	assert.equal(messages.length, 1, "the cap force-sends even during a live run");
	assert.equal(runtime.noticeQueueStats().forcedFlushes, 1, "the overflow is counted");
	assert.equal(runtime.noticeQueueStats().pending, 0);
});

test("T4: runtime — agent_settled cancels the overflow timer and does not double-send", async () => {
	const messages: unknown[] = [];
	const overflow = manualOverflow();
	let resolveCollect!: (value: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
		now: () => 1_000,
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
	assert.equal(messages.length, 1, "settle delivered it once");

	// A late fire of the already-cancelled timer must not send again.
	overflow.timers[0]!.fn();
	assert.equal(messages.length, 1, "no duplicate delivery after the settle");
	assert.equal(runtime.noticeQueueStats().forcedFlushes, 0, "the cap never counted");
});

test("T5: runtime — a cancelled watch whose collect lands later is released, not left as a working ghost", async () => {
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
	// (stop() semantics): the watch continuation is now the only owner left.
	runtime.cancelWatch("ghost");
	assert.equal(runtime.get("ghost")?.watching, false);

	// The in-flight collect still resolves. Without the orphan release the job
	// stays in the map forever and the widget/OSC keeps reporting "working".
	resolveCollect(joinSnapshot());
	await waitFor(() => runtime.activeJobs().length === 0, "orphaned job released");
	assert.equal(runtime.get("ghost"), undefined, "no phantom row");
});

test("T6: runtime — a stale continuation never releases a job a newer watch owns", async () => {
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
	// path: the old generation's collect resolving must not release it.
	runtime.rewatch("owned");
	const job = runtime.get("owned");
	assert.ok(job);
	assert.equal(job.generation, 2, "rewatch bumped the generation");
	assert.equal(job.watching, true);

	resolvers[0]!(joinSnapshot({ output: "stale" }));
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(runtime.activeJobs().length, 1, "the stale continuation must not release the job");
	assert.equal(runtime.get("owned")?.watching, true, "the newer watch still owns it");
	assert.equal(messages.length, 0, "the stale snapshot is never notified");

	resolvers[1]!(joinSnapshot({ output: "live" }));
	await waitFor(() => messages.length === 1, "the live watch notifies");
	assert.match(messages[0]!.content, /live/);
	assert.equal(messages.length, 1, "exactly one notice from the owning watch");
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
});
