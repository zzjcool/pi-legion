# Contributing

This package is a Pi extension. The public surface is `index.ts` (the
`subagent` tool) plus `src/api.ts` (programmatic imports). Please keep those
two as the only things a downstream should need.

## Project workflow

**Issues first.** A bug or feature found while dogfooding starts as a GitHub
issue. Include a repro, the expected behaviour, the actual behaviour, and the
environment (Node version, OS, and the Pi / pi-legion version).

**One concern per pull request.** Link the issue (none needed for a
`release:` / `chore:` / docs-only PR — say so in the PR body). Open the PR as
a draft.
Mark it **Ready for review** when the change is ready and you expect the
required check `ci` to pass.

**Link every issue you touch, not just the parent.** GitHub only auto-closes an
issue on a bare `Closes #<n>` line (`Fixes` / `Resolves` also work) in a PR
body or a commit message. A `fix(#<n>):` subject **names** the issue and closes
nothing. A fix that says `fix(#280)` while the report actually lives in `#306`
leaves `#306` open forever, and the next reader cannot tell whether the work
never landed or was merely forgotten — that is exactly what happened to `#306`
(fixed in `19ea0cf` … `ac26836`, shipped in 5.0.1, still open for nearly four
days, hand-closed by the maintainer). So:

- `Closes #<child>` for **the issue being fixed** — the one the reporter filed.
- `Refs #<parent>` (or `Refs #<sibling>`) for the context issue.
- `fix(#<child>): …` in a commit subject is a **naming convention only**; it
  does not close anything. The actual close is a separate bare `Closes #<child>`
  line, in the PR body or in the commit body — not packed into the subject's
  parentheses.
- No `Closes` for a given issue? Then closing it stays a manual step after
  merge — do it in the same pass, not "later".

**Before you ask for merge.** Re-read the issue you were handed and check the
PR closes *that* one, not an issue one level up.

**Merge gate.** Alice (the maintainer bot) merges only after code review has
passed and the required GitHub Actions check `ci` is green. Do not push
directly to `master`. Implementers do not merge their own pull requests.

**Before you push.** Run:

```bash
npm run typecheck
npm test
npm run test:integration   # or npm run test:all
```

The required GitHub Actions check `ci` runs typecheck, unit, integration, and
mock-llm. Run `npm run test:integration` (or `npm run test:all`) locally
before you push, especially when the change touches `src/runs/`, `src/legion/`,
or `src/extension/runtime.ts`.

Add the unit tests the change needs. Prefer **TDD** (see [Checks](#checks)):
a failing test in `test/unit` or `test/integration` first, then the production
code.

**Regression tests.** When you fix a bug, add a unit or integration test in
the same PR when that is feasible: failing first, then passing. Do not
`unref()` a timer that must keep the Node test runner alive. `unref()` drops
the timer from the event-loop refcount, so `node --test` can exit before the
callback runs. That is the rpc-supervisor retire-timer lesson (`waitForExit`
and the descendant-sweep delay in `src/supervisor/rpc-supervisor.ts`): a
timeout the caller is awaiting stays referenced, as with the wait timer in
`src/extension/runtime.ts`.

**npm release.** A `v*.*.*` tag runs the release workflow
(`.github/workflows/release.yml`). Dependencies are installed with **npm**;
publishing is **npm trusted publishing (OIDC)** — there is no `NPM_TOKEN` and
no manual approval step. The job declares `id-token: write`, the registry
trusts this repository plus the workflow filename (`release.yml`), and the npm
CLI exchanges the job's OIDC token for a short-lived publish credential.
Provenance is attached from the same token, so the tarball is verifiably built
from that commit:

```bash
npm install -g npm@^11.15.0   # Node 22 still bundles npm 10
npm publish --provenance --access public
```

The OIDC exchange needs npm CLI >= 11.5.1 (`release.yml` pins `npm@^11.15.0`
for that reason) and Node >= 22.14, which `node-version: 22` with
`check-latest` already satisfies.

Cut a release in this order — skip a step and the workflow fails:

1. Write the release notes into `CHANGELOG.md`.
2. Bump `version` in `package.json` and refresh `package-lock.json` in the same
   change.
3. Commit as `release: x.y.z`.
4. Tag that commit `vx.y.z` and push the tag.

Step 4 is gated: `Check tag matches package.json version` compares
`GITHUB_REF_NAME` against `v<package.json version>` and exits 1 on a mismatch,
so the bump and the tag must land together — the tag alone publishes nothing.
Release notes are read from the tag annotation
(`git for-each-ref refs/tags/<tag> --format='%(contents)'`), and the job re-runs
typecheck / unit / integration / mock-llm before it publishes.

**Communication.** Coordinate in the team channel, or with Alice. Do not ping
the maintainer user for a routine review or merge ask.

**Closing issues is part of the work.** Merge is not done until every issue
the change resolved says `CLOSED`, and every issue it only *partly* resolved
has the remainder split into a new issue (see `#317`, split out of `#306`).

## Setup

```bash
git clone https://github.com/zzjcool/pi-legion.git
cd pi-legion
npm install
```

Requires Node.js 22+ (`node --experimental-strip-types` is how tests run; there
is no compile step to ship). **npm is the reference path** — it is what Pi uses
for `pi install` / `pi update --extensions` and what the git-source install
path runs, so the repository must stay installable and usable with npm.

**Do not add package-manager enforcement.** A `preinstall` guard (3.0.0)
failed every npm consumer; `devEngines.packageManager` / `packageManager`
(3.0.1) made every npm command in the checkout fail with `EBADDEVENGINES` and
broke `pi install git:<repo>`. See issue #210. pnpm may be used locally by
anyone who prefers it — `node --run` keeps the scripts neutral — but the
repository does not demand it, and CI uses `npm ci`.

> pnpm 12+ users: the manifest no longer pins a pnpm version, so a modern pnpm
> refuses the install with `ERR_PNPM_IGNORED_BUILDS` (`@google/genai` and
> `protobufjs` have build scripts). Either run `pnpm approve-builds`, or install
> with `pnpm install --config.strict-dep-builds=false`. Do not add an `.npmrc`
> for this — npm warns about the unknown key on every command.

## Checks

The required GitHub Actions check `ci` (`.github/workflows/ci.yml`, on pull
requests and pushes to `master`) runs, in order:

1. `npm run typecheck`
2. `npm test` (unit)
3. `npm run test:integration`
4. `npm run test:mock-llm`

A failing integration step fails `ci`, so nesting and orchestrator regressions
are blocked before merge. `test:live` and `test:docker` stay out of that job.

```bash
npm run typecheck
npm test                 # test/unit/*.test.ts
npm run test:integration # FakeSupervisor / nested fakes; no live `pi` binary
npm run test:all         # typecheck + unit + integration
npm run test:mock-llm    # also part of the required ci check
```

`npm run test:live` is a **pi RPC live** smoke (`test/live/rpc-live.test.ts`).
It skips itself when the `pi` binary is missing from `PATH` (see the probe at
the top of that file). Do not fail CI on it.

Three heavier checks stay out of `ci`; run them when you touch what they cover:

| Command | What it covers |
| --- | --- |
| `npm run test:perf` | `test/perf/*.test.ts` — collect latency, ledger write/read cost, event-bus poll, session JSONL parse |
| `npm run test:wal-stress` | `test/stress/wal-stress.ts` — 60 concurrent supervisors against one WAL `legion.db` (contract §14-M2 (g); `-- --duration 30` for a quick smoke) |
| `npm run test:tui-visual` | builds `test/docker/Dockerfile.tui-sandbox`, then runs `test/docker/verify-tui-visual.sh` (mock LLM + tmux + ANSI→PNG) |

`.github/workflows/docker-tui-sandbox.yml` rebuilds and pushes that sandbox image
(`ghcr.io/<repo>/tui-sandbox`) on `master` when the Dockerfile, the ANSI→PNG
helper, or the visual script changes.

Prefer **TDD** for behaviour changes: a failing test in `test/unit` or
`test/integration` first, then the production code. Integration tests should
drive the orchestrator through `FakeSupervisor` (`test/helpers/fake-supervisor.ts`)
so nesting / launch / collect stay covered without a live `pi`. The old
herdr-era `createHerdrClient` / `createFakeRunner` helpers are **gone** as of
v4.0.0, together with `src/backends/legacy/` and `test/legacy/`; everything
runs as `kind: pi`, in-process or over `pi --mode rpc`.

## Mock LLM

For offline Pi / legion smoke without provider quota, start the scriptable
OpenAI-compatible mock (see [`test/mock-llm/README.md`](test/mock-llm/README.md)):

```bash
npm run mock-llm                 # default scenario=echo on :8765
npm run test:mock-llm            # engine + HTTP + optional pi --print smoke
```

`test/docker/mock-llm.mjs` launches the same CLI (default scenario `tool-once`
for legacy inside-*.sh). Point Pi at it with `writeMockPiHome({ baseUrl })` or
the `providers.mock` block in that README. Never commit real API keys; the
dummy key is always the literal `mock`.

## Docker verification

`test/docker/` runs the package inside the RPC / pi-legion sandbox image.
Default image and staging path names are **historical** (`pi-herdr-sandbox:latest`,
`/tmp/pi-herdr-docker-home`; override with `PI_DOCKER_IMAGE` / `DOCKER_PI_HOME`).
Content is the 2.x RPC sandbox, not a live herdr pane host. The scripts copy
the **host** Pi config (`~/.pi/agent/settings.json`, `models.json`, `auth.json`
if present) into that disposable home; the container cannot write back to your
real `~/.pi`.

```bash
# image must already exist (historical default name; do not rename a local tag
# just to match docs — override with PI_DOCKER_IMAGE if yours differs)
docker image inspect pi-herdr-sandbox:latest >/dev/null

bash test/docker/verify-1-child-guard.sh      # RPC child-guard / ledger block
bash test/docker/verify-2-task-appendix.sh    # frozen task appendix
bash test/docker/verify-3-readonly.sh         # read-only bash denylist
bash test/docker/verify-4-acceptance.sh       # collect → verified
bash test/docker/verify-5-blocked.sh          # onBlocked forward
bash test/docker/verify-6-cache.sh            # collect cache / retire no-op
bash test/docker/verify-7-budget.sh           # tool/turn budget + bash timeout
bash test/docker/verify-8-verify-command.sh   # criterion.command + timeout
bash test/docker/verify-9-worktree.sh         # git worktree cwd
bash test/docker/verify-10-fallback.sh        # fallbackModels
bash test/docker/verify-11-nested-alias.sh    # nested + alias + completionGuard
```

Or all at once (RPC mainline **1–11** only):

```bash
npm run test:docker
```

Override paths with `HOST_PI_AGENT`, `DOCKER_PI_HOME`, `PI_DOCKER_IMAGE`. Every
`verify-*.sh` honors `PI_DOCKER_IMAGE` (all eleven, not just 1 and 7, since #367's
follow-up), so a locally built `tui-sandbox:latest` works without retagging; the
historical default is only a fallback. `make rpc` in `test/docker` runs the eleven
against `$(IMAGE)`.

### Verifying a plugin code change in the sandbox

`/plugin` is a read-only mount of this checkout, so a code change does **not**
need a rebuild — `make rebuild` is only for `Dockerfile` / pi-version changes
(and it deletes the container, so follow it with `make up`). The agent-executable
path is:

```bash
cd test/docker && make rebuild && make up && make smoke && make rpc
```

`make run` is the interactive TUI (`docker exec -it`) and needs a real terminal.
Two non-interactive probes that answer "what does a child agent actually get"
live in [`test/docker/README.md`](test/docker/README.md#改完插件代码后怎么测agent-可执行) —
the important gotcha is that MCP tools have `deferred` exposure, so a child's
tool list never shows `mcp__*`; count `ALL_TOOLS` from inside a codemode script
instead.

Each `inside-N-*.sh` is what actually runs **in** the container. Keep those
scripts self-contained: they should still make sense if you `docker exec`
them by hand.

## Layout

| Path | Role |
| --- | --- |
| `index.ts` | Pi extension entry: parent tool + child-guard branch |
| `src/agents/` | role cards: frontmatter parsing + validation, `subagent({ action: "list" })` payload |
| `src/supervisor/` | spawn backends (`RpcSupervisor` / `InProcessSupervisor` / `TerminalSupervisor`) arbitrated by `RoutingSupervisor` |
| `src/legion/` | shared team state: `legion.db` schema, phase machine, node tree, mail, stall notice |
| `src/hc/` | `hc connect` JSON-RPC client — the hc-terminal transport behind the terminal backend |
| `src/shared/` | cross-layer types, pi session JSONL parsing, process sweep, output caps |
| `src/tui/` | TUI viewer: tree view, live overlay, viz panels |
| `src/runs/orchestrator.ts` | launch / collect / retire |
| `src/extension/child-guard.ts` | child process interceptor + task appendix |
| `src/extension/budget.ts` | tool/turn/timeout env + bash wrap |
| `src/runs/worktree.ts` | `git worktree` isolation for `worktree: true` |
| `src/extension/runtime.ts` | status widget, watch, auto-recycle |
| `src/extension/blocked.ts` | `onBlocked` confirm / auto-approve / notify |
| `src/runs/acceptance.ts` | `verification-output` command |
| `test/mock-llm/` | Scriptable OpenAI mock for offline pi / legion |
| `agents/*.md` | bundled roles |
| `examples/` | parent/child context cards — **repo-only**: absent from `package.json` `files`, so they do not ship with the package |
| `docs/design.md` | design of the 5.5.0 architecture (five layers, phase machine, `legion.db`, mail/notice) — code is the source of truth |
| `docs/archive/design-herdr-era.md` | historical herdr-era design notes (F1–F46); superseded by v4/v5, kept for context only |
| `README.md` | what is actually wired today |

Do not import from `src/` in downstream packages — use
`pi-legion/api`. If a helper needs to be public, re-export
it there and add a test that imports from the API path.

## Agent definitions

A frontmatter key that is parsed but ignored is listed on
`subagent({ action: "list" })` as `⚠ not enforced yet`. If you start honouring
a field, **remove it from `UNENFORCED_FIELDS`** in `src/agents/agents.ts` in
the same change, and add a test that it is no longer reported.

That list is currently **empty** (`const UNENFORCED_FIELDS = [] as const` in
`src/agents/agents.ts`), so nothing is reported as unenforced today; adding a
key there is how you flag a field you parse but do not yet honour.

## Style

- TypeScript strict, `noUncheckedIndexedAccess`
- Imports use the `.ts` extension
- Node stdlib only at runtime (plus `typebox` for the tool schema)
- No `git commit` / `git push` unless the maintainer asked for it in that
  conversation
