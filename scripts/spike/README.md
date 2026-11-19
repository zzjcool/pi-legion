# scripts/spike — throwaway experiment rig for issue #417

**Delete this entire directory once the hold implementation lands.** Nothing here is product
code, nothing imports it, and it is not in any `npm test` glob.

It exists to answer one question with measurements instead of guesses: *can legion borrow
pi-async's settle hold (`agent_before_settle`)?* The answers and the raw evidence are in
[`docs/reports/hold-spike.md`](../../docs/reports/hold-spike.md).

## What it does

Boots the **real** `pi` host in `--print` mode against a mock provider, with one or two
throwaway extensions registered on `agent_before_settle`:

```
scripts/spike/logged-mock.ts   mock OpenAI endpoint; logs every request's message blob so we can
                               time when an injected message actually reaches the model
scripts/spike/hold-common.ts   the registrant body, driven entirely by env vars
scripts/spike/ext-a.ts         registrant A  (separate pi extension)
scripts/spike/ext-b.ts         registrant B  (separate pi extension)
scripts/spike/run.ts           case driver; artifacts land in /tmp/hold-spike/<case>/
```

Each case leaves `spike.jsonl` (extension observations), `mock.jsonl` (provider requests),
`session.jsonl` (the transcript) and `summary.json` behind, so every number in the report can be
checked against a raw file.

## Run it

`node` is not on the default PATH here:

```sh
export PATH=/root/.nvm/versions/node/v24.13.1/bin:$PATH
node --experimental-strip-types scripts/spike/run.ts --list          # all cases + what they probe
node --experimental-strip-types scripts/spike/run.ts 1a-a-only       # one case
node --experimental-strip-types scripts/spike/run.ts 2a-hold-blind 2d-control-no-hold
SPIKE_OUT=/tmp/hold-spike/r2 node --experimental-strip-types scripts/spike/run.ts 2a-hold-blind
```

Requires `pi` on PATH (this rig was measured against `pi 1.5.2`).

## Knobs (per registrant, `<ID>` is `A` or `B`)

| env | meaning |
|---|---|
| `SPIKE_<ID>_ITERS` | how many boundary invocations to hold (0 = observe only) |
| `SPIKE_<ID>_HOLD_MS` | how long one hold waits before releasing |
| `SPIKE_<ID>_MODE` | `spread` (default) · `replace` (bare list, drops earlier drafts) · `none` (bare `continue:true`) · `veto` (`continue:false`) |
| `SPIKE_<ID>_WATCH` | `""` · `pending` (poll `ctx.hasPendingMessages()`) · `signal` (race `ctx.signal`) |
| `SPIKE_<ID>_SEND_AT_MS` | ms after `agent_start` to send a message (arms the send) |
| `SPIKE_<ID>_SEND_TEXT` / `_SEND_AS` / `_SEND_KIND` | payload, `deliverAs`, `custom` \| `user` |
| `SPIKE_<ID>_ABORT_AT_MS` | ms after `agent_start` to call `ctx.abort()` |
| `SPIKE_LOG` | JSONL path (set by the driver) |
| `SPIKE_PI_ASYNC` | optional 3rd `--extension` path, e.g. a real pi-async checkout |
| `SPIKE_OUT` | artifact root, default `/tmp/hold-spike` |

## Two traps encoded here (they cost real time)

1. **Do not reset a budget on `agent_start`.** A boundary continuation starts a whole new agent
   run, so `agent_start` fires again on every hop; a per-run counter reset there can never be
   exhausted (observed: 278 hops in 60 s). `hold-common.ts` deliberately keeps `fires` across runs
   and tracks `runStarts` separately.
2. **`ctx.hasPendingMessages()` is blind to `custom_message` sends.** It reads the session queues
   (`agent-session.js:2056/2922`), while a followUp `custom_message` lands in the agent queue that
   `event.context.pendingMessages` exposes. Use `SEND_KIND=user` to exercise the visible path.
