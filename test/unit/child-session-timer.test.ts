import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The 1000ms cap in `releaseChildSessionExtensions` must actually fire.
 *
 * Why this runs in a subprocess: the failure it guards against is an empty event
 * loop. With `.unref()` on that timer, a process whose only pending work is the
 * release promise exits before the cap fires, `dispose()` never runs, and an MCP
 * server is left behind. Inside `node --test` the runner always has handles
 * pending, so an in-process test cannot see it — and that is exactly how the
 * unref'd timer reached a release tag and failed CI
 * ("Promise resolution is still pending but the event loop has already resolved").
 */
test("the shutdown cap fires in a process with nothing else pending", () => {
	const moduleUrl = new URL("../../src/supervisor/child-session.ts", import.meta.url);
	const script = `
		const { attachChildSessionRelease, bindChildSessionExtensions } = await import(${JSON.stringify(moduleUrl.href)});
		let disposed = false;
		const session = {
			async bindExtensions() {},
			// A handler that never settles: only the cap can release the session.
			extensionRunner: { hasHandlers: () => true, emit: () => new Promise(() => {}) },
			dispose: () => { disposed = true; },
		};
		attachChildSessionRelease(session, undefined, 10);
		await bindChildSessionExtensions(session);
		await session.dispose();
		console.log(disposed ? "DISPOSED" : "MISSED");
	`;

	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", script],
		{ encoding: "utf8", timeout: 30_000 },
	);

	assert.equal(
		result.status,
		0,
		`subprocess must exit cleanly (a cap that never fires leaves an unsettled top-level await):\n${result.stderr}`,
	);
	assert.match(result.stdout, /DISPOSED/, "the cap must reach the real dispose");
});

/**
 * Same process, same question — but proving the module is importable without the
 * SDK, which is what keeps `test/unit` fast and portable.
 *
 * #468 narrowed this from "no import statement at all" to "no HOST import", and
 * the difference matters: the child diagnostic sink has to be reachable from this
 * module, and the sink (`./child-diagnostics.ts`) uses `node:fs` + `node:path`
 * only. The invariant being protected is that importing `child-session.ts` never
 * pulls `@earendil-works/pi-coding-agent` into every unit run — a static "zero
 * imports" test never protected more than that, and it would now fail for a
 * sibling module that loads no SDK at all.
 *
 * Both files are scanned (a sibling on the same path is exactly where an SDK
 * import could hide) and every specifier form counts — `import … from`, for
 * `export … from`, `await import(…)` and `require(…)` — so a re-export or a
 * dynamic import cannot slip past the way a `^\s*import\b` regex allowed (review
 * of #468, finding 2).
 */
const SPECIFIER_PATTERNS = [
	/\bfrom\s*["']([^"']+)["']/g, // import … from "x" / export … from "x"
	/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // await import("x")
	/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require("x")
	/^\s*import\s+["']([^"']+)["']/gm, // side-effect import "x"
];

function importedSpecifiers(source: string): string[] {
	return SPECIFIER_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]!));
}

test("child-session's module path imports nothing but node builtins and its own siblings (no SDK)", async () => {
	const read = (await import("node:fs")).readFileSync;
	const base = new URL("../../src/supervisor/", import.meta.url);
	for (const file of ["child-session.ts", "child-diagnostics.ts"]) {
		const specifiers = importedSpecifiers(read(fileURLToPath(new URL(file, base)), "utf8"));
		// The doc comments legitimately name the host package, so the check is on the
		// SPECIFIERS only: a bare specifier is what would load it.
		assert.deepEqual(
			specifiers.filter((specifier) => !specifier.startsWith("node:") && !specifier.startsWith("./")),
			[],
			`${file} must not import the HOST package: that would load the SDK in every unit run`,
		);
	}
	assert.ok(
		importedSpecifiers("export * from \"pkg\"; await import('pkg'); require(\"pkg\"); import x from 'pkg';").length === 4,
		"the detector itself must see every specifier form",
	);
});
