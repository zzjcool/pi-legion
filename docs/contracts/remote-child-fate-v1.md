# Remote child fate v1 — a cross-machine launch that produced no transcript must say WHY

> Status: frozen for `feat/remote-child-diag`. Supersedes nothing; extends
> `cross-machine-spawn-v1` (S4/D15 read-back, S5.6 startup probe, D6 pathMap).
> Regression target: `subagent({agent:"worker", host:"hw-nj"})` returned
> `execution: unknown (no messages in session)` + `read-back … FAILED — not_found`
> with **no** stderr, **no** exit code and no next step.

## 0. The bug this contract exists for (facts, 6.1.1)

1. A remote child's stdout/stderr/exit code are **never** read. `terminal.run`
   returns facts only; the parent never calls anything that could carry the
   child's own words. `SettleResult.exitCode` is obtained by `waitSettled` and
   then **dropped** by `Orchestrator.settleDisposition` (`orchestrator.ts:3228`).
2. The only result carrier is `<remoteDir>/session.jsonl`. When the child dies
   during startup that file never appears, so the parent has exactly one
   observable: "not found".
3. Measured on pi 1.5.2 (this is the mechanism, not a guess):
   - `node cli.js -ne -e /missing/index.ts -p ok` → **exit 1**,
     `Error: Failed to load extension "/missing/index.ts": Extension path does not exist`.
   - `node cli.js -ne --session /tmp/x/session.jsonl -p ok` with no usable model
     → **exit 1**, `No API key found…`, and `session.jsonl` is **never created**.
   So "no transcript + no `/tmp/X.txt`" == the child died during startup, and
   the reason was always in a word the parent structurally threw away.
4. `read-back … no-run/<name>/session.jsonl` is **not** a symptom: production
   `index.ts:1614` builds `new TerminalSupervisor()` with no `runId`, so
   `remoteDirFor(target, undefined, name)` always yields `…/no-run/<name>`.
   Launch and read-back therefore agree; `no-run` proves nothing.

## 1. Non-goals (deliberate, with the reason)

- **No "drop it and carry on", and no basename guessing.** v1.2 (already on
  master) re-anchors an extension by **package name** and REFUSES the launch when
  the package is not installed there or its entry differs
  (`mapRemoteArgv` / `HostPackageIndex`). This contract does not add a fallback
  beside it: the only new pre-launch fact is that an explicitly configured
  `hosts.<host>.piExtensions` path must exist on that machine (§3).
- **No new hc method.** Only `terminal.get`, `terminal.run`, `machine.exec`,
  `file.read`, `file.write` are used.
- **No hard failure for "still alive but has not written yet"** — a slow machine
  is not a bug. Only *proven* death fails a launch (§4).

## 2. The one new seam: `probeRemoteChild`

New, in `src/runs/remote.ts`:

```ts
export type RemoteFateClass = "started" | "no-child" | "no-session" | "path";

export interface RemoteChildFate {
	kind: RemoteFateClass;
	host: string;
	/** `host/name` exactly as the launch addressed it. */
	terminal: string;
	/** `live` | `running` | `idle` | `finished` | `missing` (= the core does not know it). */
	terminalState: string;
	exitCode?: number;
	/** Last non-empty lines the child's terminal rendered (its own stderr/stdout). At most 6. */
	screenTail: string[];
	sessionPath: string;
	dir: string;
	dirExists: boolean;
	sessionExists: boolean;
	/** At most 12 lines of the remote dir listing. */
	dirLines: string[];
	/** One sentence, no trailing period. What this class means. */
	summary: string;
	/** One sentence, actionable. Never empty. */
	nextStep: string;
}

export async function probeRemoteChild(opts: {
	client: HcClient;
	target: HostTarget;
	terminal: string;          // "host/name"
	sessionPath: string;
	/** The record's persisted mirror dir, when it differs from dirname(sessionPath). */
	recordedDir?: string;
}): Promise<RemoteChildFate>;
```

Behaviour:

- `dir = path.posix.dirname(sessionPath)`.
- **Two round trips, both already in the whitelist**: `terminal.get` (state,
  `exit_code`, `screen`) and ONE `machine.exec` that prints prefixed evidence
  lines (`dir=1|0`, `session=1|0`, `entry=<ls line>`, ≤12). `terminal.get`
  throwing `not_found` ⇒ `terminalState = "missing"`, never an error.
- Classification, in this order (first match wins):
  1. `sessionExists` → `started`.
  2. `recordedDir` set and ≠ `dir` → `path`.
  3. `terminalState === "finished"` **or** `exitCode !== undefined` **or**
     (`terminalState === "missing"` **and the address was not inferred**) → `no-child`.
  4. otherwise → `no-session`.
- **Death is a claim about the ADDRESS, never about a guess.** A record written
  before `remoteTerminal` existed makes the read-back recompute
  `host/lgl-<name>`, and a run-scoped launch holds `host/lgl-<runid8>-<name>`;
  `not_found` for that invented name proves nothing. So `probeRemoteChild` takes
  `terminalInferred?: boolean`, and with it a `missing` terminal cannot become
  `no-child` (it falls to `no-session`, and the evidence says the name was
  inferred). The start-up gate always holds the address the core returned, so
  this only ever weakens a guess.
- `probeRemoteChild` **propagates** a transport failure of `machine.exec` only
  (callers turn that into `fate: "unreachable"`). It never invents a class it
  cannot support.
- Anchor sentences (frozen, tests match on them):

| kind | `summary` | `nextStep` |
|---|---|---|
| `no-child` | `the child's terminal ended before it wrote a transcript` | `run the command below on that machine: the child's own error is on its terminal, and pi exits before its first turn when a --extension / --model is not usable there` |
| `no-session` | `the child's terminal is alive but has written no transcript yet` | `collect after it reaches a turn, or \`status\` for liveness — a live terminal with no transcript is not a verdict` |
| `path` | `the record and this configuration disagree about the mirror dir` | `the transcript may have landed in the recorded dir; fix \`subagents.crossMachine.hosts.<host>.cwd\`/\`worktreeRoot\`, or retire and relaunch the child` |
| `started` | `the transcript exists on that machine` | `—` |

## 3. Before the terminal exists: `piExtensions` must exist THERE

`remotePreflightScript` (`src/runs/remote.ts`) gains **exit 17**: for every
`target.piExtensions` entry, `test -e <entry>`; the first missing one prints its
path to stderr and exits 17. `remotePreflight` maps 17 to

```
host '<host>': piExtensions entry '<entry>' does not exist on that machine
(subagents.crossMachine.hosts.<host>.piExtensions is read ON <host>; the child's
argv loads it with --extension, so a missing file makes pi exit 1 before its
first turn)
```

with `ErrorCodes.INVALID_PARAMS` and details `{ host, missingExtension }`.

That check composes with v1.2 and does not duplicate it: v1.2 answers "the same
package lives somewhere else on that machine", exit 17 answers "the path written
down is simply not there". Neither one drops anything from argv.

`ChildRecord` gains `remoteTerminal?: string` (the address `host/mappedName` the
core actually holds, so a later process can ask about it without recomputing a
name that may have been shortened).

## 4. After `terminal.run`: proof of death, not a guess

In `TerminalSupervisor.spawnChild`, remote launches only, once `run.address` is
known:

- `REMOTE_STARTUP_CONFIRM_MS = 8_000`, poll interval 500 ms, plus
  `TerminalSupervisorOptions.remoteStartupConfirmMs` (`0` = gate disabled; the
  fake-core harnesses pass `0` so their launches stay instant).
- Each poll: `file.read {limit: 0}` on `<remoteDir>/session.jsonl` ⇒ exists ⇒
  confirmed, done. `terminal.get` ⇒ `state === "finished"` or a numeric
  `exit_code` ⇒ **proven death**: throw `START_FAILED` (§4.1). Deadline without
  either ⇒ **warn on stderr and launch anyway**, recording
  `startupUnconfirmed: true` on the record (`ChildHandle.startupUnconfirmed`).
- A remote launch whose gate is disabled behaves exactly as today.

### 4.1 The launch error (frozen)

```
host '<host>': the child did not survive startup — its terminal ended before it wrote <sessionPath>
  exit: <code|the core reported none>
  dir: <dirExists ? "the mirror dir is there" : "the mirror dir is gone"> (<dir>)
  screen: <screenTail joined by " ⏎ " | "(the core reported none)">
  next: <nextStep>
  Command (run on '<host>' to reproduce):
<remoteStartupProbeLine(argv, cwd)>
```

Same shape, `START_FAILED`, details `{ host, fate: "no-child", exitCode }`.

## 5. Read-back failure carries the class (no more bare `not_found`)

`RemoteReadbackFailure` (`src/runs/remote-artifact.ts`) gains three fields —
`fate`, `evidence`, `nextStep`; `reason` keeps the raw core text:

```ts
export interface RemoteReadbackFailure {
	ok: false;
	host: string;
	reason: string;
	/** `started` never appears here: a failure is one of these four. */
	fate: "no-child" | "no-session" | "path" | "unreachable";
	/** 1..5 short lines ("terminal finished", "exit 1", "dir holds: system-prompt.md"). */
	evidence: string[];
	nextStep: string;
}
```

- `fate: "unreachable"` covers what cannot be classified: `resolveHostTarget`
  refused, the hc core did not start, or `probeRemoteChild`'s `machine.exec`
  rejected. `nextStep` then names the config key or the connection.
- `RemoteSessionRequest` gains `remoteTerminal?: string` (the record's
  `remoteTerminal`; falls back to `terminalName(undefined, name)`, the same
  convention `assertRemoteResume` already uses).
- `started` — i.e. the file is there — cannot be a failure: if
  `probeRemoteChild` says `started` while `file.read` failed, the read-back
  becomes `fate: "path"` with the reason preserved (the file exists but the
  bytes came back wrong).

Plumbing (mechanical, no new semantics): `RemoteReadbackFailure` → 
`CollectResult.remoteReadback` gains `fate?`, `evidence?: string[]`,
`nextStep?: string`; `readbackFacts()` copies them; `cachedCollect` keeps
dropping read-back facts (unchanged).

## 6. Render (frozen text, `index.ts:renderCollect`)

1. Read-back failure — the old prefix is preserved so existing assertions and
   operator habits survive:

```
read-back from host '<host>': FAILED (<fate>) — <reason> (the verdict below rests on no transcript at all)
  evidence: <evidence joined by "; ">
  screen: <screenTail joined by " ⏎ ">          # only when the fate carries one
  next: <nextStep>
```

2. The execution line must never leave `unknown` unexplained. When
   `remoteReadback.fate` is set, append ` · read-back: <fate>`:

```
execution: unknown (no messages in session) · read-back: no-child
```

There is no third line to render: v1.2 never hands the child a reduced
extension set, so "the child quietly lost a provider" is not a state this
product can be in.

## 7. Acceptance (what the tests must prove)

| # | scenario | observable |
|---|---|---|
| T1 | normal remote child writes its transcript | launch ok, `read-back … N of N lines (complete)`, no `read-back:` suffix on `execution` |
| T2 | child dies at startup (terminal `finished`, `exit_code 1`, screen has pi's `Error:`) | **launch** throws `START_FAILED` naming the exit code and the screen line; `terminal.run` was reached |
| T3 | child alive, no transcript | read-back `FAILED (no-session)` + `next:` line; `execution: … · read-back: no-session` |
| T4 | record's `remoteDir` disagrees with the configuration | read-back `FAILED (path)` naming both dirs |
| T5 | `piExtensions` entry missing on the target | preflight exit 17, actionable message, `terminal.run` never called |
| T6 | an extension no `pathMap`/package rule can reach | the launch is REFUSED before `terminal.run` (v1.2), naming the path and the `pathMap` key |

Everything above is exercised through `test/helpers/fake-hc-core.mjs`; the
manifest that makes a fake terminal die / stay silent / write files is
`FAKE_HC_TERMINALS` (JSON), applied at `terminal.run`:

```json
{ "lgl-worker-0": { "state": "finished", "exit_code": 1,
                    "screen": "Error: Failed to load extension …",
                    "writes": [{ "path": "<ABS UNDER REMOTE_ROOT>/session.jsonl", "text": "…" }] } }
```

Absent manifest entry = today's behaviour (a terminal that runs and writes
nothing), so every existing fake-core test keeps its meaning.
