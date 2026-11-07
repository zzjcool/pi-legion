# centurion terminal backend v1 (frozen contract)

Status: **frozen** · scope: centurion only · host: `hc` (herdr-core) only

## Why

herdr-app's agents sidebar lists only terminals whose program reports status
(OSC 7501 `app`). Today a centurion holding a worktree is a headless
`pi --mode rpc` child: it can never appear there, and a person cannot attach to
it. A terminal-hosted centurion is a real `pi` TUI inside `hc`, so it shows up in
the window, can be attached, and can be interrupted without losing its context.

Worktree **creation stays with pi-legion** (`src/runs/worktree.ts`), because it
already enforces timeout guards, unique branches and post-admission creation.
This backend only replaces the *transport* for the one role that holds a worktree.

## Decisions

- **D1 Scope.** Only `agent.name === "centurion"` and only when the worktree
  arbitration yields `worktree === true`. Workers, scouts, vexillatio, utility
  children and every non-centurion role keep today's behaviour exactly.
- **D2 Host detection.** `terminalHostAvailable(env)` is true iff both
  `HC_TERMINAL_SOCKET` and `HC_TERMINAL_ID` are non-empty. No subprocess, no
  socket probe, no git call. Missing either ⇒ arbitration is byte-identical to
  today (`worktree === true ? "rpc" : "inprocess"`).
- **D3 Transport.** Talk JSON-RPC (newline-delimited, `jsonrpc: "2.0"`) to the
  core by spawning `hc connect` as a child process. The CLI is NOT used for
  spawning because `hc run` exposes no `--env`, while the `terminal.run` method
  accepts `env`, `labels`, `cwd`, `name`, `argv` (verified against
  `hc schema`). The executable resolves as `HC_BIN` → first `hc` on `PATH` →
  `~/.local/bin/hc` → bare `hc`: the installer's location is not on `PATH`
  inside an hc terminal (measured: its PATH is only `/usr/local/bin:/usr/bin`).
- **D4 Spawn argv.** Reuse `buildPiArgs({...input, includeTask: false})` so
  `--session`, `--model`/`--provider`, `--tools`, `--no-extensions`, every
  inherited `-e`, `--skill`/`--no-skills`, `--no-context-files` and
  `--system-prompt <file>` are identical to the rpc backend. Then append the
  task as one positional argv element: `formatChildTask(task, {allowNested,
  worktreeBranch})`. Rationale: verified in the spike that a positional message
  starts turn 1 in a TUI; `--session <absolute sessionFile>` (already
  pre-created 0600 by the orchestrator) is what keeps `resolveLegionIdentity`
  valid. The inherited `-e` set **must include provider extensions**: without
  them `pi` starts with no model (status bar `0.0%/0`) and never takes a turn.
- **D5 Env.** `terminal.run` merges `env` over the core's environment. Pass:
  `PATH` (from `process.env.PATH` — the core's is only
  `/usr/local/bin:/usr/bin` and has no `node`), `HOME`, and
  `TERM`/`TERM_PROGRAM`/`COLORTERM` from the parent when present; then
  `childMemoryEnv()`; then `input.env` (lineage, legion identity, phases,
  budgets) last so nothing overwrites it.
- **D6 Visibility.** Copy the parent terminal's `herdr.space` label (read once
  per supervisor from `terminal.get($HC_TERMINAL_ID)` and cached) so the child
  appears in the same space as its parent. Add `legion.role=centurion`. **v1
  omits `legion.run`**: no run id exists when the supervisor is constructed and
  `SpawnInput` carries none, while a path-derived id would name the *parent*
  run — a fabricated fact this contract forbids. Do NOT copy `herdr.tab` (each
  child gets its own tab).
- **D7 Terminal name.** `hc` requires 1–32 chars of `[a-z0-9_-]`, unique among
  live terminals. Map `<runId>-<handle>` to `lgl-<runId8>-<sanitized handle>`,
  saniting every other char to `-`, truncating the handle so the total is ≤ 32.
  The mapping is stored on the backend's per-child record; it is the only name
  used for later `send`/`wait`/`interrupt`/`kill`/`rm`.
- **D8 Settle.** `waitSettled` polls `terminal.get` (short interval, bounded by
  `timeoutMs`): settled when `turn > promptTurn` **and**
  `status.state === "done"`, or when `state === "finished"`. A boot-time
  `turn === promptTurn, status idle` must NEVER count as settled — the spike
  showed `hc wait` returns exactly that at startup. Timeout returns
  `{settled: false, reason: "timeout"}`; it must not throw and must not kill.
  `promptTurn` is recorded before each `terminal.send` and refreshed from the
  last observed turn.
- **D9 Verdict.** Unchanged: `collect` keeps reading
  `parseSessionFile(child.sessionFile).lastTurnOutput`. A human interjection in
  the terminal opens an extra turn, so the verdict may degrade to `unknown` —
  an honest `unknown`, never a fabricated accept. v1 does not re-scope the
  transcript by turn index.
- **D10 Steer / abort.** `steer` = `terminal.send` (the child queues it at its
  turn boundary; verified in the spike). `abort` = `terminal.interrupt` (Esc:
  keeps the process, its context and its turn counter). `clearQueued` is NOT
  supported and must not be claimed: return the documented
  `{status: "interrupted"}` shape and declare `capabilities.promptDisposition
  = false`.
- **D11 Retire.** `terminal.kill`, then `terminal.rm` best-effort (a killed
  terminal otherwise stays in `hc ls --all` forever). Never throw from the `rm`
  path.
- **D12 No events.** v1 does not feed `subscribeSupervisorEvents`. Omit
  `inFlightTool`, `inFlightToolStack` and `lastEventAt` instead of inventing
  facts (absence = no claim; the stall detector must stay silent).
- **D13 No card field.** `spawnMode` stays forbidden in agent frontmatter
  (#290). `"terminal"` is reachable only through this arbitration.

## Invariants

- **I1** With `HC_TERMINAL_SOCKET`/`HC_TERMINAL_ID` absent, behaviour is
  unchanged. `test/unit/worktree-centurion-only.test.ts`,
  `test/unit/launch-worktree-probe.test.ts`,
  `test/unit/spawn-mode-arbitration.test.ts`, `test/unit/teams.test.ts` stay
  untouched and green.
- **I2** `src/runs/worktree.ts` is not edited. Worktree creation, bootstrap and
  cleanup semantics are unchanged.
- **I3** No new git subprocess on the launch path; the probe count asserted by
  `launch-worktree-probe.test.ts` must not change.
- **I4** `SPAWN_MODES` gains `"terminal"`. Every exhaustive switch/map over
  `SpawnMode` must handle it (typecheck is the gate); the only permitted
  behaviour there is displaying the new literal.
- **I5** `inprocess` stays the default for everything else; a centurion outside
  `hc` still runs on `rpc`.
- **I6** legion-v2-contract §9 (REV-17) semantics survive: centurion is the
  only role that can hold a worktree; the backend name changes, not the owner.

## Files

Create:

- `src/hc/client.ts` — JSON-RPC client over `hc connect` (spawn, `hello`,
  request/response with ids, per-call timeout, `close()`); method allowlist as
  string literals; no shell interpolation anywhere.
- `src/supervisor/terminal-supervisor.ts` — `LegionSupervisor` implementation
  plus `terminalHostAvailable(env)` and the name mapping.
- `test/unit/terminal-supervisor.test.ts` — fake client: argv/env/labels
  construction, name mapping, settle turn-gating (idle at promptTurn must not
  settle), abort → interrupt, retire → kill+rm, timeout shape.
- `test/unit/terminal-arbitration.test.ts` — with HC env: centurion+worktree ⇒
  `terminal`; without: `rpc`; non-centurion unchanged; inprocess default
  unchanged.

Modify (and nothing else):

- `src/shared/types.ts` — `SPAWN_MODES` literal list.
- `src/runs/orchestrator.ts` — the single arbitration line, plus backend wiring
  through the existing `LegionSupervisor` deps.
- `src/supervisor/routing-supervisor.ts` — third backend, owner map, `backendFor`,
  spawn guard (`terminal` + worktree allowed; `inprocess` + worktree still
  throws with the frozen message).
- `index.ts` — construct the terminal supervisor and inject it; no behaviour
  change when the host is not `hc`.
- Any file the typechecker flags for a non-exhaustive `SpawnMode` switch — add
  the literal only.

## Acceptance

- `npm run typecheck` green.
- `npm test` green with the four frozen test files unmodified.
- New tests prove D2, D4, D5, D6, D7, D8, D10, D11.
- No new git invocation in the launch path (I3).

## Amendments recorded while landing v1

None of these changes a decision above.

- **Test hosts are hermetic.** `package.json`'s `test*` scripts sanitize
  `HC_TERMINAL_SOCKET`/`HC_TERMINAL_ID` alongside the existing `PI_SUBAGENT_*`
  list. Without it, running the suite inside an hc terminal flips the four
  frozen `worktree ⇒ rpc` tests for a reason that is not about them. The new
  `terminal-arbitration` tests set the markers explicitly.
- **`stripLegionIdentity` is unreachable here.** `terminal.run`'s `env` is an
  overlay with no delete semantics; the only caller that strips identity is
  vexillatio, which can never be a centurion, so the arbitration never reaches
  this backend with it.
- **No memory gate.** `RpcSupervisor` runs `checkMemoryGate` before spawning;
  this backend does not (one centurion per run, and no `onSpawnRefused`
  wiring). Add it if a future revision lets several centurions share a host.
- **Name collisions.** A live terminal holding the mapped name yields
  `NAME_TAKEN`; a *finished* one is `rm`-ed and retried once. Resume after a
  parent exit lands in the second case because `die_with_parent` already ended
  the old terminal.

## Non-goals (v1)

Worker/scout visibility, herdr 0.9.5 support, `herdr worktree` adoption,
event streaming into the parent TUI, blocked-tool forwarding, transcript
re-scoping per prompt, `--outlive-parent` survival.
