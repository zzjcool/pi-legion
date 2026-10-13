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
export const TALL_PORTRAIT_MAX_COLS = 100;

/** Terminal cells are ~2:1, so rows*2 >= cols looks taller than wide. */
export function isTall(cols: number, rows: number): boolean {
	return rows * 2 >= cols;
}

export function selectLayout(cols: number, rows: number): LayoutKind {
	if (cols < PORTRAIT_MAX_COLS) return "portrait";
	if (cols < TALL_PORTRAIT_MAX_COLS && isTall(cols, rows)) return "portrait";
	if (cols >= WIDE_MIN_COLS) return "wide";
	return "stacked";
}

export function computeLayout(cols: number, rows: number): LegionLayout {
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
		const galaxyH = Math.max(3, Math.round(bodyH * 0.55));
		return {
			kind,
			header,
			footer,
			galaxy: { x: 0, y: bodyY, w: leftW, h: galaxyH },
			chart: { x: 0, y: bodyY + galaxyH, w: leftW, h: bodyH - galaxyH },
			log: { x: leftW, y: bodyY, w: W - leftW, h: bodyH },
		};
	}
	if (kind === "stacked") {
		const topH = Math.max(3, Math.round(bodyH * 0.58));
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
	const galaxyH = Math.max(3, Math.round(bodyH * 0.36));
	const chartH = Math.max(3, Math.round(bodyH * 0.34));
	return {
		kind,
		header,
		footer,
		galaxy: { x: 0, y: bodyY, w: W, h: galaxyH },
		chart: { x: 0, y: bodyY + galaxyH, w: W, h: chartH },
		log: { x: 0, y: bodyY + galaxyH + chartH, w: W, h: Math.max(0, bodyH - galaxyH - chartH) },
	};
}
