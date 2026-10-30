## What this changes

<!-- One or two sentences. Link the contract doc if this changes a frozen semantic. -->

## Issue linkage

- [ ] **No issue applies** (release / chore / docs-only) — one-line reason; skip the rest of this block
- [ ] `Closes #<child>` (a report exists in its own issue) **or** `Refs #<issue>` (the report and the fix are the same issue, or only a parent issue exists) — bare `Closes`, not `fix(#<n>):` in a subject
- [ ] Both numbers appear in the line above when they differ (e.g. `Closes #<child>`, `Refs #<parent>`)
- [ ] Anything only partly fixed got a follow-up issue (default owner: the implementer)

See [CONTRIBUTING → Project workflow](CONTRIBUTING.md#project-workflow) for why: `#306`
was fixed and shipped in 5.0.1 but stayed open nearly four days, because no PR body or
commit message carried a bare `Closes #306` — the commits only said `fix(#280)`.

## Verification

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:integration` (when `src/runs/`, `src/legion/`, or `src/extension/runtime.ts` is touched)
- [ ] New/updated test for a bug fix (failing first, then passing)

## Docs

- [ ] `CHANGELOG.md` `[Unreleased]` entry added
- [ ] `docs/contracts/*.md` updated if a frozen semantic moved
