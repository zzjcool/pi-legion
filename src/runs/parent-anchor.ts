/**
 * #409 — every terminal legion starts must have a PARENT, and the parent must be
 * an address the TARGET core can resolve.
 *
 * The defect this module names facts for: a terminal created through `hc`'s
 * JSON-RPC `terminal.run` inherits no parent unless the request says so. `hc run`
 * on the command line looks after itself (it knows the terminal it was typed
 * into), so the gap was invisible in CLI experiments and real in every legion
 * launch: `hc get <address>` answered `parent: null`, `hc ls --all` printed no
 * `where` column for the row, and the ancestor chain stopped there. "Whose
 * terminal is this, and whose directory?" had no answer — the #411/#414 family.
 *
 * Three measured facts about `hc` 0.1.21 decide the shape below (issue #409,
 * four CLI experiments plus the API measurements recorded in
 * `docs/reports/spawn-parent-anchor.md`):
 *
 *   - `parent: "t5f"` (a terminal that exists in the TARGET core)        → works;
 *   - `parent: "t1t"` (the caller's local id, another core)              → `no terminal "t1t"`;
 *   - `parent: "hw-nj/t5j"` (machine-qualified)                          → `unknown machine "hw-nj"`
 *     (the SENDING core resolves the prefix, and a machine name is not a
 *     registered machine there — a core id is rejected the same way).
 *
 * So "the parent address" is always a **target-local** address: the spelling the
 * receiving core resolves in its own namespace. For a LOCAL launch that is this
 * process's own terminal (`HC_TERMINAL_ID`, sent as `caller` and now also as the
 * explicit `parent`), and for a cross-machine launch it is the machine's
 * {@link ANCHOR_TERMINAL_NAME} terminal — the one terminal that exists over
 * there and stands for "the legion session using this machine".
 *
 * The rule is pure and lives in one place because three surfaces need the same
 * sentence: the launch receipt, `/legion status`, and the record a later process
 * reads. A launch that cannot name a parent does NOT lie about it: the reason
 * travels as `parent=absent(<reason>)` instead of a silent omission — the same
 * posture `launch-evidence` (#423) took for "did the child ever start".
 */

/** The one anchor terminal a target machine gets, shared by every legion launch. */
export const ANCHOR_TERMINAL_NAME = "lgl-anchor";

/**
 * Label naming the machine an anchor belongs to (`legion.anchor=<host>`).
 *
 * Carried because a terminal's name is only unique per core: a human (or
 * `legion-doctor`) reading `hc ls --all` on that machine needs to know what the
 * `lgl-anchor` row is FOR. Deliberately not `legion.role`: an anchor is not an
 * agent, and `legion.role` is consumed by role lookups.
 */
export const LEGION_ANCHOR_LABEL = "legion.anchor";

/** Facts that chain a child terminal to its parent terminal and its run. */
export interface ParentChainFacts {
	/** Machine the child runs on; absent/empty = this host. */
	host?: string | null;
	/** `host/name` of the terminal the core holds for the child (#423's `remoteTerminal`). */
	remoteTerminal?: string | null;
	/** Address this launch used as the terminal's parent, in the target core's namespace. */
	parentTerminal?: string | null;
	/** The run that dispatched the child — the run whose `run.json` holds this record. */
	parentRunId?: string | null;
	/** Why no parent address could be named, when that happened (#409 req 2). */
	parentAbsent?: string | null;
}

/** The three linked facts, for a reader that must walk child → parent → run. */
export interface ParentChain {
	/** True when both the parent address and the run id are recorded. */
	ok: boolean;
	/** The child's own address, when the record knows it (`host/name`). */
	childTerminal?: string;
	/** The address the target core was told is the parent. */
	parentTerminal?: string;
	/** The run that owns this chain. */
	parentRunId?: string;
}

function text(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The chain child → parent → run, or the half of it the record actually holds.
 *
 * `ok` is about the two facts #409 makes checkable — the parent address and the
 * run that owns it. `childTerminal` is reported when the record carries it
 * (`remoteTerminal` is written for a cross-machine child only; a local child's
 * terminal is `lgl-<runId8>-<handle>` and needs no second field here).
 *
 * A record with `parentAbsent` never answers `ok`: an explained absence is still
 * an absence, and a reader that treats "explained" as "connected" would report a
 * broken ancestry as a fixed one.
 */
export function parentChain(facts: ParentChainFacts): ParentChain {
	const parentTerminal = text(facts.parentTerminal);
	const parentRunId = text(facts.parentRunId);
	const childTerminal = text(facts.remoteTerminal);
	const absent = text(facts.parentAbsent);
	return {
		ok: absent === undefined && parentTerminal !== undefined && parentRunId !== undefined,
		...(childTerminal !== undefined ? { childTerminal } : {}),
		...(parentTerminal !== undefined ? { parentTerminal } : {}),
		...(parentRunId !== undefined ? { parentRunId } : {}),
	};
}

/**
 * `parent=<address>` or `parent=absent(<reason>)`.
 *
 * One spelling for the receipt and the status: the issue's requirement is that a
 * missing parent be VISIBLE with its cause, not that two renderers each invent a
 * phrasing. `undefined` when the record knows neither — a legacy record (or a
 * backend that has no terminals) says nothing rather than `parent=absent(unknown)`.
 */
export function parentLine(facts: ParentChainFacts): string | undefined {
	const absent = text(facts.parentAbsent);
	if (absent !== undefined) return `parent=absent(${absent})`;
	const parent = text(facts.parentTerminal);
	return parent !== undefined ? `parent=${parent}` : undefined;
}

/**
 * The TARGET-LOCAL spelling of the anchor a `terminal.run` reply describes.
 *
 * A remote `terminal.run` answers address `"<host>/<local>"` (`hc` 0.1.21:
 * `loopback409/t1`, `hw-nj/t5j`), and the local part is the one string that is a
 * valid `parent` for a second terminal on that machine — the qualified spelling
 * is refused by the sending core (`unknown machine "hw-nj"`). The reply's `name`
 * is the fallback (it resolves by name too), and an address without a machine
 * prefix is already local, so it is used as-is.
 */
export function anchorLocalAddress(
	run: { address?: unknown; name?: unknown },
	host: string,
): string | undefined {
	const address = text(run.address);
	if (address !== undefined) {
		const prefix = `${host}/`;
		if (address.startsWith(prefix)) return text(address.slice(prefix.length));
		// No machine prefix: the core answered the bare local address. A DIFFERENT
		// machine's address (any other `/`) is not usable as a parent on `host`.
		if (!address.includes("/")) return address;
	}
	return text(run.name);
}

/**
 * The receipt lines one launch owes about its parent.
 *
 * A LOCAL launch prints none: its parent is the caller's own terminal, which the
 * person reading the receipt is looking at. A cross-machine launch prints the
 * address it used (the anchor) because that address is the proof the chain is
 * connected on the OTHER machine, and an absent parent prints the `⚠` line
 * because a missing ancestry is a defect the caller must be able to see.
 */
export function parentNoticeLines(name: string, facts: ParentChainFacts): string[] {
	const absent = text(facts.parentAbsent);
	if (absent !== undefined) return [`  ⚠ ${name}: parent=absent(${absent})`];
	const parent = text(facts.parentTerminal);
	const host = text(facts.host);
	if (parent === undefined || host === undefined) return [];
	return [`  parent=${parent} (target-local address on ${host})`];
}
