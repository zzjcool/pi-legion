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
import { Container, Text, TuiAltScreen, TuiMainScreen, type OverlayOptions, type Terminal } from "@earendil-works/pi-tui";
import { createLiveOverlay, resolveModalOverlayOptions, type LiveOverlaySource } from "../../src/tui/live-overlay.ts";

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
