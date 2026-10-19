/**
 * One-shot reporting for configuration values that are still parsed but no
 * longer honoured.
 *
 * v4 runs `kind: pi` only. The `kind` key survives in three places (role
 * frontmatter, `subagents.presets.<name>.kind`, `subagents.agentOverrides.
 * <name>.kind`) and each is re-parsed every time the agent catalog is loaded —
 * which happens on several UI paths, not once per process. Reporting on every
 * parse would emit the same line a dozen times as the user moves through the UI,
 * so the report is deduplicated per (source, subject) pair for the lifetime of
 * the process.
 *
 * The dedupe key deliberately excludes the file path for presets and overrides:
 * the same role in a project and a user settings file is the same surprise, and
 * two lines would read as two problems.
 */

const reported = new Set<string>();

/**
 * Emit `message` once per unique `key`. Returns whether it was emitted.
 *
 * `emit` is injectable so tests can assert on the calls without owning stderr.
 */
export function reportIgnoredOnce(
	key: string,
	message: string,
	emit: (message: string) => void = (line) => console.error(line),
): boolean {
	if (reported.has(key)) return false;
	reported.add(key);
	emit(message);
	return true;
}

/** Reset the dedupe set. Unit tests only: no production path clears it. */
export function resetIgnoredReportsForTests(): void {
	reported.clear();
}

/**
 * The standard line for an ignored non-`pi` kind.
 *
 * Names where the value came from, the role or preset it applies to, the value
 * the user actually wrote, and what happens instead — so the message is
 * actionable without opening the source.
 */
export function ignoredKindMessage(input: {
	origin: string;
	subject: string;
	value: unknown;
}): string {
	return (
		`[pi-legion] ${input.origin} ${input.subject} sets kind ${JSON.stringify(input.value)}; ` +
		`v4 supports kind: pi only, so that field is ignored and it runs as kind: pi.`
	);
}
