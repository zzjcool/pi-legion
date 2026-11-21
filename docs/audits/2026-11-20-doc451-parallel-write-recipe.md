# docs-verification: §3 "parallel-write isolation" (#451), run as a new user

> Scope: read `docs/contracts/worktree-override-v1.md` §3 + §1 D4 and execute the
> recipe verbatim. No implementation, no commit of product code. Runner branch:
> `pi-subagent/doc451-runner-4253d56b`, branched from `33d8eb2` (6.2.9).
>
> Result in one line: **the write-isolation recipe works first try; the audit
> surface it promises (`worktreeSource=… worktree=…`) does not exist in the build
> a new user runs, and did not exist at this commit at all — so `status` prints no
> such line.** See §4 for the attribution.

## 1. Pre-built trees

```
$ git worktree add -b doc451-a /tmp/legion-451-doc-run/wt-a HEAD
Preparing worktree (new branch 'doc451-a')
HEAD is now at 33d8eb2 chore(release): 6.2.9 — 自动接回跨机 child（#445）+ hc EPIPE 崩溃修复（#447）
$ git worktree add -b doc451-b /tmp/legion-451-doc-run/wt-b HEAD
Preparing worktree (new branch 'doc451-b')
HEAD is now at 33d8eb2 chore(release): 6.2.9 — 自动接回跨机 child（#445）+ hc EPIPE 崩溃修复（#447）

$ git worktree list | grep legion-451-doc-run
/tmp/legion-451-doc-run/wt-a    33d8eb2 [doc451-a]
/tmp/legion-451-doc-run/wt-b    33d8eb2 [doc451-b]
```

## 2. Two writers, one launch call per tree (§3 literally)

`subagent({ agent:"worker", name:"doc451-w-a", cwd:"/tmp/legion-451-doc-run/wt-a", worktree:false })`
and the same call for `-b`. Both settled `ok:true`. Raw outputs reported by the
children, and re-checked by the parent:

| | doc451-w-a | doc451-w-b |
|---|---|---|
| `pwd` | `/tmp/legion-451-doc-run/wt-a` | `/tmp/legion-451-doc-run/wt-b` |
| `git -C . rev-parse --abbrev-ref HEAD` | `doc451-a` | `doc451-b` |
| `cat WRITER.md` | `writer doc451-w-a in /tmp/legion-451-doc-run/wt-a` | `writer doc451-w-b in /tmp/legion-451-doc-run/wt-b` |
| `git -C . status --porcelain=v1` | `?? WRITER.md` | `?? WRITER.md` |

Parent re-verified independently (not trusting the child's paste):

```
$ cat /tmp/legion-451-doc-run/wt-a/WRITER.md
writer doc451-w-a in /tmp/legion-451-doc-run/wt-a
$ cat /tmp/legion-451-doc-run/wt-b/WRITER.md
writer doc451-w-b in /tmp/legion-451-doc-run/wt-b
$ git -C /tmp/legion-451-doc-run/wt-a status --porcelain=v1
?? WRITER.md
$ git -C /tmp/legion-451-doc-run/wt-b status --porcelain=v1
?? WRITER.md
```

`cwd` at the **call** level pinned the child's working directory exactly as §3
claims. No file crossed trees; no commit, no push, no `git add` happened.

## 3. The audit surface (§2 / §1 D4) — not observable

```
$ subagent status doc451-w-a
doc451-w-a — state=retired agent=worker kind=pi
owner: live
execution: success
usage: in=8689 out=4357 cost=0.0000
acceptance: accepted (attested)
context: ctx=12.4K tok
supervisor=inprocess
session=…/.pi-subagents/runs/r-ea663578/doc451-w-a.jsonl

$ subagent status doc451-w-b
doc451-w-b — state=retired agent=worker kind=pi
owner: live
execution: success
usage: in=5632 out=895 cost=0.0000
acceptance: accepted (attested)
context: ctx=7.3K tok
supervisor=inprocess
session=…/.pi-subagents/runs/r-842dce10/doc451-w-b.jsonl
```

No `worktreeSource=… worktree=…` line in either. The corresponding run.json
records carry `cwd`, `nodeId`, `herdr`, `path`, `depth`, `budget` — and **no**
worktree field of any kind (`worktreeSource`, `worktreePath`, `worktreeBranch`,
`worktreeHost` all absent).

## 4. Attribution: doc describes pending work, not the shipped build

Absence is not a rendering-state artifact. Three independent checks:

```
# at the delivered commit (33d8eb2) and every committed branch:
$ git log --all --oneline -S worktreeSource
(no commits)                      # the identifier has never been committed here
$ grep -rn worktreeSource src/    # (nothing)
$ ls test/integration/worktree-override.test.ts
No such file or directory

# the build that actually ran the children:
$ cat ~/.pi/agent/npm/node_modules/pi-legion/package.json | head -3
  "name": "pi-legion", "version": "6.2.9"
$ grep -rl worktreeSource ~/.pi/agent/npm/node_modules/pi-legion/
(nothing)
```

The implementation exists **only as uncommitted working-tree changes in the parent
checkout** (` M src/extension/runtime.ts`, ` M src/runs/orchestrator.ts`,
` M src/extension/summary.ts`, ` M src/extension/playbook.ts`,
`?? docs/contracts/worktree-override-v1.md`, …; mtimes 17:18–17:31, i.e. before
the 17:32 run — the parent checkout was not touched by this run). In that tree the
renderer is `src/extension/runtime.ts:874-876`:

```ts
if (input.worktreeSource !== undefined) {
    lines.push(`worktreeSource=${input.worktreeSource} worktree=${input.worktreeBranch ?? input.worktreePath ?? "none"}`);
}
```

So §1 D4/§2/§4 are accurate **for the pending diff** and unverifiable — indeed
unreachable — for anyone on 6.2.9 or on this branch's HEAD (`33d8eb2`). §4's
"what turns red if this regresses" points at a test file that does not exist at
this commit either.

## 5. Cleanup

```
$ git worktree remove --force /tmp/legion-451-doc-run/wt-a     # exit 0 (no output)
$ git worktree remove --force /tmp/legion-451-doc-run/wt-b     # exit 0 (no output)
$ git branch -D doc451-a doc451-b
Deleted branch doc451-a (was 33d8eb2).
Deleted branch doc451-b (was 33d8eb2).
$ git worktree list | grep legion-451-doc-run
(grep exit 1 — none left)
$ ls -A /tmp/legion-451-doc-run
(empty)
```

## 6. Where the contract is ambiguous or incomplete

1. **Silent absence is indistinguishable from "not supported".** §2 says the line
   is absent for records written before #451. A new user who passes an explicit
   `worktree:false` and sees no line cannot tell "my opt-out was recorded" from
   "this build predates the feature" — exactly the failure mode this run hit.
   Suggest naming a minimum version, or having `status` say `worktreeSource=unknown
   (pre-#451 record)` only in the detail view.
2. **No minimum version anywhere in the doc.** §4 reads as if the code is present;
   a reader has no way to know D1–D6 are *proposed landing*, not shipped behavior.
3. **`git -C <repo> worktree add -b feat-a ../wt-a HEAD` is path-relative to the
   repo root.** The absolute-path form is what actually reads unambiguously in a
   recipe that later says "`cwd` is the directory the child runs in"; spell the
   example with an absolute path.
4. **Run records do not follow the pre-built tree.** With `cwd` pinned to
   `/tmp/legion-451-doc-run/wt-{a,b}`, no `.pi-subagents/` directory was created
   inside either tree; the children's records landed in the *launching* repo's
   store (`…/pi-legion-451-worktree/.pi-subagents/runs/r-ea663578` and
   `r-842dce10`). That is friendly (the trees stay clean of run artifacts) but the
   §3 ownership list only mentions `git worktree remove`, so a reader would not
   learn that record cleanup is separate — worth one sentence next to the #450
   cross-store note.
5. **`tasks[].cwd` does not pin the working directory** is stated as an observed
   fact, not a tested one here (re-testing it requires a deliberate clobber). The
   recommended shape — separate call per tree — is what this run validated.
6. **Provisioning is real, not a formality.** Both children reported the trees had
   no `node_modules` (`tsc: command not found`, exit 127), confirming §3's "you own
   provisioning" bullet: a recipe user who expects `npm run typecheck` to work in a
   fresh `HEAD` tree must run `npm ci` first.

```json
{"ok": false, "reason": "§3 parallel-write isolation worked first try: two call-level cwd launches (worktree:false) produced pwd=/tmp/legion-451-doc-run/wt-a|wt-b on branches doc451-a|doc451-b, each tree holding only its own WRITER.md, no cross-writes, clean removal; §2/§1 D4 audit surface could not be observed - `subagent status doc451-w-a` and `doc451-w-b` print NO worktreeSource line at all (no worktreeSource lines exist to quote), because the field is absent from HEAD 33d8eb2, from every committed branch (git log --all -S worktreeSource empty), from test/integration/worktree-override.test.ts (missing), and from the shipped extension that ran the children (pi-legion@6.2.9 installed: zero occurrences); the implementation exists only as uncommitted parent-checkout changes (src/extension/runtime.ts:874-876), so the doc's audit claim is unverifiable for a new user and §2 needs a minimum version plus an explicit 'absence means pre-#451 build' note."}
```
