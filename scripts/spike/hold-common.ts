/**
 * Shared body of the two throwaway spike extensions (`ext-a.ts`, `ext-b.ts`).
 *
 * EXPERIMENT ONLY — issue #417 hold-spike. Nothing here is product code and the
 * whole `scripts/spike/` directory is meant to be deleted once the report lands.
 *
 * Each extension is a *separate* pi extension (loaded with its own `--extension`
 * flag), so two of them registered at once reproduces "two independent extensions
 * both holding the settle boundary".
 *
 * Everything is configured through env vars so one file can serve every case:
 *   SPIKE_<ID>_ITERS      how many boundary invocations to hold (default 0 = observe only)
 *   SPIKE_<ID>_HOLD_MS    how long one hold waits before releasing (default 300)
 *   SPIKE_<ID>_MODE       "spread" (default) | "replace" | "none"
 *                         spread  -> entries: [...event.entries, draft]
 *                         replace -> entries: [draft]          (drops earlier drafts)
 *                         none    -> continue:true only, no draft
 *                         veto    -> continue:false, entries passed through
 *   SPIKE_<ID>_WATCH      "" (default) | "pending" | "signal"
 *                         pending -> release as soon as ctx.hasPendingMessages()
 *                         signal  -> release as soon as ctx.signal aborts
 *   SPIKE_<ID>_SEND_AT_MS delay after agent_start before sending a followUp (enables the send)
 *   SPIKE_<ID>_SEND_TEXT  payload of that followUp (default SPIKE_FOLLOWUP)
 *   SPIKE_<ID>_SEND_AS    deliverAs for that send (default "followUp")
 *   SPIKE_<ID>_SEND_KIND  "custom" (pi.sendMessage) | "user" (pi.sendUserMessage)
 *   SPIKE_<ID>_ABORT_AT_MS delay after agent_start before ctx.abort() (enables the abort)
 *   SPIKE_LOG             JSONL path every extension appends its observations to
 */

import fs from "node:fs";

/** Wall-clock ms + ISO stamp; both go in the log so cross-file joins are exact. */
function iso(): string {
	return new Date().toISOString();
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

function envStr(name: string, fallback: string): string {
	const raw = process.env[name];
	return raw === undefined || raw === "" ? fallback : raw;
}

function log(record: Record<string, unknown>): void {
	const path = process.env.SPIKE_LOG;
	if (!path) return;
	try {
		fs.appendFileSync(path, `${JSON.stringify({ ts: iso(), t: Date.now(), ...record })}\n`);
	} catch {
		/* a spike must never fail the run it measures */
	}
}

/** A minimal pi-shaped extension. `pi` is `ExtensionAPI`; untyped on purpose. */
export function installHold(pi: any, id: string): void {
	const iters = envInt(`SPIKE_${id}_ITERS`, 0);
	const holdMs = envInt(`SPIKE_${id}_HOLD_MS`, 300);
	const mode = envStr(`SPIKE_${id}_MODE`, "spread");
	const watch = envStr(`SPIKE_${id}_WATCH`, "");
	const sendAt = process.env[`SPIKE_${id}_SEND_AT_MS`];
	const sendText = envStr(`SPIKE_${id}_SEND_TEXT`, "SPIKE_FOLLOWUP");
	const sendAs = envStr(`SPIKE_${id}_SEND_AS`, "followUp");
	const abortAt = process.env[`SPIKE_${id}_ABORT_AT_MS`];
	const sendKind = envStr(`SPIKE_${id}_SEND_KIND`, "custom");

	// NOTE: deliberately NOT reset on `agent_start`. The spike discovered that a
	// boundary continuation starts a whole new agent run, so `agent_start` fires
	// again on every hop — a per-run budget reset there can never be exhausted.
	let fires = 0;
	let runStarts = 0;
	let timers: Array<ReturnType<typeof setTimeout>> = [];

	log({ ext: id, ev: "registered", iters, holdMs, mode, watch, sendAt, abortAt, mode_ctx: undefined });

	pi.on("agent_start", (_event: unknown, ctx: any) => {
		runStarts += 1;
		log({ ext: id, ev: "agent_start", runStarts, runMode: safe(() => ctx?.mode) });
		if (sendAt !== undefined) {
			timers.push(
				setTimeout(() => {
					const t = Date.now();
					log({ ext: id, ev: "send:begin", text: sendText, deliverAs: sendAs });
					try {
						if (sendKind === "user") {
							pi.sendUserMessage(sendText, { deliverAs: sendAs });
						} else {
							pi.sendMessage(
								{ customType: `spike-${id.toLowerCase()}-notice`, content: sendText, display: true },
								{ triggerTurn: true, deliverAs: sendAs },
							);
						}
						log({ ext: id, ev: "send:done", t });
					} catch (error) {
						log({ ext: id, ev: "send:throw", error: String(error) });
					}
				}, Number(sendAt)),
			);
		}
		if (abortAt !== undefined) {
			timers.push(
				setTimeout(() => {
					log({ ext: id, ev: "abort:begin" });
					safe(() => ctx?.abort());
					log({ ext: id, ev: "abort:done" });
				}, Number(abortAt)),
			);
		}
	});

	pi.on("agent_end", () => {
		log({ ext: id, ev: "agent_end" });
	});

	pi.on("agent_settled", (event: any) => {
		log({ ext: id, ev: "agent_settled", aborted: safe(() => event?.aborted) });
		for (const timer of timers.splice(0)) clearTimeout(timer);
	});

	pi.on("session_shutdown", () => {
		for (const timer of timers.splice(0)) clearTimeout(timer);
		log({ ext: id, ev: "session_shutdown" });
	});

	pi.on("agent_before_settle", async (event: any, ctx: any) => {
		fires += 1;
		const entryTypes = Array.isArray(event?.entries)
			? event.entries.map((e: any) => e?.customType ?? e?.type)
			: [];
		log({
			ext: id,
			ev: "boundary:in",
			fires,
			runStarts,
			entriesIn: entryTypes,
			continueIn: event?.continue,
			canContinue: safe(() => event?.context?.canContinue),
			pendingMessages: safe(() => event?.context?.pendingMessages?.length),
			hasPendingMessages: safe(() => ctx?.hasPendingMessages()),
			hasSignal: safe(() => Boolean(ctx?.signal)),
			signalAborted: safe(() => ctx?.signal?.aborted),
			runMode: safe(() => ctx?.mode),
			outcome: safe(() => event?.outcome),
		});

		if (fires > iters) {
			log({ ext: id, ev: "boundary:release", fires, reason: "budget-spent" });
			return undefined;
		}

		const inAt = Date.now();
		let reason = "hold-ms";
		if (watch === "signal") {
			reason = await waitForSignal(ctx, holdMs);
		} else if (watch === "pending") {
			reason = await waitForPending(ctx, holdMs);
		} else {
			await sleep(holdMs);
		}
		const heldMs = Date.now() - inAt;
		log({ ext: id, ev: "boundary:held", fires, reason, heldMs, signalAborted: safe(() => ctx?.signal?.aborted) });

		if (mode === "veto") {
			// explicit continue:false — can a later handler cancel an earlier hold?
			const vetoEntries = Array.isArray(event?.entries) ? event.entries : [];
			log({ ext: id, ev: "boundary:out", fires, entriesReturned: vetoEntries.map((e: any) => e?.customType), continue: false });
			return { entries: vetoEntries, continue: false };
		}
		if (mode === "none") {
			log({ ext: id, ev: "boundary:out", fires, entriesReturned: [], continue: true });
			return { continue: true };
		}
		const draft = {
			type: "custom_message",
			customType: `spike-${id.toLowerCase()}-hold`,
			content: `SPIKE_${id}_HELD_AT_${fires}`,
			display: false,
		};
		const entries =
			mode === "replace" ? [draft] : [...(Array.isArray(event?.entries) ? event.entries : []), draft];
		log({
			ext: id,
			ev: "boundary:out",
			fires,
			entriesReturned: entries.map((e: any) => e?.customType ?? e?.type),
			continue: true,
		});
		return { entries, continue: true };
	});
}

function safe<T>(fn: () => T): T | string {
	try {
		return fn();
	} catch (error) {
		return `throw:${String(error)}`;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `ctx.hasPendingMessages()` — the "does a queued message preempt the hold" probe. */
async function waitForPending(ctx: any, holdMs: number): Promise<string> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < holdMs) {
		const pending = safe(() => ctx?.hasPendingMessages());
		if (pending === true) return "pending-message";
		await sleep(50);
	}
	return "hold-ms";
}

/** Release the moment the host aborts the run, if the signal actually fires here. */
async function waitForSignal(ctx: any, holdMs: number): Promise<string> {
	const signal = safe(() => ctx?.signal) as AbortSignal | undefined;
	if (!signal || typeof signal.addEventListener !== "function") {
		await sleep(holdMs);
		return "hold-ms-no-signal";
	}
	if (signal.aborted) return "signal-already-aborted";
	const aborted = new Promise<string>((resolve) => {
		signal.addEventListener("abort", () => resolve("signal-aborted"), { once: true });
	});
	const timer = new Promise<string>((resolve) => setTimeout(() => resolve("hold-ms"), holdMs));
	return Promise.race([aborted, timer]);
}
