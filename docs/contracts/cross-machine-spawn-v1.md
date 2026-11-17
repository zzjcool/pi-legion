# cross-machine spawn v1 (frozen contract)

Status: **frozen** · scope: terminal backend + hc only · landed: S0 · in progress: S1 · pending: S2–S5

## Why

Every launch in this package assumes one machine: the worktree is created here,
the child's `argv` carries three parent-absolute paths, and the verdict comes
back from a session file this process can `stat`. `hc` already has the transport
for the step in between — `terminal.run{on}` runs a terminal on another machine
and forwards it through the local core — so the missing piece is a *name* for
the target machine plus the honesty about what does NOT survive the hop.

The single hardest fact this contract records: a remote child is delivered
through the **shared git remote**, not through a filesystem. Anything that
treats a remote worktree path as a local path is the one failure in this design
that destroys data instead of failing loudly.

## Decisions

- **D1 Scope.** A `host` is honored only by the `terminal` backend on an `hc`
  host. `host` on an `rpc`/`inprocess` launch is **refused** with
  `INVALID_PARAMS`, never silently ignored: those backends have no way to reach
  another machine, and a child that ran locally while the caller believed it ran
  remotely is the worst possible answer.
- **D2 Naming.** Legion speaks `host` end to end (frontmatter, tool params,
  `LaunchInput`, `SpawnInput`, `ChildRecord`, `nodes`). The `hc` wire parameter
  is `on`, and the mapping exists in exactly ONE place — the params construction
  in `src/supervisor/terminal-supervisor.ts`. `machine` is already the phase
  machine (`machineForRole`, `PhaseMachine`, `legion_phase`) and must not be
  reused for a hostname; `grep 'on: host' src/` must return exactly one hit.
- **D3 Transport.** Still one local `hc connect`; the local core forwards `on`
  to the remote core. No new socket, no ssh invocation of our own, no listening
  port, no background daemon. `hc connect` cannot attach to a remote core
  directly, and this contract does not try to make it.
- **D4 Absent = local.** `host` missing, `""` or whitespace-only ⇒ the params
  carry NO `on` key and the launch is byte-identical to the pre-contract one.
  `normalizeHost()` in `src/runs/remote.ts` is the only definition of "absent":
  every other site reads its result, never re-decides.
- **D5 Old records.** A missing host field on `nodes` / `ChildRecord` /
  `run.json` is interpreted as **this host**, so old runs resume exactly as
  before. Nothing backfills; `host IS NULL` is a legal, permanent spelling of
  "local".
- **D6 Remote argv.** A remote launch must rewrite the three parent-absolute
  paths in the child's `argv`: `process.execPath`, `--system-prompt <file>` and
  `--session <path>`. If any of them cannot be rewritten, the launch is refused
  — sending a parent path to another machine produces `hc`'s least informative
  error (`cannot start "pi": No such file or directory`) or, worse, a session
  file on the wrong machine.
- **D7 Remote env.** A remote `env` contains only `childMemoryEnv()` +
  `input.env`. The parent's `PATH`/`HOME`/`TERM*` are NOT projected (the remote
  core's login environment is the correct one there). Legion identity keys are
  not sent at all, and the launch is refused if the remote core already carries
  them — `terminal.run`'s `env` is an overlay with no delete semantics.
- **D8 Remote labels.** A remote terminal carries `legion.role`, `legion.run`
  and `legion.host`. It does NOT copy `herdr.space`: a bare space id belongs to
  the parent's document and would only create an orphan label on the remote.
  Placing a remote terminal into a remote space is a non-goal.
- **D9 Two temp dirs.** The parent `tempDir` stays where it is — it is the
  parent's cleanup right (`TEMP_OWNER_FILE`) and is never migrated. Files that
  `argv` points at are mirrored to a `remoteTempDir` with `file.write{on}`; the
  path is recorded so `legion-doctor` can list it, and `retire` does not delete
  it.
- **D10 Delivery = git remote.** The only materialization channel across
  machines is a push to a common `origin`. No common origin, or no checkout at
  the configured remote path ⇒ fail before spawning, naming both origins.
- **D11 Remote worktree.** The remote tree is created by a REMOTE
  `git worktree add -b` through `machine.exec` (timeout ≤ 120 s, the existing
  local budget). Delivery and integration are git's job; no filesystem is
  copied between machines.
- **D12 Branch namespace.** Cross-machine branches are
  `pi-subagent/<host>/<name>-<nonce8>`; local branch names are unchanged, so no
  existing run's MR changes.
- **D13 Ownership pair.** Worktree ownership is the pair `(host, path)`. Every
  local `fs`/`git` probe or mutation first passes `assertLocalWorktree()`; a
  non-empty `worktreeHost` with a path throws `INVALID_PARAMS` naming both. There
  is no downgrade path: a remote path that happens to exist locally means
  something else here.
- **D14 Remote verify.** Remote verification runs through `machine.exec`;
  `hc`'s 600 s ceiling is clamped explicitly and announced in the log header.
  Failures are strictly classified as `code` / `timeout` / `unreachable` /
  `unknown-host`, and `unreachable` is never recorded as a failed verification.
  Slot queuing stays on the parent.
- **D15 Product recall.** A remote child's verdict and artifacts are read back
  with `wc -l` + `file.read{offset,limit}` (≤ 8 MB per read); the on-disk layout
  on the parent does not change. For a remote child the local session JSONL is
  no longer the verdict source — the parent keeps a mirror instead, and an
  unreadable tail degrades to an honest `unknown`.
- **D16 Remote subtree is opaque.** A remote centurion's nested team runs in ITS
  own `.pi-subagents` / `legion.db`. The parent ledger holds one node row;
  `legion_mail` and the upward MR tree do not cross machines. This is a stated
  degradation, not a defect to "fix" later in v1.
- **D17 Resume honesty.** Cross-machine resume finds its child by
  `(host, terminalName, worktreePath, branch)`, and a dead remote terminal or a
  missing tree must be reported truthfully together with what survived (the
  branch). Automatic rebuild is forbidden — a rebuilt child would silently
  restart work whose output nobody collected. Cross-machine `continue` is a
  non-goal.
- **D18 Files.** Only the files listed under **Files** are touched.
  `test/unit/terminal-supervisor.test.ts` is a frozen input: its 22
  `paramsFor("terminal.run")` assertions must not be modified, and they are what
  proves D4.

## Invariants

- **I1** The absent-host path changes no behaviour: `npm run typecheck` and
  `npm test` are green with `test/unit/terminal-supervisor.test.ts` unmodified.
- **I2** Exactly one `on` downlink exists in `src/` (`grep -rn 'on: host' src/ |
  wc -l` = 1), and no host meaning is spelled `machine` (only the phase machine
  may use that word).
- **I3** No new background process, poller or daemon is introduced; a
  cross-machine launch must not become "start an ssh guard process".
- **I4** `LEGION_DB_USER_VERSION` is 4 after the migration lands, and a v3 file
  migrates without changing its `nodes` row count.
- **I5** No `fs.*` / `git -C` call receives a worktree path whose
  `worktreeHost` is non-empty — guaranteed at one point by
  `assertLocalWorktree()` and pinned by a unit test.

## Files

Create:

- `src/runs/remote.ts` — `normalizeHost`, `terminalAddress`,
  `assertLocalWorktree`; later stages add the `machine.exec` / origin-check
  wrappers here, never beside them.
- `src/runs/remote-verify.ts` — the four failure classes, the 600 s clamp and the
  timeout race (S3).
- `src/runs/remote-artifact.ts` — tail read by `wc -l` + `file.read`, artifact
  fetch, the 8 MB degradation (S4).
- `test/unit/cross-machine-params.test.ts` — D2/D4/D5: the params key set with
  and without a host, `terminalAddress`, `assertLocalWorktree`.
- `test/unit/worktree-host.test.ts`, `test/unit/remote-verify.test.ts`,
  `test/unit/remote-artifact.test.ts`, `test/unit/resume-remote.test.ts`,
  `test/integration/fake-core-spawn.test.ts`,
  `test/integration/remote-worktree.test.ts`, `test/live/remote-e2e.test.ts`
  (later stages), plus `test/helpers/fake-hc-core.mjs` for the fake core.

Modify (and nothing else):

- `src/shared/types.ts` — `AgentConfig.host`, `ChildRecord.host` /
  `ChildRecord.worktreeHost`.
- `src/agents/agents.ts` — `host` in the frontmatter field set, plus its
  applier. `assertKnownFrontmatter` is untouched: the closed set is the
  mechanism, so no second validation is added.
- `src/agents/overrides.ts`, `src/agents/settings.ts` — `host` as an overridable
  string.
- `index.ts` — `host` on `TaskItem` / `SubagentParams` / `VexillatioParams`,
  passthrough in `launchStep` and `resume`.
- `src/runs/orchestrator.ts` — `LaunchInput.host`, one `normalizeHost` call,
  `SpawnInput.host`, `record.host` on the child records.
- `src/supervisor/types.ts` — `SpawnInput.host`.
- `src/supervisor/terminal-supervisor.ts` — `TerminalChildRecord.host` and the
  ONE `...(host ? { on: host } : {})`.
- `src/hc/client.ts` — allowlist gains `machine.exec`, `file.read`, `file.write`;
  `machine.add` / `machine.rm` / `machine.list` stay excluded.
- `src/runs/worktree.ts`, `src/runs/provision.ts`, `src/runs/args.ts`,
  `src/runs/artifacts.ts`, `src/runs/acceptance.ts`, `src/legion/db.ts`,
  `src/legion/nodes.ts`, `src/extension/legion-tools.ts`, `package.json`
  (S1–S5).

## Acceptance

- `npm run typecheck` green.
- `npm test` green with `test/unit/terminal-supervisor.test.ts` unmodified.
- The new tests prove D2, D4, D5 and D13; later stages add D6–D8, D14, D15, D17.
- `grep -rn 'on: host' src/ | wc -l` = 1 (I2), and no new git subprocess on the
  launch path (I3).
- A remote launch in the fake-core harness sends `on`, a remote-only `env`
  without `PATH`/`HOME`/`TERM*`, labels without `herdr.space`, and `--session` /
  `--system-prompt` under the fake remote's root (S1).

## Amendments recorded while landing v1

None of these changes a decision above.

- **S0 scope.** S0 ships the types, the plumbing and the single `on` mapping,
  and nothing else: no argv/env/labels rewrite (D6–D8), no worktree or verify
  branch (D10–D14), no read-back (D15). A launch that carries `host` therefore
  still runs with this machine's `argv` until S1 lands — the params test pins
  the mapping, not a working remote child.
- **Role-card `host` resolves with `worktree`'s precedence.** An explicit
  per-step value beats the call-level one, which beats the card's default, and
  `normalizeHost` decides at that one point. D1's refusal for the non-terminal
  backends is not in S0, so a card `host` on an `rpc`/`inprocess` launch is
  ignored rather than refused until that guard lands.

## Non-goals (v1)

Worker/scout visibility on the remote machine, membership of a remote terminal
in a herdr space, cross-machine `continue`, streaming a remote child's events
into the parent TUI, `legion_mail` / nested subtree crossing machines, automatic
recovery of a dead remote terminal or a deleted remote worktree, automated
`machine.add` / `machine.rm`, non-git delivery (rsync, scp, tarballs), and
`host` on the `rpc` / `inprocess` backends.
