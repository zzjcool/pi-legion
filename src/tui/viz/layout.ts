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
	/** Subagent wall/gen/other table (#151). */
	timing: Rect;
	log: Rect;
	/**
	 * Agent status table (role/state/supervisor/ctx/rss/turns). Zero-area in
	 * portrait: 46×24 already packs four panes into 19 of 21 body rows, so the
	 * fifth cannot fit (D1). A zero-height rect keeps `frame()` from painting and
	 * `availablePanes()` (view.ts) keeps Tab off it.
	 */
	status: Rect;
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
/** Compact timing band in portrait / stacked-strip. */
export const TIMING_BAND_MIN = 5;
export const TIMING_BAND_MAX = 10;
/** Below this bottom height, stacked prefers a timing strip over side-by-side. */
export const STACKED_TIMING_SIDE_MIN = 8;
/** Status band: enough rows for a header plus a few agents, never a tall empty box. */
export const STATUS_BAND_MIN = 5;
export const STATUS_BAND_MAX = 12;
/**
 * Rows the log keeps when a status band is carved out above it. Below this the
 * band is dropped entirely rather than shrinking the log to a header-only stub —
 * the same trade `timing` already makes against `log` in portrait.
 */
export const STATUS_LOG_RESERVE = 4;

/**
 * Height of a status band carved out of `avail` rows while leaving `reserve`
 * rows for whatever sits below it. Returns 0 when the band cannot reach
 * STATUS_BAND_MIN — callers then hand the whole area to the neighbouring pane,
 * and the zero-height rect is what makes Tab skip it.
 */
function statusBandHeight(avail: number, reserve: number, share: number): number {
	const cap = Math.min(STATUS_BAND_MAX, avail - reserve);
	if (cap < STATUS_BAND_MIN) return 0;
	return Math.min(cap, Math.max(STATUS_BAND_MIN, Math.round(avail * share)));
}

/**
 * A pane that could not be placed (D1). Zero-area, so `frame()` paints nothing
 * and `availablePanes()` (view.ts) keeps Tab off it.
 */
function noRect(): Rect {
	return { x: 0, y: 0, w: 0, h: 0 };
}

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
		const rightW = W - leftW;
		// Right column: timing on top, log below (#151).
		const timingH = Math.min(
			Math.max(TIMING_BAND_MIN, Math.round(bodyH * 0.42)),
			Math.max(TIMING_BAND_MIN, bodyH - 6),
		);
		// Right column: timing, then log, then the status band closes it (D1).
		const statusH = statusBandHeight(bodyH - timingH, STATUS_LOG_RESERVE, 0.25);
		const logH = Math.max(0, bodyH - timingH - statusH);
		return {
			kind,
			header,
			footer,
			galaxy: { x: 0, y: bodyY, w: leftW, h: galaxyH },
			chart: { x: 0, y: bodyY + galaxyH, w: leftW, h: chartH },
			timing: { x: leftW, y: bodyY, w: rightW, h: timingH },
			log: { x: leftW, y: bodyY + timingH, w: rightW, h: logH },
			status: statusH > 0 ? { x: leftW, y: bodyY + timingH + logH, w: rightW, h: statusH } : noRect(),
		};
	}
	if (kind === "stacked") {
		const topH = Math.min(STACKED_TOP_MAX, Math.max(3, Math.round(bodyH * 0.58)));
		const galaxyW = Math.floor(W * 0.5);
		const bottomH = bodyH - topH;
		const bottomY = bodyY + topH;
		// Prefer timing|log side-by-side; strip when the bottom band is too short (#151).
		if (bottomH >= STACKED_TIMING_SIDE_MIN) {
			const timingW = Math.floor(W * 0.45);
			const rightW = W - timingW;
			// Right column of the bottom band: log on top, status closing it (D1).
			const statusH = statusBandHeight(bottomH, STATUS_LOG_RESERVE, 0.35);
			const logH = Math.max(0, bottomH - statusH);
			return {
				kind,
				header,
				footer,
				galaxy: { x: 0, y: bodyY, w: galaxyW, h: topH },
				chart: { x: galaxyW, y: bodyY, w: W - galaxyW, h: topH },
				timing: { x: 0, y: bottomY, w: timingW, h: bottomH },
				log: { x: timingW, y: bottomY, w: rightW, h: logH },
				status: statusH > 0 ? { x: timingW, y: bottomY + logH, w: rightW, h: statusH } : noRect(),
			};
		}
		const timingH = Math.min(TIMING_BAND_MAX, Math.max(TIMING_BAND_MIN, Math.round(bottomH * 0.4)), Math.max(3, bottomH - 3));
		const afterTiming = Math.max(0, bottomH - timingH);
		const statusH = statusBandHeight(afterTiming, STATUS_LOG_RESERVE, 0.35);
		const logH = Math.max(0, afterTiming - statusH);
		return {
			kind,
			header,
			footer,
			galaxy: { x: 0, y: bodyY, w: galaxyW, h: topH },
			chart: { x: galaxyW, y: bodyY, w: W - galaxyW, h: topH },
			timing: { x: 0, y: bottomY, w: W, h: timingH },
			log: { x: 0, y: bottomY + timingH, w: W, h: logH },
			status: statusH > 0 ? { x: 0, y: bottomY + timingH + logH, w: W, h: statusH } : noRect(),
		};
	}
	// Portrait: galaxy (aspect-limited), chart (fixed band), timing (compact), log gets the rest.
	const chartH = Math.min(PORTRAIT_CHART_MAX, Math.max(PORTRAIT_CHART_MIN, Math.round(bodyH * 0.3)), Math.max(3, bodyH - 9));
	// A visually round galaxy is ~W/2 rows tall (cells are 2:1); allow it up to ~W*0.6.
	const galaxyCap = Math.max(8, Math.round(W * 0.5));
	const galaxyGrowCap = Math.max(galaxyCap, Math.round(W * 0.65));
	let galaxyH = Math.max(3, Math.min(galaxyCap, Math.round(bodyH * 0.4), bodyH - chartH - 6));
	// Reserve a compact timing band between chart and log (#151).
	let timingH = Math.min(
		TIMING_BAND_MAX,
		Math.max(TIMING_BAND_MIN, Math.round(bodyH * 0.18)),
		Math.max(3, bodyH - galaxyH - chartH - 4),
	);
	let logH = bodyH - galaxyH - chartH - timingH;
	// Few events: give some of the empty log area back to the galaxy (keep timing).
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
	// If body is too short, shrink timing before wiping log.
	if (logH < 3 && timingH > 3) {
		const give = Math.min(timingH - 3, 3 - logH);
		timingH -= give;
		logH += give;
	}
	return {
		kind,
		header,
		footer,
		galaxy: { x: 0, y: bodyY, w: W, h: galaxyH },
		chart: { x: 0, y: bodyY + galaxyH, w: W, h: chartH },
		timing: { x: 0, y: bodyY + galaxyH + chartH, w: W, h: Math.max(0, timingH) },
		log: { x: 0, y: bodyY + galaxyH + chartH + Math.max(0, timingH), w: W, h: Math.max(0, logH) },
		// D1: portrait has no room for a fifth pane — zero-area, so frame()/Tab skip it.
		status: noRect(),
	};
}
