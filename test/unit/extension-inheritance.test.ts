/**
 * #280: extension inheritance policy.
 *
 * The default flipped from "opt in" to "inherit everything, then narrow". These
 * cases pin the narrowing rules and the discovery resolver, because both decide
 * what code actually runs inside a child.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	childInheritsExtensions,
	discoveredHostExtensions,
	ensureHostExtensions,
	inheritedExtensions,
	matchesExcludedExtension,
	parsePiList,
	resetExtensionDiscoveryCache,
	resolveExtensionEntries,
} from "../../src/runs/extension-inheritance.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import { InMemoryUIProxy } from "../../src/supervisor/ui-proxy.ts";
import type { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";
import type { InProcessSupervisor } from "../../src/supervisor/inprocess-supervisor.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

const HOST = [
	"/host/node_modules/pi-lens/index.ts",
	"/host/node_modules/pi-any-endpoint/extensions/index.ts",
	"/host/plugin/index.ts",
];

test("#280: inheritance defaults ON, and either opt-out narrows to the card's own list", () => {
	assert.equal(childInheritsExtensions({}), true, "a card that says nothing inherits");
	assert.equal(childInheritsExtensions({}, { PI_LEGION_CHILD_INHERIT_EXTENSIONS: "1" }), true);
	assert.equal(childInheritsExtensions({}, { PI_LEGION_CHILD_INHERIT_EXTENSIONS: "off" }), false);
	assert.equal(childInheritsExtensions({}, { PI_LEGION_CHILD_INHERIT_EXTENSIONS: "0" }), false);
	assert.equal(
		childInheritsExtensions({ inheritExtensions: false }, { PI_LEGION_CHILD_INHERIT_EXTENSIONS: "1" }),
		false,
		"the card wins over an env opt-IN; a hermetic role must stay hermetic",
	);

	assert.deepEqual(inheritedExtensions({}, HOST), HOST, "default: everything");
	assert.deepEqual(
		inheritedExtensions({ inheritExtensions: false }, HOST),
		[],
		"opt-out: nothing inherited (the caller still appends the card's own list + guard)",
	);
});

test("#280: excludeExtensions accepts a package NAME and a PATH, and nothing else", () => {
	// Name form: matches the package directory regardless of entry layout.
	assert.equal(matchesExcludedExtension("/h/node_modules/pi-lens/index.ts", "pi-lens"), true);
	assert.equal(matchesExcludedExtension("/h/node_modules/pi-lens/dist/ext/x.ts", "pi-lens"), true);
	// Loose entry file named after the extension.
	assert.equal(matchesExcludedExtension("/h/extensions/pi-lens.ts", "pi-lens"), true);
	// Path form: exact file match, `~` expanded.
	assert.equal(matchesExcludedExtension("/h/node_modules/pi-lens/index.ts", "/h/node_modules/pi-lens/index.ts"), true);
	assert.equal(
		matchesExcludedExtension("/h/node_modules/pi-lens/other.ts", "/h/node_modules/pi-lens/index.ts"),
		false,
		"a path matches the FILE, not the package",
	);
	// Names must not leak across packages.
	assert.equal(matchesExcludedExtension("/h/node_modules/pi-lens-extra/index.ts", "pi-lens"), false);
	assert.equal(matchesExcludedExtension("/h/node_modules/pi-lens/index.ts", ""), false);
});

test("#280: excludeExtensions subtracts, and an unlisted pattern changes nothing", () => {
	const filtered = inheritedExtensions(
		{ excludeExtensions: ["pi-lens", "/host/plugin/index.ts"] },
		HOST,
	);
	assert.deepEqual(
		filtered,
		["/host/node_modules/pi-any-endpoint/extensions/index.ts"],
		"both spellings subtract, everything else stays",
	);
	assert.deepEqual(
		inheritedExtensions({ excludeExtensions: ["not-installed"] }, HOST),
		HOST,
		"excluding something absent is a no-op, not an error",
	);
});

test("#280: excludeExtensions is inert when the card opted out entirely", () => {
	assert.deepEqual(
		inheritedExtensions({ inheritExtensions: false, excludeExtensions: ["pi-lens"] }, HOST),
		[],
		"nothing is inherited, so there is nothing to subtract",
	);
});

test("#280: discovery resolves a package the way pi's loader does", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ext-inherit-"));
	try {
		// package.json with pi.extensions
		const pkg = path.join(dir, "with-manifest");
		mkdirSync(path.join(pkg, "extensions"), { recursive: true });
		writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions/index.ts"] } }));
		writeFileSync(path.join(pkg, "extensions", "index.ts"), "export default {};\n");
		assert.deepEqual(resolveExtensionEntries(pkg), [path.join(pkg, "extensions", "index.ts")]);

		// index.ts fallback (this is how /plugin resolves: no package.json)
		const bare = path.join(dir, "bare");
		mkdirSync(bare, { recursive: true });
		writeFileSync(path.join(bare, "index.ts"), "export default {};\n");
		assert.deepEqual(resolveExtensionEntries(bare), [path.join(bare, "index.ts")]);

		// index.js fallback
		const js = path.join(dir, "js");
		mkdirSync(js, { recursive: true });
		writeFileSync(path.join(js, "index.js"), "module.exports = {};\n");
		assert.deepEqual(resolveExtensionEntries(js), [path.join(js, "index.js")]);

		// A declared-but-missing entry falls through rather than yielding a dead path.
		const broken = path.join(dir, "broken");
		mkdirSync(broken, { recursive: true });
		writeFileSync(path.join(broken, "package.json"), JSON.stringify({ pi: { extensions: ["./gone.ts"] } }));
		writeFileSync(path.join(broken, "index.ts"), "export default {};\n");
		assert.deepEqual(resolveExtensionEntries(broken), [path.join(broken, "index.ts")]);

		// Not an extension package at all.
		const empty = path.join(dir, "empty");
		mkdirSync(empty, { recursive: true });
		assert.deepEqual(resolveExtensionEntries(empty), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("#280: parsePiList keeps package directories and drops headers/descriptors", () => {
	const output = [
		"User packages:",
		"  npm:pi-any-endpoint@0.1.3",
		"    /root/.pi/agent/npm/node_modules/pi-any-endpoint",
		"  ../../../plugin",
		"    /plugin",
		"",
	].join("\n");
	assert.deepEqual(parsePiList(output), [
		"/root/.pi/agent/npm/node_modules/pi-any-endpoint",
		"/plugin",
	]);
});

// ── wiring (contract extension-inheritance-wiring-v1 §4) ────────────────────

/**
 * A fake host: one `pi` script on PATH that reports a package dir we control.
 *
 * Discovery shells out to `pi list`, so the honest way to drive it is a real
 * child process — stubbing `execFile` would not exercise the argv, the env
 * passthrough or the failure path.
 */
interface FakeHost {
	/** Extension entry the fake package resolves to. */
	entry: string;
	/** Append a line to the shared call log (orders shim calls vs. host calls). */
	log(line: string): void;
	/** Lines in the call log. */
	lines(): string[];
	/** Number of `pi` invocations recorded by the shim. */
	piCalls(): number;
	/** PATH overlay that makes this host visible, keeping the real PATH for /bin/sh. */
	pathValue: string;
	cleanup(): void;
}

function fakeHost(options: { failFirst?: boolean; alwaysFail?: boolean } = {}): FakeHost {
	const root = mkdtempSync(path.join(tmpdir(), "ext-host-"));
	const pkgDir = path.join(root, "npm", "node_modules", "fake-lens");
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(path.join(pkgDir, "index.ts"), "export default {};\n");
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = path.join(root, "calls.log");
	const failMarker = path.join(root, "fail-once");
	if (options.failFirst) writeFileSync(failMarker, "1");
	const shim = path.join(binDir, "pi");
	writeFileSync(
		shim,
		[
			"#!/bin/sh",
			`echo "pi $*" >> ${JSON.stringify(logPath)}`,
			...(options.alwaysFail ? ["exit 4"] : []),
			`if [ -f ${JSON.stringify(failMarker)} ]; then rm -f ${JSON.stringify(failMarker)}; exit 3; fi`,
			'echo "User packages:"',
			`echo "    ${pkgDir}"`,
		].join("\n") + "\n",
	);
	chmodSync(shim, 0o755);
	const readLog = (): string[] =>
		readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
	const readQuiet = (): string[] => {
		try {
			return readLog();
		} catch {
			return [];
		}
	};
	return {
		entry: path.join(pkgDir, "index.ts"),
		log(line: string) {
			writeFileSync(logPath, [...readQuiet(), line].join("\n") + "\n");
		},
		lines: readQuiet,
		piCalls: () => readQuiet().filter((line) => line.startsWith("pi ")).length,
		pathValue: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Run `fn` with a modified `process.env`, restoring it (and the cache) after. */
async function withPathEnv<T>(
	pathValue: string,
	vars: Record<string, string | undefined>,
	fn: () => Promise<T>,
): Promise<T> {
	const prev: Record<string, string | undefined> = { PATH: process.env.PATH };
	for (const key of Object.keys(vars)) prev[key] = process.env[key];
	process.env.PATH = pathValue;
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetExtensionDiscoveryCache();
	try {
		return await fn();
	} finally {
		resetExtensionDiscoveryCache();
		for (const key of Object.keys(prev)) {
			if (prev[key] === undefined) delete process.env[key];
			else process.env[key] = prev[key];
		}
	}
}

/** Run `fn` with the fake host first on PATH (so its `pi` wins) and the cache reset. */
async function withHostEnv<T>(host: FakeHost, vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
	return withPathEnv(host.pathValue, vars, fn);
}

const DISCOVERY_STORE_KEY = Symbol.for("pi-legion.extension-discovery");

function discoveryStore(): object | undefined {
	return (globalThis as unknown as Record<symbol, object | undefined>)[DISCOVERY_STORE_KEY];
}

/** Minimal spawn input for the router-level cases. */
function spawnInput(overrides: Partial<SpawnInput> = {}): SpawnInput {
	return {
		name: "worker",
		cwd: "/tmp",
		sessionFile: "/tmp/worker.jsonl",
		tempDir: "/tmp",
		task: "t",
		agent: {
			name: "worker",
			description: "d",
			systemPrompt: "",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: false,
			kind: "pi",
			source: "user",
			filePath: "/f.md",
		},
		...overrides,
	} as SpawnInput;
}

/** Router whose backends are recording stubs (the real router code still runs). */
function stubRouter(record: (name: string, mode: string | undefined) => void): RoutingSupervisor {
	const uiProxy = new InMemoryUIProxy();
	const spawn = async (input: SpawnInput) => {
		record(input.name, input.agent.spawnMode);
		return { name: input.name, sessionFile: input.sessionFile, pid: 1 };
	};
	const rpc = { uiProxy, isAlive: () => false, spawnChild: spawn } as unknown as RpcSupervisor;
	const inprocess = { uiProxy, isAlive: () => false, spawnChild: spawn } as unknown as InProcessSupervisor;
	return new RoutingSupervisor({ rpc, inprocess, uiProxy });
}

test("A1: ensureHostExtensions primes the sync getter the argv builder reads", async () => {
	const host = fakeHost();
	try {
		await withHostEnv(host, { PI_LEGION_CHILD_EXTENSIONS: undefined }, async () => {
			assert.equal(discoveredHostExtensions(), undefined, "cold cache starts empty");
			const resolved = await ensureHostExtensions();
			assert.deepEqual(resolved, [host.entry], "resolution keeps pi's package shape");
			assert.deepEqual(
				discoveredHostExtensions(),
				resolved,
				"D1: the sync getter must see what the async resolver stored",
			);
		});
	} finally {
		host.cleanup();
	}
});

test("A2: resetExtensionDiscoveryCache clears the shared holder in place", async () => {
	const host = fakeHost();
	try {
		await withHostEnv(host, {}, async () => {
			await ensureHostExtensions();
			assert.deepEqual(discoveredHostExtensions(), [host.entry]);
			const holder = discoveryStore();
			assert.ok(holder, "discovery must live on the globalThis holder (D1-a)");

			resetExtensionDiscoveryCache();
			assert.equal(discoveredHostExtensions(), undefined, "reset empties the cache");
			assert.equal(discoveryStore(), holder, "reset must not re-assign the holder (D1-a)");

			// The holder is shared with every other module instance of this file — the
			// whole point of D1. A second evaluation sees the reset and a fresh prime.
			// The specifier is computed so the module cache is bypassed (a query string
			// is how a re-evaluated jiti copy of this module differs from the first),
			// and it is non-literal so TypeScript does not try to resolve the query.
			const isolatedSpecifier = "../../src/runs/extension-inheritance.ts?isolated-instance";
			const otherInstance = (await import(isolatedSpecifier)) as typeof import(
				"../../src/runs/extension-inheritance.ts"
			);
			assert.notEqual(
				otherInstance.discoveredHostExtensions,
				discoveredHostExtensions,
				"precondition: this really is a second module instance",
			);
			assert.equal(
				otherInstance.discoveredHostExtensions(),
				undefined,
				"a second module instance reads the same (now empty) holder",
			);
			await ensureHostExtensions();
			assert.deepEqual(
				otherInstance.discoveredHostExtensions(),
				[host.entry],
				"a second module instance sees the prime — the parent warms the whole tree",
			);
			assert.equal(discoveryStore(), holder, "still the original holder");
		});
	} finally {
		host.cleanup();
	}
});

test("A3: RoutingSupervisor.spawnChild warms discovery before the backend spawns", async () => {
	const host = fakeHost();
	try {
		await withHostEnv(host, {}, async () => {
			const order: string[] = [];
			const supervisor = stubRouter((name) => {
				// Whatever the shim already logged came first; read it at spawn time so the
				// assertion is about real ordering, not about post-hoc bookkeeping.
				order.push(...host.lines(), `spawn:${name}`);
			});
			host.log("sentinel");
			await supervisor.spawnChild(spawnInput());
			assert.deepEqual(
				order,
				["sentinel", "pi list", "spawn:worker"],
				"`pi list` must complete before the backend sees the spawn",
			);
			// The warm result is what the argv builder/in-process plan will read.
			assert.deepEqual(discoveredHostExtensions(), [host.entry]);
		});
	} finally {
		host.cleanup();
	}
});

test("A4: warm discovery is idempotent — two spawns run one `pi list`", async () => {
	const host = fakeHost();
	try {
		await withHostEnv(host, {}, async () => {
			const spawned: string[] = [];
			const supervisor = stubRouter((name) => spawned.push(name));
			await supervisor.spawnChild(spawnInput({ name: "first" }));
			await supervisor.spawnChild(spawnInput({ name: "second" }));
			assert.deepEqual(spawned, ["first", "second"]);
			assert.equal(host.piCalls(), 1, "the second spawn must hit the cache, not `pi list`");
		});
	} finally {
		host.cleanup();
	}
});

test("A5: a failed discovery resolves to [] without caching, so the next spawn retries", async () => {
	const host = fakeHost({ failFirst: true });
	try {
		await withHostEnv(host, {}, async () => {
			const first = await ensureHostExtensions();
			assert.deepEqual(first, [], "a `pi list` failure degrades to no extensions");
			assert.equal(
				discoveredHostExtensions(),
				undefined,
				"a failure must NOT be cached as [] (F23: one blip would disable inheritance)",
			);

			const second = await ensureHostExtensions();
			assert.deepEqual(second, [host.entry], "the retry succeeds once `pi list` works");
			assert.equal(host.piCalls(), 2, "exactly one retry, then cached");

			assert.deepEqual(await ensureHostExtensions(), [host.entry]);
			assert.equal(host.piCalls(), 2, "the success is cached");
		});
	} finally {
		host.cleanup();
	}
});

test("A5: a host with no `pi` never fails a launch", async () => {
	await withPathEnv("/nonexistent-bin-dir", {}, async () => {
		assert.deepEqual(await ensureHostExtensions(), [], "no throw, no rejection");
		assert.equal(discoveredHostExtensions(), undefined, "and nothing cached");
	});
});

test("A5: concurrent cold callers share one `pi list`", async () => {
	const host = fakeHost({ alwaysFail: false });
	try {
		await withHostEnv(host, {}, async () => {
			const [a, b, c] = await Promise.all([
				ensureHostExtensions(),
				ensureHostExtensions(),
				ensureHostExtensions(),
			]);
			assert.deepEqual(a, [host.entry]);
			assert.deepEqual(b, [host.entry]);
			assert.deepEqual(c, [host.entry]);
			assert.equal(host.piCalls(), 1, "one in-flight promise, one child process");
		});
	} finally {
		host.cleanup();
	}
});

test("A5: a `pi list` failure does not burn the in-flight slot for later callers", async () => {
	const host = fakeHost({ failFirst: true });
	try {
		await withHostEnv(host, {}, async () => {
			const [, after] = await Promise.all([
				ensureHostExtensions(),
				// Enqueued while the first is in flight: it shares the failing promise…
				ensureHostExtensions(),
			]);
			assert.deepEqual(after, [], "concurrent callers see the same failure");
			// …and the slot is released, so a later caller runs a real retry.
			assert.deepEqual(await ensureHostExtensions(), [host.entry]);
		});
	} finally {
		host.cleanup();
	}
});
