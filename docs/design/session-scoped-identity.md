# 用父 session 身份（psid）给跨机产物加固命名空间

- 状态：**设计稿（未实现）**。本分支只含文档，不改产品代码。
- 基线：`origin/master` `0ed298d`（= 6.2.4）。
- 跟踪 issue：<https://github.com/zzjcool/pi-legion/issues/405>
- 调研证据与现状键冲突矩阵：`docs/reports/session-scoped-identity.md`。
- 上游契约：`docs/contracts/cross-machine-spawn-v1.md`（D2/D7/D9/D12）、
  `docs/contracts/legion-session-continuity-v1.md`（§1 会话身份）、
  `docs/reports/orphan-on-natural-exit.md`（6.2.4 的 D 场景）。
- 与上游冲突时停下报告，不得自行解释。

---

## §0 一句话

远端产物的键今天是 **`name`**，而 `name` 只在**一个 run 内**唯一；
外层命名空间（远端机器的一个目录根、一个 hc core 的终端名空间、一个 store root 的跨 run 查找）
却是**整机/整项目共享**的。把它换成 **`(psid, runId, name)`** 复合键，
并把「这条遗留 child 属于哪个 session」变成一条**可打印的事实**。

`psid` **不是新的身份**，它是既有身份（session 文件 / `getSessionId()`）的一个**定长渲染**——
这一条必须先说清，否则会与 `legion-session-continuity-v1.md` §1「仓内没有 session id 概念，不要新造」相撞。

---

## §1 psid 的定义

### §1.1 来源（按优先级，取第一个可用的）

| 序 | 来源 | pi 的 API | 可得性 |
|---|---|---|---|
| 1 | **会话 id** | `ctx.sessionManager.getSessionId()` → `SessionHeader.id` | 持久化会话必有；`inMemory()` 也有 |
| 2 | **会话文件绝对路径** | `ctx.sessionManager.getSessionFile()` → `path.resolve` | 持久化会话必有；`inMemory()` 无 |
| 3 | 无 | — | `inMemory()` 且宿主不暴露 id 时 |

实测（本机 328 个真实 session 文件）：文件 basename 恒为 `<ISO 时间戳>_<sessionId>.jsonl`，
header `id` 与 basename 的 id 段**逐字相等**，且全局无重复。所以序 1 的 id 与序 2 的路径
**指向同一个事实**，不是两个权威。

### §1.2 派生规则

```
preimage = "psid-v1|" + sessionId                    // 序 1
         = "psid-v1|file:" + path.resolve(sessionFile) // 序 2
psid     = "p" + sha256(preimage).hex[0..12]          // 13 字符（"p"+12 hex，48 bit）
psid4    = psid[0..5]                                 // 5 字符（"p"+4 hex，16 bit）——终端名用
psid8    = psid[0..9]                                 // 9 字符（"p"+8 hex，32 bit）——目录/ref 用
```

- **算法**：sha256（Node 内置，零依赖），小写 hex——与仓内既有 `randomBytes(4).toString("hex")`
  （nonce）、`r-<8hex>`（runId）同一套字母表，人眼可读、可粘贴、可 grep。
- **长度理由**：见 §2.2 的名额表。终端名总长硬上限 32（`TERMINAL_NAME_MAX`），
  必须给 handle 留 ~17 个字符（真实 handle：`worker-0` 8、`centurion-1` 11、`scout-recon-1` 13），
  所以换不出更长的前缀。
- **`v1|` 前缀**：派生规则本身要能换代。加前缀后，将来换 preimage 不会与旧 psid 撞。
- **为什么 hash 而不是直接用 id**：id 是 36 字符（占满终端名额）、路径是机器相关的绝对路径
  （会把父机的文件系统布局写进远端目录名 / git ref）。hash 是为了把它压成**定长、可移植、不泄露布局**的段。
- **可读性**：给人看的地方（`/legion status`、`recover` 首行、日志）打印 `psid` 全形（13 字符）；
  名字里只放 `psid4`。两者都能从同一个 preimage 复现，不需要存两份。

### §1.3 稳定性（这是全设计的地基，逐条已核实）

| 事件 | psid 是否变 | 依据 |
|---|---|---|
| 进程重启、`--continue`/`--session <同一文件>` 续接 | **不变** | `session-manager.js:718-722` `_loadEntries()` 把 `this.sessionId = header.id` 读回来 |
| compaction（`appendCompaction`） | **不变** | 只追加一条 entry 到同一文件，id 不动 |
| `/branch`、`createBranchedSession` | **变**（新 id + 新文件，旧文件记在 `header.parentSession`） | `session-manager.js:1250` |
| `forkFrom` | **变**（同上） | `session-manager.js:1386-1419` |
| `mv` 会话文件 | **不变**（序 1）；序 2 会变 | 序 1 只吃 id |
| `inMemory()` | 有 id、无文件；进程内有效，不可持久 | `session-manager.js:1376-1377` |

**语义定名**：psid = 「**这一条**会话」，不是「这条对话的血缘」。
fork 之后旧 session 的遗留会变成「别人的遗留」（§4 的 tier 2），而不是自动继承——
这是**要的**行为：fork 出来的分支不该悄悄接管原分支还在跑的远端 child。

---

## §2 逐处改造

### §2.0 先讲一个通用规则（比任何单点改动都重要）

> **`no-run` / `no-psid` 这种「作用域缺失就退化成一个共享常量」的写法，本身就是撞点生成器。**

今天 `remoteDirFor(target, runId, name)`（`src/runs/remote.ts:1485`）在 runId 缺席时把段写成常量
`no-run`，而生产上 `new TerminalSupervisor()`（`index.ts:1667`）**从来不传 runId**（构造函数注释
自己承认「index.ts 在构造时还没有 run id」）。于是远端的**每一个** child 都住在
`<mirrorRoot>/no-run/<handle>`——这不是「没带作用域」，这是「全机共用一个作用域」。

规则：**缺席的作用域必须 (a) 拒绝，或 (b) 取一个本进程唯一的替代值，绝不能是常量。**
本设计的每一处改动都遵守这一条。

### §2.1 远端镜像目录 + 远端 transcript（`<remoteDir>/session.jsonl`）

- 现状：`src/runs/remote.ts:1485-1495` `remoteDirFor` → `<mirrorRoot>/<runId|no-run>/<handle>`；
  远端 child 的 `--session` 经 `src/supervisor/terminal-supervisor.ts:573` 重写成
  `<remoteDir>/session.jsonl`。
- 撞法：两个父会话（甚至两个**不同项目**的父会话）在同一台机器的同一个用户下
  launch 同名 child → 同一个目录、同一个 `session.jsonl`。
  （§2.3 的远端 worktree 目录 `remoteWorktreePathFor` 是同一类缺陷的另一半，只是撞出来的方式更呛。）
- 后果：`pi --session <已存在的文件>` 走 `_setSessionFile`（`session-manager.js:666-690`）——
  文件非空则**读回 header、沿用别人的 sessionId、在别人的 transcript 后面追加**。
  不是「覆盖」，是**跨父会话的上下文污染 + 两条 transcript 交织**。比覆盖更难诊断。
- 改造：

  ```
  remoteDirFor(target, scope, name) = <mirrorRoot>/<psid8>/<runId>/<handle>
  ```

  - `psid8` = 9 字符；`runId`（`r-<8hex>`）取代 `no-run`；
  - `scope.psid` 缺失 → `no-psid`（见 §5，且必须打 warning，不是静默）；
  - `scope.runId` 缺失 → **不再有共享常量**：`terminal-supervisor` 的 **per-spawn**
    `SpawnInput` 增加 `runId`/`psid`（`Orchestrator` 一直知道 `path.basename(this.runDir)`），
    由 orchestrator 传下来，而不是从构造函数拿（构造函数拿不到，注释已说明）。
    真拿不到时拒绝远端 launch（`START_FAILED` + 一句「作用域不可知，拒绝在共享命名空间里建产物」），
    不退化。
- 为什么三层都要：`psid` 挡跨会话，`runId` 挡**同一会话的两个 run**
  （一个 centurion 会开自己的 run 目录；两个 centurion 各有 `worker-0` 是合法且常见的），
  `handle` 在一个 run 内本就唯一（`ChildRecord.name` 在一个 run 内不重复）。
- **ledger 里已有 `remote_dir`（v5）**，读路径一律用它，不重算；重算只服务 pre-v5 行（§3.3）。

### §2.2 hc 终端名（`hc run --name`）

- 现状：`src/supervisor/terminal-supervisor.ts:160-168` `terminalName(runId, handle)` →
  `lgl-<runId8>-<handle>`；但生产 `runId` 缺失（`index.ts:1667`），实际落成 `lgl-<handle>`。
- 撞法：同一 hc core（= 同一台父机）上，两个会话 launch 同名 child 到**同一台**远端机，
  请求同一个裸终端名 `lgl-worker-0`。
- 后果分两种，都真实存在：
  1. **响亮**：持有者是 live → `runTerminal`（`:1397-1448`）抛 `NAME_TAKEN`。
     第二个会话 launch 直接失败——安全但莫名其妙，且用户不知道是谁占了名字。
  2. **静默且危险**：`remote_terminal` 未记录（pre-v5 行）时，recover/probe 用
     `terminalName(undefined, name)` **重算**地址（`src/runs/remote-artifact.ts:258, 264, 438, 653`），
     得到 `host/lgl-worker-0`，于是**去问别人的终端**：别人 live → 本会话的遗留被判「还在跑」，
     永不 settle；别人 finished → 本会话的遗留被静默判死。
- 改造：
  - 名字改为 `lgl-<psid4>-<run4>-<handle>`，`prefix = 15` 字符，`handle` 仍有 17 个字符；
    `run4` = runId 末 4 位 hex（比 runId 前 4 位 `r-1a` 的熵更实在）。
  - `psid` 缺失：`lgl-<run4>-<handle>`（退化一档，+warning）；`runId` 缺失：不允许（§2.0 规则）。
  - **把「猜地址」这条兜底删掉**：`remote_terminal` 没记录 → 返回 `state: "unknown"` +
    「记录里没有远端终端地址，用 `hc terminal ls --on <host>` 查」。
    猜错比不猜坏得多，而 v5 之后的行永远有真值。

| 方案 | prefix 长度 | handle 名额 | 撞的概率（≈几百个终端） |
|---|---|---|---|
| 现状 `lgl-<handle>` | 4 | 28 | **结构性必撞**（无作用域） |
| `lgl-<psid4>-<handle>` | 10 | 22 | 16 bit：~1e-4 |
| **`lgl-<psid4>-<run4>-<handle>`（选定）** | **15** | **17** | **32 bit：~1e-8** |
| `lgl-<psid8>-<handle>` | 14 | 18 | 32 bit，但挡不住同会话两个 run |

（口径：`TERMINAL_NAME_MAX = 32`，`terminalName()` 末尾 `.slice(0,32)`；`worker-0` 8 字符、
`centurion-1` 11、`scout-recon-1` 13——17 个字符的名额够真实 handle 用，超了与今天一样被截断。）

### §2.3 远端 worktree 目录与分支名

这一处是**同一个功能的两半，作用域不一致**——目录按 `name`，分支按 `name`+nonce：

| | 键 | 出处 |
|---|---|---|
| 远端 worktree 目录 | `<worktreeRoot>/<name>`（无 runId、无 nonce） | `src/runs/remote-worktree.ts:134-136`；调用点 `:767` |
| 目录已存在时 | **硬失败**：`worktree path <dest> already exists on that machine (remove it there, or relaunch with a different name)`（`INVALID_PARAMS`） | `:768-775` |
| 分支 | `pi-subagent/<host>/<name>-<hex8>`（`hex8 = randomBytes(4)`，每次 launch 一个新 nonce） | `:75-77`；调用点 `:781` |
| 本地两半（对照组） | 目录 `<runDir>/worktrees/<name>`、分支 `pi-subagent/<name>-<hex8>` | `src/runs/worktree.ts:19-20`、`:201-204` |

- 改造（正确性）：目录段与远端镜像目录同形——`<worktreeRoot>/<psid8>/<runId>/<name>`，
  与 §2.1 一致，于是「一个 worktree 属于谁」只差一条 `ls`。
- 撞（分支）：**不撞**。nonce 已经保证唯一——这是本清单里「UUID 已经够了」的一处。
- 真正的欠账是**归因**：`git branch -r | grep worker-0` 看不出是哪个父会话的一次性分支。
- 改造（可选，**只做归因**）：`pi-subagent/<host>/<psid8>/<name>-<hex8>`（本地同形）。
  必须显式声明它是**归因段，不是唯一性来源**——审阅者随时可以砍掉它而不损失正确性。
  迁移：老分支不改名（账本里存着 `worktreeBranch`），只有新 launch 用新形。
- 注意：目录上的那个硬失败**文案本身在误导**——它说「换个名字重试」，
  于是用户会去改名字，而不是发现「那个路径属于另一个会话，里面还留着它未提交的改动」。

### §2.4 本地 mirror / 本地 worktree / 本地 session 文件 / out/

| 路径 | 现状 | 键 | 撞？ |
|---|---|---|---|
| `<runDir>/remote/<name>.jsonl`（`remote-artifact.ts:152`） | 每个 run 一个目录 | `(runDir, name)` | 单 run 内不撞；**但 §4 的跨会话 recover 会让两个会话写同一个文件** |
| `<runDir>/worktrees/<name>`（`worktree.ts:19`） | 同上 | `(runDir, name)` | 不撞 |
| `<runDir>/<name>.jsonl` 本地 child session（`store.ts:281`） | 同上 | `(runDir, name)` | 不撞 |
| `<runDir>/out/<name>/r<N>.md`（`artifacts.ts:79`） | 同上 | `(runDir, name, round)` | 不撞 |
| `artifacts.id = <runId>/<segment>/r<round>`（`legion-output.ts:299`） | runId 已在主键里 | `(runId, name, round)` | 不撞 |

**结论：本地命名空间已经是 `(run, name)`，不需要 psid。** 这批路径的 `runDir` 本身就是会话作用域的
替身（一个会话一个 run，靠 `run.sessionFile` 认回来）。
唯一要补的是 §4.4 的「claim」，因为跨会话 recover 打破了「一个 run 只有一个写者」这个前提。

### §2.5 ledger

- 现状：`legion.db` 在 `<runDir>/legion.db`（`db.ts:307`）——**本身就是 per-run 的**，
  所以 `nodes.id = <parentId>.<slug(name)>`（`nodes.ts:169-172`）在账本内已经是路径唯一的：
  `root.worker-0` 与 `root.centurion-1.worker-0` 是两行，不冲突。
- 撞点不在主键，在**查找**（§2.6）与**它属于谁**（§4）。
- v6 方案（纯加法，与 v4/v5 同模式）：`nodes` 加两列

  ```
  ALTER TABLE nodes ADD COLUMN psid TEXT;         -- 发起这次 launch 的进程自己的 session
  ALTER TABLE nodes ADD COLUMN claimed_by TEXT;   -- 认领这次遗留的 session（§4.4）
  ```

  **根行的 `psid` 就是「这棵树的父会话」**——子节点（in-process child）有**自己的** session 文件
  （`inprocess-supervisor.ts:813` `SessionManager.open(input.sessionFile)`），
  它的 id 与 root 不同。所以作用域**必须**向上归到 `nodes WHERE id='root'`，
  否则「本会话的遗留」会漏掉所有孙代。这是本设计里最容易做错的一处，写在这里钉住。

- `run.json` 同步加 `psid?: string`（走 `store.ts:32-43` 的 `declare module` 增强，与 `sessionFile` 同模式），
  让 store 层不用开每个账本就能按 session 过滤 run。

### §2.6 `already settled` 的判据键

- 现状：`hasEnded(node)`（`remote-recover.ts:339`）+ `recordedSettle(db, node.id)`（`:360`）
  → 判据是 **`(账本, node.id)` 这一对的「已结束 + 已记录 verdict」**，其中 `node.id` 是路径 id。
  **这一层本身是对的**：它是 `(runId, 节点路径)`，不是 `(name)`。
- 撞点在**上一跳查找**：`listRemoteNodesNamed(db, name)`（`nodes.ts:548`）
  与 `SELECT * FROM nodes WHERE name = ?`，然后
  `const node = unsettled.at(-1) ?? rows[rows.length-1]`（`remote-recover.ts:332-334`）——
  **同名的两个分支节点靠 `updated_at` 排序挑一个**。
- 后果：`recover({name:"worker-0"})` 在有两棵子树都起了 `worker-0` 的树里，
  可能把 A 分支的行 settle 掉，而 transcript 取的是 B 分支的 `remote_dir`。
  第二次调用「already settled」于是把一个**从未被读过的** verdict 当成事实返回。
- 改造：
  - `recover` 接受**节点路径**（`centurion-1/worker-0` 或 `root.centurion-1.worker-0`）；
  - 只给 `name` 时，若匹配到 **>1 条 unsettled 行**，**不猜**：列出候选（路径 id + host + psid4 +
    `updated_at`）并回 `AMBIGUOUS_NAME`，让调用方补全；
  - 只有恰好 1 条时才走原来的路径。`already-settled` 的幂等语义不变。

---

## §3 迁移

### §3.1 原则

1. **不删任何旧目录、旧分支、旧账本**。远端 `<mirrorRoot>/no-run/<name>` 原地保留。
2. **读路径优先用记录值，不重算**。`remote_dir`（v5）与 `remote_terminal`（v5）是真值。
3. **psid 缺失永远不等于不可达**——它只让答案少一条归因，不让一条遗留变成孤儿。
4. **6.2.4 的 `recover` 能力逐字保留**（§4.5 给出推演）。

### §3.2 ledger v5 → v6

- 两步 ALTER，`PRAGMA table_info(nodes)` 先问（照抄 v4/v5 的 `missing` 写法，`db.ts:488-500`），
  **无 backfill**：`NULL` 是「未知」，是合法且永久的取值。
- 老账本打开后：`nodes.psid` 全 `NULL` → 根行的 psid 未知 → 该树的所有遗留归 tier 2/3（§4.2），
  而不是「无主」。读代码只有一处需要判断 `null`。
- `LEGION_DB_USER_VERSION = 6`；`version > 6` 的账本照旧抛「newer than supported」——不变。

### §3.3 磁盘上的老 artifact

| 老东西 | 处理 |
|---|---|
| 远端 `<mirrorRoot>/no-run/<name>/`（v5 行有 `remote_dir`） | 直接用记录值读，**不重算**；新 launch 才会去新布局 |
| 远端 `<mirrorRoot>/no-run/<name>/`（pre-v5 行，无 `remote_dir`） | 重算时**按顺序试两个候选**：新布局 → 旧布局 `no-run/<handle>`；谁存在用谁，都不存在就报「路径未知」并给出 `hc exec --on <h> -- ls` 的查法。这是一次**读**，多探一个候选是诚实的 |
| `<runDir>/remote/<name>.jsonl` 本地镜像 | 不动，路径不变，仍是 `(runDir, name)` |
| 老分支 `pi-subagent/<host>/<name>-<hex8>` | 不改名（`worktreeBranch` 记在账本里） |
| `legion doctor` | 加一行：有多少 pre-v6 行仍指向 `no-run/`（可操作，不自动清理） |

### §3.4 为什么不能反着来（不能让新代码去读「老布局优先」）

老布局是一个**共享命名空间**：`no-run/<name>/session.jsonl` 里现在装的内容可能来自**任何一个**
父会话。新进程若优先读它，就等于把「可能是别人的 transcript」当成自己的结果——
这正是本设计要消灭的错误。所以：**记录值 > 新布局 > 老布局（仅 pre-v5 且仅在不存在前两者时）**。

---

## §4 `recover` 的作用域语义

### §4.1 现状（先承认它已经比 D1 好）

`findRecoveryLedgerForName`（`remote-recover.ts:114`）的优先级：
1. 本会话自己的 run（`run.sessionFile` 相等）；
2. **本 store root 里最新的、持有该 name 的跨机行的其它 run**（无会话限制）；
3. 都没有。

`runsInRecoveryOrder`（`:188`）只是把 1 排到前面。所以现状是：
**默认就能跨会话，且不打印那条遗留属于谁。** D1 的修复（不能只读 `ownLegionIdentity()`）
是对的，但它顺手把「跨会话」变成了隐式默认。

### §4.2 三档作用域（本设计）

| 档 | 判据 | 默认 | 允许的动作 | 打印 |
|---|---|---|---|---|
| **1 `mine`** | 账本根行 `psid` == 我的 psid（**或** `run.sessionFile` 相等） | ✅ | 全动作（fetch + settle） | 不额外标注 |
| **2 `orphan-of-other`** | psid 不同/未知 **且** 拥有者 run 不活（`owner.json` 的 pid 已死，或 `owner.json` 缺失） **且** 未被别人 claim（或 claim 已过期） | ✅ | 全动作（这就是 6.2.4 D 场景） | 必须打印：`belongs to session p1a2b3c4d5e6f (2026-11-16T13-17-03…jsonl), owner pid 1234 (gone)` |
| **3 `foreign-live`** | 拥有者 run **活着**（另一台 pi 会话正在用） | ❌ `SCOPE_FOREIGN_LIVE` | 只读摘要；要 fetch/settle 必须 `any: true` | 必须打印同一个归属行 + 「它在运行，加 `any: true` 才会动它」 |

- 「活/不活」用**已有的**事实：`<runDir>/owner.json` 的 `{pid, host, at}`（`src/runs/owner.ts:24`）
  + `isPidAlive`。`run-active.ts` 那个 registry 是**进程内**的，读不了别人，不能用。
- pid 复用会让「死」看起来「活」。这个方向的错**安全**（只会多要一个 `any: true`），
  所以不引入更重的锁；把 `owner.json` 的 `at` 一起打印出来，让用户自己判。
- `any: true` 的语义**只放开 tier 3**，不是「跳过一切检查」：它不改变「先 claim 再 fetch」（§4.4）。

### §4.3 反例推演：默认改「只本会话」会不会打死 6.2.4 的 D？

**会。而且不是理论问题——D 的验收脚本就是这么跑的。**
`docs/reports/orphan-on-natural-exit.md` 的验收方式是「`pi -p` launch → 父进程自然退出 →
**全新进程** `status` + `recover`」。全新 `pi -p` = 新 session 文件 = 新 uuidv7 ⇒ **psid 不同**。
所以：

- 若默认 = 「只 mine」且没有 tier 2，**D 场景直接不可用**（新进程看不到任何东西）。
  这是把 6.2.4 的修复回退掉。**不可接受。**
- 若默认 = 「mine + tier 2」，D **仍然成立**：那条遗留的拥有者 pid 已死、没人 claim、
  psid 与当前不同 ⇒ 落 tier 2 ⇒ 默认就 fetch + settle，行为与 6.2.4 逐字一致，
  **唯一新增**是那句归属说明（这正是用户要的「不再不知道从哪冒出来」）。
- 若把 D 的第二个进程改成**续接同一 session 文件**（`pi --continue`），则 psid 相同 ⇒ tier 1，
  根本不进 tier 2。**两条路都通**，这就是为什么 psid 必须从「session id」派生而不是从「进程」派生。

**结论**：不是「本会话 vs 全部」的二选一，而是**用「拥有者是否还活着 / 是否已被认领」把
「别人的」切开**。tier 2 = 「无主的别人的」，允许默认接管；tier 3 = 「有主的别人的」，必须显式。
这条切法比 `any: true` 一刀切更贴 6.2.4 的事实，也不损失 D。

### §4.4 claim（消除双 fetch / 双 settle）

跨会话恢复打破了「一个 run 只有一个写者」这个前提：两个新会话可以同时发现同一条遗留。
所以 fetch **之前**在账本里写一条认领：

```
nodes.claimed_by = <psid>,  events: node_claimed{psid, at}
```

- 认领是**先写后 fetch**（顺序承重，与 6.2.4 的 settle 事件同一套路）。
- 认领过期：`claimed_by` 非空但 `claimed_at` 早于 N 分钟（默认 30）且认领者 pid 已死 ⇒ 可被重新认领。
- `listRecoverableLeftovers`（`:149`）打印 `claimed by <psid4> (at …)`，
  于是「谁在恢复它」也是一条可读事实，而不是一个静默的竞态。
- 这条同时修掉 §2.4 那个「两个会话写同一个 `<runDir>/remote/<name>.jsonl`」的隐患：
  只有认领者写。

### §4.5 对 6.2.4 的兼容清单（逐条）

| 6.2.4 已有行为 | 本设计后 |
|---|---|
| 父进程自然退出 → 远端行保持 open + `orphan_detected` | 不变（v6 不动 `orphan.ts`） |
| 全新进程 `status` 能列出遗留 | 不变（`listRecoverableLeftovers` 的扫描范围不变），**多一行归属** |
| `recover` 默认能 fetch 到 D 场景的那条 | **不变**（tier 2 默认开） |
| 第二次 `recover` → `already settled`，零 fetch | 不变（§2.6 不动幂等判据；claim 不改 `hasEnded`） |
| `already settled` 的 `recordedSettle` 读回 | 不变 |
| 本地 child 的 `session_shutdown` → `aborted` | 不变 |
| 同名两棵子树 | **行为变化**：从「按 `updated_at` 猜一个」变成 `AMBIGUOUS_NAME` + 候选列表 |

---

## §5 失败模式（psid 取不到）

| 情况 | psid | 产物落点 | 行为 |
|---|---|---|---|
| 正常持久化会话 | `p<12hex>` | `<mirrorRoot>/<psid8>/<runId>/<h>` | 正常 |
| `getSessionFile()` 有、id 抛错 | 由 `file:` preimage 派生 | 同上（仍是稳定键） | 正常；debug 日志各一行 |
| `inMemory()`（无文件） | 由 `getSessionId()` 派生 | 同上，但**跨进程不可复现** | 正常，**并打一条**：`session has no transcript; this run's psid is process-local` |
| id 与文件都没有（降级宿主） | **无** | `<mirrorRoot>/no-psid/<runId>/<h>` | **打 warning**（每次进程一次，不刷屏）：`session identity unavailable — remote artifacts are keyed by (run, name) only; a same-named child in another session could share them` |
| runId 不可知 | — | **不建产物** | 远端 launch 直接 `START_FAILED`（§2.0 规则）；本地 launch 不受影响 |
| v5 账本行（`psid NULL`） | 未知 | 老布局 | 读：按记录值；recover：tier 2/3 判定，不禁用 |

**一条硬规矩**：psid 的缺失**只能**降级命名空间，**不能**降级「是不是别人的」这个判断。
也就是说 `no-psid` 的产物必须与「明确属于别人」同样处理（tier 2/3），
不能因为「不知道是谁的」就当成「我的」。

---

## §6 键冲突矩阵（一页版）

| # | 位置 | 今天的键 | 外层命名空间 | 撞的后果 | 谁兜底 |
|---|---|---|---|---|---|
| 1 | 远端 `remoteDir` / `session.jsonl` | `(no-run, name)` | 整机（`<mirrorRoot>`，per-user） | 两条 transcript 交织 + 继承别人的上下文 | 无 |
| 2 | hc 终端名 | `lgl-<name>` | 一个 hc core | live→`NAME_TAKEN`；残缺→问错终端 | 半个（`NAME_TAKEN`） |
| 3 | recover 的终端地址兜底 | `lgl-<name>` | 同上 | 别人的 terminal 冒充自己的 | 无 |
| 4 | 远端 worktree 目录 | `<worktreeRoot>/<name>` | 整机 | launch 硬失败，且文案归咎于用户的取名（真凶是别的会话） | **无** |
| 5 | 分支名 | `<host>/<name>-<hex8>` | shared origin | 不撞（nonce）；只缺归因 | nonce |
| 6 | 本地 mirror / worktree / session / out | `(runDir, name)` | 一个 run | 不撞；**跨会话 recover 时两个写者** | runDir |
| 7 | `artifacts.id` | `(runId, name, round)` | 一个账本 | 不撞 | runId |
| 8 | `already settled` 判据 | `(账本, node.id)` | 一个账本 | 不撞 | 路径 id |
| 9 | **recover 的定位** | **`name`**（`WHERE name=?`） | store root 全部 run | 挑错分支的行 / 挑错会话的行 | 无（`updated_at` 排序=猜） |
| 10 | 控制类调用（`continue`/`stop`/`legion_output`） | **`name`**（`pickChildByName`） | store root 全部 run | 操作到别的会话的 child | 「优先 live」= 猜 |

**10 个键位 / 要动 7 处**：结构性必撞 5（1、2、3、4、9）；会静默误判 2（10 的「猜 live/最新」、
6 的「跨会话 recover 打破单写者」）；已经够了 3（5 的随机 nonce、7 的 runId、8 的路径 id）。

---

## §7 实施顺序（给实现 PR 的建议，不在本分支）

1. **P1（正确性，最小面）**：`SpawnInput` 透传 `runId`；`remoteDirFor` 加 `psid8`+`runId` 段；
   `no-run` 常量消失。→ 关掉 #1/#4。
2. **P2**：v6 迁移（`nodes.psid` + `run.json.psid`）+ 根行 psid 归一；
   `/legion status` 打印归属。→ 打开 §4 的可能。
3. **P3**：`recover` 三档作用域 + `any: true` + `AMBIGUOUS_NAME` + claim。→ 关掉 #9/#10 的误判。
4. **P4**：终端名加 `psid4`/`run4`，删掉「猜地址」兜底。→ 关掉 #2/#3。
5. **P5（可选）**：分支名归因段。
6. **P6**：`legion doctor` 的老布局提示。

每一档独立可回滚：P1/P2/P4 只写新产物，P3 只改查询与提示，互相不阻塞。

---

## §8 待定项

1. **claim 过期时长**（默认 30 分钟）要不要跟 renewal 预算联动？
2. **tier 2 的默认开**是否需要一个可见的开关（`legion.recoverScope = "mine" | "orphan" | "any"`）？
   当前倾向：不做开关，做 `any: true` 单向放开。
3. **fork 后的血缘**：要不要用 `header.parentSession` 记一条 `parent_psid` 让 fork 出来的会话
   能「认领」原会话的遗留？当前倾向：**不做**（§1.3 的语义定名），等有真实需求再加。
4. `psid` 进不进 `hc` terminal 的 `labels`（`legion.psid`）？成本极低，收益是
   `hc terminal ls` 能直接看出是谁的——倾向做。
5. 远端 `<mirrorRoot>/no-psid/` 这种降级目录要不要在 doctor 里变成「建议清理」？倾向：只报告。
