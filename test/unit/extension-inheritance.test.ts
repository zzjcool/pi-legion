/**
 * #280: extension inheritance policy.
 *
 * The default flipped from "opt in" to "inherit everything, then narrow". These
 * cases pin the narrowing rules and the discovery resolver, because both decide
 * what code actually runs inside a child.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	childInheritsExtensions,
	inheritedExtensions,
	matchesExcludedExtension,
	parsePiList,
	resolveExtensionEntries,
} from "../../src/runs/extension-inheritance.ts";

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
