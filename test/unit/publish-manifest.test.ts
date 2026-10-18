import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for the 3.0.0 / 3.0.1 release incidents: both attempts to
// force contributors onto pnpm broke npm consumers.
//
// 3.0.0 shipped `scripts.preinstall` in the published manifest, so every npm
// consumer failed: Pi installs extensions by running
// `npm install <spec> --prefix <agentDir>/npm --legacy-peer-deps`, and the hook
// made `pi update --extensions` exit 1, roll back, and report "updates
// available" on every start.
//
// 3.0.1 replaced it with `devEngines.packageManager` (`onFail: "error"`), which
// npm enforces for *every* non-global command in the checkout: `npm run`,
// `npm pack`, `npm exec`, and `npx` all failed with EBADDEVENGINES, and
// `pi install git:<repo>` (git clone + npm install) failed too. See issue #210.
//
// The rule this file now enforces: the manifest must be installable and usable
// by npm, which is the reference path for every consumer. pnpm may still be
// used locally; the repository does not demand it.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(
	readFileSync(join(repoRoot, "package.json"), "utf8"),
) as {
	scripts?: Record<string, string>;
	engines?: Record<string, string>;
	devEngines?: {
		packageManager?: { name?: string; version?: string; onFail?: string };
	};
	packageManager?: string;
};

test("published manifest has no preinstall hook", () => {
	// npm always packs package.json, so any install-phase script here reaches
	// every consumer. Extension installs must stay script-free.
	assert.equal(
		manifest.scripts?.preinstall,
		undefined,
		"preinstall runs under npm for every consumer; the manifest must stay script-free",
	);
});

test("manifest declares no install-phase scripts at all", () => {
	const installPhase = ["preinstall", "install", "postinstall"];
	for (const name of installPhase) {
		assert.equal(
			manifest.scripts?.[name],
			undefined,
			`${name} would execute in consumer installs (pi runs npm install)`,
		);
	}
});

test("manifest declares no package-manager enforcement", () => {
	// `devEngines.packageManager` makes npm reject every command in the
	// checkout (EBADDEVENGINES), including `pi install git:<repo>`; and
	// `packageManager` makes corepack refuse to run npm at all. npm is the
	// reference path for consumers, so neither field may come back (#210).
	assert.equal(
		manifest.devEngines,
		undefined,
		"devEngines rejects npm for every command in this checkout; see issue #210",
	);
	assert.equal(
		manifest.packageManager,
		undefined,
		"packageManager makes corepack refuse npm; see issue #210",
	);
});

test("manifest keeps the Node floor without a pnpm requirement", () => {
	assert.match(manifest.engines?.node ?? "", />=22/);
	assert.equal(
		manifest.engines?.pnpm,
		undefined,
		"engines.pnpm documents a requirement the repository no longer has",
	);
});

test("repository scripts run under either package manager", () => {
	// `node --run` is package-manager neutral: `npm run` and `pnpm run` both
	// work for contributors, and nothing in the manifest names a package
	// manager binary. Note: `node --run` does NOT execute pre/post hooks.
	for (const name of ["test:all", "prepublishOnly"]) {
		const command = manifest.scripts?.[name] ?? "";
		assert.doesNotMatch(
			command,
			/\b(pnpm|yarn|bun)\b/,
			`scripts.${name} must not hardcode a package manager`,
		);
		assert.match(
			command,
			/node --run/,
			`scripts.${name} should compose via node --run`,
		);
	}
});
