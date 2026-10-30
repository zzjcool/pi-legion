/**
 * #280: extension inheritance policy.
 *
 * The default flipped from "opt in" to "inherit everything, then narrow". These
 * cases pin the narrowing rules and the discovery resolver, because both decide
 * what code actually runs inside a child.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	FAILURE_TTL_MS,
	childInheritsExtensions,
	discoveredHostExtensions,
	ensureHostExtensions,
	hostExtensionDiscoveryState,
	inheritedExtensions,
	matchesExcludedExtension,
	parsePiList,
	resetExtensionDiscoveryCache,
	resolveExtensionEntries,
} from "../../src/runs/extension-inheritance.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import { InMemoryUIProxy } from "../../src/supervisor/ui-proxy.ts";
import { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";
import { InProcessSupervisor } from "../../src/supervisor/inprocess-supervisor.ts";
import { collectChildExtensions } from "../../src/runs/args.ts";
import { spawnFailureHint } from "../../src/extension/spawn-hints.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";

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

function fakeHost(
	options: {
		failFirst?: boolean;
		alwaysFail?: boolean;
		/** Text the failing shim writes to stderr before exiting non-zero. */
		failMessage?: string;
		/** Replace the default `index.ts` layout; return the entry the package resolves to. */
		layout?: (pkgDir: string) => string;
	} = {},
): FakeHost {
	const root = mkdtempSync(path.join(tmpdir(), "ext-host-"));
	const pkgDir = path.join(root, "npm", "node_modules", "fake-lens");
	mkdirSync(pkgDir, { recursive: true });
	const entry = options.layout
		? options.layout(pkgDir)
		: (writeFileSync(path.join(pkgDir, "index.ts"), "export default {};\n"), path.join(pkgDir, "index.ts"));
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
			...(options.failMessage ? [`echo ${JSON.stringify(options.failMessage)} 1>&2`] : []),
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
		entry,
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

/**
 * Age the failure stamp past `FAILURE_TTL_MS`.
 *
 * R2-b turned a failed discovery into a short backoff instead of an immediate
 * retry, so every "a failure is not permanent" case has to cross that window the
 * way real time would. The stamp is aged through the shared holder instead of
 * faking the clock, so production keeps calling `Date.now()` and the test moves
 * only the value it wants to move.
 */
function expireFailureBackoff(): void {
	const holder = discoveryStore() as { failedAt?: number } | undefined;
	assert.ok(holder, "the failure stamp lives on the shared discovery holder");
	holder.failedAt = Date.now() - FAILURE_TTL_MS - 1;
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

test("A5: a failed discovery resolves to [] without caching, so a later call retries", async () => {
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

			// R2-b: the retry is deferred by `FAILURE_TTL_MS`, not skipped forever —
			// that is the whole point of ageing the stamp instead of caching `[]`.
			expireFailureBackoff();
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
			assert.equal(host.piCalls(), 1, "they shared one probe, so the slot did not leak a second");
			// …and the slot is released: once the R2-b backoff window passes, a later
			// caller runs a real retry rather than reusing a stuck promise.
			expireFailureBackoff();
			assert.deepEqual(await ensureHostExtensions(), [host.entry]);
			assert.equal(host.piCalls(), 2, "a real retry, not a dead in-flight slot");
		});
	} finally {
		host.cleanup();
	}
});

// ── R1-a: directory-shaped `pi.extensions` entries (contract §7 A11–A13) ────

/** The slice of `AgentConfig` `collectChildExtensions` reads, with inheritance on. */
function inheritingAgent(): {
	tools: string[];
	extensions: string[];
	inheritExtensions?: boolean;
	excludeExtensions?: string[];
} {
	return { tools: [], extensions: [] };
}

/**
 * The `pi-diff-review` shape (F26/F28): the manifest declares a DIRECTORY, the
 * directory has no `package.json`/`index.ts`, and its only extension is a
 * loose `review.ts`.
 */
function diffReviewLayout(pkgDir: string, files: string[] = ["review.ts"]): string {
	const extensionsDir = path.join(pkgDir, "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions"] } }));
	for (const file of files) writeFileSync(path.join(extensionsDir, file), "export default {};\n");
	return path.join(extensionsDir, files[0] ?? "review.ts");
}

test("A11: a directory entry expands to the loadable file inside it, not the directory", () => {
	const root = mkdtempSync(path.join(tmpdir(), "ext-dir-entry-"));
	try {
		// `pi.extensions: ["./extensions"]`, that directory holds only `review.ts`.
		const pkgDir = path.join(root, "pi-diff-review");
		const review = diffReviewLayout(pkgDir);
		const resolved = resolveExtensionEntries(pkgDir);
		assert.deepEqual(
			resolved,
			[review],
			"the declared DIRECTORY must expand to review.ts — `pi -e <dir>` exits 1 (F28)",
		);
		assert.ok(
			resolved.every((entry) => statSync(entry).isFile()),
			"every entry handed to `-e` must be a file",
		);

		// A loose directory also expands to its `*.ts`/`*.js` files, sorted.
		const multi = path.join(root, "multi");
		diffReviewLayout(multi, ["b.ts", "a.js", "notes.md"]);
		assert.deepEqual(resolveExtensionEntries(multi), [
			path.join(multi, "extensions", "a.js"),
			path.join(multi, "extensions", "b.ts"),
		], "both extension-typed files expand; a non-extension file is skipped");

		// A declared directory that IS its own package resolves through its manifest —
		// the declared shape stays authoritative one level down.
		const nested = path.join(root, "nested");
		mkdirSync(path.join(nested, "extensions"), { recursive: true });
		writeFileSync(path.join(nested, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions"] } }));
		writeFileSync(path.join(nested, "extensions", "decoy.ts"), "export default {};\n");
		writeFileSync(path.join(nested, "extensions", "package.json"), JSON.stringify({ pi: { extensions: ["./entry.ts"] } }));
		writeFileSync(path.join(nested, "extensions", "entry.ts"), "export default {};\n");
		assert.deepEqual(
			resolveExtensionEntries(nested),
			[path.join(nested, "extensions", "entry.ts")],
			"a directory entry with its own manifest resolves through that manifest, not by sweeping files",
		);

		// Its index file is the second choice, ahead of the loose-file sweep.
		const withIndex = path.join(root, "with-index");
		mkdirSync(path.join(withIndex, "extensions"), { recursive: true });
		writeFileSync(path.join(withIndex, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions"] } }));
		writeFileSync(path.join(withIndex, "extensions", "index.ts"), "export default {};\n");
		writeFileSync(path.join(withIndex, "extensions", "other.ts"), "export default {};\n");
		assert.deepEqual(
			resolveExtensionEntries(withIndex),
			[path.join(withIndex, "extensions", "index.ts")],
			"an index entry wins over the loose-file sweep",
		);

		// A manifest that declares `"./"` must terminate (the sweep is one level).
		const selfDeclaring = path.join(root, "self-declaring");
		mkdirSync(selfDeclaring, { recursive: true });
		writeFileSync(path.join(selfDeclaring, "package.json"), JSON.stringify({ pi: { extensions: ["./"] } }));
		writeFileSync(path.join(selfDeclaring, "main.ts"), "export default {};\n");
		assert.deepEqual(resolveExtensionEntries(selfDeclaring), [path.join(selfDeclaring, "main.ts")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A12: a directory entry that expands to nothing is dropped, not emitted", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "ext-empty-dir-"));
	try {
		// Empty declared directory, and the package has its own index fallback: the
		// dead directory entry must not appear alongside it.
		const empty = path.join(root, "empty-declared");
		mkdirSync(path.join(empty, "extensions"), { recursive: true });
		writeFileSync(path.join(empty, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions"] } }));
		writeFileSync(path.join(empty, "index.ts"), "export default {};\n");
		assert.deepEqual(
			resolveExtensionEntries(empty),
			[path.join(empty, "index.ts")],
			"an empty directory entry contributes nothing; the package still falls back to index.ts",
		);

		// Declared directory with only non-extension files: same verdict.
		const docsOnly = path.join(root, "docs-only");
		mkdirSync(path.join(docsOnly, "extensions"), { recursive: true });
		writeFileSync(path.join(docsOnly, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions"] } }));
		writeFileSync(path.join(docsOnly, "extensions", "README.md"), "# docs\n");
		assert.deepEqual(resolveExtensionEntries(docsOnly), [], "nothing loadable → dropped entirely");

		// And nothing appears in the child's argv either.
		const host = fakeHost({ layout: (pkgDir) => diffReviewLayout(pkgDir, []) });
		try {
			const extensionsDir = path.dirname(host.entry);
			await withHostEnv(host, { PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined }, async () => {
				const resolved = await ensureHostExtensions();
				assert.deepEqual(resolved, [], "the dead directory is not in the discovered set");
				assert.equal(
					collectChildExtensions(inheritingAgent()).includes(extensionsDir),
					false,
					"and it never reaches the `--extension` list the child is started with",
				);
			});
		} finally {
			host.cleanup();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A13: no non-file path ever reaches collectChildExtensions", async () => {
	// The set is resolved from a fake host shaped like `pi-diff-review` (declared
	// directory, no manifest/index inside), which is the shape the reviewer's
	// defect hit. The fake host is the ONLY source: `withHostEnv` replaces PATH
	// outright, so no live `pi list` result can leak into this assertion.
	const host = fakeHost({ layout: (pkgDir) => diffReviewLayout(pkgDir) });
	try {
		await withHostEnv(host, { PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined }, async () => {
			await ensureHostExtensions();
			const list = collectChildExtensions(inheritingAgent());
			assert.ok(list.length >= 2, "the inherited entry plus the child-guard at minimum");
			const offenders = list.filter((entry) => {
				try {
					return !statSync(entry).isFile();
				} catch {
					return true;
				}
			});
			assert.deepEqual(offenders, [], `non-file entries reached the child argv: ${offenders.join(", ")}`);
			assert.ok(list.includes(host.entry), "the expanded review.ts is what got inherited");
		});
	} finally {
		host.cleanup();
	}
});

// ── R2-a: the sweep must mirror pi's `collectAutoExtensionEntries` (§8 A17–A19) ──

/**
 * The documented pi layout: a package whose manifest declares `./extensions`, and
 * whose extensions are `<name>/index.ts` SUBDIRECTORIES rather than loose files.
 * `resolveExtensionEntries` used to sweep only files, so this shipped `[]`.
 */
function namedDirsLayout(pkgDir: string, dirs: string[]): string {
	const extensionsDir = path.join(pkgDir, "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions"] } }));
	for (const dir of dirs) {
		mkdirSync(path.join(extensionsDir, dir), { recursive: true });
		writeFileSync(path.join(extensionsDir, dir, "index.ts"), "export default {};\n");
	}
	return extensionsDir;
}

test("A17: `extensions/<name>/index.ts` subdirectories are collected, not dropped", () => {
	const root = mkdtempSync(path.join(tmpdir(), "ext-named-dirs-"));
	try {
		const pkgDir = path.join(root, "pkg");
		const extensionsDir = namedDirsLayout(pkgDir, ["alpha", "beta"]);
		// Precondition the defect depended on: no manifest and no index file at the
		// declared directory's own root, so only the subdirectories can resolve.
		assert.equal(existsSync(path.join(extensionsDir, "package.json")), false);
		assert.equal(existsSync(path.join(extensionsDir, "index.ts")), false);

		assert.deepEqual(
			resolveExtensionEntries(pkgDir),
			[
				path.join(extensionsDir, "alpha", "index.ts"),
				path.join(extensionsDir, "beta", "index.ts"),
			],
			"pi's documented `extensions/<name>/index.ts` layout must resolve (F34: both were lost)",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A18: a dotfile in the declared directory is not collected", () => {
	const root = mkdtempSync(path.join(tmpdir(), "ext-dotfile-"));
	try {
		const pkgDir = path.join(root, "pkg");
		const extensionsDir = namedDirsLayout(pkgDir, ["alpha", "beta"]);
		// `pi -e` accepts it (exit 0, F37), so this is not a crash guard: it is
		// behavioural alignment — pi's own `collectAutoExtensionEntries` skips every
		// `.`-prefixed entry, so we must not hand the child one.
		writeFileSync(path.join(extensionsDir, ".eslintrc.js"), "module.exports = {};\n");
		const resolved = resolveExtensionEntries(pkgDir);
		assert.equal(
			resolved.some((entry) => path.basename(entry).startsWith(".")),
			false,
			`a dotfile is never an extension entry: ${resolved.join(", ")}`,
		);
		assert.deepEqual(resolved, [
			path.join(extensionsDir, "alpha", "index.ts"),
			path.join(extensionsDir, "beta", "index.ts"),
		], "and the real extensions are unaffected by the dotfile beside them");

		// A directory whose ONLY content is dotfiles resolves to nothing at all.
		const dotOnly = path.join(root, "dot-only");
		mkdirSync(path.join(dotOnly, "extensions"), { recursive: true });
		writeFileSync(path.join(dotOnly, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions"] } }));
		writeFileSync(path.join(dotOnly, "extensions", ".eslintrc.js"), "module.exports = {};\n");
		assert.deepEqual(resolveExtensionEntries(dotOnly), [], "dotfiles alone cannot make a loadable entry");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A19: the subdirectory resolution is bounded — a directory inside a directory is not walked", () => {
	const root = mkdtempSync(path.join(tmpdir(), "ext-nested-dir-"));
	try {
		// `extensions/x/y/index.ts`: `x` is the one subdirectory level R2-a allows,
		// and it resolves to nothing (no manifest, no index of its own), so `y` must
		// not be reached. pi stops at the same depth (F33).
		const pkgDir = path.join(root, "pkg");
		const extensionsDir = path.join(pkgDir, "extensions");
		mkdirSync(path.join(extensionsDir, "x", "y"), { recursive: true });
		writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions"] } }));
		writeFileSync(path.join(extensionsDir, "x", "y", "index.ts"), "export default {};\n");
		assert.deepEqual(
			resolveExtensionEntries(pkgDir),
			[],
			"the sweep resolves one subdirectory level and stops; a deepening path must not become a walk",
		);

		// The same bound holds for the SWEEP inside a declared directory: a second
		// level down never appears even when the first level does resolve.
		const mixed = path.join(root, "mixed");
		const mixedExt = path.join(mixed, "extensions");
		mkdirSync(path.join(mixedExt, "good", "deeper"), { recursive: true });
		writeFileSync(path.join(mixed, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions"] } }));
		writeFileSync(path.join(mixedExt, "good", "index.ts"), "export default {};\n");
		writeFileSync(path.join(mixedExt, "good", "deeper", "index.ts"), "export default {};\n");
		assert.deepEqual(
			resolveExtensionEntries(mixed),
			[path.join(mixedExt, "good", "index.ts")],
			"one level of subdirectory resolution, and the index of that level wins over deeper files",
		);

		// A self-declaring manifest one level in must still terminate (the R1-a guard
		// and the R2-a depth bound are the same mechanism).
		const selfDeclaring = path.join(root, "self-declaring");
		mkdirSync(path.join(selfDeclaring, "nested"), { recursive: true });
		writeFileSync(path.join(selfDeclaring, "package.json"), JSON.stringify({ pi: { extensions: ["./nested"] } }));
		writeFileSync(path.join(selfDeclaring, "nested", "package.json"), JSON.stringify({ pi: { extensions: ["./main.ts"] } }));
		writeFileSync(path.join(selfDeclaring, "nested", "main.ts"), "export default {};\n");
		assert.deepEqual(resolveExtensionEntries(selfDeclaring), [path.join(selfDeclaring, "nested", "main.ts")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── R2-b: a failed probe is backed off for one spawn (§8 A20–A22) ────────────

test("A21: a failed discovery still retries once the backoff window has passed", async () => {
	const host = fakeHost({ failFirst: true });
	try {
		await withHostEnv(host, {}, async () => {
			const first = await ensureHostExtensions();
			assert.deepEqual(first, [], "the failing `pi list` degrades to no extensions");
			assert.equal(host.piCalls(), 1, "precondition: one probe paid for");

			// Inside the window the failure is remembered without another probe. This is
			// the R2-b behaviour, not a permanent off switch: the next assertion crosses
			// the window.
			assert.deepEqual(await ensureHostExtensions(), []);
			assert.equal(host.piCalls(), 1, "a second warm inside the TTL must not re-probe");

			expireFailureBackoff();
			assert.deepEqual(
				await ensureHostExtensions(),
				[host.entry],
				"past `FAILURE_TTL_MS` discovery is retried and succeeds (F23: never permanently off)",
			);
			assert.equal(host.piCalls(), 2, "exactly one retry, then cached");
			assert.deepEqual(await ensureHostExtensions(), [host.entry], "the success is cached again");
			assert.equal(host.piCalls(), 2);
		});
	} finally {
		host.cleanup();
	}
});

test("A22: the success path is unchanged by the failure backoff", async () => {
	const host = fakeHost();
	try {
		await withHostEnv(host, {}, async () => {
			// Two warm calls (router + backend, or two spawns) still cost one probe,
			// and the second is a cache hit — the TTL only ever engages on failure.
			assert.deepEqual(await ensureHostExtensions(), [host.entry]);
			assert.deepEqual(await ensureHostExtensions(), [host.entry]);
			assert.deepEqual(discoveredHostExtensions(), [host.entry]);
			assert.equal(host.piCalls(), 1, "success is cached; the new backoff must never add a probe");
			const holder = discoveryStore() as { failedAt?: number } | undefined;
			assert.equal(holder?.failedAt, undefined, "a success records no failure stamp");
		});
	} finally {
		host.cleanup();
	}
});

// ── #317: discovery failure is visible, and its state is introspectable ─────

/** Capture `console.error` lines (the project's log channel) for one case. */
function captureConsoleError(): { lines: string[]; restore(): void } {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
	};
	return {
		lines,
		restore() {
			console.error = original;
		},
	};
}

test("#317: a failed discovery warns exactly once, with the `pi list` stderr", async () => {
	const host = fakeHost({ alwaysFail: true, failMessage: "boom: pi list is broken" });
	const log = captureConsoleError();
	try {
		await withHostEnv(host, {}, async () => {
			assert.deepEqual(await ensureHostExtensions(), [], "the failure still degrades to no extensions");
			assert.equal(host.piCalls(), 1, "precondition: exactly one probe ran");
			assert.equal(log.lines.length, 1, `expected one warning, got ${JSON.stringify(log.lines)}`);
			assert.match(log.lines[0]!, /^\[pi-legion\] host extension discovery failed/, "project log prefix");
			assert.match(log.lines[0]!, /boom: pi list is broken/, "the warning carries the stderr summary");
			assert.match(log.lines[0]!, /\/legion doctor|PI_LEGION_CHILD_EXTENSIONS/, "and says what to do");

			// Inside the backoff window nothing re-probes, so nothing can re-warn.
			assert.deepEqual(await ensureHostExtensions(), []);
			assert.equal(host.piCalls(), 1, "the R2-b backoff is untouched");
			assert.equal(log.lines.length, 1, "no warning per warm call");

			// Past the window the probe is retried (never-reject stays recoverable),
			// and the same failure episode still must not spam a second warning: the
			// `failedAt` stamp is the already-told bit.
			expireFailureBackoff();
			assert.deepEqual(await ensureHostExtensions(), []);
			assert.equal(host.piCalls(), 2, "the failure is still retried after FAILURE_TTL_MS (F23)");
			assert.equal(log.lines.length, 1, "a repeated failure does not warn twice");
		});
	} finally {
		log.restore();
		host.cleanup();
	}
});

test("#317: an empty `pi list` stderr still warns and never throws", async () => {
	// No failMessage: the shim exits 4 with no stderr at all. The warning must
	// degrade to the next description instead of throwing on `undefined`.
	const host = fakeHost({ alwaysFail: true });
	const emptyDir = mkdtempSync(path.join(tmpdir(), "ext-no-pi-"));
	const log = captureConsoleError();
	try {
		await withHostEnv(host, {}, async () => {
			assert.deepEqual(await ensureHostExtensions(), []);
			assert.equal(log.lines.length, 1, `expected one warning, got ${JSON.stringify(log.lines)}`);
			// The reason after the colon must be non-empty, and with no stderr it is the
			// EXIT CODE that names the failure (the `error.message` fallback sits after
			// the code on purpose: `execFile` always fills message with the generic
			// `Command failed: pi list`, which would make the code branch unreachable).
			assert.match(log.lines[0]!, /failed \(pi list\): [^.\s]/, "a reason is still reported");
			assert.match(log.lines[0]!, /pi list exited 4/, "the exit code is the reason when stderr is empty");
			assert.equal(log.lines[0]!.includes("undefined"), false, "no `undefined` leaked into the message");
		});

		// No `pi` on PATH at all: `code` is the string `ENOENT`, so the chain falls
		// through to `error.message` — the other half of the fallback order.
		await withPathEnv(emptyDir, {}, async () => {
			assert.deepEqual(await ensureHostExtensions(), []);
			assert.equal(log.lines.length, 2, `expected a second warning, got ${JSON.stringify(log.lines)}`);
			assert.match(log.lines[1]!, /spawn pi ENOENT/, "a non-numeric code falls through to the message");
		});
	} finally {
		log.restore();
		host.cleanup();
		rmSync(emptyDir, { recursive: true, force: true });
	}
});

test("#317: hostExtensionDiscoveryState separates ok / failed / never probed", async () => {
	resetExtensionDiscoveryCache();
	assert.deepEqual(
		hostExtensionDiscoveryState(),
		{ status: "unknown", count: 0 },
		"never probed is its own state, not an empty host",
	);

	const failing = fakeHost({ alwaysFail: true });
	const log = captureConsoleError();
	try {
		await withHostEnv(failing, {}, async () => {
			await ensureHostExtensions();
			const state = hostExtensionDiscoveryState();
			assert.equal(state.status, "failed", "a failed probe is not reported as an empty host");
			assert.equal(state.count, 0);
			assert.equal(typeof state.at, "number", "the stamp doctor renders as `<n>s ago`");
			assert.ok(Math.abs(Date.now() - state.at!) < 60_000, "and it is the time of THIS probe");
		});
	} finally {
		log.restore();
		failing.cleanup();
	}

	// A host that really ships no extension package resolves successfully to 0 —
	// `ok` with count 0 must stay distinguishable from `failed`.
	const empty = fakeHost({ layout: () => "" });
	try {
		await withHostEnv(empty, {}, async () => {
			assert.deepEqual(await ensureHostExtensions(), []);
			assert.deepEqual(
				hostExtensionDiscoveryState(),
				{ status: "ok", count: 0 },
				"an empty host is `ok`, not `failed`",
			);
		});
	} finally {
		empty.cleanup();
	}

	const host = fakeHost();
	try {
		await withHostEnv(host, {}, async () => {
			assert.deepEqual(await ensureHostExtensions(), [host.entry]);
			assert.deepEqual(hostExtensionDiscoveryState(), { status: "ok", count: 1 });
		});
	} finally {
		host.cleanup();
	}
});

test("#317: the production path — no injected status — reads the shared discovery holder", async () => {
	// The production caller (`enrichFailureWithAutoDoctor` → `spawnFailureHint`) does
	// NOT pass `discoveryStatus`. If the `?? hostExtensionDiscoveryState().status`
	// default ever stopped reading the real holder — say it fell back to `"ok"` — the
	// note would silently never appear in production while every explicitly-injected
	// case stayed green. So this case goes through the two real modules: discovery
	// writes the state in `extension-inheritance.ts`, spawn-hints reads it, and
	// nothing is passed in.
	const host = fakeHost({ alwaysFail: true, failMessage: "pi list exploded" });
	const log = captureConsoleError();
	try {
		await withHostEnv(host, {}, async () => {
			await ensureHostExtensions();
			assert.equal(hostExtensionDiscoveryState().status, "failed", "precondition: the probe failed");

			// The state lives on `globalThis[Symbol.for(...)]`, i.e. it survives module
			// re-evaluation — that is the only reason a re-loaded extension or a different
			// jiti module instance can see what this process already discovered.
			const holder = discoveryStore() as { failedAt?: number } | undefined;
			assert.equal(typeof holder?.failedAt, "number", "the state lives on the shared holder");
			// #329: `import("../../src/extension/spawn-hints.ts?fresh=1")` used to stand here and
			// proved nothing: ESM drops the query when resolving that module's own relative
			// imports, so it re-evaluated spawn-hints but got the SAME extension-inheritance
			// instance — a module-local store stayed green. Re-evaluate the module that OWNS the
			// holder instead: a second instance must read the failure the first one wrote.
			// (Non-literal specifier so TypeScript does not try to resolve the query.)
			const freshSpecifier = "../../src/runs/extension-inheritance.ts?fresh=1";
			const fresh = (await import(freshSpecifier)) as typeof import("../../src/runs/extension-inheritance.ts");
			assert.notEqual(
				fresh.hostExtensionDiscoveryState,
				hostExtensionDiscoveryState,
				"precondition: this really is a second module instance",
			);
			assert.equal(
				fresh.hostExtensionDiscoveryState().status,
				"failed",
				"a second instance of the owner module reads the same shared holder",
			);

			const hint = spawnFailureHint({ stderr: "Unknown provider: workbuddy/hy4", spawnMode: "inprocess" });
			assert.ok(hint);
			assert.match(hint!, /host discovery is failed/, "the un-injected path reads the real state");
			assert.match(hint!, /the child got 0 host extensions/);
		});
	} finally {
		log.restore();
		host.cleanup();
	}
});
