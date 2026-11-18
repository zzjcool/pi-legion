# first-run success v1 (frozen contract)

Status: frozen. Base: `master` @ `962992f` (6.2.0). Branch: `feat/first-run-success`.

## Why

A real 103-line session (6.2.0) was asked "demo the cross-machine centurion" and failed
five times before the user interrupted it. Each failure was a **fact the tool already
had** (or could get with one probe) reported as something the reader had to research:

1. the parent's cwd was not a git checkout → the error said "this checkout has no
   origin" and told the reader to `git remote add origin` **in a directory that is not
   a repository** — the one advice that cannot work there;
2. an inherited extension was missing on the target → the error named the package but
   not the key that fixes it (`subagents.agentOverrides.<role>.excludeExtensions`), so
   the reader opened `src/runs/extension-inheritance.ts`;
3. the reader then tried to work around the tool (`hc run … pi -p …`), burning turns;
4. the per-call remote directory was a guess (`hostCwd` vs `cwd`), and `--help` truncates
   the one sentence that distinguishes them;
5. no single command answered "what is missing right now, and what do I type next?".

The product target (added by the user after the evidence was reviewed) is stronger than
"better messages": **a cross-machine centurion must take the same inputs as a local one**,
the only new input being the directory ON the target machine. When that directory is
unknown the tool must **ask**, not hand out a configuration lesson.

## Decisions

- **D1 Goal.** First attempt succeeds; when it cannot, the first error contains a
  directly pasteable fix. "Missing fact" is answered by (a) automatic discovery, or
  (b) a question to the user. **Never** by "read this source file" and — for a caller —
  never by "edit settings" as the primary instruction. A settings key may appear only as
  a one-clause aside after the action.

- **D2 Missing remote directory is a QUESTION.** One shared function in
  `src/runs/remote.ts`, `missingRemoteCwdQuestion(host)`, used by both
  `resolveHostTarget` (both the `mentionPerCallCwd` branch and the legacy branch) and by
  `resolveHostTargetAsync` **before discovery starts**. Frozen text (one message, four
  sentences, may only be re-wrapped):

  ```
  host 'vps' needs a directory on that machine, and this call did not name one — which directory should the child work in? Pass it with the call: subagent({ agent: "centurion", host: "vps", cwd: "/abs/path/on/vps", task: "..." }) (that path is read ON vps; it is never translated from here). If this conversation has not named a directory on vps, ask the user which one to use. Do not ssh or run `hc exec` to browse that machine — a guess here becomes a child in the wrong tree.
  ```

  - Ordering: the refusal happens **before any `machine.exec`** (no discovery probe, no
    `test -d`, no `--list-models`). `machine.list` (one `hc connect` round trip) is
    allowed and already happens before it.
  - `details`: `{ host, cwd: "", reason: "cwd-missing" }`, `noModelFallback: true`.

- **D3 Zero configuration except the directory.** `{"subagents":{"crossMachine":{"enabled":true}}}`
  with no `hosts` block is a complete configuration when `hc machine ls` knows the name
  and the call passes `cwd` (or `hostCwd`). `resolveHostTargetAsync` already synthesizes
  `entry = {}` after admission; this decision freezes that as the contract and adds a
  test that proves it end to end through the real `HcCliClient` + fake core. `node`,
  `piCli`, `piLegionRoot` and provider extensions come from discovery; `cwd` is the one
  input that must be given.

- **D4 The missing-package error carries the fix.** `packagePathError` in
  `src/runs/remote.ts` gains the concrete role when the caller knows it
  (`mapRemoteArgv(..., { role })`, supplied by `terminal-supervisor` from
  `input.agent.name`). Frozen shape:

  ```
  host 'vps': the extension '/Users/me/pi-sysmon/extensions/index.ts' belongs to package 'pi-sysmon', which is not installed on that machine (the launch would have silently dropped it). Two ways out: 1) install it there — hc exec --on vps -- pi install npm:pi-sysmon (same entry names are then mapped automatically); 2) keep it on this machine only, for role 'centurion': subagents.agentOverrides.centurion.excludeExtensions — {"subagents":{"agentOverrides":{"centurion":{"excludeExtensions":["pi-sysmon"]}}}}
  ```

  Without a role (resume / read-back paths) the second way out reads
  `for the role you launch: subagents.agentOverrides.<role>.excludeExtensions` and the
  JSON is omitted. `details` keeps `{ host, extension, package, reason }` and gains
  `role` when known. The sentence `which is not installed on that machine` is preserved
  verbatim (it is grepped by tests and docs).

- **D5 The parent-side delivery facts are three different answers.**
  `src/runs/remote-worktree.ts` exports one more message, and
  `cross-machine-preflight.ts` step 2 asks git TWO questions (`rev-parse --git-dir`,
  then `remote get-url origin`) so it can pick the right one:

  - not a checkout at all — `notALocalCheckoutMessage({ host, localRepo })`:
    ```
    cross-machine delivery needs a git checkout on this machine too, and this session's directory (/Users/me/agents) is not one. Two ways out: 1) run the launch from a checkout — start pi inside yours, or pass a relative cwd that points at one (with `host` named, an ABSOLUTE cwd is the directory ON that machine): subagent({ agent: "centurion", host: "vps", cwd: "../my-repo", task: "..." }); 2) dispatch a worker instead — subagent({ agent: "worker", host: "vps", task: "..." }) needs no checkout and no origin.
    ```
  - checkout without `origin` — the existing `noLocalOriginMessage`, **unchanged**
    (it is correct in this case and 4 tests pin it);
  - both have one and they differ — existing `originMismatchMessage`, unchanged.

  The `Two ways out` convention and the `cross-machine delivery needs one shared remote`
  grep-able prefix stay: the not-a-checkout message keeps
  `cross-machine delivery needs a git checkout on this machine too` and the
  no-origin message keeps `needs one shared remote`. `assertSharedOrigin` (the worktree
  creator's guard) applies the same three-way split by reusing the same probe helper, so
  the two call sites cannot drift.

- **D6 `/legion doctor crossmachine` is a one-command checkup.** A new module
  `src/runs/cross-machine-checkup.ts` exports
  `runCrossMachineCheckup(options): Promise<CrossMachineCheckup>`; it performs every
  probe, in read-only fashion (no `git` writes, no `mkdir`, no launch), and returns
  structured items. `legion-doctor.ts` stays **synchronous and probe-free**: it renders
  the snapshot it is given (`DoctorOptions.crossMachineCheckup`). Both async callers
  (`/legion doctor` in `legion-commands.ts`, `subagent({action:"diagnose"})` in
  `index.ts`) await the checkup **only when the `crossmachine` section is selected**, so
  every other doctor run keeps its current cost and its zero-probe promise.
  Host enumeration is `Object.keys(settings.hosts)` **∪** `hc machine ls`, in that order,
  deduped — the v1.1 "only `enabled: true`" configuration must appear in the report.

- **D7 Checkup items (order frozen).** Each item is `PASS` / `FAIL` / `SKIP`, one line per
  fact, `FAIL` lines carry `fix:` lines that are commands or a JSON snippet with REAL
  values (host, paths, package, role):

  1. `parent checkout` — is this session's cwd a git checkout? what is its origin?
     (FAIL here also names the D5 remedy: relative `cwd` / start pi in the checkout.)
  2. `hc machines` — the `machine.list` answer, printed; FAIL when the host is absent,
     with the `hc machine add` line.
  3. `target checkout` — `test -d <cwd>` on that machine; FAIL names the directory and
     the `ls` to run, or (when no cwd is known) prints the D2 question.
  4. `target origin` — `<cwd>` is a checkout there and its origin equals this checkout's
     (normalized); FAIL names both urls and the `set-url` command.
  5. `target runtime` — node version and pi JS entry, as the child will invoke them;
     FAIL names the missing program and the install/PATH action.
  6. `inherited extensions` — for each role that inherits extensions, the packages on
     THIS machine resolved against the target's package index; missing ones FAIL with
     the D4 snippet (concrete role) and the `pi install npm:<pkg>` command.
  7. `target models` — `pi --list-models` on the target (through the same argv the child
     would use, minus the task); PASS when the launch model is visible, FAIL listing
     what that machine does see.

  Bounds: at most 5 hosts, 8 listed missing packages, 10 listed models; the rest is a
  count (`… and N more`). Every remote call has the existing 10 s budget; a transport
  failure marks the remaining items of that host `SKIP` with the reason.

- **D8 Last line of the section is a pasteable launch** built from REAL resolved values
  (`host`, `cwd`, `model`, role `centurion`) — no `<…>` placeholders. When no cwd is
  known it prints the D2 question instead.

- **D9 Runbook step 0.** `docs/runbooks/cross-machine-centurion-demo.md` opens with
  "step 0: `/legion doctor crossmachine`" — one command, what each PASS/FAIL means, and
  the copy-paste launch it prints. The old "check three commands" table is kept below it
  as the manual fallback.

- **D10 Tests must be red when reverted.** Four error situations
  (not-a-checkout / checkout without origin / package missing on the target / model
  missing on the target) and four doctor situations (all green, no checkout, missing
  package, missing model) are covered; each assertion pins the sentence that carries the
  remedy, so deleting the remedy turns the test red. Doctor tests use the fake core +
  temp dirs, never a real `hc`.

- **D11 Gates.** `npm run typecheck`, `npm test`, `npm run test:integration` all green.
  `test/unit/terminal-supervisor.test.ts` stays unmodified (D18 of
  `cross-machine-spawn-v1`).

- **D12 Report.** `docs/reports/first-run-success.md`: the five pitfalls before/after with
  the real strings, a doctor sample, runbook step 0, red/green evidence, the
  "indistinguishable from local" table, and the version recommendation.

## File ownership

| Unit | Files |
| --- | --- |
| W1 cwd-as-question + zero config + package error | `src/runs/remote.ts`, `src/supervisor/terminal-supervisor.ts`, `test/unit/remote-host-cwd.test.ts` (new), `test/unit/cross-machine-discovery.test.ts`, `test/unit/cross-machine-params.test.ts`, `test/integration/fake-core-minimal-config.test.ts` (new), `test/integration/fake-core-host-discovery.test.ts` |
| W2 delivery facts (D5) | `src/runs/remote-worktree.ts`, `src/runs/cross-machine-preflight.ts`, `test/unit/remote-worktree.test.ts`, `test/unit/cross-machine-preflight.test.ts`, `test/integration/remote-worktree.test.ts`, `test/integration/cross-machine-preflight-order.test.ts` |
| W3 doctor checkup (D6–D8) | `src/runs/cross-machine-checkup.ts` (new), `src/extension/legion-doctor.ts`, `src/extension/legion-commands.ts`, `index.ts`, `test/unit/cross-machine-checkup.test.ts` (new), `test/unit/legion-doctor.test.ts` |
| W4 docs (D9, D12) | `docs/runbooks/cross-machine-centurion-demo.md`, `docs/reports/first-run-success.md` (new), `CHANGELOG.md` |

Shared file serialization: only one writer runs at a time in this worktree; the order is
W1 → W2 → W3 → W4, each with its own verify gate.

## Acceptance

- Five pitfalls each answered in the FIRST error (or by one doctor command):
  1. parent cwd not a checkout → `notALocalCheckoutMessage` with a real next step;
  2. missing extension on target → D4 text with the role and the JSON;
  3. no workaround needed: the D2/D4/D5 messages each end with a `subagent(...)` shape;
  4. remote directory: the D2 question names `cwd` and the tool never guesses;
  5. one command: `/legion doctor crossmachine` prints every fact with PASS/FAIL.
- `{"subagents":{"crossMachine":{"enabled":true}}}` + `cwd` launches (fake core).
- Missing cwd: message contains the question, the pass shape, the ask-the-user sentence,
  the no-probe sentence, and the wire log contains zero `machine.exec`.

## Amendments recorded while landing v1

Adversarial review (three fresh-context reviewers) produced these corrections. Each is
a strengthening of the decision it names, not a new scope; the code, tests and docs in
this branch implement the amended text.

- **A1 (D2).** The pre-v1.1 `resolveHostTarget` branch (no `mentionPerCallCwd`) now
  throws the SAME question. It is the branch the read-back paths (`remote-verify`,
  `remote-artifact`) take, and a resume that cannot name the directory must get the
  question rather than a settings lesson. The two assertions that pinned the old
  sentence for an empty entry (`cross-machine-target.test.ts`,
  `cross-machine-discovery.test.ts`) were updated with it; the single assertion for a
  WRONG (relative) value is untouched.
- **A2 (D5).** The pasteable shape carries the remote half too:
  `subagent({ agent: "centurion", host: "vps", cwd: "../my-repo", hostCwd: "/abs/path/on/vps", task: "..." })`.
  A relative `cwd` alone only points the parent at a checkout — it would drop the
  remote directory and send the reader straight into D2.
- **A3 (D7/D8).** Four corrections to the checkup output:
  1. `enabled: false` probes nothing (not even `machine.list`) and reports one FAIL on
     the switch: a report that prints PASS lines and a launch for a feature every
     launch refuses is worse than no report.
  2. `machine.list` empty AND no configured host is a FAIL carrying the
     `hc machine add --name …` first step (a green "no machines registered" gave the
     reader nothing to type).
  3. A launch is labelled `launch (copy-paste once the FAILs above are fixed)` when any
     item failed; "copy-paste, real values" is reserved for an all-green block.
  4. The launch carries the model the checkup judged (`centurion`'s model, else any
     role's, else absent). With no model known, `target models` still probes and FAILs
     when that machine's `pi` lists none, instead of skipping the item away.
- **A4 (D7).** The missing-package fix is ONE merged
  `{"subagents":{"agentOverrides":{…}}}` snippet (per-role arrays) plus a
  `# where:` line naming the user and project settings files — two separate snippets
  would overwrite each other on paste. `target origin` fixes use this checkout's real
  url whenever it is known (only the parent-side "no origin anywhere" keeps `<url>`).
- **A5 (D6).** The section gate is one exported predicate
  (`crossMachineCheckupRequested`) used by both callers and tested; with cross-machine
  unconfigured (`enabled` unset and no host entry) the registry is printed but no target
  is probed, so a plain `/legion doctor` keeps its cost on machines that never used the
  feature.
- **A6 (D2, adjacent paths).** `resume` replays the caller's `cwd`/`hostCwd` into the
  resolver, so the zero-config shape is resumable; a tree revive (which has no caller
  parameters) still asks, and that is recorded as a boundary in the report.
  `assertSharedOrigin` / `packagePathError` now set `noModelFallback` (a local git or a
  missing package is deterministic — retrying the candidate chain re-runs the same
  probes). Scoped package names (`@scope/name`) match `excludeExtensions` again, so the
  D4 snippet works for them.
