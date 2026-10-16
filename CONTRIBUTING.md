# Contributing

This package is a Pi extension. The public surface is `index.ts` (the
`subagent` tool) plus `src/api.ts` (programmatic imports). Please keep those
two as the only things a downstream should need.

## Project workflow

**Issues first.** A bug or feature found while dogfooding starts as a GitHub
issue. Include a repro, the expected behaviour, the actual behaviour, and the
environment (Node version, OS, and the Pi / pi-legion version).

**One concern per pull request.** Link the issue. Open the PR as a draft.
Mark it **Ready for review** when the change is ready and you expect the
required check `ci` to pass.

**Merge gate.** Alice (the maintainer bot) merges only after code review has
passed and the required GitHub Actions check `ci` is green. Do not push
directly to `master`. Implementers do not merge their own pull requests.

**Before you push.** Run:

```bash
pnpm run typecheck
pnpm test
pnpm run test:integration   # or pnpm run test:all
```

The required GitHub Actions check `ci` runs typecheck, unit, integration, and
mock-llm. Run `pnpm run test:integration` (or `pnpm run test:all`) locally
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
(`.github/workflows/release.yml`). Dependencies are installed with **pnpm**;
staging still uses the npm CLI (`npm stage publish`) and a stage-only token.
A maintainer promotes the staged version on npm with 2FA. Do not use plain
`npm publish` in GitHub Actions.

**Communication.** Coordinate in the team channel, or with Alice. Do not ping
the maintainer user for a routine review or merge ask.

## Setup

```bash
git clone https://github.com/zzjcool/pi-legion.git
cd pi-legion
pnpm install
```

Requires Node.js 22+ and **pnpm** 9+ (`packageManager` in `package.json`;
`node --experimental-strip-types` is how tests run; there is no compile step
to ship). Prefer Corepack (`corepack enable`) or install pnpm 9.x. Do not use
`npm install` in this repo.

## Checks

The required GitHub Actions check `ci` (`.github/workflows/ci.yml`, on pull
requests and pushes to `master`) runs, in order:

1. `pnpm run typecheck`
2. `pnpm test` (unit)
3. `pnpm run test:integration`
4. `pnpm run test:mock-llm`

A failing integration step fails `ci`, so nesting and orchestrator regressions
are blocked before merge. `test:live` and `test:docker` stay out of that job.

```bash
pnpm run typecheck
pnpm test                 # test/unit/*.test.ts
pnpm run test:integration # FakeSupervisor / nested fakes; no live `pi` binary
pnpm run test:all         # typecheck + unit + integration
pnpm run test:mock-llm    # also part of the required ci check
```

`pnpm run test:live` is a **pi RPC live** smoke (`test/live/rpc-live.test.ts`).
It skips itself when the `pi` binary is missing from `PATH` (see the probe at
the top of that file). Do not fail CI on it.

Prefer **TDD** for behaviour changes: a failing test in `test/unit` or
`test/integration` first, then the production code. Integration tests should
drive the orchestrator through `FakeSupervisor` (`test/helpers/fake-supervisor.ts`)
so nesting / launch / collect stay covered without a live `pi`. The herdr-era
helpers `createHerdrClient` / `createFakeRunner` remain as **deprecated legacy**
exports (see `src/api.ts` and `test/legacy/`); use them only when touching the
archived Herdr backend.

## Mock LLM

For offline Pi / legion smoke without provider quota, start the scriptable
OpenAI-compatible mock (see [`test/mock-llm/README.md`](test/mock-llm/README.md)):

```bash
pnpm run mock-llm                 # default scenario=echo on :8765
pnpm run test:mock-llm            # engine + HTTP + optional pi --print smoke
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
pnpm run test:docker
```

**Legacy Herdr / Space / kind checks** live under `test/legacy/docker/` (need
pi-legion **0.16.x** Herdr-era setup). They are **not** part of
`pnpm run test:docker`:

```bash
bash test/legacy/docker/verify-12-workspace.sh  # Herdr Space pin (legacy)
bash test/legacy/docker/verify-13-kinds.sh      # kind/model matrix; live CodeBuddy when mounted
```

`verify-13-kinds.sh` also bind-mounts host `codebuddy` / `cursor-agent` and
(unless `LIVE_KIND_PROBES=0`) calls live CodeBuddy. The numbered 1–11 scripts
under `test/docker/` stay offline/mock.

Override paths with `HOST_PI_AGENT`, `DOCKER_PI_HOME`, `PI_DOCKER_IMAGE`.

Each `inside-N-*.sh` is what actually runs **in** the container. Keep those
scripts self-contained: they should still make sense if you `docker exec`
them by hand.

## Layout

| Path | Role |
| --- | --- |
| `index.ts` | Pi extension entry: parent tool + child-guard branch |
| `src/runs/orchestrator.ts` | launch / collect / retire |
| `src/extension/child-guard.ts` | child process interceptor + task appendix |
| `src/extension/budget.ts` | tool/turn/timeout env + bash wrap |
| `src/runs/worktree.ts` | `git worktree` isolation for `worktree: true` |
| `src/extension/runtime.ts` | status widget, watch, auto-recycle |
| `src/extension/blocked.ts` | `onBlocked` confirm / auto-approve / notify |
| `src/runs/acceptance.ts` | `verification-output` command |
| `test/mock-llm/` | Scriptable OpenAI mock for offline pi / legion |
| `agents/*.md` | bundled roles |
| `docs/design.md` | design notes / F1–F46 (incl. historical herdr-era measurements; see file banner) |
| `README.md` | what is actually wired today |

Do not import from `src/` in downstream packages — use
`pi-legion/api`. If a helper needs to be public, re-export
it there and add a test that imports from the API path.

## Agent definitions

A frontmatter key that is parsed but ignored is listed on
`subagent({ action: "list" })` as `⚠ not enforced yet`. If you start honouring
a field, **remove it from `UNENFORCED_FIELDS`** in `src/agents/agents.ts` in
the same change, and add a test that it is no longer reported.

## Style

- TypeScript strict, `noUncheckedIndexedAccess`
- Imports use the `.ts` extension
- Node stdlib only at runtime (plus `typebox` for the tool schema)
- No `git commit` / `git push` unless the maintainer asked for it in that
  conversation
