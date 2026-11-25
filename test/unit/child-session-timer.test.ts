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
		attachChildSessionRelease(session, 10);
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
 */
test("child-session imports nothing but node builtins and its own siblings (no SDK)", async () => {
	const request = fileURLToPath(new URL("../../src/supervisor/child-session.ts", import.meta.url));
	const source = (await import("node:fs")).readFileSync(request, "utf8");
	const specifiers = [
		...source.matchAll(/^\s*import\b[^;]*?from\s*["']([^"']+)["']/gm),
		...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
	].map((match) => match[1]!);
	for (const specifier of specifiers) {
		assert.ok(
			specifier.startsWith("node:") || specifier.startsWith("./"),
			`child-session.ts may only import node builtins and siblings, found ${JSON.stringify(specifier)}`,
		);
	}
	// The doc comments legitimately name the host package, so the check is on the
	// SPECIFIERS only: a bare specifier is what would load it.
	assert.deepEqual(
		specifiers.filter((specifier) => !specifier.startsWith("node:") && !specifier.startsWith("./")),
		[],
		"child-session.ts must not import the HOST package: that would load the SDK in every unit run",
	);
});
