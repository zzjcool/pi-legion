# #451 — launch-level `worktree` override + the parallel-write isolation recipe

- Issue: pi-legion#451 — *允许 launch 时显式 `worktree:false` 覆盖角色声明（并把 `worktreePath` 记为 null），同时把并行写隔离的推荐写法写进契约*
- Contract: `docs/contracts/worktree-override-v1.md` (new), `docs/legion-v2-contract.md` §9 + REV-37
- Branch: `pi-subagent/hw-nj/pi-legion-451-worktree-c2b86516` (base `master`)
- PR: `Fixes #451`, base `master` (URL in the final verdict)
- No version bump, no tag, no publish. `src/legion/stall-notice.ts` untouched.

## 0. What was actually broken

`agents/centurion.md` pins `worktree: true`, and the Legion branch of the worktree
arbitration hardcoded `true` on top of it (`src/runs/orchestrator.ts`), so a launch
argument could not override the card. "A centurion working inside an existing
checkout" had no expression, and the documented workaround (N workers + N
pre-built worktrees + `cwd`) loses the ledger fact: a tree named only by `cwd` is
not recorded as `node.worktreePath`, and readers fall back to the record cwd
(`node.worktreePath ?? options.cwd`) — silently, which is the dangerous half.

## 1. A — override semantics (landed)

| Fact | Where |
|---|---|
| Explicit launch value wins over the role card; Legion no longer hardcodes `true` | `src/runs/orchestrator.ts:1940` (source split), `:1943-1962` (arbitration; Legion uses `resolveLaunchWorktree({roleDefault:true, launch: <only when request>})`) |
| Explicit opt-out is durable: old path/branch/host are cleared on a revive and never seed the spawn | `src/runs/orchestrator.ts:1973` (`explicitWorktreeOptOut`), `:2220-2221` (seed), `:2269` (reservation writes `null`), `:2431-2438` (record cleared + source kept) |
| Ledger spelling "no tree" = SQL `NULL` (not `undefined`, cwd, or the previous path) | `src/runs/orchestrator.ts:1397` (`reserveNode` revive: `input.worktreePath === null ? null : …`), `:2269` |
| Audit field `worktreeSource: "role" \| "request"` on `ChildRecord` (run.json, **not** a `nodes` column; schema stays v5) | `src/shared/types.ts:455` (type), `:534` (record field); written at `src/runs/orchestrator.ts:1468,1495,2438,2469` |
| Tool layer passes the caller's intent without changing the pre-resolved value (no-arg behaviour stays byte-identical, incl. the nested-worktree probe path) | `index.ts:5498-5506` |
| `status` shows `worktreeSource=request worktree=none` / `…=role worktree=<branch>` on both surfaces | `src/extension/runtime.ts:874` (shared `renderLiveChildStatus`), `index.ts:6793` (`childWorktreeFacts`, wired at `:2722`, `:3969`, `:6989`), `src/extension/summary.ts:666` (`worktree: none (source=request)`) |
| Reverse rule unchanged: non-centurion `true` still warns once and is demoted to false | `src/runs/orchestrator.ts:1962-1965` (untouched) |

No `nodes` column was added; the ledger schema and the event set are unchanged.

## 2. B — documentation (landed)

- New contract `docs/contracts/worktree-override-v1.md`: the override (D1–D6), the
  status surface + how to read an ABSENT line (minimum build), and §3 "recommended
  parallel-write isolation".
- `src/extension/playbook.ts:16`: rule 6 now names the override, the recipe
  (N pre-built worktrees, **one launch call per tree**, call-level absolute `cwd`,
  `worktree:false`, you own branch/provisioning/cleanup), the `tasks[].cwd`
  limitation and the pointer to #450.
- `docs/legion-v2-contract.md`: §9's "centurion cards always get a tree" clause
  now records the explicit-override exception; REV-37 added with the full rule.

## 3. Acceptance (all four, with the commands that produced them)

### 3.1 Acceptance 1 — centurion + `worktree:false`

Pinned by `test/integration/worktree-override.test.ts` ("acceptance 1"):

```
$ node --experimental-strip-types --test test/integration/worktree-override.test.ts
✔ #451 acceptance 1: a centurion launched with worktree:false works in THIS checkout and records NULL
```

Assertions: spawn `cwd` = the caller's checkout; `spawn.agent.worktree === false`;
`handle.child.worktreePath === undefined`; `handle.child.worktreeSource === "request"`;
`<runDir>/worktrees` does not exist; `nodes.worktree_path === null` (strict, sampled
**twice**: at spawn time and after settle) and `!== cwd`; run.json carries
`worktreeSource=request`; `status` contains `worktreeSource=request worktree=none`.

### 3.2 Acceptance 2 — no argument = today, byte for byte

Same file ("acceptance 2"):

```
✔ #451 acceptance 2: no worktree argument keeps today's behaviour byte for byte (tree + source=role)
```

A real `git worktree add` tree, `spawnMode=rpc`, run.json `worktreeSource=role`,
status names `pi-subagent/centurion-0-…`. The tool layer still passes the
pre-resolved value (`index.ts:5499`) so an omitted argument keeps the old
`roleDefault → launch → nested-worktree suppression` order, including a
dispatcher that itself sits inside a worktree.

### 3.3 Acceptance 3 — mutations actually turn the suite red

Three mutations were applied one at a time, run, and reverted:

| Mutation | Result |
|---|---|
| Delete the override (Legion branch hardcodes `launch: undefined`) | **red**: acceptance 1 and 3 fail (`✖` 2 of 5) |
| Record `this.cwd` instead of `null` in `reserveNode` | **red**: acceptance 1 fails (the spawn-time row sample catches it) |
| Record the cwd instead of the tree on the child (`appliedWorktreePath ?? this.cwd`) | **red**: acceptance 1 and the #214 case fail |

The whole file, before/after each revert: `5 pass / 0 fail`.

### 3.4 Acceptance 4 — a real agent ran the documented scenario

A fresh centurion (`doc451-runner`) was given only the contract path and told to
follow §3 as a new user. Verbatim result (its full audit is in the child output):

```
$ git worktree add -b doc451-a /tmp/legion-451-doc-run/wt-a HEAD
$ git worktree add -b doc451-b /tmp/legion-451-doc-run/wt-b HEAD
$ git worktree list | grep legion-451-doc-run
/tmp/legion-451-doc-run/wt-a   33d8eb2 [doc451-a]
/tmp/legion-451-doc-run/wt-b   33d8eb2 [doc451-b]
```

Two separate `subagent` calls, `cwd` at the call level, `worktree:false`:

| | doc451-w-a | doc451-w-b |
|---|---|---|
| `pwd` | `/tmp/legion-451-doc-run/wt-a` | `/tmp/legion-451-doc-run/wt-b` |
| branch | `doc451-a` | `doc451-b` |
| `WRITER.md` | `writer doc451-w-a in /tmp/legion-451-doc-run/wt-a` | `writer doc451-w-b in /tmp/legion-451-doc-run/wt-b` |
| `git status --porcelain` | `?? WRITER.md` | `?? WRITER.md` |

Each tree held only its own file, zero cross-writes; cleanup
(`git worktree remove --force` ×2, `git branch -D` ×2) left nothing behind. The
runner also confirmed the "you own provisioning" bullet from the inside
(`tsc: command not found` in a fresh tree).

**Honest caveat on the audit-surface half.** The live session in this worktree runs
the *installed* `pi-legion@6.2.9` package, not this uncommitted checkout, so the
runner's children executed 6.2.9 and their `status` blocks had no
`worktreeSource=` line at all (`grep -rl worktreeSource ~/.pi/agent/npm/node_modules/pi-legion/` → empty).
That is exactly why §2 now spells out "an absent line can also mean an older
build". The audit surface itself is proven by the five integration tests above,
which run against this tree.

The runner's critique was folded back into the contract before this report:

1. absent-line ambiguity → §2 "Reading an ABSENT line" (minimum build);
2. relative example paths → §3 and the playbook now say **absolute** `cwd`;
3. records do not follow the pre-built tree (`cwd` pins the working directory,
   records stay in the Legion run's store) → §3 ownership list corrected;
4. provisioning is real (no `node_modules` in a fresh tree) → §3 bullet made explicit;
5. `tasks[].cwd` does not pin a child → §3 states it as observed, with the
   clobber it caused during this landing.

Side effect worth naming: the runner opened its own audit PR (#453) with its
168-line walkthrough (`docs/audits/2026-11-20-doc451-parallel-write-recipe.md`).
It is incidental evidence, not part of this delivery, and was not merged.

## 4. Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **2907 / 2907 pass** (master baseline 2907; +0) |
| `npm run test:integration` | **206 / 206 pass** (master baseline 201; +5 = the new file) |

Baseline was measured on the same machine on this branch's starting commit
(`33d8eb2`, 6.2.9) before any edit: `2907 / 201`.

Frozen-test check: `test/unit/launch-worktree-probe.test.ts`,
`test/unit/worktree-centurion-only.test.ts` and
`test/unit/spawn-mode-arbitration*` were not modified. The only changed existing
test is `test/unit/playbook.test.ts` (its old assertion pinned the removed
sentence "Isolation belongs to centurion"; it now pins the #451 wording).

## 5. Known non-goals / follow-ups

- **#450** (cross-store/scan limits for children whose records live under another
  store) is referenced in the docs, not fixed here.
- A per-item `tasks[].cwd` still does not change a child's working directory. The
  docs state the working recipe (one call per tree) instead of silently relying
  on a shape that does not work; changing the step-cwd semantics is a separate
  contract change.
- `worktreeSource` is run.json-only by design. A record rebuilt from the ledger
  (`childFromNode`) has no source, so no line is printed for it — never a guessed
  one.
