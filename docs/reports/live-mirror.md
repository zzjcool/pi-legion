# 跨机 child 的 transcript 实时镜像（6.2.5, #411）

- repo: `github.com/zzjcool/pi-legion` · branch `pi-subagent/host-workspace/legion-411-b680008b`
- 基线: `origin/master` @ `26647da`（基线门禁实测：unit 2706 tests / 2705 pass / 0 fail / 1 skip；integration 192/192）
- 真机: `hw-nj`（hc 0.1.21，远端 pi 1.5.2，`any-endpoint/workbuddy/deepseek-v4.1-flash`）
- 契约: `.pi-legion/contract.md`（本轮冻结稿，未入库）

## §1 现象

issue 里的三条实测，同一个根因。本机复现（`subagent status` + `ls`）：

```
$ subagent({action:"status", name:"psid-rev-a"})
  state=retired  execution: success
  session=…/.pi-subagents/runs/r-1bb33dde/psid-rev-a.jsonl

$ ls -l …/r-1bb33dde/psid-rev-a.jsonl
  0 bytes
远端实际：…/.pi-subagents-mirror/no-run/psid-rev-a/session.jsonl  1,488,402 bytes
```

```
state=launching   alive · quiet 908s (living)
远端同一时刻：…/no-run/legion-413/session.jsonl  725,016 bytes  (4 秒前还在写)
```

## §2 根因

`ChildRecord.sessionFile` 是**本机预先创建的空占位文件**
（`preCreateSessionFile`，`src/runs/orchestrator.ts:620/1812`，
路径 `runStore.sessionFileFor()` = `~/.pi-subagents/runs/<run>/<name>.jsonl`）。
跨机 child 写的是**另一台机器上**的 `<remoteDir>/session.jsonl`。
两者之间**没有任何字节搬运**，于是：

| 症状 | 机制 |
|---|---|
| 面板 `No displayable messages` | 面板读 `sessionFile` → 永远 0 字节 |
| `quiet` 恒增长 | `lastJsonlEventAgeMs(sessionFile)`（`src/extension/runtime.ts:614-620`）stat 的就是那个空文件 |
| `state=launching` 卡住 | `persistParentReservation` 往 run.json 写 `state:"launching"`（`:1088`），而**全仓 `updateChild` 只有这一处调用** —— spawn 成功后没有任何人把 `working` 写回去，跨机 child 又没有任何本地信号能推动它 |

**关键判断**：既有 `<runDir>/remote/<name>.jsonl`（`remoteMirrorPathFor`，
由 `createRemoteSessionReadback` 在 collect 时整段覆盖写）**不是** issue 说的那个文件。
它是 `sessionFileOf()` 优先读的读回镜像；issue（和面板、`quiet`）读的是 `sessionFile`。
所以泵写 `sessionFile`，两个文件不同名、不同写者，互不覆盖。

## §3 改法（三层）

### 3.1 `src/runs/live-mirror.ts`（新，泵）

- 远端能力：`machine.exec` + `wc -c`（大小）与 `tail -c +N`（**1-based**，`from=0 → +1`）。
  stdout 是 BASE64，直解成 `Buffer`（不做 utf8 round-trip，多字节字符跨块不损坏）。
  一条长生命周期 `hc connect`，`stop()` 关掉。
- **byte offset 增量**：`offset` 是「消费到远端第几字节」，与本地被裁剪后的长度**独立**；
  每次只追加新字节，绝不重读全量。
- **远端变小 → 重置 + warning**：`remoteBytes < offset` ⇒ `offset=0`、镜像**替换**（不是追加），
  一条 `…the remote transcript shrank (N bytes, mirror had consumed M)…`。
- **本地只留末尾 N MB**：默认 4 MiB（`PI_LEGION_LIVE_MIRROR_MAX_BYTES`），按**行边界**裁头。
- **行边界**：最后一个 `\n` 之后的字节不写，留到下一次 —— 本地文件永远结束在完整行。
  **单行大于读窗时窗口翻倍增长**（真实 transcript 有 256 KiB+ 的巨型 tool result；
  死等换行会让泵静默冻死）；只有单行大于 `maxBytes` 才允许写残（否则永远镜像不了任何东西）。
- **写入语义（review 后修正）**：稳态是**一次 `O_APPEND` 追加**，**inode 不变** ——
  仓库既有的增量解析缓存是 `dev`/`ino`（`sessionFileStillValid`）与 `(size,mtimeMs)`
  （`parseSessionFileCached`）键控的，每 5s 换 inode 会让每个消费者（含面板
  `progressFromSessionFile`）每 tick 全量重解析最多 4 MiB。追加最多只暴露撕裂的**最后一行**，
  这与本地 child 自己的 transcript 性质相同，`parseSessionFile` 本来就丢弃（#36）。
  严格的 temp+`renameSync` 原子替换保留在**必须重写**的两处：cap 裁剪、shrink 重置。
- **泵绝不伤 child**：`syncNow()` 吞一切异常，记进 `facts().error`，同一文本只 warn 一次；
  tick **串行化**（定时 tick 与 settle 的 final sync 不会共用 offset）；`stop()` 之后在飞的
  tick 也不再落盘。
- **可配置关闭**：`PI_LEGION_LIVE_MIRROR=off|0|false` ⇒ `mode:"off"`，**不装定时器**，
  只写一次 facts 行；另外 `PI_LEGION_LIVE_MIRROR_INTERVAL_MS`（默认 5000，下限 500）、
  `PI_LEGION_LIVE_MIRROR_MAX_BYTES`（默认 4 MiB，下限 4096）。

### 3.2 接线（`src/runs/orchestrator.ts` + `index.ts`）

- `OrchestratorDeps.liveMirror?: { config?, env?, create?, warn? }`；**缺席 = 今日行为逐字节不变**
  （每个未要求泵的测试替身/嵌入者都保持「没有泵」）。
- `launch()` 在 `recordLegionLaunch` 之后 `startLiveMirror(child)`：只对
  `normalizeHost(child.host) === undefined` 之外、且 `remoteDir` 已知的 child 起泵。
- **settle 时最终同步 + 停泵**：`collect()` 里 `wait === "settled"` 分支
  `finalSyncLiveMirror(child,{stop:true})`。**带 deadline**（`LIVE_MIRROR_FINAL_SYNC_MS = 5s`，
  外加一层 `Promise.race`）：settle 在父会话关键路径上，半死的机器不能把「child 结束了」
  变成「child 还在 collect」。
- `retire()` / `retireAll()` 停泵。
- **状态机**：`onGrowth` ⇒ `promoteLiveChild`，把 run.json 的 `launching` 写成 `working`
  （并顺手把账本 `starting` 推成 `running`），每个泵只推进一次。
- **`index.ts` 的 5 个 `new Orchestrator(...)` 站点各加一个 `...liveMirrorFrom()` spread**
  （与既有 `...rpcApproveFrom(settings)` 同型）。这是**契约 §1 允许清单之外的一处改动**：
  没有它，seam 在生产里没有提供者，#411 的三个症状一个都修不掉（第一轮对抗式审查把它列为
  critical，正确）。

### 3.3 状态渲染（`src/extension/runtime.ts`）

`renderLiveChildStatus` 在 `host=`/`terminal=` 之后、`execution` 之前插**一行**，
且**仅当**持久化 facts 存在时（⇒ 本地 child 输出逐字节不变）：

- `mode:"off"` ⇒ `mirror=off`
- `mode:"on"` 且（`staleBytes > 0` 或 `error`）⇒ `mirror=stale(<n> bytes)`，`<n>` = 远端有而本地没有的字节数
- 否则 ⇒ `mirror=ok(<bytes> bytes)`

facts 落在 `<runDir>/remote/<name>.mirror.json`（与读回镜像同目录不同名；`store.listSessionFiles`
只收 `*.jsonl`，`retention`/`hygiene` 都不会误读）。

## §4 测试与变异

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/unit/live-mirror.test.ts` | 24 | 泵的 8 条不变量 + 配置 + 状态文件往返 |
| `test/unit/live-mirror-orchestrator.test.ts` | 10 | 起泵/本地不起泵/final sync+stop/retire/**真 run.json 的 launching→working**/泵抛不影响 collect/create 抛不影响 launch/关闭/无 remoteDir |
| `test/unit/live-mirror-status.test.ts` | 15 | `formatMirrorLine` 四规则 / `readMirrorFacts` 形状校验 / 渲染插入位与顺序 |
| `test/unit/live-mirror-transport.test.ts` | 9 | **`wc -c` 与 `tail -c +N` 的真实 argv**、BASE64 字节保真、`wc` 失败语义、**inode 稳定性**、**no-op tick 不动 size/mtime/inode**、超大单行不冻死、`stop()` 后不再写 |
| 合计 | **58** | |

**变异矩阵（实测，每条改完恢复）**

| 变异 | 变红 |
|---|---|
| M1 `commit()` 不写（删掉追加） | `live-mirror`: 7 red —— inv1 / inv2-empty / inv6×2 / inv7×2 … |
| M2 删掉 `collect` 的 settle 最终同步 | `live-mirror-orchestrator`: 2 red —— "a settled collect runs one final sync and then stops the pump"、"a failing final sync never fails the collect" |
| M3 `tail -c +N` 丢掉 1-based（`+${from+1}` → `+${from}`） | `live-mirror-transport`: 1 red —— "tail -c +N is 1-based" |
| M4 删掉「远端变小 → 重置 offset」 | `live-mirror`: 2 red —— inv2×2 |
| M5 no-op tick 也重写文件 | `live-mirror-transport`: 3 red —— inode 稳定性 / 超大单行 / 超 cap |

## §5 真机（hw-nj）

跨机 child `live411-277127` 真跑：`TerminalSupervisor` → 真 `hc` → 远端真 `pi`
（18 行 transcript）。本地镜像每 5s 采样（`wc -c`）：

```
wc -c live411-277127.jsonl  # t+5s   => 0      (state=launching pump.offset=0     remote=?     stale=0)
wc -c live411-277127.jsonl  # t+10s  => 31162  (state=working   pump.offset=31162 remote=31891 stale=729)
wc -c live411-277127.jsonl  # t+15s  => 32926  (state=working   pump.offset=32926 remote=32926 stale=0)
wc -c live411-277127.jsonl  # t+20s  => 32926  (state=working   pump.offset=32926 remote=32926 stale=0)
wc -c live411-277127.jsonl  # t+25s  => 33232  (state=working   pump.offset=33232 remote=33232 stale=0)
wc -c live411-277127.jsonl  # after settle (final sync) => 38094
remote bytes on hw-nj: 38094
local lines: 18   remote lines: 18
```

- **增长 5 次采样 ≥3**：`0 → 31162 → 32926 → 33232`，settle 最终同步补到 `38094`，
  与远端 `wc -c` **逐字节相等**。
- **`state` 由远端增长推进**：`t+5s` 还是 `launching`，第一个拿到新字节的 tick 变成 `working`
  （run.json 里的真实字段）。
- **`stale=729`** 出现在「远端已写、本地还没轮到」的那 5 秒里 —— 就是 `mirror=stale(<n> bytes)` 要表达的事实。
- **面板有内容**：镜像首行就是真正的 session 头
  `{"type":"session","version":3,"id":"01a1f377-…","cwd":…`，`context: ctx=9.7K tok` 是从镜像解析出来的。

settle 后的 `subagent status` 块（`renderLiveChildStatus`，即 status 动作本身用的函数）：

```
live411 — state=working agent=worker kind=pi
alive · quiet 697s (living)
host=hw-nj
terminal=hw-nj/lgl-probe
see: hc read hw-nj/lgl-probe   (cross-machine children have no Herdr pane)
mirror=ok(38094 bytes)
context: ctx=9.7K tok
supervisor=terminal
session=…/runs/r-e5a3ed7c/live411-277127.jsonl
```

6 秒后再渲染：`alive · quiet 703s (living)` —— `quiet` 从**镜像 mtime**（最后一次真实增量）来，
不是恒 0，也不是恒增长的空文件（§4 的 no-op tick 用例把这条钉住了）。

清理：远端 mirror 目录与 `probe.log` 已 `rm`。

## §6 门禁与范围

```
flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test"
  ℹ tests 2764   ℹ pass 2763   ℹ fail 0   ℹ skipped 1        （基线 2706/2705/0/1，+58，无删除）
flock /tmp/pi-legion-ci.lock -c "npm run test:integration"
  ℹ tests 192    ℹ pass 192    ℹ fail 0
```

**没动的**（按 issue 边界）：`src/legion/stall-notice.ts`（#413）、
`src/supervisor/terminal-supervisor.ts` 与任何 spawn argv（#424）、
`createRemoteSessionReadback` 的读回逻辑、`lastJsonlEventAgeMs`、settings schema。

**已知未决**（本轮不做，记录在案）：

1. 配置只走 `PI_LEGION_LIVE_MIRROR*` 环境变量，没有 `subagents.crossMachine.*` 键 ——
   加 key 要动 `src/shared/types.ts` + `parseSubagentSettings` 白名单，属另一条边界外改动。
2. 进程重启后 `restore()` 不重建泵；持久化的 facts 行会一直显示 `mirror=ok(N bytes)`，
   虽然没人在镜像。要修需要给 `lastSyncAt` 加新鲜度判据（渲染层无法知道泵是否还活着）。
3. `remoteMirrorPathFor` 那条读回镜像仍是「整段尾窗覆盖写」，与本文的增量泵是两条独立路径。
4. `cross-machine-spawn-v1` 的 I3（「不引入后台 poller」）被本条**有意修订**：每台跨机 child
   多一个长生命周期 `hc connect`，由 `stop()` 关闭。
