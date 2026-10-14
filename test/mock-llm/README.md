# Mock LLM for pi-legion

Deterministic OpenAI-compatible endpoint so legion tests and local smoke runs
can drive `pi` / RPC children **without real API keys or quota**.

Pi discovers it the same way as Ollama / vLLM: a provider block in
`models.json` with `api: "openai-completions"` and a local `baseUrl`
([pi models docs](https://pi.dev/docs/latest/models)).

## Quick start

```bash
# from repo root
npm run mock-llm
# → mock-llm listening on http://127.0.0.1:8765/v1 scenario=echo
```

In another shell, point an isolated agent dir at it (do **not** paste real keys):

```bash
node --experimental-strip-types -e '
import { writeMockPiHome, startMockLlm } from "./test/mock-llm/index.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "mock-pi-"));
// If the server is already up on 8765:
writeMockPiHome({ dir, baseUrl: "http://127.0.0.1:8765/v1" });
console.log(dir);
'

export PI_CODING_AGENT_DIR=/path/from/above
export PI_OFFLINE=1
pi --print --provider mock --model flash --thinking off \
  "MOCK_SAY: hello from mock"
```

Or use the snippet below in `~/.pi/agent/models.json` (dummy `apiKey` only):

```json
{
  "providers": {
    "mock": {
      "baseUrl": "http://127.0.0.1:8765/v1",
      "api": "openai-completions",
      "apiKey": "mock",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": true,
        "supportsFinishReason": true
      },
      "models": [
        {
          "id": "flash",
          "name": "Mock Flash",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32000,
          "maxTokens": 2048,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Then `settings.json`: `"defaultProvider": "mock"`, `"defaultModel": "flash"`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` or `/v1/health` | liveness |
| GET | `/v1/models` | model list |
| POST | `/v1/chat/completions` | streaming (default) or JSON completions |

## Scenarios

| Name | Behaviour |
| --- | --- |
| `echo` (default) | Reply `MOCK_OK`; after tool results echo tool content |
| `tool-once` | One tool call (`MOCK_TOOL_NAME` / `MOCK_TOOL_ARGS`), then echo — docker legacy |
| `spawn-scout` | Call `subagent` with a scout task, then settle |
| `child-done` | Role-aware leaf reply (`scout` / `worker` / …) with verdict JSON |
| `doctor` | Call `subagent({ action: "diagnose" })`, then settle |
| `stop-all` | Call `subagent({ action: "stop", all: true })`, then settle |
| `declare-verify` | Declare acceptance passed in text |
| `script` | Load rules from `--script` / `MOCK_LLM_SCRIPT` JSON |
| _(example)_ | `examples/scout-guard-streak.json` — N read tool_calls then settle (#108 e2e) |

```bash
MOCK_LLM_SCENARIO=spawn-scout npm run mock-llm
npm run mock-llm -- --scenario doctor
npm run mock-llm -- --script test/mock-llm/examples/custom.json
```


Scout-guard regression (#108) lives in `test/integration/mock-llm-scout-guard-e2e.test.ts` (picked up by `npm run test:mock-llm`): mock scripts N consecutive read-class tool_calls; light extension harness asserts one `scout-guard-notify` followUp, dispatch clear, and cooldown.

Per-request override: header `x-mock-scenario: child-done` or
`?scenario=child-done` on the chat URL.

## Inline directives (any scenario)

Put these in the **latest user** message:

- `MOCK_SAY: exact reply text` — assistant returns that text (no tools).
- `MOCK_TOOL: bash | {"command":"pwd"}` — assistant issues that tool call once.
- `MOCK_TOOL: subagent | {"action":"diagnose"}` — same for legion tools.

After a tool result turn, built-in scenarios typically echo or settle; custom
scripts should include a `when: { hasToolResult: true }` rule.

## Custom script JSON

```json
{
  "models": [{ "id": "flash", "name": "Mock Flash" }],
  "rules": [
    {
      "name": "after-tool",
      "when": { "hasToolResult": true },
      "then": { "type": "text", "content": "{{lastToolContent}}" }
    },
    {
      "name": "by-role",
      "when": { "role": "scout", "turnIndex": 0 },
      "then": { "type": "text", "content": "scout mock ok" }
    },
    {
      "name": "default",
      "then": { "type": "text", "content": "MOCK_OK" }
    }
  ]
}
```

`when` fields: `hasToolResult`, `turnIndex`, `promptIncludes`, `promptMatches`,
`model`, `role`, `scenario`. First match wins. Templates in text:
`{{lastToolContent}}`, `{{role}}`, `{{model}}`, `{{scenario}}`, `{{turnIndex}}`.

## Legion e2e suite

`npm run test:mock-llm` also runs:

- `test/integration/mock-llm-pi-smoke.test.ts` — `pi --print` against the mock
- `test/integration/railway-mock-e2e.test.ts` — spawn connectors + lockstep scroll
- `test/integration/mock-llm-legion-e2e.test.ts` — stop one/all + idle Esc, idle hint,
  auto-doctor on model-miss / memory refuse, verify concurrency ≤ 2

## Library API

```ts
import {
  startMockLlm,
  writeMockPiHome,
  mockPiEnv,
  resolveScenario,
} from "./test/mock-llm/index.ts";

const mock = await startMockLlm({ scenario: "echo", port: 0 });
const home = writeMockPiHome({
  dir: "/tmp/mock-pi-home",
  baseUrl: mock.baseUrl,
  packages: ["/path/to/pi-legion"],
});
// spawn pi with env: mockPiEnv(home.agentDir)
await mock.close();
```

## Env reference

| Env | Default | Meaning |
| --- | --- | --- |
| `MOCK_LLM_PORT` | `8765` (CLI) | listen port; library default `0` = ephemeral |
| `MOCK_LLM_HOST` | `127.0.0.1` | bind address |
| `MOCK_LLM_SCENARIO` | `echo` | built-in scenario |
| `MOCK_LLM_SCRIPT` | — | path to script JSON |
| `MOCK_LLM_LOG` | — | append-only request log |
| `MOCK_TOOL_NAME` | `bash` | `tool-once` tool name |
| `MOCK_TOOL_ARGS` | `{"command":"pwd"}` | `tool-once` arguments JSON |

## Security

- Dummy `apiKey` is always the literal `mock`.
- `writeMockPiHome` never copies host `auth.json`.
- Do not commit real provider credentials into scripts or examples.
