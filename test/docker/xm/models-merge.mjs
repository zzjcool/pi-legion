#!/usr/bin/env node
// Per-container models.json for the xm-harness (contract §v1.1 "每容器各自的 models.json").
//
//   node models-merge.mjs --base /root/.pi/agent/models.json --out /tmp/xm/parent/models.json \
//        --base-url http://parent:8765/v1
//   node models-merge.mjs --base ... --out ... --base-url http://parent:8766/v1 --no-xm
//
// WHY a separate file per container: the container's models.json is a bind mount of
// the HOST's ~/.pi/agent/models.json (read-only), so the mock provider cannot be
// appended in place. `test/docker/xm-up.sh` therefore generates one merged file per
// container and mounts that instead. The rest of the host file is preserved verbatim
// so `make xm-real` (`XM_MODEL=workbuddy/hy4std`) still has its real providers.
//
// WHY the provider id and model id are identical on both ends: the parent passes
// `<provider>/<model>` (`xm/flash`) to the child's argv, and the child resolves that
// string against ITS OWN models.json. Two different names would make every remote
// launch a `model-missing` refusal.
//
// `--no-xm` omits the provider entirely (the `model-missing` scenario). That is
// deliberate: pi answers an unregistered model id under a KNOWN provider with
// "Using custom model id" and carries on, so a provider that exists but lacks the id
// is NOT a refusal — only an unknown provider makes the launch probe report
// `model-missing` (src/runs/remote.ts:841-867).
//
// Prints one line on success:
//   XM_MODELS_WRITTEN out=<path> providers=<a,b> xm=<yes|no> baseUrl=<url> models=<ids>
// Exits 1 with XM_MODELS_FAIL on any problem. Never silently drops a provider.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const XM_PROVIDER = "xm";
const XM_MODEL_ID = "flash";
const DUMMY_KEY = "mock";

function fail(message) {
	process.stderr.write(`XM_MODELS_FAIL ${message}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const out = {
		base: "",
		out: "",
		baseUrl: "",
		withXm: true,
		models: [XM_MODEL_ID],
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--base") out.base = argv[++i] ?? "";
		else if (arg === "--out") out.out = argv[++i] ?? "";
		else if (arg === "--base-url") out.baseUrl = argv[++i] ?? "";
		else if (arg === "--models") out.models = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
		else if (arg === "--no-xm") out.withXm = false;
		else fail(`unknown arg '${arg}'`);
	}
	if (!out.out) fail("--out is required");
	if (out.withXm && !out.baseUrl) fail("--base-url is required unless --no-xm");
	if (out.models.length === 0) fail("--models must not be empty");
	return out;
}

const args = parseArgs(process.argv.slice(2));

let base = {};
if (args.base && existsSync(args.base)) {
	const raw = readFileSync(args.base, "utf8");
	if (raw.trim().length > 0) {
		try {
			base = JSON.parse(raw);
		} catch (error) {
			fail(`base ${args.base} is not valid JSON :: ${error.message}`);
		}
	}
}
if (typeof base !== "object" || base === null || Array.isArray(base)) base = {};

const providers = typeof base.providers === "object" && base.providers !== null && !Array.isArray(base.providers)
	? { ...base.providers }
	: {};

if (args.withXm) {
	providers[XM_PROVIDER] = {
		baseUrl: args.baseUrl,
		api: "openai-completions",
		apiKey: DUMMY_KEY,
		models: args.models.map((id) => ({
			id,
			name: id === XM_MODEL_ID ? "XM Flash" : `XM ${id}`,
			contextWindow: 32000,
			maxTokens: 2048,
		})),
	};
} else {
	delete providers[XM_PROVIDER];
}

const merged = { ...base, providers };
const body = `${JSON.stringify(merged, null, 2)}\n`;
try {
	mkdirSync(path.dirname(args.out), { recursive: true });
	const tmp = `${args.out}.tmp-${process.pid}`;
	writeFileSync(tmp, body, { mode: 0o644 });
	renameSync(tmp, args.out);
} catch (error) {
	fail(`cannot write ${args.out} :: ${error.message}`);
}

process.stdout.write(
	`XM_MODELS_WRITTEN out=${args.out} providers=${Object.keys(providers).sort().join(",") || "-"} xm=${args.withXm ? "yes" : "no"} baseUrl=${args.withXm ? args.baseUrl : "-"} models=${args.withXm ? args.models.join(",") : "-"}\n`,
);
