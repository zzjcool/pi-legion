/** Layout selection and panel rectangles for the /legion full view. */

export type LayoutKind = "wide" | "stacked" | "portrait";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface LegionLayout {
	kind: LayoutKind;
	header: Rect;
	galaxy: Rect;
	chart: Rect;
	log: Rect;
	footer: Rect;
}

export const WIDE_MIN_COLS = 140;
export const PORTRAIT_MAX_COLS = 80;
/** Kept for compatibility; tallness is now decided by aspect ratio alone. */
export const TALL_PORTRAIT_MAX_COLS = 100;
/** Chart rows in portrait: enough to read, never a tall skinny bar. */
export const PORTRAIT_CHART_MIN = 10;
export const PORTRAIT_CHART_MAX = 18;
/** Side-by-side layouts never stretch panels beyond this many rows. */
export const STACKED_TOP_MAX = 24;
export const WIDE_CHART_MAX = 24;

/** Terminal cells are ~2:1 (tall), so rows*2 >= cols means the window looks taller than wide. */
export function isTall(cols: number, rows: number): boolean {
	return rows * 2 >= cols;
}

export function selectLayout(cols: number, rows: number): LayoutKind {
	if (cols < PORTRAIT_MAX_COLS) return "portrait";
	if (isTall(cols, rows)) return "portrait";
	if (cols >= WIDE_MIN_COLS) return "wide";
	return "stacked";
}

export interface LayoutHints {
	/** Number of log events, so a short history does not get a huge empty box. */
	logEvents?: number;
}

export function computeLayout(cols: number, rows: number, hints: LayoutHints = {}): LegionLayout {
	const W = Math.max(1, Math.floor(cols));
	const H = Math.max(6, Math.floor(rows));
	const kind = selectLayout(W, H);
	const headerH = kind === "portrait" ? 2 : 1;
	const header = { x: 0, y: 0, w: W, h: headerH };
	const footer = { x: 0, y: H - 1, w: W, h: 1 };
	const bodyY = headerH;
	const bodyH = H - headerH - 1;
	if (kind === "wide") {
		const leftW = Math.floor(W * 0.6);
		// Chart is capped; on very tall wide terminals the galaxy absorbs the rest.
		const chartH = Math.min(WIDE_CHART_MAX, Math.max(3, Math.round(bodyH * 0.45)));
		const galaxyH = bodyH - chartH;
		return {
			kind,
			header,
			footer,
			galaxy: { x: 0, y: bodyY, w: leftW, h: galaxyH },
			chart: { x: 0, y: bodyY + galaxyH, w: leftW, h: chartH },
			log: { x: leftW, y: bodyY, w: W - leftW, h: bodyH },
		};
	}
	if (kind === "stacked") {
		const topH = Math.min(STACKED_TOP_MAX, Math.max(3, Math.round(bodyH * 0.58)));
		const galaxyW = Math.floor(W * 0.5);
		return {
			kind,
			header,
			footer,
			galaxy: { x: 0, y: bodyY, w: galaxyW, h: topH },
			chart: { x: galaxyW, y: bodyY, w: W - galaxyW, h: topH },
			log: { x: 0, y: bodyY + topH, w: W, h: bodyH - topH },
		};
	}
	// Portrait: galaxy (aspect-limited), chart (fixed band), log gets the rest.
	const chartH = Math.min(PORTRAIT_CHART_MAX, Math.max(PORTRAIT_CHART_MIN, Math.round(bodyH * 0.3)), Math.max(3, bodyH - 9));
	// A visually round galaxy is ~W/2 rows tall (cells are 2:1); allow it up to ~W*0.6.
	const galaxyCap = Math.max(8, Math.round(W * 0.5));
	const galaxyGrowCap = Math.max(galaxyCap, Math.round(W * 0.65));
	let galaxyH = Math.max(3, Math.min(galaxyCap, Math.round(bodyH * 0.4), bodyH - chartH - 6));
	let logH = bodyH - galaxyH - chartH;
	// Few events: give some of the empty log area back to the galaxy.
	if (hints.logEvents !== undefined) {
		const logNeeded = Math.max(8, hints.logEvents + 4);
		const spare = logH - logNeeded;
		if (spare > 0) {
			const grow = Math.min(spare, galaxyGrowCap - galaxyH);
			if (grow > 0) {
				galaxyH += grow;
				logH -= grow;
			}
		}
	}
	return {
		kind,
		header,
		footer,
		galaxy: { x: 0, y: bodyY, w: W, h: galaxyH },
		chart: { x: 0, y: bodyY + galaxyH, w: W, h: chartH },
		log: { x: 0, y: bodyY + galaxyH + chartH, w: W, h: Math.max(0, logH) },
	};
}
