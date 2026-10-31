/**
 * #193: composite-level harness for the floating context modal.
 *
 * The bug (opaque black area around the modal) cannot be seen by rendering the
 * component alone: pi-tui's `compositeTuiLine` discards every base cell inside
 * the overlay rectangle, and `OverlayOptions` has no transparency option. So the
 * only way to assert "the host chat / /legion view is still visible" is to mount
 * the real component on a real `TuiMainScreen` over a known underlay and inspect
 * the composited frame.
 *
 * Kept out of `legion-live-overlay.test.ts` because it needs a TUI instance and
 * a fake terminal, not just a component.
 */
import { Container, Text, TuiAltScreen, TuiMainScreen, sliceByColumn, type OverlayOptions, type Terminal } from "@earendil-works/pi-tui";
import { createLiveOverlay, resolveModalOverlayOptions, type LiveOverlaySource } from "../../src/tui/live-overlay.ts";
import { createLegionViewFactory } from "../../src/tui/viz/view.ts";
import type { VizNode } from "../../src/tui/viz/model.ts";
import { RateSampler } from "../../src/tui/viz/rate.ts";
import type { ViewData } from "../../src/tui/viz/panels.ts";

class FakeTerminal implements Terminal {
	readonly written: string[] = [];
	rows: number;
	cols: number;
	constructor(rows: number, cols: number) {
		this.rows = rows;
		this.cols = cols;
	}
	start(): void {}
	stop(): void {}
	write(data: string): void {
		this.written.push(data);
	}
	get columns(): number {
		return this.cols;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
	drainInput(): Promise<void> {
		return Promise.resolve();
	}
}

/** One row of the faked host underlay: an unmistakable token per row. */
export function underlayToken(row: number): string {
	return `HOSTROW${String(row).padStart(2, "0")}`;
}

/** Strip every escape so the frame reads exactly as the user does. */
function stripEscapes(line: string): string {
	return line
		.replace(/\u001b\[[0-9;:?]*[A-Za-z]/g, "")
		.replace(/\u001b\][^\u0007]*\u0007/g, "")
		.replace(/\u001b./g, "");
}

export interface CompositeProbe {
	totalRows: number;
	totalCols: number;
	frameRows: number;
	frameCols: number;
	/** True when the frame leaves a host-visible margin on BOTH axes. */
	frameInset: boolean;
	/** Screen rows whose composited content still contains host underlay text. */
	visibleRows: number;
	/** Rows the underlay occupied that the modal wiped. */
	wipedRows: number;
	rows: string[];
}

/**
 * Mount the real viewer as a host overlay (using the geometry the plugin passes
 * to `ctx.ui.custom`) over a full-screen host underlay, render once, and report
 * how much of the underlay survived.
 */
export function assertUnderlayVisible(options: {
	rows: number;
	cols: number;
	/** Override the overlay geometry; defaults to the plugin's frame-rect options. */
	overlayOptions?: OverlayOptions;
}): CompositeProbe {
	const { rows, cols } = options;
	const terminal = new FakeTerminal(rows, cols);
	const tui = new TuiMainScreen(terminal, false, undefined);

	const underlay = new Container();
	for (let i = 0; i < rows; i++) underlay.addChild(new Text(`${underlayToken(i)} host chat line`, 0, 0));
	tui.addChild(underlay);

	const source: LiveOverlaySource = {
		subscribe: () => () => {},
		unsubscribe: () => {},
		getNode: () => ({
			id: "root.worker",
			name: "worker",
			role: "worker",
			model: "test/model",
			status: "running",
			parentId: "root",
			depth: 1,
			createdAt: 1_000,
			updatedAt: 1_000,
		}),
	};
	const component = createLiveOverlay(source).open("root.worker", {
		terminalRows: rows,
		now: () => 5_000,
	});
	const overlayOptions = options.overlayOptions ?? resolveModalOverlayOptions();
	const handle = tui.showOverlay(component, overlayOptions);
	tui.renderNow(true);
	terminal.written.length = 0;
	tui.renderNow(true);

	const frame = terminal.written.join("").split(/\r\n/);
	const rendered = frame.map(stripEscapes);
	const visibleRows = rendered.filter((line) => /HOSTROW\d\d/.test(line)).length;
	const bounds = handle.getBounds();
	component.dispose();
	const frameRows = bounds?.height ?? 0;
	const frameCols = bounds?.width ?? 0;
	return {
		totalRows: rows,
		totalCols: cols,
		frameRows,
		frameCols,
		/** True when the frame leaves host-visible margin on BOTH axes. */
		frameInset: frameRows < rows && frameCols < cols,
		visibleRows,
		wipedRows: rows - visibleRows,
		rows: rendered,
	};
}

/**
 * Click a screen coordinate OUTSIDE the frame rect and report where it lands.
 *
 * #193 consequence: with a frame-sized overlay, pi-tui clips dispatch to the
 * overlay rect, so clicks outside reach the host chat / /legion view instead of
 * the modal — which is why "click the mask to dismiss" is gone and Esc is the way
 * out.
 *
 * Needs `TuiAltScreen` (the only TUI with real mouse plumbing) driven through
 * `handleTerminalInput`, so the SGR click sequence follows the production path.
 */
export function assertOutsideClickReachesHost(options: { rows: number; cols: number }): OutsideClickProbe {
	const { rows, cols } = options;
	const terminal = new FakeTerminal(rows, cols);
	const tui = new TuiAltScreen(terminal, false, undefined);


	const host = new Container();
	host.addChild({
		render: () => Array.from({ length: rows }, () => "host chat line"),
		handleMouse: () => ({ handled: true }),
		invalidate: () => {},
	});
	tui.setLayoutRoot(host);

	const source: LiveOverlaySource = {
		subscribe: () => () => {},
		unsubscribe: () => {},
		getNode: () => ({
			id: "root.worker",
			name: "worker",
			role: "worker",
			model: "test/model",
			status: "running",
			parentId: "root",
			depth: 1,
			createdAt: 1_000,
			updatedAt: 1_000,
		}),
	};
	let componentGotClick = false;
	const component = createLiveOverlay(source).open("root.worker", {
		terminalRows: rows,
		now: () => 5_000,
	});
	const probe = component as unknown as { handleMouse?: (e: unknown) => unknown };
	const original = probe.handleMouse?.bind(component);
	if (original) {
		probe.handleMouse = (event: unknown) => {
			componentGotClick = true;
			return original(event);
		};
	}
	tui.showOverlay(component, resolveModalOverlayOptions());
	tui.renderNow(true);

	// Dispatch through pi-tui's own overlay routing, which clips by the rect it
	// reserved for this overlay. A coordinate outside that rect must not produce a
	// hit. (Driving a full SGR sequence via handleTerminalInput needs an started
	// alt-screen; the clipping rule under test lives here.)
	const router = tui as unknown as {
		dispatchMouseToOverlay?(event: Record<string, unknown>): { hit: boolean };
	};
	const outsideEvent = {
		type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: cols, height: rows,
	};
	const dispatch = router.dispatchMouseToOverlay?.(outsideEvent);
	const modalStillOpen = component.getState().open;
	component.dispose();
	return {
		componentGotClick,
		modalStillOpen,
		// True when pi-tui reported no overlay hit, i.e. the click is left to the host.
		hostHandledClick: dispatch?.hit === false,
	};
}

export interface OutsideClickProbe {
	/** Whether the modal component received the click at all. */
	componentGotClick: boolean;
	/** Whether the modal is still open afterwards. */
	modalStillOpen: boolean;
	/** Whether the click fell through to the host underlay. */
	hostHandledClick: boolean;
}

export interface ResizeProbe {
	/** Overlay rect pi-tui reserved after the resize. */
	bounds: { row: number; col: number; width: number; height: number };
	/** Rows the component itself wants to render at the new size. */
	componentRows: number;
	bottomBorder: boolean;
	footerHint: boolean;
	visibleRows: number;
	totalRows: number;
}

/**
 * Open the modal at one terminal size, resize, and re-render — proving the
 * overlay geometry tracks the terminal instead of freezing at open time.
 *
 * #193 follow-up: absolute `width`/`maxHeight` cells are resolved by pi once when
 * the overlay is shown, so a resize left `maxHeight` at the old value and pi-tui
 * clipped the frame — the bottom border and the Esc footer hint disappeared.
 */
export function assertUnderlayVisibleAfterResize(
	from: { rows: number; cols: number },
	to: { rows: number; cols: number },
): ResizeProbe {
	const terminal = new FakeTerminal(from.rows, from.cols);
	const tui = new TuiMainScreen(terminal, false, undefined);

	const underlay = new Container();
	const lineCount = Math.max(from.rows, to.rows) + 8;
	for (let i = 0; i < lineCount; i++) underlay.addChild(new Text(`${underlayToken(i)} host chat line`, 0, 0));
	tui.addChild(underlay);

	const source: LiveOverlaySource = {
		subscribe: () => () => {},
		unsubscribe: () => {},
		getNode: () => ({
			id: "root.worker",
			name: "worker",
			role: "worker",
			model: "test/model",
			status: "running",
			parentId: "root",
			depth: 1,
			createdAt: 1_000,
			updatedAt: 1_000,
		}),
	};
	const component = createLiveOverlay(source).open("root.worker", {
		// Track the (mutable) fake terminal, exactly like the real factory's
		// `terminalRows: () => tui.terminal.rows`.
		terminalRows: () => terminal.rows,
		now: () => 5_000,
	});
	const handle = tui.showOverlay(component, resolveModalOverlayOptions());
	tui.renderNow(true);

	// Resize and re-render.
	terminal.rows = to.rows;
	terminal.cols = to.cols;
	terminal.written.length = 0;
	tui.renderNow(true);

	const rendered = terminal.written.join("").split(/\r\n/).map(stripEscapes);
	const componentRows = component.render(to.cols).length;
	component.dispose();
	return {
		bounds: handle.getBounds() ?? { row: -1, col: -1, width: 0, height: 0 },
		componentRows,
		bottomBorder: rendered.some((line) => line.includes("┗")),
		footerHint: rendered.some((line) => line.includes("Esc close")),
		visibleRows: rendered.filter((line) => /HOSTROW\d\d/.test(line)).length,
		totalRows: to.rows,
	};
}

// ---------------------------------------------------------------------------
// #308: the modal's *gutter style*, not just its text.
//
// `assertUnderlayVisible` above is deliberately blind to color: it strips every
// escape, so a base row that paints plain spaces over the terminal's default
// background and one that paints the page floor look identical. That is exactly
// the #308 bug — the /legion view sits under a 75%-wide centered modal, and the
// band right of the frame rendered with no background at all because pi-tui's
// compositor inherits the *SGR state* of the base row at the overlay's right
// edge (a one-shot snapshot in `extractSegments`), and the base row ended in
// spaces carrying no SGR.
//
// So this probe keeps the escapes: it renders the real /legion view (as the mount
// under test — full-screen overlay before #347, main-screen child after), captures
// the frame, adds the real context modal on top, re-captures, and reports the
// background SGR in force at the first cell of each gutter on both passes.
// ---------------------------------------------------------------------------

/** Escape the faked theme paints as the page floor; distinctive by construction. */
export const PAGE_FLOOR_ANSI = "\u001b[48;5;236m";

/**
 * `/legion` render theme with a real background token. `bg` is what makes the
 * probe meaningful: a theme without it reproduces today's bytes (see
 * `paintPageFloor`), so the assertion would have nothing to compare.
 */
const pageTheme = {
	fg: (color: string, text: string): string => `\u001b[38;5;${(color.length % 200) + 20}m${text}\u001b[39m`,
	bg: (_color: string, text: string): string => `${PAGE_FLOOR_ANSI}${text}\u001b[49m`,
	bold: (text: string): string => `\u001b[1m${text}\u001b[22m`,
	inverse: (text: string): string => `\u001b[7m${text}\u001b[27m`,
};

/** Deterministic /legion payload: a root plus two live agents and one that settled. */
function pageData(): ViewData {
	const t0 = 1_700_000_000_000;
	const sec = (s: number): number => t0 + s * 1_000;
	const node = (id: string, opts: Partial<VizNode> = {}): VizNode => ({
		id,
		name: id,
		role: id.replace(/-\d+$/, ""),
		parentId: "root",
		depth: 1,
		status: "running",
		startedAt: t0,
		tokens: 0,
		tokensOut: 0,
		generationMs: 0,
		...opts,
	});
	const nodes: VizNode[] = [
		node("root", { name: "legion-0", role: "legion", parentId: null, depth: 0 }),
		node("worker-0", { role: "worker", startedAt: sec(0), tokens: 1_000, tokensOut: 600, generationMs: 60_000 }),
		node("scout-0", { role: "scout", startedAt: sec(10), tokens: 400, tokensOut: 200, generationMs: 30_000 }),
		node("worker-1", { role: "worker", status: "settled", startedAt: sec(20), endedAt: sec(80), tokens: 300, tokensOut: 150, generationMs: 20_000 }),
	];
	const sampler = new RateSampler();
	sampler.record(sec(90), nodes);
	return { nodes, sampler, now: sec(90), rate: 42 };
}

/** Background SGR in force at the first printable cell of `raw`; "" = terminal default. */
function backgroundAtStart(raw: string): string {
	let bg = "";
	let i = 0;
	while (i < raw.length) {
		if (raw[i] !== "\u001b") {
			break; // first printable cell: report the state that paints it
		}
		if (raw[i + 1] === "]") {
			// OSC (e.g. the hyperlink terminator pi-tui emits): skip to BEL/ST.
			const bel = raw.indexOf("\u0007", i);
			const st = raw.indexOf("\u001b\\", i);
			if (bel < 0 && st < 0) return bg;
			i = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st + 2;
			continue;
		}
		if (raw[i + 1] !== "[") return bg;
		const end = raw.slice(i + 2).search(/[A-Za-z]/);
		if (end < 0) return bg;
		const final = raw[i + 2 + end]!;
		const params = raw.slice(i + 2, i + 2 + end);
		i += 2 + end + 1;
		if (final !== "m") continue;
		const codes = params.split(";");
		for (let k = 0; k < codes.length; k++) {
			const code = codes[k] === "" ? "0" : codes[k]!;
			if (code === "0") bg = "";
			else if (code === "49") bg = "";
			else if (code === "48") {
				const kind = codes[k + 1];
				const width = kind === "5" ? 2 : kind === "2" ? 4 : 0;
				if (width === 0) continue;
				bg = `\u001b[${codes.slice(k, k + 1 + width).join(";")}m`;
				k += width;
			}
		}
	}
	return bg;
}

export interface GutterRow {
	/** Screen row this sample came from. */
	row: number;
	/** Stripped base text left of the frame, before and after the modal is composited. */
	baseLeft: string;
	frameLeft: string;
	/** Stripped base text right of the frame, before and after the modal is composited. */
	baseRight: string;
	frameRight: string;
	/** Background SGR at column 0 of the base row (the page floor). */
	rowBg: string;
	/** Background SGR at the first cell of each gutter. */
	baseLeftBg: string;
	frameLeftBg: string;
	baseRightBg: string;
	frameRightBg: string;
}

export interface GutterProbe {
	rows: number;
	cols: number;
	/** How the /legion page was mounted for this probe. */
	mount: LegionMount;
	/** Rect pi-tui reserved for the modal (screen coordinates). */
	bounds: { row: number; col: number; width: number; height: number };
	gutters: GutterRow[];
}

/**
 * `overlay` = the pre-#347 production mount (a full-screen overlay); `main` = the
 * current one (`ui.custom(..., { overlay: false })`, a layout child that replaces
 * the base instead of being composited over it).
 */
export type LegionMount = "overlay" | "main";

/**
 * Stack the real /legion view (as a full-screen overlay by default, or mounted on
 * the main screen with `mount: "main"`) and the real context modal (75% centered
 * overlay), then report, per frame row, the text and background SGR of both
 * gutters on both passes.
 */
export function assertOverlayGutterInheritsBase(options: { rows: number; cols: number; mount?: LegionMount }): GutterProbe {
	const { rows, cols } = options;
	const mount: LegionMount = options.mount ?? "overlay";
	const terminal = new FakeTerminal(rows, cols);
	const tui = new TuiMainScreen(terminal, false, undefined);
	const data = pageData();
	const legionFactory = createLegionViewFactory({ getData: () => data });
	// `ViewTui` is the slice of `TUI` the view actually touches.
	const legion = legionFactory(
		{ terminal: { rows, columns: cols }, requestRender: () => {} },
		pageTheme,
		{},
		() => {},
	);
	// pre-#347 production geometry: /legion is a full-screen overlay
	// (`legion-commands.ts` before #347). Kept as the recorded #308 case.
	if (mount === "overlay") {
		tui.showOverlay(legion, { width: "100%", maxHeight: "100%", anchor: "top-left", row: 0, col: 0 });
	} else {
		// #347 production geometry: the page replaces the base component as a
		// main-screen child, so nothing composites it row by row.
		tui.addChild(legion);
	}
	const capture = (): string[] => {
		tui.renderNow(true);
		terminal.written.length = 0;
		tui.renderNow(true);
		return terminal.written.join("").split(/\r\n/);
	};
	const base = capture();

	const source: LiveOverlaySource = {
		subscribe: () => () => {},
		unsubscribe: () => {},
		getNode: () => ({
			id: "root.worker",
			name: "worker",
			role: "worker",
			model: "test/model",
			status: "running",
			parentId: "root",
			depth: 1,
			createdAt: 1_000,
			updatedAt: 1_000,
		}),
	};
	const modal = createLiveOverlay(source).open("root.worker", { terminalRows: rows, now: () => 5_000 });
	const handle = tui.showOverlay(modal, resolveModalOverlayOptions());
	const framed = capture();
	const bounds = handle.getBounds() ?? { row: -1, col: -1, width: 0, height: 0 };
	const leftCols = bounds.col;
	const rightStart = bounds.col + bounds.width;
	const rightCols = Math.max(0, cols - rightStart);
	const sample = (line: string, start: number, width: number): string =>
		width > 0 ? sliceByColumn(line, start, width, true) : "";
	const gutters: GutterRow[] = [];
	for (let i = 0; i < bounds.height; i++) {
		const screenRow = bounds.row + i;
		const baseLine = base[screenRow] ?? "";
		const frameLine = framed[screenRow] ?? "";
		const baseLeft = sample(baseLine, 0, leftCols);
		const baseRight = sample(baseLine, rightStart, rightCols);
		const frameLeft = sample(frameLine, 0, leftCols);
		const frameRight = sample(frameLine, rightStart, rightCols);
		gutters.push({
			row: screenRow,
			baseLeft: stripEscapes(baseLeft),
			frameLeft: stripEscapes(frameLeft),
			baseRight: stripEscapes(baseRight),
			frameRight: stripEscapes(frameRight),
			rowBg: backgroundAtStart(baseLine),
			baseLeftBg: backgroundAtStart(baseLeft),
			frameLeftBg: backgroundAtStart(frameLeft),
			baseRightBg: backgroundAtStart(baseRight),
			frameRightBg: backgroundAtStart(frameRight),
		});
	}
	modal.dispose();
	legion.dispose();
	return { rows, cols, mount, bounds, gutters };
}
