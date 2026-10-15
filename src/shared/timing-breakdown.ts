/**
 * Shared wall/gen/other math for `/legion timing` (#150) and the TUI timing panel (#151).
 * Zero schema — callers supply wall_ms and generation_ms (null = no turn data → other —).
 */
export interface TimingBreakdown {
	wall_ms: number;
	generation_ms: number | null;
	/** max(0, wall − gen); null when generation_ms is null. Coarse bucket, not wait/tool. */
	other_ms: number | null;
}

/** Pure breakdown: other = max(0, wall − gen); gen absent → other —. */
export function breakdown(
	wall_ms: number,
	generation_ms: number | null,
): TimingBreakdown {
	return {
		wall_ms,
		generation_ms,
		other_ms:
			generation_ms === null ? null : Math.max(0, wall_ms - generation_ms),
	};
}
