# orphaned 行回收：按终端地址结算 + idle-orphan 清理 + `stop` 接受 orphaned 句柄（#456）

- issue：https://github.com/zzjcool/pi-legion/issues/456
- 基线：本 worktree 从 `2a01776`（6.2.10 发版点，含 #450/#451）切出；分支
  `pi-subagent/hw-nj/pi-legion-orphan-reclaim-f0504fab`。PR base = `master`。
- 范围：issue 的四条落地 + 四条验收（含反向与两个变异）。**不动** #445 的
  `reattach.ts`、#441 的 stall 过滤；不动版本号 / 不打 tag / 不 publish。
- 门禁：`npm run typecheck` ✔，`npm test` **2966 pass**（HEAD 基线实测 2942），
  `npm run test:integration` **221 pass**（基线 213）。

---

## §1 现象与根因

重启后昨天干完活的 centurion 仍在远端活着；`subagent stop <name>` 回
`unknown child … (not tracked by this session)`，于是既不能停、也不会自己结算：

1. leftover 在**上一个会话的 store**，`stop` 只查本会话的 run；
2. 上一个进程已死 ⇒ 没有任何 postman tick 会收敛它；#445 的接回按
   `unknown ≠ live` 正确跳过，`recover` 只读结果、不清理；
3. 远端终端还活着（程序停在提示符），`hc` 导轨一直列着；`status` 又按
   `owner.json` 的 pid 把它算成 live。

## §2 四条落地

### 2.1 按终端地址结算

`src/runs/orphan-reclaim.ts`（新模块，~870 行）：

| 事实 | 判据 | 落点 |
|---|---|---|
| 终端 `finished` / `killed` / `exited` | 终端自身的终态 | `inspectOrphan` `:362`，verdict `terminal-gone` |
| 终端 `missing`（**地址是记录下来的**） | 核里不再有这个地址 | 同上；`reattach.ts` 的 "inferred ≠ proof" 守卫生效 |
| 终端 `missing` 但地址是推出来的 | 不是证据 | `:404-406` → `unknown`，不写 |
| 终端 alive、程序已结束/在提示符 | 两次 transcript 采样相等 | `:441-500` → `stale-orphan` |
| 终端 alive、程序在 working | 程序自己的词 | `:427-434` → `working` |
| 终端 alive、只有 `finished_ms`/`reason` | 仍是 `terminalProgramEnd` 的结束事实 | `:436-445` → 走采样 |
| 机器问不到 | 无证据 | `unknown`，不写 |

结算写三件事，顺序固定（`reclaimOrphan` `:665`）：

1. `stale-orphan` **先 kill**（`killTerminalAt` `:524`；`not_found` 视为已消失，
   其它失败 ⇒ 拒绝，零写入）；
2. 账本按 `collect`/`recover` 同一把梯子结束：可评级 transcript ⇒
   `settledStatusFor` + `node_settled`/`node_failed` + usage；不可评级 ⇒
   `node_retired{execution:"unknown", reason:"terminal-gone"|"stale-orphan", reclaimed:true}`
   （仍可 `recover` 取结果）；
3. `run.json`：`state:"retired"`、删 `orphaned`、写 `reclaimed{at,verdict,evidence,ledgerStatus,sessionFile}`。
   每次清理写 `<storeRoot>/orphan-reclaim.log`：`谁（session+pid）/何时/哪个 host+terminal/哪条证据/ledger 结果`。

### 2.2 idle-orphan 检测

“终端活着” ≠ “孩子在工作”：`createRemoteTerminalProbe` 的 `live` 由
`terminalProgramEnd` 决定（exit_code / finished_ms / reason / state / done|error），
所以 kept terminal 在程序退出后仍是 `running`。判 idle 前必须**两次采样**
（`ORPHAN_MIN_GROWTH_WAIT_MS=250`，`ORPHAN_MAX_GROWTH_WAIT_MS=1200`）：

- 第二次 > 第一次 ⇒ `working`（仍在写，放过）；
- 两次相等 ⇒ `stale-orphan`（kill + 结算）；
- 任一次取不到 / 变小 ⇒ `unknown`（放过）。

### 2.3 `stop` 接受 orphaned handle

`index.ts` 的 `stop` 分支先走 `reclaimOrphanOnStop`（`index.ts:7447`），再回落到
原 `stopAction`：

- 只按**名字**（`stop all` 仍只停本会话的 job——leftover 没有 handle，按 `(store,name)` 寻址）；
- 会话自己的 store 先答：若它有一条第**非 orphan** 记录（含 `failed`/`settled` 历史），
  普通 stop 拥有这个名字，不会去别的 store 抓同名 leftover（review F2）；
- 本 store 没有 ⇒ 在 `candidateStoreRoots` 的有界面上找同名的 orphan（#450 的扫描面），
  两个 store 都有 ⇒ 拒绝歧义并列 `store=/run=`；
- 找到后：owner 闸（`orphanOwnerGate` `:248`）→ 检查（`inspectOrphan`）→ 结算。
  返回值三选一：`Reclaimed …` / `Refusing …`（working、unknown、live owner）/
  歧义拒绝。`unknown child` 只留给真正不存在的名字。

### 2.4 导轨诚实

- `status` 总览/具名：对 orphaned 行做**有界只读**检查（`inspectOrphansForSurface`
  `index.ts:7373`；最多 8 行、2 路并发、总预算 4s），渲染成
  `state=orphaned (terminal gone, work done)` / `(idle, transcript quiet)` /
  `(still working)` / `(liveness unknown)`，并在下行给出 `orphan: <证据>`；
  没检查到（cap 外 / 无 facts）仍是 `state=orphaned`（显式，只是少一个词）。
- 总览头不再把它算 live：`classifyChildrenForStatus` 收到 `orphaned:true` ⇒
  `live:false`；`renderStatusOverview` 单独计 `N orphaned`，不算 `dead`。
- 无 `orphan` facts 时输出逐字不变（既有 263 条 status/overview 断言全绿）。

## §3 验收

| # | 证明 | 测试 |
|---|---|---|
| A1 | finish 终端 ⇒ `status` 显示 `terminal gone, work done` 且 `0 live (1 orphaned)`；一次 `stop` 结算：ledger `settled(execution:success)`、`listUnsettledRemoteNodes` 空、run.json retired、日志齐全；第二次 `status` 消失 | `test/integration/orphan-reclaim.test.ts` A1；`test/unit/orphan-reclaim.test.ts` “terminal-gone with a graded transcript…” |
| A2（反向） | 终端 alive + 程序 idle + transcript 仍在增长 ⇒ `Refusing … growing (N → M)`，ledger 仍 running，run.json 仍 orphaned，核心日志**无** `terminal.kill` | 同文件 A2 |
| A3 | 终端不存在（地址记过）+ 无 transcript ⇒ 仍结算：ledger `retired{execution:"unknown"}`、run.json retired、日志 `verdict=terminal-gone`（<30s 回返） | 同文件 A3；unit “unreadable transcript…” |
| A4 | `owner.json` 指向**真实活着的**别的进程 ⇒ `Not reclaiming … is alive`，且核心日志连 `terminal.get` 都没有（闸在 wire 前） | 同文件 A4；unit owner gate 四种情形 |
| 附加 | A5 跨 store（`store=` 标记 + 该 store 的账本/日志）；A6 第二次 stop 只留一个 settle 事件；A7 无记录地址的 inferred miss 不结算（review F1）；A8 正面 stale-orphan 真的走 `hc terminal.kill` 再结算 | 同文件 A5–A8 |

### 变异（都能红）

| 变异 | 改法 | 结果 |
|---|---|---|
| M1（验收 4） | 删掉 “terminal finished ⇒ 死行”：`finished` 直接返回 `unknown` | A1 ✖（`state=… terminal gone, work done` 不出现） |
| M2（验收 2） | 删掉两次采样/增长证据：idle 直接判 `stale-orphan` | A2 ✖（不再 `Refusing`，growing 的行被 kill/结算） |
| M3（review F1） | 删掉 “inferred `missing` 不是证据” 的守卫 | unit ✖（inferred miss 被当成 terminal-gone） |
| M4（验收 3） | 删掉 “终端不存在 ⇒ 死行”（`missing` 不再算 gone） | A3 ✖（不再 `Reclaimed`，行挂住） |

四次变异均 `cp` 原文件恢复并 `sha256sum -c` 校验；源码里没有残留。

## §4 实现中被对抗审查修掉的点

独立 scout 审查（1 major + 8 minor）后修复：

- **F1（major）**：`missing` 只有**记录过地址**时才算终结；推断地址的 miss 落到
  transcript/`unknown`（`orphan-reclaim.ts:404-406`），并补 A7。
- F2：own store 的任意非 orphan 记录（含 failed/settled）拥有名字，不再被跨 store
  leftover 抢走（`index.ts:7483`）。
- F3：`reclaimOrphan` 回报 `recordWritten`；run.json 写失败时 stop 文案不再谎称
  `run record: retired`。
- F4：删掉 `/legion status` recoverable 行的 verdict 装饰（同步 dep 无法产出该
  facts，留着就是死代码 + 不可失败的测试）。
- F5：kill 之后才失败的拒绝把 `killed=true` 写进日志与回答；usage 写失败不再把
  已写好的 ledger 结算说成拒绝。
- F6：`probe.live === false`（含只有 finished_ms/reason）按结束事实处理，不再 unknown。
- F7：status 检查 2 路并发 + 总预算；具名 status 也套同一预算。
- F8：owner.json 的 host 参与闸（异机 ⇒ live，不可检查）；写 run.json 前重读记录，
  mutator 里再验一次（被别的会话 adopt 就不覆盖）。
- F10：`terminal.kill` 的 `not_found` 按 `kind` 判断（不靠文案）；`retiredAt` 取本次
  回收时间；facts 缓存按记录（非名字）键。

## §5 已知边界

- `stop all` 不扫 leftover（有意）：leftover 没有 handle，必须按 `(store,name)` 点名；
  `status` 已把名字列出来。
- `/legion status` 的 recoverable 块仍只读当前账本、仍显示裸 `orphaned`（#450 的
  已知限制 3）；本条的 `terminal gone` 词只在 `subagent status` 上。
- 终端未记录地址、且无 transcript 的行只能 `unknown`：没有可核的地址，也没有可验的
  transcript；`recover` 仍可用于取结果。
- 未在真机 `hc` 上复跑（fake core 覆盖 JSON-RPC 形状）；`finished_ms`/`holder_lost`
  的真实字段组合按 `terminalProgramEnd` 的既有判据处理。
