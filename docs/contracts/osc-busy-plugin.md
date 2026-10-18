# OSC 7501 busy / plugin contract (pi-legion #156)

Legion keeps the **root** program-status record `working` while any live child
or registered extension activity remains. OSC truth is owned by Pi's
`ProgramStatusReporter` — **plugins and legion must not `printf` OSC 7501**.

## Handshake

- Terminals may answer `OSC 7501;?` / `PI_PROGRAM_STATUS=1`.
- Prefer Pi APIs (`ui.setActivity`, `ui.setProgramRecord`). Do not emit raw OSC.

## Plugin / child-side rules

1. **Raise**: while async work is unfinished →
   `ui.setActivity(source, { message })` and/or
   `ui.setProgramRecord({ id, state: "working", message })`.
2. **Clear**: on settle / cancel / error →
   `ui.setActivity(source, undefined)` and
   `ui.setProgramRecord({ id, state: "clear" })`.
3. **Ids**: use a stable hierarchical id (`plugin/<name>/…` or
   `legion/<slug>`). Do **not** write an id-less root `working` that steals
   Pi's root semantics — register an activity source or a child id.
4. **RPC children**: in RPC mode, Pi forwards `ui.setActivity` /
   `ui.setProgramRecord` as `extension_activity` to the parent. Legion folds
   those into the parent reporter (`legion/<child>/<source>`). **Do not**
   parse child PTY OSC bytes.

## Legion aggregation

| Source | Mechanism |
|--------|-----------|
| Live RPC child | `emitBusy` → `ui.setActivity("legion", …)` + per-child `id=legion/<slug>` |
| Child-side plugin busy | RPC `extension_activity` → parent `setActivity` / `setProgramRecord` |
| Same-process plugin | Direct `ui.setActivity` / `setProgramRecord` |

Root stays `working` while any activity source or uncleared `legion/*` child
id remains. `/legion stop` and runtime dispose clear the legion source and
child ids. **Esc** (wait interrupt) does **not** clear activity.

Priority inside Pi (unchanged): `blocked` > compacting > (`runActive` OR
`activities.size > 0` → root `working`) > resting (`done`/`idle`/`error`).

## Mock example (copy-paste)

```ts
// Same-process plugin / test double
ui.setActivity?.("plugin/bg-tasks", { message: "2 background tasks" });
ui.setProgramRecord?.({
  id: "plugin/bg-tasks/job-1",
  state: "working",
  message: "job-1",
});

// …work finishes…
ui.setProgramRecord?.({ id: "plugin/bg-tasks/job-1", state: "clear" });
ui.setActivity?.("plugin/bg-tasks", undefined);
```

Parent-side mock of a child fan-in (what legion does after RPC):

```ts
// Child "scout" raised setActivity("bg", { message: "compiling" })
ui.setActivity("legion/scout/bg", { message: "compiling" });
// Child cleared
ui.setActivity("legion/scout/bg", undefined);
```

## Non-goals

- Herdr / inbox OSC consumers
- Parsing child stdout for OSC 7501
- Big TUI railway/footer changes in this wave
