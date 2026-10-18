# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Published GitHub Release notes remain available at
https://github.com/zzjcool/pi-legion/releases — this file is the in-repo
summary so you can see **2.x vs 0.16** without leaving the tree.

## [Unreleased]

### Fixed

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
  immediately, `agent_settled` repaints once, and a watch continuation whose
  generation was invalidated now releases the job it was watching instead of
  leaving it tracked forever. The release is **identity-checked**: it happens
  only when that same job object is still the one tracked under the name, so a
  stale continuation can never delete a newer job that reused the name. While an
  explicit `stop` has a `retire` in flight the job is held (not released), so a
  failed retire can still rewatch a live child instead of leaking it untracked.

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
[Herdr transition](README.md#herdr-transition-and-role-migration) in the README.

Earlier 0.11–0.15 history (including the `pi-herdr-swarm` /
`@zzjcool/pi-herdr-subagents` renames) lives in git tags and older Releases.

[Unreleased]: https://github.com/zzjcool/pi-legion/compare/v3.0.2...HEAD
[3.0.2]: https://github.com/zzjcool/pi-legion/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/zzjcool/pi-legion/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/zzjcool/pi-legion/compare/v2.0.4...v3.0.0
[2.0.4]: https://github.com/zzjcool/pi-legion/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/zzjcool/pi-legion/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/zzjcool/pi-legion/compare/v2.0.1...v2.0.2
[2.0.0]: https://github.com/zzjcool/pi-legion/releases/tag/v2.0.0
[0.16.x]: https://github.com/zzjcool/pi-legion/releases
