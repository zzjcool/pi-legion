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
 */
test("child-session has no SDK import", async () => {
	const request = fileURLToPath(new URL("../../src/supervisor/child-session.ts", import.meta.url));
	const source = (await import("node:fs")).readFileSync(request, "utf8");
	assert.equal(
		/^\s*import\b/m.test(source),
		false,
		"child-session.ts must stay import-free (structural types only): a host import would load the SDK in every unit run",
	);
});
