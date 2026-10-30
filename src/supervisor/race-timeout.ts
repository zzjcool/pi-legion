/**
 * The one bounded-wait helper both supervisor backends use (#325).
 *
 * `abort` has two steps that must not hang the caller: the pre-abort queue clear
 * and the interrupt itself (#314 D4). Both used to be implemented twice — once in
 * `RpcSupervisor`, once in `InProcessSupervisor` — with the same three
 * load-bearing details spelled out in each copy: the timer is cleared on the
 * settling path, a loser that settles after the timer answered is not left to
 * surface as an unhandled rejection, and the delay is clamped to the largest one
 * `setTimeout` honours. Two copies of that reasoning is two places for it to
 * drift, so it lives here.
 *
 * `onTimeout` builds the answer rather than passing one in because each caller
 * formats a different value ({@link countClearedQueue}'s zeros vs. `"timeout"`),
 * and a fresh object per call keeps two callers from sharing one mutable answer.
 */

import { MAX_ABORT_TIMER_DELAY_MS } from "./types.ts";

/**
 * Resolve with `work`, or with `onTimeout()` if `bound` elapses first.
 *
 * - the timer is **not** `unref`'d: it is usually the only thing driving the
 *   caller's `await`, and an unref'd timer lets the event loop drain (and
 *   `node --test` abort the case) before it ever fires;
 * - the explicit `work.catch` below is defensive, not the mechanism: `Promise.race`
 *   already subscribes to every input, so a late rejection from the loser is
 *   observed either way. It is kept as the plain statement of intent ("the loser
 *   is none of the caller's business once the timer answered"), and deleting it
 *   would not make anything red — do not read it as a load-bearing line;
 * - the delay is clamped to `MAX_ABORT_TIMER_DELAY_MS`. Node does not saturate an
 *   out-of-range delay, it collapses it to 1 ms, so an unclamped `1e12` would
 *   fabricate an instant timeout. Callers normalize their bound too (a junk value
 *   has to fall back to the shared default before it gets here); this is the
 *   second, defensive clamp, not a replacement for that one.
 * - the timer is cleared on **both** paths, so a fast `work` leaves no pending
 *   timer behind for the process to wait on.
 */
export async function raceWithTimeout<T>(
	work: Promise<T>,
	bound: number,
	onTimeout: () => T,
): Promise<T> {
	work.catch(() => {});
	const delay = Math.min(bound, MAX_ABORT_TIMER_DELAY_MS);
	let timer: NodeJS.Timeout | undefined;
	const expiry = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(onTimeout()), delay);
	});
	try {
		return await Promise.race([work, expiry]);
	} finally {
		clearTimeout(timer);
	}
}
