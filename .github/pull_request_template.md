## What this changes

<!-- One or two sentences. Link the contract doc if this changes a frozen semantic. -->

## Issue linkage

- [ ] `Closes #<child issue>` — **the issue this actually fixes** (the one the reporter filed)
- [ ] `Refs #<parent / related issue>` — the context issue
- [ ] If the report lives in a different issue than the fix target, **both** numbers are named above
- [ ] Anything only **partly** fixed has the remainder split into a new issue and referenced here
- [ ] Whoever closes the leftover issues after merge is named (a missing `Closes` means manual close, not "later")

See [CONTRIBUTING → Project workflow](CONTRIBUTING.md#project-workflow) for why: `#306`
was fixed and shipped in 5.0.1 but stayed open because the commits only said `fix(#280)`.

## Verification

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:integration` (when `src/runs/`, `src/legion/`, or `src/extension/runtime.ts` is touched)
- [ ] New/updated test for a bug fix (failing first, then passing)

## Docs

- [ ] `CHANGELOG.md` `[Unreleased]` entry added
- [ ] `docs/contracts/*.md` updated if a frozen semantic moved
