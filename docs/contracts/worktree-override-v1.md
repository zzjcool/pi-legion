# worktree override v1 — a launch may override the role card, and parallel-write isolation gets a supported recipe

> Status: frozen for #451. Supersedes nothing; amends one clause of
> `legion-v2-contract.md` §9 (REV-17 / #214: "centurion cards always get a
> subtree worktree") with an explicit caller override. Regression targets:
> `test/integration/worktree-override.test.ts`.

## 0. The bug this contract exists for

`agents/centurion.md` pins `worktree: true`, and the Legion branch of the
worktree arbitration hardcoded `true` on top of that, so there was **no
expression for "a centurion working inside an existing checkout"**:

```
agents/centurion.md:8                          worktree: true   ← the card
src/agents/agents.ts:920                       setIf(config,"worktree",bool(fm.worktree))
src/runs/orchestrator.ts (legion branch)       isCenturion → true, regardless of the argument
```

The measured workaround was `N workers + N pre-built worktrees + cwd`, which is
write-isolation equivalent but loses four facts a centurion launch gets for
free: the auto-created branch, `node.worktreePath`, the worktree bootstrap, and
retire semantics. The dangerous one is `node.worktreePath`: resume/verify read
`node.worktreePath ?? options.cwd`, so a missing ledger fact does not fail — it
**silently runs against the wrong checkout**. That silence is what this contract
removes: opt out explicitly, and the ledger says `NULL` instead of pretending.

## 1. Decisions

- **D1 — the launch argument wins.** `subagent({ worktree: false })` (or a
  per-item `tasks[].worktree: false`) overrides the role card for that launch:
  the child works in the checkout the launch already selected (`cwd`, i.e.
  `this.cwd` for a local launch), **no tree is created**, and the spawn carries
  `worktree: false`. `true` from a launching caller wins symmetrically (a
  centurion card that says `false` can still be asked to take a tree).
- **D2 — omitted = unchanged, byte for byte.** No `worktree` argument anywhere
  means the role card decides, with the pre-#451 arbitration untouched: on the
  Legion path a centurion still resolves to `true` (the frozen #214 rule), a
  centurion-parent's member still resolves to `false`, and the lib path still
  runs `roleDefault → launch → nested-worktree suppression` in that order. The
  tool layer keeps pre-resolving the value exactly as it did before; the new
  `worktreeSource` field is what distinguishes "the card produced this" from
  "the caller asked for this".
- **D3 — the ledger spelling of "no worktree" is SQL `NULL`.** A fresh row is
  inserted with `worktree_path = NULL`; a revived row is explicitly set to
  `NULL` (never `undefined`, never the cwd, never the previous tree). The
  mutation this guards: recording `cwd` in `worktree_path` "because that is
  where it runs" would make `… ?? cwd` look valid while the record claims an
  isolation that does not exist.
- **D4 — audit field `worktreeSource: "role" | "request"`.** Recorded on
  `ChildRecord` (run.json), **not** a `nodes` column: the ledger schema stays
  v5, and a record written before #451 simply lacks the field (no line is
  invented for it — status output stays byte-identical).
  - `role`    — the launch carried no argument; the card decided.
  - `request` — the launch call carried the boolean. `request` + no
    `worktreePath` therefore means "the caller decided there is no tree": either
    an explicit `worktree:false`, or a `true` that #214 demoted (the demotion is
    its own auditable fact: one `console.warn` + `budget_refused` reason
    `worktree_denied_non_centurion`).
- **D5 — the opt-out is durable.** An explicit `false` never resurrects a
  previous launch's tree: `worktreePath` / `worktreeBranch` / `worktreeHost` are
  cleared from the run.json record and `worktree_path` set to `NULL` in the
  ledger on a revive. Reason: `resume` re-derives its worktree flag from
  `saved.worktreePath`, so a stale path would silently re-create the isolation
  the caller refused.
- **D6 — reverse direction unchanged (#214).** Only `centurion` may hold a
  worktree. A non-centurion `true` — from the card or the launch — is demoted to
  `false` with the same one-time warning, and the demoted launch records no
  tree. `worktree:false` for a non-centurion changes nothing (it was already the
  effective value).

## 2. Where it is visible

`status` (both surfaces share `renderLiveChildStatus`) prints one line when the
record carries a source:

```
worktreeSource=request worktree=none
worktreeSource=role worktree=pi-subagent/centurion-0-1a2b3c4d
```

`/legion summary <name>` (the detail view) prints the same fact as
`worktree: none (source=request)`.

**Reading an ABSENT line.** The line is absent for records written before #451,
and it is also absent in a process that runs a build older than #451 — the two
are indistinguishable from the text alone, so do not read silence as "the
override was honored". Minimum version: the release that contains #451. When a
dispatched child answers with no `worktreeSource=` line at all, check the build
that actually executed it (`grep -r worktreeSource <package>/src`) before
believing the record is old. A live doc-walkthrough during landing hit exactly
this: the session ran the installed 6.2.9 package while the patch was still an
uncommitted checkout change, and every `status` block was silent.

## 3. Recommended parallel-write isolation (the supported recipe)

**One centurion = one delivery unit.** Its members run `worktree: false`
in-process; do not try to get parallel isolation by stacking centurions inside
one another (and #371 already refuses a non-root dispatch of a centurion).

For N independent writers, pre-build N worktrees and pin **each launch call** to one:

```
git -C <repo> worktree add -b feat-a /abs/path/wt-a HEAD
git -C <repo> worktree add -b feat-b /abs/path/wt-b HEAD
```

```
subagent({ agent: "worker", cwd: "/abs/path/wt-a", worktree: false, task: "…" })
subagent({ agent: "worker", cwd: "/abs/path/wt-b", worktree: false, task: "…" })
```

Use ABSOLUTE paths: `cwd` is resolved by the dispatcher, and the example above
is written from the caller's directory, not from the repository root.

One call per tree, and `cwd` at the **call** level: that is the directory the
child actually runs in. A per-item `tasks[].cwd` does **not** pin a child's
working directory today (observed while landing this contract: two `tasks[]`
writers given two different `cwd` values both ran in the dispatcher's checkout
and clobbered the same file). Use separate calls when writers need separate
trees; `tasks[]` is for fan-out inside one directory.

What you own in that shape (this is the price of not using a centurion launch):

- the branch names and their creation;
- provisioning the tree (install/build steps the `legion.worktreeBootstrap`
  setting would otherwise run for you) — a fresh tree has no `node_modules` and
  no toolchain: a doc-walkthrough writer got `tsc: command not found` there;
- cleanup after delivery (`git worktree remove --force <path>`) — nothing in
  the product cleans these up;
- **where the records live**: `cwd` pins the child's working directory, not its
  record directory. Inside a Legion tree the child records still land in that
  run's store (the one that holds `legion.db`), so the pre-built tree stays
  clean — do not look for `.pi-subagents/` under it;
- **the known non-equivalence**: a tree named only by `cwd` is **not** recorded
  as `node.worktreePath`. Readers that derive a candidate root from
  `node.worktreePath ?? options.cwd` (contract path, verification tree,
  resume/collect candidate roots) will fall back to the record cwd instead.
  A `worktree:false` centurion does record the fallback honestly
  (`worktree_path = NULL`), which is why the explicit override is preferable to
  "pretend a hand-built tree is the ledger fact".

Do **not** use multiple centurions for parallel writes. Use a centurion when you
want a delivery unit with its own branch, ledger path, bootstrap and team; use
workers pinned to pre-built trees when you want N parallel edits.

Cross-store/scan limits for children that live under a worktree store are
tracked in **#450** and are deliberately not changed here.

## 4. Verification (what turns red if this regresses)

`test/integration/worktree-override.test.ts` pins:

1. centurion + `worktree:false` → spawn cwd is the caller's checkout, no
   `worktrees/` directory, `nodes.worktree_path === null` (sampled both at spawn
   time and after settle), run.json has `worktreeSource=request`, status shows
   `worktreeSource=request worktree=none`;
2. no argument → a real tree, `rpc`, `worktreeSource=role`, status names the
   branch;
3. explicit opt-out after a tree-holding first launch → the old path/branch are
   gone and the ledger is `NULL`;
4. non-centurion + `true` → still demoted, warned, no tree;
5. a record without `worktreeSource` grows no status line.

Mutation checks performed while landing this (both must fail the suite):
deleting the override (legion branch hardcodes `true` again) fails 1 and 3;
writing `cwd` into `worktree_path` instead of `NULL` fails 1.
