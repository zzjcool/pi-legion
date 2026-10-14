# Contributing

This package is a Pi extension. The public surface is `index.ts` (the
`subagent` tool) plus `src/api.ts` (programmatic imports). Please keep those
two as the only things a downstream should need.

## Setup

```bash
git clone https://github.com/zzjcool/pi-legion.git
cd pi-legion
npm install
```

Requires Node.js 22+ (`node --experimental-strip-types` is how tests run;
there is no compile step to ship).

## Checks

```bash
npm run typecheck
npm test                 # test/unit/*.test.ts
npm run test:integration # fake herdr, no live binary
npm run test:all         # typecheck + unit + integration
```

`npm run test:live` talks to a real herdr. It skips itself unless `HERDR_ENV=1`
and `herdr` is on `PATH`. Do not fail CI on it.

Prefer **TDD** for behaviour changes: a failing test in `test/unit` or
`test/integration` first, then the production code. Integration tests should
go through `createHerdrClient(createFakeRunner(fake))` so argv construction
and JSON parsing stay covered.

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

`test/docker/` runs the package inside `pi-herdr-sandbox:latest` with a copy
of the **host** Pi config (`~/.pi/agent/settings.json`, `models.json`,
`auth.json` if present). The copy is disposable (`/tmp/pi-herdr-docker-home`
by default); the container cannot write back to your real `~/.pi`.

```bash
# image must already exist
docker image inspect pi-herdr-sandbox:latest >/dev/null

bash test/docker/verify-1-child-guard.sh      # child herdr interceptor
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
bash test/docker/verify-12-workspace.sh       # pi install + child pinned to parent Space
bash test/docker/verify-13-kinds.sh           # kind/model matrix; live CodeBuddy when mounted
```

Or all at once:

```bash
npm run test:docker
```

`verify-13-kinds.sh` is **not** in `npm run test:docker`: it bind-mounts host
`codebuddy` / `cursor-agent` and (unless `LIVE_KIND_PROBES=0`) calls live
CodeBuddy. The numbered 1–12 scripts stay offline/mock.

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
| `docs/design.md` | measured herdr findings (F1–F46) |
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
