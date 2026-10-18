import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for the 3.0.0 release incident: `preinstall` shipped in the
// published manifest and rejected every npm consumer. Pi installs extensions by
// running `npm install <spec> --prefix <agentDir>/npm --legacy-peer-deps`, so the
// hook made `pi update --extensions` fail for everyone (npm exits 1, npm rolls
// the package back to the previous version, and the "package updates available"
// notice reappears on every start).
//
// The pnpm-only intent belongs in `devEngines.packageManager`, which npm enforces
// for the repository root (`EBADDEVENGINES`) and ignores when this package is
// installed as a dependency — exactly the split we need.

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
		"preinstall runs under npm for every consumer; use devEngines.packageManager instead",
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

test("pnpm-only intent lives in devEngines.packageManager", () => {
	assert.equal(manifest.devEngines?.packageManager?.name, "pnpm");
	assert.equal(manifest.devEngines?.packageManager?.onFail, "error");
	assert.match(manifest.devEngines?.packageManager?.version ?? "", /9/);
});

test("pnpm intent is preserved for contributors", () => {
	// Removing the npm script must not silently drop the pnpm requirement.
	assert.equal(manifest.packageManager, "pnpm@9.15.9");
	assert.equal(manifest.engines?.pnpm, ">=9");
	assert.match(manifest.engines?.node ?? "", />=22/);
});

test("devEngines does not leak into the consumer install path", () => {
	// `devEngines` must stay a repo-root-only guard: it has to be scoped to
	// packageManager and must never carry an install-phase script or dependency
	// requirement that npm would enforce for a consumer (pi installs with npm).
	const devEngines = manifest.devEngines as Record<string, unknown> | undefined;
	assert.deepEqual(
		Object.keys(devEngines ?? {}),
		["packageManager"],
		"devEngines must only declare packageManager",
	);
});
