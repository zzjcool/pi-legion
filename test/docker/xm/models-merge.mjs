#!/usr/bin/env node
// Per-container models.json for the xm-harness (contract §v1.1 "每容器各自的 models.json").
//
//   node models-merge.mjs --base /root/.pi/agent/models.json --out .../parent/models.json \
//        --base-url http://parent:8765/v1
//   node models-merge.mjs --base ... --out .../remote/models.json \
//        --base-url http://parent:8766/v1 --no-host-providers --provider xmock --models other
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
// `--no-host-providers` + `--provider xmock --models other` is the target-model
// fallback scenario (§5.4 as of 6.2.2). Two facts make it deterministic:
//
//   1. the requested provider must be ABSENT from that machine. pi answers an
//      unregistered model id under a KNOWN provider with "Using custom model id" and
//      `classifyRemoteStartupProbe` deliberately reads that as "not a refusal"
//      (remote.ts:871-878), so `xm` must not be listed at all — only then does the
//      probe answer `model-missing`;
//   2. `planRemoteModelFallback` picks `available.find(same provider) ?? available[0]`
//      (remote.ts:975-977), so the listing must contain EXACTLY ONE row and it must be
//      served by the mock — otherwise the fallback lands on a real model and the gate
//      stops being reproducible.
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
		provider: XM_PROVIDER,
		hostProviders: true,
		models: [XM_MODEL_ID],
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--base") out.base = argv[++i] ?? "";
		else if (arg === "--out") out.out = argv[++i] ?? "";
		else if (arg === "--base-url") out.baseUrl = argv[++i] ?? "";
		else if (arg === "--models") out.models = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
		else if (arg === "--provider") out.provider = String(argv[++i] ?? "").trim();
		else if (arg === "--no-host-providers") out.hostProviders = false;
		else fail(`unknown arg '${arg}'`);
	}
	if (!out.out) fail("--out is required");
	if (!out.baseUrl) fail("--base-url is required");
	if (out.provider.length === 0) fail("--provider must not be empty");
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

// F6: never copy a credential out of the host's models.json. Everything this file
// contains is read by two throwaway containers and lives in /tmp, so any host `apiKey`
// is dropped here. It is not needed: real credentials come from auth.json, which is
// mounted read-only and never copied.
//
// The generated `xm` provider is the ONE exception and it is not a credential: its
// value is the literal "mock". pi HIDES a provider that has no apiKey at all
// (verified on pi 1.5.0: `pi --list-models` answers "No models available"), so the
// dummy is what makes the mock visible — not a secret.
let strippedApiKeys = 0;
for (const [name, value] of Object.entries(providers)) {
	if (name === args.provider) continue;
	if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
	if (!("apiKey" in value)) continue;
	const next = { ...value };
	delete next.apiKey;
	providers[name] = next;
	strippedApiKeys += 1;
}

if (!args.hostProviders) {
	// The fallback scenario wants a listing with ONE row: the host's real providers
	// would otherwise sit in front of it and become the fallback pick.
	for (const name of Object.keys(providers)) delete providers[name];
}
providers[args.provider] = {
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
	`XM_MODELS_WRITTEN out=${args.out} providers=${Object.keys(providers).sort().join(",") || "-"} provider=${args.provider} host_providers=${args.hostProviders ? "yes" : "no"} baseUrl=${args.baseUrl} models=${args.models.join(",")} stripped_api_keys=${strippedApiKeys}\n`,
);
