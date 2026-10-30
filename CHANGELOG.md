# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Published GitHub Release notes remain available at
https://github.com/zzjcool/pi-legion/releases — this file is the in-repo
summary so you can see **2.x vs 0.16** without leaving the tree.

## [Unreleased]

### Added

- **`legion_phase` gained the two arguments a centurion actually needed: `supersedes`
  and `reason`.** `implementing` had no legal exit for the most common way a squad settles — one child
  failed, the rest settled. `implementing → reviewing` demands `children_none_failed`, which only
  tolerates failures listed in `handledIds`; that set had exactly one producer, and its hard
  precondition was `reworkCount > 0`, which increments only on the two `rework: true` edges —
  `implementing` has none. `implementing → failed` demands `children_all_failed`, and
  `to: "failed"` was refused on the tool surface before the state machine ever ran. Meanwhile
  `terminalReason: "parent_decision"` was already unconditionally accepted by the state machine
  with zero producers in `src/`. Both gaps are now closed without touching the transition graph: a
  centurion may declare `to: "failed"` **with a reason** (a missing reason is refused, and `done`/`aborted`
  stay off-limits because they belong to the parent or supervisor), and may pass
  `supersedes: [<failed child>]` to name which failures a settled sibling has taken over — an
  extra source unioned into the existing `reworkCount > 0` / `updatedAt < phaseSince` derivation,
  never a replacement for it, with a `node_handled` audit event per handled id. A declared failure
  still has to be a declared exit: the tool only hands the state machine that terminal reason when
  the team's effective (normalized) machine offers a `failed` edge out of the current phase that
  this node may take, so a card that reserves `failed` to another actor — or declares the phase but
  omits the edge — keeps its veto, and the persisted reason is capped like `note`/`evidence`. The
  refusal text for the deadlock now names both of those calls instead of two actions that were
  unreachable in the current code. Contract: `docs/contracts/partial-failure-exit-v1.md` (#309).

- **`status` now says what a live child is doing and for how long — `working · bash 00:07:31` —
  and marks a single tool that has run unchanged for five minutes.** "The process is alive but has
  stopped progressing" was invisible everywhere: the strongest `liveness()` rule calls any child
  holding a non-terminal handle `live`, the heartbeat refreshes for exactly those children, and the
  orphan scan exempts a node whose first root child is still alive, so a child stuck inside one
  tool call looked identical to one doing useful work and the parent learned otherwise only when
  its 900s `collect` deadline fired. Both backends now record the one tool call a child is inside —
  tool name plus the host clock reading when its own `tool_execution_start` arrived — onto the child
  record, folded from the session event stream each backend already consumes (no new IPC, no
  polling, no new state machine). `subagent({ action: "status" })`, the `all: true` overview and
  `/legion status <name>` lead each block with that fact and, at or past
  `STALL_NOTICE_MS = 300_000`, append a marker naming how many whole minutes the call has been
  stuck and which lever can move it — `steer` cannot reach a child that is inside a tool call
  (#313), `abort` can (#314).
  **This is display only**: `liveness()` is untouched, no heartbeat or orphan-scan criterion moved,
  and nothing is ever auto-killed, aborted or retired — the marker names the levers, the parent
  still pulls them. A child with no in-flight tool renders exactly the pre-#315 block, byte for
  byte. The one behaviour change is that the read-only `scout` role now declares
  `toolTimeoutMs: 600000`, because `toolTimeoutMs` had no default and the SDK bash tool has no
  default timeout, so a single hung probe could pin a recon child for its whole turn budget and
  report nothing; `worker` and `centurion` deliberately keep no default, since killing a
  slow-but-progressing build or integration run costs more than the hang it would prevent. Contract and the frozen boundary:
  `docs/contracts/stall-visibility-v1.md` (#315).

- **`subagent({ action: "abort" })` stops a child's current turn without killing it.** The
  capability was already sitting in the supervisor (`LegionSupervisor.abort`, `RpcSupervisor`,
  `InProcessSupervisor`, `Orchestrator.abort`) with zero call sites and no action on the tool
  surface, so the only ways out of a stuck child were `stop` (tear the process down and throw the
  context away) and `steer` (a queue, so it cannot reach a child that is inside a tool call). The
  action now clears the child's queued steering/follow-up messages first — `clearQueued`,
  default `true`, because an abort that lands first lets the child immediately pick up the oldest
  queued instruction, the opposite of "stop that" — and then asks the child to stop the current
  turn. Context, transcript and session file survive, so the child can be continued afterwards.
  The call is bounded: one 5s limit covers the interrupt **and** the queue clear that has to land
  before it, so the worst case is about twice that bound — and the tool surface takes no bound of
  its own (`timeoutMs` stays a `wait`-only parameter; a clear that cannot answer counts as zero
  while the interrupt is still sent). A call that hits the bound answers `timeout` instead of
  hanging, and it never kills anything: `stop` (`force: true` for the hard variant) remains the
  path that takes the process down. Three honest receipts — `interrupted` (with the count of
  queued messages it dropped), `no-turn` (nothing was running; the queue is left alone) and
  `timeout` (the request went out, the child had not settled). Contract and the frozen three-state
  table: `docs/contracts/abort-soft-interrupt-v1.md` (#314).

### Fixed

- **A team can no longer deadlock in `implementing` after a partial failure, and two error codes
  stopped lying.** Covered by the `supersedes` / `reason` entry above; the code-hygiene half is
  separate: resuming a terminal legion child reported `BUDGET_EXCEEDED` although nothing about a
  budget was involved, so a parent could not tell "this child is finished" from "this child ran
  out of budget" — the new `ErrorCodes.CHILD_TERMINAL` says what happened, and `reviveChild`'s
  catch no longer rewrites every failure to `START_FAILED` (a `SubagentError` keeps its own code,
  anything else still gets `START_FAILED`). Codes travel only in `details.error`, never in the
  user-visible text, so no tool output gained a `BUDGET_EXCEEDED` string (#309).

- **Host extension discovery is no longer a silent failure, and `/legion doctor` can say whether
  inheritance is wired at all.** `ensureHostExtensions` kept its never-reject / R2-b backoff
  semantics but recorded a failure only as a `failedAt` timestamp: a host whose `pi list` breaks
  looked exactly like a host that ships no package extensions, because `discoveredHostExtensions()
  ?? []` collapses "could not ask" and "nothing installed" into one empty array. A failure now logs
  one `[pi-legion]`-prefixed warning carrying a bounded `pi list` stderr summary (the `failedAt` stamp doubles as
  the already-told bit, so a permanently broken probe warns at most once per process instead of once
  per warm call; with no stderr the reason falls back to the exit code, then to pi's own message,
  and the warning itself can never throw). `/legion doctor`'s
  Extensions section answers the question with
  `discovered host extensions: N (last probe: ok | failed <n>s ago | never)`, backed by the new
  read-only `hostExtensionDiscoveryState()` — doctor never probes on its own, so `never` is honest
  and the line costs nothing. The in-process spawn hint also stopped recommending levers that no
  longer do anything (`inheritExtensions: true` is the default policy since #280,
  `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1` is a no-op, and neither brings back a host extension when
  discovery failed): it names `PI_LEGION_CHILD_EXTENSIONS=<path>` and a static `models.json`
  provider, and appends "inheritance is enabled but host discovery is failed/never probed — the
  child got 0 host extensions" when that is the actual situation — on every spawn-hint branch, so
  the rpc `--no-extensions` hint lost its own `inheritExtensions` clause too (it would have
  contradicted the note right below it). Contract revision:
  `docs/contracts/extension-inheritance-wiring-v1.md` §9 (#317).
- **A `collect` that bails after claiming no longer swallows that round's completion notice.**
  The claim-once seam claims a terminal result as it hands the snapshot to the tool call, and
  `collectChild` can still bail afterwards — the parent turn aborts, or persisting the child
  throws. Two things were wrong with the rollback. It deleted the claim unconditionally, so a
  bail on a `(runId, name, round)` a real delivery had already claimed erased the evidence and
  resurrected an already-read notice into the next flush; the seam now hands out *whether this
  call took the claim* with the snapshot (`consumeCollect*` returns `{ snapshot, claimedNow }`),
  and only that one comes back — per call, not per snapshot, because the watch and the tool call
  await the same `job.collectPromise` and a shared record lets the second call overwrite the
  first's answer. And it did not hand the notification route back: the seam sets
  `consumedByTool` before the claim, every child is watched in production, so the watch passed
  its gate first (`!consumedByTool && !notified` → skip `onTerminal`) and was already parked in
  `retire` when the bail arrived — meaning the repair had to re-arm unconditionally, which it
  now does (clear the flag, `watch` again; the generation bump keeps the old watch from
  releasing the job, `notified` keeps the round single, `deliverBatch`'s claim filter is the
  last net). Measured in that production shape: 0 notices before, 1 after. The one case still
  not recovered is a bail that lands only after the watch has already released the child — there
  the result stays readable through a later `collect` and a copy already held in the run outbox
  still arrives, but a copy sitting in the join window goes with the release. Contract revision:
  `docs/contracts/notice-claim-v1.md` (D2, #320).
- **A `steer` receipt now reports what the child's session actually answered.** `steer` is a
  queue, not an interrupt: the text is enqueued and only consumed at the child's next turn
  boundary — after the current batch of tool calls finishes, before the next LLM call — so a
  child stuck inside one long-running command never receives it, and no amount of steering can
  break into that tool call. The receipt read "Steered <name>." whatever happened, because the
  disposition the child's session reports back (`handled` vs `queued`) was dropped on the way up
  through the supervisor seam — and `handled` never meant delivered: it is the SDK's
  interception signal, returned *before* the message is queued, so the child never sees it. The
  receipt now has three honest shapes: `queued` (it takes effect after the current tool batch
  finishes), `accepted` (the child was idle, so this call started a turn with it) and
  `intercepted` (an input handler took it — the child never saw it). Resuming or continuing a
  live child carries the same distinction, and the parent playbook plus the v2 contract now
  state the negative semantics — a tool call in flight is unreachable by `steer`; `stop`
  (`force: true` for the hard variant) is what actually interrupts. Because `intercepted` means
  "no run started", the turn it had claimed is rolled back: `waitSettled` answers at once with
  `prompt was intercepted before any run started` instead of timing out, the child does not stay
  `running` forever, and a launch prompt swallowed that way fails the spawn rather than handing
  back a child that was born busy. Legion mail sent to a busy child with `action-needed` now logs
  a warning when its steer was intercepted — `delivered=1` still records the send (D3), so the
  warning is the only signal that the child never saw the message.
- **A child's completion notice is delivered once, whichever route won.** A terminal
  result reaches the parent two ways — the tool result (`wait` / `collect`) and the
  pushed notice (`watch` → `join` → outbox) — and each kept its own memory
  (`consumedByTool` / `notified`), judged once when the watch hit terminal. The notice
  still had to cross the 10s join window and the run-scoped outbox, neither of which
  knew those flags existed, so four duplicate windows followed: a buffered entry
  flushed after a `wait` (W1), an outbox entry flushed on `agent_settled` after a
  `wait` (W2), a buffered entry orphaned by `release()` (W3), and the flags
  evaporating with the deleted job (W4).
  - Dedupe collapses onto **one claim per `(runId, name, round)`**. `round` is a
    per-name counter because `runId` is the *parent* run id — every round of a
    same-named child shares it, so a two-part key lets an unread old round win the
    flush and filter out the new round's real result. Three claim sites — `wait`
    (before its retire await), the `collect` seam, and a notice that actually went
    out — and one rollback: when a `collect` claims and then bails (the parent turn
    aborts, or persisting the child fails), the claim is handed back, because a
    notice for a result nobody saw must not stay suppressed. Delivery itself never
    unclaims.
  - `deliverBatch` is the single exit: claimed entries are filtered, survivors
    formatted (grouped headers and the `N of M` count recomputed at delivery time),
    then sent or held. The outbox now holds structure rather than formatted text, so a
    member claimed while a notice waits drops out of the body and the count alike.
  - Each round is one deliverable result, so releasing a child only ever drops the
    copy of the round the parent just read: an earlier round's unread notice still
    arrives.
  - Tool results are **never** suppressed: `wait` / `collect` always return the full
    text, only the passive notice is deduplicated. Claim state stays in memory by
    design — after a process restart the result is still recoverable via `collect`.
  - Contract and the four implementation-time revisions:
    `docs/contracts/notice-claim-v1.md`.

## [5.0.1] — 2026-10-27

Patch release. **This is the release where 5.0.0's extension-inheritance policy
starts actually taking effect** — upgrading changes what a child loads, so read
the first entry before rolling it out to a fleet.

### Fixed

- **Host extensions are inherited again (#280).** 5.0.0 declared "children inherit
  every host extension by default" and documented the narrowing knobs, but the
  policy never reached the spawn path: `discoverHostExtensions()` had no callers,
  the sync getter it fed therefore returned `undefined`, and
  `inheritedExtensions` was always handed an empty host list. Children kept
  getting exactly the card's own `extensions` plus the child-guard — the
  `--no-extensions` behaviour #280 set out to remove, under a new description.

  Discovery is now warmed once per process before a child is spawned. The cache
  lives on `globalThis` under `Symbol.for` rather than in a module-level `let`,
  because pi re-evaluates an extension module with `moduleCache: false` for a
  child's `--extension` load: a module-level variable is invisible across those
  instances, so a child spawned from a re-loaded instance would have inherited
  nothing. The same escape hatch already backs `child-context.ts`,
  `inprocess-depth.ts` and `admission-queue.ts`.

  The warm-up sits in each backend's `spawnChild` (and in `RoutingSupervisor`,
  which sees both). It is deliberately not in `Orchestrator.launch`: that fast
  path may not gain an await before the synchronous admission block
  (`launch-admission-queue-v1` §13.7).

- **`PI_LEGION_CHILD_INHERIT_EXTENSIONS=0` works on the inherited half (#280).**
  `collectChildExtensions` accepted an `env` argument and then did not forward it
  to `inheritedExtensions`, so the operator kill-switch applied everywhere except
  the set it was meant to disable. Harmless while that set was always empty;
  wrong the moment it is not.

- **A manifest that names a directory no longer breaks rpc children (#280).**
  `pi.extensions: ["./extensions"]` (what `pi-diff-review` ships) resolved to the
  directory itself, and `pi -e <dir>` exits 1 with `Failed to load extension:
  Cannot find module` — so wiring inheritance up would have failed every rpc
  child of a session with that package installed. Declared entries now resolve the
  way pi's own loader does: a file as-is, a directory through its own
  `pi.extensions`, else its `index.ts` / `index.js`, else its `*.ts` / `*.js`
  files. An entry that expands to nothing is dropped instead of leaving an
  unloadable path.

- **`extensions/<name>/index.ts` is discovered (#280).** The first sweep collected
  only files directly inside a declared directory, so pi's documented
  subdirectory layout resolved to nothing and the package silently contributed
  zero extensions. The sweep now matches pi's `collectAutoExtensionEntries`:
  `.`-prefixed names and `node_modules` are skipped, `*.ts` / `*.js` files are
  collected, and a subdirectory is resolved as a package of its own (one level,
  as pi does).

- **A failing `pi list` is retried, and costs one probe per spawn (#280).** The
  old shape cached the failure as `[]` permanently, so one transient error
  disabled inheritance until the process restarted. Failures now stamp
  `failedAt` and short-circuit for `FAILURE_TTL_MS` (5 s), which keeps a
  three-point warm-up from probing twice on the same spawn while still retrying
  once the window passes.

- **A direct `RpcSupervisor` gets the same warm-up (#280).** `api.ts` documents
  `new Orchestrator({ supervisor: new RpcSupervisor(), … })`, which never touches
  `RoutingSupervisor`; warming only there left that path inheriting nothing.

### Notes

- **Cost now matches what 5.0.0 promised.** Inheriting everything includes
  pi-lens (a ~5.7 MB bundle that starts an LSP stack) on every child. In-process
  children share the host process, so this is host memory, not a new process.
  Add `excludeExtensions: [pi-lens]` to a card (or
  `PI_LEGION_CHILD_INHERIT_EXTENSIONS=0` globally) if a fleet does not need it —
  before this release those knobs were inert.
- **This package is never inherited into its own children.** In the source-tree
  layout `pi list` and the child-guard name different files for the same code, so
  dedupe could not collapse them and a child loaded two legion factories
  (`Tool "subagent" conflicts with …`). The guard is still appended
  unconditionally at the end.
- Doctor output and the README described the intended behaviour, which is now the
  actual behaviour; they were not rewritten for this release.

## [5.0.0] — 2026-10-26

Major because upgrading **can break an existing role card**: unknown frontmatter
is now a hard error, and `spawnMode` / `placement` are gone. A card carrying
either fails to load with a message naming the offending field. That is the point
— the previous behaviour was to silently ignore them, so a setting that looked
active did nothing.

**Before upgrading**, remove `spawnMode:` and `placement:` from every card under
`~/.pi/agent/agents/` and `.pi/agents/`. Nothing else about a card needs to
change.

### Breaking

- **`spawnMode` is gone from role cards (#290).** The backend is a property of
  the launch, not of a role: a launch that needs a worktree runs over rpc, and
  everything else runs in-process. Since only a `centurion` may hold a worktree
  (#214), a centurion is the only role that can reach rpc. There is no global
  default to configure because there is no longer a choice to make per role.
- **Unknown frontmatter is refused (#290).** A card with a field the runtime does
  not honour is rejected at load, listing the bad keys and the full legal set. The
  retiral of `placement` was previously "tolerated"; fourteen bundled and local
  cards still carried it while it did nothing.
- **Five bundled roles removed (#301).** `planner`, `reviewer`, `designer`,
  `prototype`, and `advisor` are gone; `centurion`, `worker`, and `scout` remain.
  They existed because the phase machine keyed its rules on role *names* — a role
  that merely existed carried workflow meaning. See the declarative machine below.
- **Children inherit every host extension by default (#280).** The old default was
  `--no-extensions` plus whatever a card named, which meant a role silently lost
  host capabilities (a provider extension, a guard) it never knew to name. Use
  `excludeExtensions: [pi-lens]` on a card, or
  `PI_LEGION_CHILD_INHERIT_EXTENSIONS=0` globally, to get the old isolation.
  `inheritExtensions: false` loads only the card's own list.

### Added

- **Declarative phase machine (#298).** A team declares its own phases on its
  lead's card:
  ```yaml
  phases:
    - id: recon
      next:
        - to: build
          require: [contract_file]
    - id: build
      next:
        - to: done
          require: [children_settled]
  ```
  Omitted means the built-in `planning → implementing → reviewing → verifying`.
  Conditions are a closed vocabulary (`contract_file`, `children_present`,
  `children_settled`, `children_none_failed`, `verdict_ok`, `verdict_not_ok`,
  `verification_passed`, `verification_failed`, `rework_available`,
  `children_all_failed`, `always`) and **none of them names a role**, which is
  what lets a team reshape its workflow without touching source.
  - Conditions live on the **edge**, not the phase: `planning → implementing`
    needs a contract while `planning → failed` must not, or a team could not fail
    before it had one.
  - `done` / `failed` / `aborted` are injected when a card omits them. A team that
    cannot be aborted is a safety hole. Reaching them is still gated: `failed`
    needs a terminal reason, `aborted` needs a parent retire, `done` stays
    supervisor-only. `aborted` is deliberately exempt from phase-level
    requirements — an emergency stop must not wait for "everything settled".
  - An invalid machine is rejected at load, reporting every problem at once
    (unknown condition, duplicate id, unknown target, self-edge, unreachable
    phase, terminal start).
- **The tree shows a team's machine (#302).** Selecting a team root unfolds its
  phases, the current one, and every transition with its conditions.
- **`legion_phase` refusals name the legal exits (#299).** A refused transition
  reports `legal next phases from 'recon': build, done, failed, aborted`. Measured:
  without it a model invented plausible-but-nonexistent transitions and burned a
  turn being refused.

### Fixed

- **In-process children enforce `toolBudget` / `turnBudget` (#295).** The parent
  computed budgets into `SpawnInput.env`, which an rpc child receives as its real
  environment — but an in-process child shares the *host's* `process.env`, so the
  guard read the parent's (absent) values. A card with `toolBudget: {maxToolCalls:
  3}` made 12 tool calls and finished normally. Budgets now travel in the
  async-local child context, the same channel already used for lineage identity,
  with `process.env` kept as the rpc fallback.
- **A malformed budget is an error, not "no limit" (#293).** `{not json}` parsed to
  `undefined` and `{"maxToolCalls": -3}` was accepted, so the guard would have
  blocked the first call. Both now fail at load naming the file, field, and value.
- **rpc is reserved for a centurion, and in-process keeps its ledger budget
  (#279).** In-process launches had been exempted from every legion budget
  (`Number.MAX_SAFE_INTEGER`), which made "run it in-process" a way to escape
  depth/spawn/ledger caps. Admission and reservation now share one code path, so a
  launch cannot be admitted and then rejected.
- **Runtime handles are keyed by (ledger path, node id) (#283, #285, #287).** Keyed
  by path alone, a second session sharing the ledger could close the parent's
  database; the identity is now adopted per node.
- **Extension inheritance discovery (#280).** `pi list` reports package
  *directories*, resolved the way pi's own loader does (`package.json`'s
  `pi.extensions`, else `index.ts` / `index.js`). Single-file `--extension`
  arguments and builtins cannot be discovered this way — name them explicitly.
- **One spelling for "unknown child" (#288).** The old message advised "pass the
  same cwd used for launch", which stopped being actionable once cross-store
  lookup landed.
- **Prompt surfaces match the code again (#303, #304).** The parent playbook told a
  centurion to "dispatch N centurions" — an instruction the runtime refuses
  (only the root may dispatch one). The roster also listed a centurion to
  itself. `worker` kept `subagent` in its tool list while its text said not to
  spawn, and the README described every child as an rpc process.

### Notes

- `toolBudget` / `turnBudget` remain **optional and unused by the bundled cards**.
  Time, depth, per-node child counts, active-node counts, and the memory floor are
  the intended bounds; a tool budget is a scalpel for one stubborn role, not a
  default.
- Child extension inheritance includes heavy extensions. pi-lens starts an LSP
  stack (~1 GB per child, #43); add `excludeExtensions: [pi-lens]` where a fleet
  does not need it.

## [4.0.0] — 2026-10-24

- **Renewal for a budget casualty (#270).** An agent whose turn budget (`timeoutMs`)
  runs out no longer just reports `failed`. When it measurably progressed and its
  role allows renewal, the completion notice ends with a ready-to-paste
  `subagent({ action: "continue", … })` plus the evidence (`progressed: 47 tool
  results, 12 assistant messages, 6 files changed`) and the remaining budget
  (`renewals: 1/2`). Renewal reuses the existing `continue` path, so the child
  resumes from its own session file with its context intact. Two dispatches in one
  day motivated this: one worker was cut off with nothing on disk, another finished
  its code but ran out during verification.
  - **Never automatic.** An auto-renewed stuck child would hold a concurrency slot
    indefinitely; the notice hands over the decision instead.
  - "Progressed" = ≥ 3 new `toolResult` rows or ≥ 1 changed file since the last
    baseline. `assistant` messages are shown but never count — a model looping on
    the same sentence grows that number without doing work.
  - New agent frontmatter: `renewable` (default **true**; a timed-out `scout` means
    the task was mis-scoped) and `maxRenewals` (default **2**; `0` disables, each
    renewal is a fresh full budget). Both are validated in the team-override path
    like every other numeric/boolean field.
  - `wait`/`collect` timeouts never propose a renewal: those return while the child
    is still alive. Only a real termination does, judged by `stopReason: "toolUse"`
    / missing assistant row (F29) / the host's `terminated` wording — a clean
    `stop` from an ordinary retry does not spend the budget.

- **Launch admission queue (#266).** A launch that exceeds a *concurrency* gate
  (`maxChildrenPerNode`, `maxActive`, ledger `max_children_per_node` /
  `max_active_nodes`) no longer fails with `BUDGET_EXCEEDED`. It is enqueued,
  the caller gets `▶ scout-7 (scout) supervisor=inprocess queued(3)` and treats
  the work as dispatched, and the child starts automatically when a slot frees.
  Previously a 12-step fan-out against `maxChildrenPerNode: 8` ran 8 children and
  reported 4 errors — and nothing ever retried them, because the parent was
  already inside `wait` and the freed slot had no subscriber.
  - New settings: `subagents.inprocess.maxQueuedLaunches` (default **32**) and
    `subagents.inprocess.launchQueueTimeoutMs` (default **900000**). Both are
    shared by the in-process and RPC paths — one scheduler, not two.
  - Depth, spawn-per-session, memory, name-collision and config errors are still
    refused synchronously, byte-identically to before: only gates that a slot
    release can satisfy are queueable. `maxChildrenPerNode: 0` is a hard refusal
    (0 means "no children", so waiting can never satisfy it).
  - A queued launch reserves nothing: no ledger row, no child run directory, no
    worktree, no session file. `timeout`/`overflow`/`stop` are reported by name;
    `stop` dequeues without ever spawning, and a parent-turn abort flushes the
    queue and says how many launches it dropped.
  - `subagent({action:"status"})` shows `state=queued`, `collect`/`wait` block
    until admission instead of reading the placeholder session path, and
    `async: false` reports `↳ <name> waited Ns in the launch queue`.
  - Two new process-only events (`launch_queued`, `launch_admitted`) and a
    `legion-queue: N queued` status pill.

## [4.0.0] — 2026-10-19

A major line — but not only the pi-only collapse. Relative to 3.1.0 this release
removes every non-`pi` agent kind and the archived Herdr backend behind it, along
with the settings and error codes that only its transport read. It also carries
everything else that landed on `master` while that removal was held back: a
launch admission queue that queues instead of refusing, one liveness verdict
shared by every display surface, a status panel built on pid / rss /
context-token data, and ten measured performance fixes.

### Breaking

- **Kinds collapse to `pi`.** `AGENT_KINDS` is now `["pi"]`; the
  `cursor` / `claude` / `codex` / `gemini` and other third-party CLI kinds are
  gone, and with them the `cursorModel` / `nativeModelFor` / `planKindStart`
  model translation and the "model dropped, runs on its own default" notice
  (a `pi` child expresses every model, so the case no longer exists). `kind` is
  still a legal frontmatter key, but `pi` is the only accepted value: a non-`pi`
  value is ignored — one note on stderr per role (deduplicated, because the
  catalog is re-read on several UI paths) naming the role and the original
  value — and the role launches as `kind: pi`. The same applies to
  `subagents.presets.<role>.kind` and `subagents.agentOverrides.<role>.kind`,
  the three places a role's `kind` can come from. No legacy prefix aliases.
- **Herdr backend removed.** `src/backends/legacy/` and `test/legacy/` are
  deleted, together with the deprecated `pi-legion/api` re-exports that only
  served them (`createHerdrClient`, `parseHerdrResponse`, `mapHerdrErrorCode`,
  `readPaneDiagnostic`, `createCommandRunner`, `resolveHerdrBin`, `HerdrClient`
  and their types). `pi-legion@0.16.x` stays the pin for the Herdr-era
  execution model; the `spawnMode: rpc` / `inprocess` backends are unaffected —
  those are two ways of running **Pi**, not third-party transports.
- **Dead `herdr.*` settings removed.** `subagents.herdr.*` is no longer parsed
  (a leftover block is silently ignored, as it has been ignored since 2.0.0),
  the seven `herdr` constants are gone from `DEFAULTS`, and
  `ErrorCodes.HERDR_UNAVAILABLE` / `ErrorCodes.PANE_BUSY` are removed.
  `RunRecord.herdr` and `StatusEntry.herdrStatus` stay: they carry live
  `{supervisor, node_id}` state, not backend selection.

### Added

- **Launch admission queue (#266).** A launch that exceeds a *concurrency* gate
  (`maxChildrenPerNode`, `maxActive`, ledger `max_children_per_node` /
  `max_active_nodes`) no longer fails with `BUDGET_EXCEEDED`. It is enqueued,
  the caller gets `▶ scout-7 (scout) supervisor=inprocess queued(3)` and treats
  the work as dispatched, and the child starts automatically when a slot frees.
  Previously a 12-step fan-out against `maxChildrenPerNode: 8` ran 8 children and
  reported 4 errors — and nothing ever retried them, because the parent was
  already inside `wait` and the freed slot had no subscriber.
  - New settings: `subagents.inprocess.maxQueuedLaunches` (default **32**) and
    `subagents.inprocess.launchQueueTimeoutMs` (default **900000**). Both are
    shared by the in-process and RPC paths — one scheduler, not two.
  - Depth, spawn-per-session, memory, name-collision and config errors are still
    refused synchronously, byte-identically to before: only gates that a slot
    release can satisfy are queueable. `maxChildrenPerNode: 0` is a hard refusal
    (0 means "no children", so waiting can never satisfy it).
  - A queued launch reserves nothing: no ledger row, no child run directory, no
    worktree, no session file. `timeout`/`overflow`/`stop` are reported by name;
    `stop` dequeues without ever spawning, and a parent-turn abort flushes the
    queue and says how many launches it dropped.
  - `subagent({action:"status"})` shows `state=queued`, `collect`/`wait` block
    until admission instead of reading the placeholder session path, and
    `async: false` reports `↳ <name> waited Ns in the launch queue`.
  - Two new process-only events (`launch_queued`, `launch_admitted`) and a
    `legion-queue: N queued` status pill.


- **One liveness verdict for every display surface (#liveness).** The list, the
  text view and the railway chart each decided "is this agent still working?"
  their own way, and the railway one compared two clocks that no single writer
  owned: `eventOverrides` vetoed an event against `node.updatedAt`, but the
  event row is stamped by this process's event bus while `updatedAt` is stamped
  by the child's heartbeat — and only `isAlive` children are heartbeaten, so a
  dead child's `updatedAt` freezes. The comparison ranked two clocks and the
  losing side was the truthful one: a finished node was repainted `running`,
  forever, because the frozen row never moved again. `src/extension/liveness.ts`
  replaces all three with one `liveness(facts)` in TOTAL ORDER — `live` /
  `dead` / `unknown` — with no clock, no fs and no timer of its own. Unknown or
  unrecognized states now render `unknown` instead of being guessed into
  `retired`, and `queued` is a first-class display state.
  - Contract: `docs/contracts/display-liveness-v1.md` (frozen first, then
    implemented; D1-a and D5-a record two amendments found during the work).

- **A status panel on the `/legion` board (#241, #245).** A fifth pane carries
  the `/legion status` table onto the full-screen viewer — name · role · state ·
  supervisor · ctx · rss · turns — graded down by absolute column count
  (72/52/36/20) so a narrow board keeps name · state instead of a column of
  stubs. A portrait layout gets a zero-area rect and Tab skips it rather than
  painting a fifth pane that cannot fit. Only an `rpc` child owns a process, so
  only it shows rss; an `inprocess` child shows `—` rather than a share of the
  host figure it does not own, because a fabricated number would get used.
  - `pid`, `spawnMode`, `contextTokens` and `rss` are optional on `VizNode` and
    projected conditionally: a missing mode renders `unknown`, never a guessed
    `rpc`. No new `legion.db` column and no schema-version bump — pid is
    host-scoped and never persisted, so a rebuild from a `ChildRecord` invents
    none.
  - Context tokens are absolute only. Session JSONL carries no context window,
    so no percentage is computed and none is displayed.
  - `/legion status` also stopped dropping `spawnMode` and now supplies `owner`.

- **`/legion stop --force` (#179).** The TUI slash command can now hard-retire a
  child, equivalent to the tool's `force: true`; `--force` / `-f` is listed in
  the doctor help and the README. This closes the "optional follow-up" that the
  docs had been carrying.

- **`vexillatio` accepts `tasks[]` on its own.** `task` was required, so a
  `{tasks: [...]}` call was rejected by the host's typebox pre-validation before
  Legion ever saw it, and callers had to send a dummy `task` and retry. It is
  optional now; a `tasks[]`-only launch is legal.

### Changed

- **WAL is now an enforced startup precondition (#236).** `openLegionDb` used to
  discard the value returned by `PRAGMA journal_mode = WAL`. That PRAGMA is a
  *query*: the returned mode is the ground truth, and SQLite is entitled to
  answer with the mode it settled on rather than to fail — which is how a
  connection ends up on a rollback journal while every reader of the code
  believes WAL is live. The ledger's durability reasoning (single-writer
  serialisation, readers that never block the writer, the shutdown checkpoint)
  rests entirely on WAL, so the observed mode is now captured and verified: a
  file database that does not report `wal` throws at startup, with the observed
  mode in the message, instead of surfacing later as data loss. `:memory:` is
  exempt deliberately, keyed on `PRAGMA database_list` reporting an empty
  `file` — not on a database name, and not by accident.
  - The M2-(g) concurrency acceptance now runs as `npm run test:wal-stress`:
    60 supervisor processes against one ledger, 9004 attempts, 9004 commits, 0
    busy, p50 1.03 ms / p95 1.99 ms / p99 4.92 ms.

- **The worker role's turn budget is 45 minutes, not 30.** The worker does the
  heaviest per-dispatch work — several files, its own verification run, and a
  report — yet it shared centurion's budget while scout gets 10 minutes and
  reviewer 15. Two dispatches in this repository were cut off mid-work, one
  with nothing on disk and one that ran out while verifying. 45 rather than 60
  keeps a genuinely stuck child from holding a concurrency slot for an hour.
  Only `timeoutMs` changed.

### Fixed

- **A poison event row no longer freezes the cross-process event poller
  (#233).** `node_abandoned` was missing from the event-type closed set, so a
  snapshot row of that type could not be decoded; the 250 ms poller then threw
  on the same row forever, its cursor never advanced, and no later event was
  ever delivered. The closed set now contains `node_abandoned` (15 types), and
  the poller advances past a single poison row instead of freezing: the row is
  reported once through `onError`, the cursor steps over it, and the remaining
  events in that batch are still delivered.

- **A finished supervisor's pid is no longer read as its successor's (#250).**
  `rss` probes re-read `/proc/<pid>` after the child had exited, and Linux
  reuses pids; the panel could attribute a stranger's memory to a retired node.
  The probe now closes the race it was silently losing.

- **The log view stays inside its rect on narrow panes (#251).** `drawLog` wrote
  past its own `maxX` when the pane was squeezed, which corrupted the frame
  beside it.

- **The live overlay no longer scans the whole tree per token (#261).** A
  per-token `getTreeNodes()` call made a long child turn quadratic in the number
  of nodes; the scan is gone and re-opening the node that is already open is
  guarded.

- **Repository subdirectories are no longer mistaken for child worktrees
  (#237 P10).** The probe treated any git-visible path below the repo root as an
  existing worktree, so a dispatch from `src/` could reuse the wrong directory.
  All git probes are now bounded: `GIT_PROBE_TIMEOUT_MS = 5_000` and
  `GIT_WORKTREE_TIMEOUT_MS = 120_000`, so a hung `git` can no longer wedge a
  launch forever.

- **`SubagentError` is exported explicitly again.** It had reached
  `pi-legion/api` only as a side effect of the legacy client re-exporting it, so
  removing the Herdr backend silently dropped it from the public surface. It is
  a deliberate export now, pinned by a test.

### Performance

Ten fixes measured against the baseline in `docs/performance-2026-10-19.md`,
plus the harness that measured them (#239). Numbers below are the before/after
from each fix's own commit.

- **`collect()` no longer waits out a fixed settle-quiet window (#232).** An
  already-settled turn cost a flat ~2.5 s of dead time; that wait is dropped when
  the turn is settled (2509 ms → 503 ms).
- **The settle polls back off instead of re-parsing every 500 ms (#232).** The
  transient-connection wait re-parsed the whole session file on every tick. It
  now keeps the last parse, re-parses only when the artifact size moved, and
  backs off 500 ms → 4 s. On an unchanged file in a 900 s window: 1800
  iterations / 1804 parses → 228 iterations / 5 parses. The blip tolerance is
  unchanged — sleeps are clamped to the remaining budget and the loop still ends
  exactly on the deadline.
- **The `/legion` log view reads the session incrementally (#234).** It seeks
  past the cached byte offset and projects only the new JSONL lines, instead of
  re-parsing from the top on every refresh.
- **`attachUsageTotals` is one batched query (#235/#248).** It accounted for
  ~72% of the cost of a UI snapshot; it is now a chunked `IN` query instead of a
  per-node round trip.
- **Heartbeats are one transaction (#236 P1).** N children meant N commits;
  eight children now cost one (3.83 ms → 0.99 ms, 3.9×).
- **Prepared statements are cached per connection (#236 P2).** `getNode` ×400
  drops 15.7 ms → 4.8 ms.
- **Session parsing projects its result instead of `structuredClone` (#237 P7).**
- **The DB event source seeds its cursor at attach instead of replaying the log
  (#238).** Attaching used to block ~1027 ms on replay.
- **Widget events are coalesced into one snapshot and one paint per tick
  (#238).** `legion-tools` emits N `mail_sent` events in one synchronous loop, so
  every burst cost 2N scans; a burst now costs a constant 2 snapshots — 2575 ms
  → 4.4 ms for 1000 events over a 120-node ledger. `applyTreeEvent` itself still
  runs synchronously, per event, in arrival order: it is an incremental state
  machine, not a render, so deferring or reordering it would change the state it
  computes.
- **The messages rate-limit `COUNT` is covered by an index (#237 P9).** 50k rows
  go from a `SCAN` to ~6.6 µs.

## [3.1.0] — 2026-10-19

### Added

- **The arbitrated launch backend is now visible (#209).** In-process has been
  the default since #197, but the backend a launch actually resolved to only
  ever appeared as a substring of one result line, so a user could not tell
  `inprocess` from `rpc`. Three surfaces now name it, always from
  `Handle.spawnMode` (the arbitration result) and never re-derived:
  - `subagent` and `vexillatio` results carry `details.spawns[]` /
    `handles[].spawnMode`, and a shared `renderResult`
    (`src/extension/spawn-render.ts`) prepends `spawn: scout-0=inprocess` to the
    tool card. The line lives in `details`, not `content`, so it stays out of
    the LLM context.
  - The `/legion` node modal footer appends `spawn <mode>` through
    `TrackedJobInput` → `TreeNodeSnapshot` → `LiveOverlayNode` → `metaPlain()`.
    No `legion.db` column and no schema-version bump; the value is threaded from
    the live job.
  - An unknown or legacy mode is **omitted**, never guessed as `rpc`.

  `pi` does not render a tool result's `details` on its own — `renderResult` is
  its only consumer — so the field alone would have been invisible. The
  renderer is hardened accordingly: a hostile `details` (throwing getter) is
  treated as a missing fact instead of throwing into the host's silent
  fallback, and `\r` / binary control bytes are normalized before the collapsed
  line cap is counted, matching the host fallback's own sanitization.

### Changed

- **Parent-facing guidance no longer calls every child an "RPC child".** The
  playbook, the collect/retire notices and the async tail now say "child" and
  describe in-process as the default, naming the rpc backend only where it is
  genuinely meant. The internal settle reasons, the auto-doctor classifier
  regex and the frozen interrupted head line are unchanged. The
  `--no-extensions` guidance is backend-neutral again: in-process children do
  not inherit host extensions either.

- **The railway lane only shows "last activity" once it is worth a word (#231).**
  A lane used to end with `· 1s ago` on every running agent — the tallest,
  least informative field in the label, and it crowded out the role/clocks
  that actually distinguish lanes. Ages under a minute are now dropped
  entirely; from 60s up the field reads `1m ago` / `2h ago` / `3d ago` as
  before, and a missing timestamp still shows `—`. `formatActivityAgo`
  returns `""` for the dropped case, so the field simply disappears from the
  detail candidates instead of leaving a dangling separator.

  Contract: `docs/spawn-mode-visibility-v1.md` (D1–D8, with the round-1 errata).

## [3.0.3] — 2026-10-19

### Changed

- **`spawnChild` returns as soon as the child accepts the prompt, not when its
  first turn finishes (#227/#228).** The in-process backend used to await the
  whole first agent run, so for 8–18 minutes the launch produced no job: the
  status board showed a single ledger row with no token rate, and the parent
  turn was blocked for the duration. Acceptance is defined in the child
  transcript (a user line past the spawn-time size, `turns.length > 0`);
  `isLastTurnComplete` is deliberately not required, because an accepted prompt
  legitimately has no assistant line yet. The prompt promise is drained in the
  background inside the same ALS child scope, so depth/identity semantics are
  unchanged. A 15 s start bound is not an error — the handle is returned anyway
  and `onSpawnDelayed` fires once. See `docs/inprocess-supervisor.md`.
- **`worktree: true` is centurion-only (#214).** Members stay in-process; only a
  centurion gets an OS worktree for the squad it leads. Roles that declared
  `worktree: true` on a leaf no longer pay the clone/bootstrap cost, and the
  isolation they still need is the centurion's. See REV-17.

### Fixed

- **A first prompt rejected before acceptance no longer produces a ghost
  child (#227 D1a / #230).** The non-blocking spawn above had a regression: when
  the SDK threw before `appendMessage` (no model, no API key, mid-compaction)
  the spawn still returned a handle, which disabled the `fallbackModels` chain —
  `Orchestrator.launch` only retries the next model when `spawnChild` throws. A
  reject **before** acceptance now throws `SubagentError(START_FAILED)` and takes
  the existing rollback path; a reject **after** acceptance keeps the handle and
  reports `SettleResult.reason = "child turn failed: …"`.
- **An interrupted `vexillatio` keeps the work it already collected (#227/#229).**
  The frozen head line stays first and verbatim, then the collected segments (in
  handle order) and any `✗ <agent>: <error>` launch failures follow, with
  `details.stillRunning` telling you what is still live. A reason-less abort is
  now named (`ABORT_WITHOUT_REASON`) instead of surfacing as bare engine text,
  and `Orchestrator.collect` no longer stamps a deadline on a child whose last
  turn already finished.
- **Foreign children are judged by their run-directory owner (#209-3 / #215).**
  `status` reported a long-dead child as `working` and `stop` could not reach it,
  because both consulted only the in-memory liveness registry, which is empty by
  construction for a run this process never spawned. Both now resolve the owner
  from the run directory.
- **The rendered `supervisor=` is the arbitrated backend (#209-2 / #216).**
  `supervisor=rpc` was a literal in three render paths, so an in-process child
  was labeled `rpc`. `RunRecord.herdr.supervisor` widens to `SpawnMode`, handles
  carry `spawnMode`, and legacy runs with no such field render `unknown`.
- **Extensions that register providers work in the default backend
  (#209-1 / #213).** The in-process session factory loaded additional extension
  paths into `DefaultResourceLoader` but resolved models through a bare
  `ModelRuntime.create()`, so non-builtin providers were unreachable. Registered
  providers are now drained into the model runtime and their catalog refresh is
  awaited before `resolveCliModel()` reads the synchronous snapshot.
- **`legion-doctor` no longer implies RPC-only remedies for in-process
  children (#212 / #222).** In-process spawns got a false-lead
  `PI_LEGION_CHILD_EXTENSIONS` recommendation and RPC CLI-probe issues
  (`CHILD_NO_MODELS` / `CHILD_FEWER_MODELS`); model gaps now point at
  `models.json`, role extensions, or `inheritExtensions`.
- **An `orphan detected` notice now carries its detection time.** The notice is
  queued through the outbox and can be delivered tens of minutes later; it used
  to look identical to a fresh scan, so the same dead node was triaged repeatedly.
  It now leads with `detected at <ISO>`. `staleMs` is intentionally unchanged —
  it is the value at scan time, matching the persisted `orphan_detected` event.
- **`tok/s` is a decode rate again, and in-process children show it while they
  run.** Two independent causes, both fixed:
  - `generationMs` (the denominator) was derived from the nested
    `message.timestamp`, which marks when generation *started*. It captured only
    prompt→first-token latency — a real 1506s session accumulated 616ms — so the
    `MIN_RATE_GENERATION_MS` floor always tripped and `tok/s` silently fell back
    to a 60s wall-clock window that counted tool wait as generation, and the tree
    row's `avg t/s` (gated on `generationMs >= 1000`) never rendered at all. It
    now sums the measured call length (`message.durationMs`) or, when absent,
    entry-to-entry write times. Nested timestamps stay a last resort for
    synthetic sessions, paired so the two clock axes are never mixed.
  - The railway header showed `0 tok/s` for an in-process child's entire
    lifetime while `rpc` looked correct: `spawnChild` awaits the whole first run,
    so no tracked job exists and the status board only had the ledger node row —
    which has no `generationMs` and, because `pollUsage` skips non-`running`
    nodes, no `tokens_out` until settle either. `statusEntryFromNode` now parses
    `node.sessionFile` directly and falls back to the ledger.
- A live agent stopped by a tool call longer than the 60s window still decays to
  `0 tok/s`. That is the honest answer for the trailing window and is now pinned
  by tests instead of being "fixed" into a stale number later.
- **Completion notices no longer wait for the user's next message.** A child
  finishing while the parent agent run was still active was sent as a
  `followUp`, and the host only drains that queue inside a live run: the notice
  sat invisible until the next prompt. Notices are now held by the extension and
  flushed as one burst on `agent_settled` (hard cap `MAX_PENDING_AGE_MS`, 80 s,
  after which they are force-sent). The join window no longer extends itself on a
  busy parent — that turn-level signal was the wrong predictor and doubled the
  delay.
- **No more phantom `working` rows.** `awaiting`/re-armed states repaint
  immediately and `agent_settled` repaints once, so the widget board never holds
  a stale row past a state change.

### Known limits (deliberately out of scope)

- **Blocked prompts and root notices are still sent as bare `followUp`.**
  `notifyBlocked` (`index.ts`, the blocked-approval prompt) and `notice()`
  (`index.ts`, the root-level advisory) bypass the run-scoped outbox, so while
  the parent run is active they sit in the host queue exactly like the
  completion notices used to. Only completions are covered by this fix; the
  same treatment for those two paths is a follow-up, not part of this change.

## [3.0.2] — 2026-10-18

### Changed

- **Reverted the pnpm migration (#162): npm is the reference path again, and
  the repository no longer enforces any package manager (#210).** Both previous
  attempts to force contributors onto pnpm broke npm consumers: 3.0.0 shipped a
  `preinstall` guard that failed every consumer install, and 3.0.1 replaced it
  with `devEngines.packageManager` (`onFail: "error"`), which npm enforces for
  *every* non-global command in the checkout. The practical effect was that
  `npm run`, `npm pack`, `npm exec`, `npx` (and therefore MCP servers launched
  with `npx`) all failed with `EBADDEVENGINES` inside the repo, and
  `pi install git:<repo>` failed too, because that path is `git clone` +
  `npm install --omit=dev --legacy-peer-deps`.
- `package.json`: dropped `devEngines` (it makes npm reject the whole checkout),
  `packageManager` (corepack then refuses to run npm at all) and `engines.pnpm`.
  `engines.node` stays `>=22`.
- `scripts.test:all` and `scripts.prepublishOnly` compose via `node --run`
  instead of `pnpm run`, so `npm run` and `pnpm run` both work and no script
  names a package manager binary. (`node --run` does not execute pre/post hooks;
  there are none in this manifest.)
- Lockfile: `pnpm-lock.yaml` is replaced by `package-lock.json`, and
  `pnpm-lock.yaml` / `yarn.lock` are gitignored so two lockfiles cannot drift
  apart again. `src/runs/provision.ts` still detects all four lockfiles, so
  contributors who prefer pnpm can keep using it locally.
- CI and release install with `npm ci` (no `pnpm/action-setup`, no `cache:
  pnpm`), and the release workflow packs with `npm pack` again — the
  `pnpm pack` → scratch-directory workaround for `devEngines` is gone.
- `test/unit/publish-manifest.test.ts` now forbids `devEngines` and
  `packageManager` in the manifest and asserts the scripts stay package-manager
  neutral. `release.yml` fails the tag build if either field comes back.

## [3.0.1] — 2026-10-18

### Fixed

- **Published manifest no longer ships a `preinstall` hook.** 3.0.0 added a
  pnpm-only `preinstall` guard meant for repository contributors, and npm always
  packs `package.json`, so the hook shipped to every consumer. Pi installs
  extensions with `npm install <spec> --prefix <agentDir>/npm --legacy-peer-deps`,
  so `pi update --extensions` failed with
  `Use pnpm to install dependencies (see CONTRIBUTING.md).` — npm exited 1 and
  rolled the previously installed version back, which left the
  "Package Updates Available" notice pointing at the same outdated version on
  every start. The pnpm-only intent now lives in `devEngines.packageManager`,
  which npm enforces for the repository root (`EBADDEVENGINES`) and ignores when
  the package is installed as a dependency. The repository keeps all of its
  contributor tooling declarations: `packageManager`, `engines.pnpm` and
  CONTRIBUTING.md are unchanged. (Note: `pnpm pack` omits `packageManager` from
  the tarball, which only affects that dev-only field in the published manifest —
  npm consumers install and load the extension normally.)
- `test/unit/publish-manifest.test.ts` guards the published manifest against
  install-phase scripts (`preinstall` / `install` / `postinstall`) and asserts the
  pnpm requirement stays declared, so this cannot ship again silently.
- `release.yml` now fails the tag build when a published install-phase script was
  reintroduced, before anything is staged.

## [3.0.0] — 2026-10-18

### Added

- In-process `AgentSession` spawn mode (#197): `spawnMode: "rpc" | "inprocess"`,
  `InProcessSupervisor` + `RoutingSupervisor`, and separate
  `subagents.inprocess.*` limit keys. See `docs/inprocess-supervisor.md`.

### Changed

- **BREAKING (#197):** `spawnMode` now defaults to `inprocess`, not `rpc`.
  When the key is omitted and the resolved spawn needs an OS worktree
  (`worktree: true` — the writer/centurion default), Legion falls back to
  `rpc` automatically. Non-`pi` roles are unaffected by this fallback: they
  are refused with `INVALID_PARAMS` before the backend is chosen, because
  only `kind: pi` children are supported at all. An explicit
  `spawnMode: "inprocess"` combined with `worktree: true` is still refused
  with `INVALID_PARAMS` — the fallback only covers the implicit default.
- **BREAKING (#197):** omitting the whole `subagents.inprocess` block no
  longer means "unlimited". The in-process supervisor now falls back to the
  `legion.*` defaults (`maxDepth: 4`, `maxChildrenPerNode: 8`,
  `maxActive: 30`); an explicit block that omits `maxActive` still gets 8.
  `maxSpawnsPerSession` / `waitTimeoutMs` keep no default.
- #197 in-process children read their identity (node id, db path, acceptance
  role, nesting budget) from an AsyncLocalStorage child context instead of
  `PI_SUBAGENT_*` / `PI_LEGION_*` env. In-process sessions share the parent's
  `process.env`, so the env channel delivered the parent's values — or none at
  all in a root parent — and mis-scoped read-only role enforcement. ALS does
  not cross `spawn()`, so `bash` subprocesses can no longer inherit a tree
  identity.
- TUI: drop the footer `N agents running` segment (#192); the aboveEditor
  widget already shows the same count. `STATUS_FOOTER_KEY` / `formatFooterStatus`
  remain exported but `@deprecated` (soft-land).
- Railway lane clock: the leading clock is now "time since the last task
  started" — it keeps ticking through the quiet gap after a turn settles
  (previously it froze at that turn's end, i.e. the *previous* task's elapsed)
  and freezes only when the agent itself ends.
- Railway lane clocks show from round 1. #159 gated them behind `turns >= 2`,
  but a child is usually dispatched with a single user message, so that gate
  hid the clocks almost always and starved the detail column.
- Round 1 prints one clock, not two: that turn starts with the agent, so
  `16s / 17s` was one fact plus the spawn gap.
- Railway column is content-driven: the right-hand name/detail block takes what
  the labels need and the time axis absorbs the rest (floor
  `RAIL_AXIS_MIN_COLS`), so a row fills the line instead of trailing blanks.

### Fixed

- Dropped the `now` / `live` wording from every tok/s surface. "now" meant two
  different things at once (the live-only header rate vs. the chart's x-axis
  right edge), which read as a bug; the stat row key is now `rate`.
- Rail lane detail drops a field for *every* lane when it fits none, instead of
  stripping the role from one long-named row only.
- `make rebuild` rebuilds the sandbox image and swaps the container.
- Real-model sandbox: children get `PI_LEGION_CHILD_EXTENSIONS` so they load
  the provider package (#43) — without it every subagent failed with
  `Unknown provider "any-endpoint"`.
- Subagent detail modal: the area around the frame is no longer black. It was
  mounted as a full-screen overlay, and pi-tui composites an overlay by
  discarding every base cell in its rectangle (there is no transparency option),
  so the viewer's own dim-mask spaces were erasing the host chat / `/legion`
  view and leaving the terminal's default background. The overlay now covers the
  frame rect only, so the host paints everything around it (#193).
  - Geometry is a percentage width with no `maxHeight`, so pi-tui re-derives the
    rect every frame; absolute cells froze at the open-time terminal size and
    clipped the frame's bottom border and Esc hint after a resize.
  - "Click the mask to dismiss" is gone — clicks outside the frame now reach the
    host, as they should. Esc and the title-bar Esc hint still close the modal.

## [2.0.4] — 2026-10-15

### Added

- `/legion timing [--json] [<name>]`: subagent wall / generation / other timing table
  (reuses session summary parsers; live wall marked `+`; footer span vs sum_wall)
  (#148 / #150).
- `/legion` independent **timing** panel (4th pane): wide right-top / stacked bottom /
  portrait between chart↔log; fields align CLI timing; Tab / ↑↓ / Enter / `o` →
  context float (#151 / #152).
- TUI context viewer is a floating modal (dim mask, title **主**/**子**); Esc / mask
  closes without retire or stop (#147 / #149).

### Fixed

- `subagent({ action: "status" })` without `name` returns a live-children overview
  (consistent with wait/stop `all` and slash `/legion status`) (#145 / #146).
- Chart `tok/s · by role` x-domain freezes while idle: `to` advances only on
  substantive `tokensOut` / `generationMs` samples (not wall-clock / flat-collapse)
  (#153 / #154).

## [2.0.3] — 2026-10-15

### Fixed

- `maxChildrenPerNode` only counts **live/running** children; `retire` (including
  Already-retired no-op) frees the budget slot so a full tree can launch again
  after retire. Session keep for resume does **not** occupy the concurrent slot
  (#142 / #143).
- Header tok/s uses `MIN_RATE_GENERATION_MS=1000` (same floor as tree rows): when
  the in-window generation delta is under 1s, fall back to wall-clock so tiny
  `dGen` cannot explode rates into the millions (#140 / #141).

## [2.0.2] — 2026-10-16

### Fixed

- Child worktree launches are suppressed when the parent checkout is itself a
  linked git worktree (`git-dir` ≠ `git-common-dir`): role defaults and unset
  launch flags collapse to `worktree: false`, matching the centurion-child
  precedent. Explicit `launch: true` / per-child `step` flags still win.
- `worktreeBootstrap: "npm-install"` no longer fires `npm install` on a stray
  `package.json` without a lockfile (observed: Java/Maven repos carrying
  package.json for docs/tooling); without a lockfile the mode records the
  marker and skips, so non-npm worktrees launch instead of failing after the
  10-minute bootstrap budget.

### Fixed in 2.0.1 (inherited from prior entries)

- Railway / `/legion` header "now" tok/s is 0 when no agent is running; only live nodes count toward now (chart buckets still use the full trailing window) (#136).
- Narrow/stacked `/legion` header truncates long run + selection badges without overwriting `⚔ /legion`; galaxy legend reserves room for failed/retired glyphs before roles (#125).
- Galaxy legend `statusBudget` counts grapheme cells (not `String.length`); selection badge min width unified for portrait + landscape (#128).
- Dispatched children now receive `--provider` pinned from the parent's model
  registry, so a bare model id (`workbuddy/…`) that also exists under a static
  auth-less provider in `models.json` can no longer hijack the child start
  (`No API key found for …`) (#123).
- Scout-guard now counts first-class `grep` / `find` / `ls` tool calls as reads (#87).
- Doctor diagnose help no longer repeats itself; storage section shows hygiene sweep state (#86).
- Bundled roles no longer advertise unloaded `lens_*` tools (#75).
- Non-interactive `pi --print` waits for async children before cascade retire (#77).
- Roles load `builtin:codemode`; doctor diagnose shows a dedicated section (#89 / #90 → #93).
- Doctor role-tool→extension gates are data-driven / extensible (#97 / #99).
- Launch honors `name=` so `/legion status <name>` matches the railway label (#101 / #104).
- Galaxy legend shows failed/retired glyphs only when those states are present (#102 / #103).
- Live child status leads with `alive · quiet Ns`; long quiet emphasizes living over a stale execution snapshot (#81 / #92 / #105).
- npm `package.json` description/keywords aligned with Legion 2.x RPC (no Herdr panes) (#106 / #111).

### Added

- `/legion status` human-readable summary; doctor slash list covers team / agents / on|off / summary (#76).
- README documents scout-guard settings and `/scout-guard` / `/no-scout-guard` (#74 / #71).
- Scout-guard mock-llm e2e: notify ×1, cooldown, and dispatch clear (#108 / #113).

### Changed

- Esc no longer retires children; only `/legion stop` or session exit retires (esc-no-retire-v3, #134).
- Status strip shows a persistent `/legion stop` hint while children are live (railway + tree; width may truncate) (#134).
- Prefer `PI_LEGION_EXTRA_AGENT_DIRS` over legacy `PI_HERDR_SUBAGENTS_*` (alias; new name wins if both set) (#109 / #114).
- CONTRIBUTING/CI docs aligned with 2.x RPC; verify-12/13 paths point at `test/legacy/docker/` (#95 / #100, #107 / #112).
- README: remove duplicate Child extensions heading (#94 / #98).
- `design.md` historical banner; landed F38–F46 marked ✅ / Historical (#80 / #83 → #91).
- CI PR job runs `test:integration` (#79 / #88).

## [2.0.0] - 2026-10-14

First **Pi Legion** line on headless Pi RPC. Relative to the final Herdr-era
**0.16.x** packages, this is a breaking transport and packaging change.

### Breaking

- **RPC-only transport:** children run as headless `pi --mode rpc` processes
  under `LegionSupervisor`. Herdr pane execution is archived under
  `src/backends/legacy/` and is **not** a v2 runtime option.
- **Kinds:** only `kind: pi` is supported. Migrate non-Pi roles or stay on
  `pi-legion@0.16.x`.
- **Shared tree ledger:** squad state lives in SQLite WAL `legion.db` (phases,
  mail, resume), not pane-centric session bookkeeping alone.
- Bundled agent playbooks aligned with local RPC practice (#66).

### Added

- Recursive centurion trees, four-phase
  planning / implementing / reviewing / verifying machine, `legion_mail`,
  three-layer `/legion` UI (resident tree, full view, live overlay), railway
  strip, tok/s / galaxy / log panels.
- Scout-guard: remind the main session after a streak of read-class tools (#64).
- Storage hygiene sweep on startup: prune idle runs, orphan temp dirs, abandoned
  nodes, event retention, WAL checkpoint (#37 / #38 / #40 → #47).
- `/legion doctor` (+ diagnose) self-check; auto-doctor snippets on gated spawn
  failures (#52).
- Child memory gate (`NODE_OPTIONS` V8 flags, pre-spawn gate) and tree-wide
  verify concurrency limit (#50).
- Children default to `--no-extensions` with explicit/role escape hatches (#43 / #48).
- User stop controls for async children (`/legion stop`, idle Esc, `x` in view) (#41).
- Mock LLM server for offline pi / legion smoke (`test/mock-llm`, #54 / #56).
- GitHub Actions CI (typecheck + unit + integration) and stage-only npm publish
  on tag (#65 / #68).
- Project workflow docs in CONTRIBUTING (#69).

### Changed

- Slash commands consolidated under `/legion` (#57).
- Status bar shows current-turn elapsed beside lifetime total (#62).
- tok/s uses output tokens / generationMs (decode throughput) (#61).

### Fixed

- Railway: pin live spawn verticals when the strip scrolls left (#67); retire /
  downward spawn connector regressions (#46).
- Live worker no longer marked retired on a transient Connection blip (#63).
- Session JSONL streamed + incrementally parsed (no full-file `readFileSync`) (#36 / #45).
- Per-stream child output byte cap; kill on overflow (#35 / #44).
- Bun SQLite `.get()` null treated as miss on root insert (#53).
- Vexillatio sibling naming scoped to the current parent (#42 / #51).

### Security / robustness (design.md F38–F46, already on master)

- Model-scope globs use non-RegExp matching (ReDoS).
- Session create uses `writeFileSync` with `wx` (no fd leak / TOCTOU).
- Session decode swallows scalar JSON lines as torn.
- `tasks[]` / blank task validated before launch.
- Per-agent `timeoutMs`, pending criteria, nested YAML acceptance parsing;
  `UNENFORCED_FIELDS` empty.

## [0.16.x] - Herdr-era (final)

Last line that runs children in Herdr panes. Not developed further on this
branch — pin `pi-legion@0.16.x` if you still need that model. See
[Herdr transition](README.md#supported-kinds) in the README.

Earlier 0.11–0.15 history (including the `pi-herdr-swarm` /
`@zzjcool/pi-herdr-subagents` renames) lives in git tags and older Releases.

[Unreleased]: https://github.com/zzjcool/pi-legion/compare/v5.0.0...HEAD
[5.0.0]: https://github.com/zzjcool/pi-legion/compare/v4.0.0...v5.0.0
[4.0.0]: https://github.com/zzjcool/pi-legion/compare/v3.1.0...v4.0.0
[3.1.0]: https://github.com/zzjcool/pi-legion/compare/v3.0.3...v3.1.0
[3.0.3]: https://github.com/zzjcool/pi-legion/compare/v3.0.2...v3.0.3
[3.0.2]: https://github.com/zzjcool/pi-legion/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/zzjcool/pi-legion/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/zzjcool/pi-legion/compare/v2.0.4...v3.0.0
[2.0.4]: https://github.com/zzjcool/pi-legion/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/zzjcool/pi-legion/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/zzjcool/pi-legion/compare/v2.0.1...v2.0.2
[2.0.0]: https://github.com/zzjcool/pi-legion/releases/tag/v2.0.0
[0.16.x]: https://github.com/zzjcool/pi-legion/releases
