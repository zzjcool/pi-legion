# 调研报告：用父 session 身份（psid）加固跨机产物命名空间

- 基线：`origin/master` `0ed298d`（= 6.2.4）。分支 `design/session-scoped-identity`，**只含文档 + 一个只读探测脚本**。
- 设计：`docs/design/session-scoped-identity.md`。
- 相关 issue：<https://github.com/zzjcool/pi-legion/issues/405>
- 复现：`bash scripts/probe-session-identity.sh`（只读；读了本机 328 个真实 session 文件）。

---

## §0 结论先放

1. **「名字当主键」的键位找到 10 处**（矩阵见 §2）：**结构性必撞 5 处**——远端镜像目录 + `session.jsonl`、
   hc 终端名、recover 的「猜终端地址」兜底、远端 worktree 目录、`recover` 按裸 `name` 定位；
   **另有 2 处会静默误判**——跨 run 的 `pickChildByName`，以及「跨会话 recover 打破单写者前提」
   导致的 `<runDir>/remote/<name>.jsonl` 双写者；**3 处已经够了**——分支名（随机 nonce）、
   `artifacts.id`（runId）、`already settled` 的判据（路径 id）。⇒ 要动 7 处。
2. **根因不是「用了 name」，而是「作用域缺失时退化成一个共享常量」**：
   生产上 `new TerminalSupervisor()`（`index.ts:1667`）不传 `runId`，
   `remoteDirFor`（`src/runs/remote.ts:1485`）于是把段写成常量 `no-run`。
   远端的**每一个** child 都住在 `<mirrorRoot>/no-run/<handle>`——全机共用。
3. **pi 给的最稳定身份**：`ctx.sessionManager.getSessionId()`（= `SessionHeader.id`，UUIDv7）。
   跨进程重启/续接**不变**，compaction **不变**，`/branch` 与 `fork` **会变**（新 id，旧文件记在 `parentSession`）。
   文件路径（`getSessionFile()`）与它是同一个事实（basename 恒含 id），但**多一个机器相关的绝对路径**，
   所以当 fallback、不当主选。
4. **推荐方案一句话**：把远端产物键从 `(name)` 换成 `(psid, runId, name)`，
   `psid = "p"+sha256("psid-v1|"+sessionId)[0..12]`；`recover` 的作用域按
   **「我的 / 别人的但无主 / 别人的且有主」** 三档切，而不是按「本会话 vs 全部」切。
5. **其它地方**：能 3 处（远端/本地/hc 的思路可复用）、不能且**不需要** 3 处
   （pi-async 已经是 session 作用域、legion 本地 `(runDir,name)`、anotify 的 `namespace_id`+`parent_task_id`）。
   判断标准只有一条：**两个互不通信的父进程能不能算出同一个键**——能，就必须有作用域段；不能，UUID 就够。

---

## §1 证据：现状的键

### §1.1 远端 transcript（最严重）

| 事实 | 出处 |
|---|---|
| 远端镜像目录 = `<mirrorRoot>/<runId\|no-run>/<handle>` | `src/runs/remote.ts:1485-1495` `remoteDirFor` |
| 生产**不传** runId ⇒ 段落成常量 `no-run` | `index.ts:1667` `new TerminalSupervisor()`；`src/supervisor/terminal-supervisor.ts:236-252` 注释自承「index.ts 在构造时还没有 run id」 |
| 实际调用点 | `src/supervisor/terminal-supervisor.ts:534` `remoteDir = remoteDirFor(target, this.runId, input.name)` |
| `mirrorRoot` 是**每用户**的，不是每项目/每会话 | `src/runs/remote.ts:1326-1330` = `dirname(worktreeRoot)/.pi-subagents-mirror`；常量在 `:689` |
| 远端 child 的 `--session` 被重写成 `<remoteDir>/session.jsonl` | `src/supervisor/terminal-supervisor.ts:565-574` |
| 目录是 `mkdir -p`（幂等，不拒绝已存在） | `src/runs/remote.ts:3082-3085` `ensureRemoteDir` |
| pi 遇到已存在的 `--session` 文件：读 header、沿用**别人的** sessionId、向后追加 | `pi-coding-agent/dist/core/session-manager.js:666-690` `_setSessionFile` → `_loadEntries`；`:718-722` `this.sessionId = header.id` |

**后果**：不是「覆盖」，是**跨父会话的上下文污染**——第二个 child 读到的历史里有第一个 child 的对话，
两条 transcript 交织在一个文件里。父机上的本地镜像（`<runDir>/remote/<name>.jsonl`）**各存各的**，
所以两个父会话会各自从同一个远端文件里读出「混合体」，且没有任何一处会报错。

### §1.2 hc 终端名

| 事实 | 出处 |
|---|---|
| 名字 = `lgl-<runId8>-<handle>`，无 runId 时 = `lgl-<handle>` | `src/supervisor/terminal-supervisor.ts:160-168` |
| 调用点同样吃 `this.runId`（生产为 undefined） | `:360` `terminalName(this.runId, input.name)` |
| 同名且**持有者 live** → `NAME_TAKEN`（响亮） | `:1397-1448` `runTerminal` |
| 同名且**持有者 finished** → core 的 rm 后重试（拿走别人的名字） | `:1424-1444` |
| recover / probe 在 `remote_terminal` 缺失时**重算** `host/lgl-<name>` | `src/runs/remote-artifact.ts:258, 264, 438, 653` |

**后果**：第 4 条是静默的那一半。`remote_terminal` 是 v5 才有的列，所以**所有 pre-v5 行**在 recover 时
会拿一个「猜出来的地址」去问——问到别人的 terminal。别人 live → 自己的遗留被判「还在跑」，永不 settle；
别人 finished → 自己的遗留被静默判死。两种情况都不会有任何一行字说「我可能问错了」。

### §1.3 远端 worktree

| 事实 | 出处 |
|---|---|
| 目录 = `<worktreeRoot>/<name>`（**无 runId、无 nonce**） | `src/runs/remote-worktree.ts:134-136` `remoteWorktreePathFor`；调用点 `:767` |
| 目录已存在 → **硬失败**，且错误文案把责任推给用户的取名 | `:768-775`：`worktree path <dest> already exists on that machine (remove it there, or relaunch with a different name)`（`INVALID_PARAMS`） |
| 分支 = `pi-subagent/<host>/<name>-<hex8>`（**有随机 nonce**） | `:75-77`；`hex8 = randomBytes(4)`；调用点 `:781`（attempt 0 用传入 nonce，之后用随机） |
| 本地对应物：目录 = `<runDir>/worktrees/<name>`，分支 = `pi-subagent/<name>-<hex8>` | `src/runs/worktree.ts:19-20`、`:201-204` |

**后果**：分支唯一、目录不唯一——这个不对称本身就是缺陷。第二个会话的 launch 会在
`git worktree add` 之前就**硬失败**，而文案说的是「换个名字重试」——于是用户会去改名字，
而不是去发现「那个路径属于另一个会话，里面还有它未提交的改动」。
本地版没有这个问题，因为 `runDir` 已经是会话作用域。

### §1.4 ledger 与 `already settled`

| 事实 | 出处 |
|---|---|
| 账本在 `<runDir>/legion.db` ⇒ **本身就是 per-run** | `src/legion/db.ts:307-312` |
| 节点 id = `<parentId>.<slug(name)>` ⇒ 账本内**路径唯一** | `src/legion/nodes.ts:169-172`、`:187-192` |
| `already settled` 的判据 = `hasEnded(node)` + `recordedSettle(db,node.id)` | `src/runs/remote-recover.ts:339`、`:360` |
| **查找** = `WHERE name = ?`，然后 `unsettled.at(-1)` 按 `updated_at` 挑一个 | `src/legion/nodes.ts:548-555`；`src/runs/remote-recover.ts:331-334` |

**结论要分清两层**：幂等判据本身是 `(账本, 节点路径 id)`——**已经是对的**，不是 `(name)`。
撞在**上一跳**：同名两棵子树（`root.centurion-1.worker-0` 与 `root.centurion-2.worker-0`）
用裸 `name` 定位 + `updated_at` 排序 = **猜**。settle 错了行，第二次调用就会把一个
「从未被这份 transcript 支撑过」的 verdict 当成 `already settled` 返回。

### §1.5 `recover` 的作用域

| 事实 | 出处 |
|---|---|
| 账本查找优先级：①本会话的 run ②本 store root 里**最新**的、持有该 name 的其它 run ③无 | `src/runs/remote-recover.ts:114-146`（含 `:118-140`） |
| 排序实现 | `:188-207` `runsInRecoveryOrder` |
| 只按 name 找行 | `src/legion/nodes.ts:548` |
| 归属信息**不打印**：首行只有 name/host/terminal/node.id | `:571-601` `recoveryHeadline` |
| 修正的历史（D1）：旧版只读 `ownLegionIdentity()`，新进程永远「No legion ledger in this session」 | `:88-112` 的设计注释 |

**结论**：现状默认**就能**跨会话 settle 别人的遗留，且**不打印**那条遗留属于谁。
这是 6.2.4 D1 的修复（对）+ 一点过度（跨会话成了隐式默认）。

### §1.6 控制类调用的裸 name

| 事实 | 出处 |
|---|---|
| `pickChildByName` 扫**所有 run** 找同名 child，优先 live，再取最新 run | `src/runs/store.ts:173-192` |
| name miss 时还会搜「邻近 store」（sibling / worktree，最多 24 个） | `src/runs/store-lookup.ts:98-140`（`candidateStoreRoots`，`sibling` 在 `:132`）、`:42` `MAX_SEARCHED_STORES = 24`；名字解析在 `:182` |

**后果**：`continue` / `stop` / `legion_output` 传一个裸 name，可能作用到**别的会话**的 child。
「优先 live」意味着：如果别的会话的 child 正活着，你 `stop` 的是**它**。

---

## §2 键冲突矩阵

| # | 位置 | 今天的键 | 外层命名空间 | 撞的后果 | 现有兜底 |
|---|---|---|---|---|---|
| 1 | 远端 `<remoteDir>/session.jsonl` | `(no-run, name)` | 整机（每用户 `mirrorRoot`） | transcript 交织 + 继承别人的上下文；静默 | **无** |
| 2 | hc 终端名 | `lgl-<name>` | 一个 hc core | live→`NAME_TAKEN`（响亮）；finished→被 rm 后顶替 | 另一半 |
| 3 | recover 的终端地址兜底 | `lgl-<name>` | 同上 | 问错终端 ⇒ 假 live / 假死 | **无** |
| 4 | 远端 worktree 目录 | `<worktreeRoot>/<name>` | 整机 | launch 硬失败，文案归咎于用户的取名（`relaunch with a different name`） | **无** |
| 5 | 分支名 | `<host>/<name>-<hex8>` | 共享 origin | 不撞 | 随机 nonce（**够**） |
| 6 | 本地 mirror/worktree/session/out | `(runDir, name)` | 一个 run | 单 run 不撞；**跨会话 recover 会两个写者** | runDir |
| 7 | `artifacts.id` | `(runId, name, round)` | 一个账本 | 不撞 | runId（**够**） |
| 8 | `already settled` 判据 | `(账本, node.id)` | 一个账本 | 不撞 | 路径 id（**够**） |
| 9 | `recover` 的行定位 | **`name`**（`WHERE name=?` + `updated_at`） | store root 全部 run | settle 错分支/错会话的行 | 无（排序=猜） |
| 10 | `pickChildByName`（continue/stop/output） | **`name`** | store root 全部 run | 操作到别的会话的 child | 「优先 live」=猜 |

**计数（10 个键位，三种命运）**：

| 类别 | 数量 | 行号 |
|---|---|---|
| **结构性必撞**（无作用域，必然会撞，且今天无兜底） | **5** | 1、2、3、4、9 |
| **会静默误判**（有兜底但是「猜」；或本次设计新增的竞态） | **2** | 10（按名跨 run 解析，选 live/最新）、6（跨会话 recover 打破单写者前提） |
| **已经够了**（UUID / 随机 nonce / 路径 id 已经作用域化） | **3** | 5（nonce）、7（runId）、8（路径 id） |

⇒ **需要动的 7 处**（5 + 2），**不需要动的 3 处**。行 2 的「两半」（终端名 / 猜地址）算一处缺陷的两个面。

---

## §3 pi 到底给了什么父身份

### §3.1 `ExtensionContext.sessionManager` 暴露的（`ReadonlySessionManager`）

`pi-coding-agent/dist/core/session-manager.d.ts:178`：

```
Pick<SessionManager, "getCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" |
      "getLeafId" | "getLeafEntry" | "getEntry" | "getLabel" | "getBranch" |
      "buildContextEntries" | "buildSessionProjection" | "getHeader" | "getEntries" |
      "getTree" | "getSessionName">
```

| 需要的东西 | 有没有 | 出处 |
|---|---|---|
| 稳定 `sessionId` | ✅ `getSessionId(): string` | `.d.ts:253`；`.js:780-782` |
| 会话文件路径 | ✅ `getSessionFile(): string \| undefined` | `.d.ts:254`；`.js:783-785` |
| 会话起始时间 | ✅ 但只能从 `getHeader().timestamp` 拿 | `.d.ts:333`；`SessionHeader.timestamp` |
| 会话目录 | ✅ `getSessionDir()` | `.d.ts:251` |
| 父/分叉来源 | ✅ `getHeader().parentSession?: string`（**是一个文件路径**，不是 id） | `.d.ts:4-12`（`SessionHeader`） |
| `PI_SESSION_*` 环境变量 | ⚠️ **只有内建 bash 工具的子进程**才会拿到 `PI_SESSION_ID` / `PI_SESSION_FILE`，且是逐次 spawn 注入；**扩展自己的 `process.env` 里没有** | `dist/core/tools/bash.js:161-171`（`delete env.PI_SESSION_ID` 起头，只在 `exposeSessionEnvironment && ctx` 时写回） |

> 行号以运行中的 pi `1.5.2` 为准；与 `pi-legion/node_modules` 里的 `1.5.0` 相差 2–24 行（同一段代码）。

**所以：扩展必须从 `ctx.sessionManager` 取，不能指望环境变量。**
（本仓今天正是这么做的：`index.ts:1851`、`:1905`、`:2665` 等处 `ctx.sessionManager?.getSessionFile?.()`。）

### §3.2 稳定性（代码 + 实测双证）

| 事件 | sessionId | 依据 |
|---|---|---|
| 新会话 | 生成 `uuidv7()` | `session-manager.js:12-14` `createSessionId` |
| 打开/续接同一文件 | **沿用 header id** | `:718-722` |
| compaction | **不变**（同文件追加一条 entry） | `:892-912` `appendCompaction` |
| `/branch`（`createBranchedSession`） | **新 id + 新文件**，旧文件写进 `parentSession` | `:1250`、`:1257-1264` |
| `forkFrom` | **新 id + 新文件** | `:1386-1419` |
| `inMemory()` | 有 id、无文件 | `:1376-1377` + `:695-706`（`persist=false` 时不设 sessionFile） |

实测（`scripts/probe-session-identity.sh`，本机 328 个真实 session 文件）：

```
session files read     : 328
id == filename segment : 328 / 328
with parentSession     : 2  (0.6 %)
duplicate ids          : 0
id length              : [36]
```

⇒ 文件 basename 恒为 `<ISO 时间戳>_<sessionId>.jsonl`，header `id` 与 basename 的 id 段逐字相等，
id 全局唯一，id 是 UUIDv7（36 字符）。**序 1（id）与序 2（路径）指向同一个事实。**

### §3.3 结论：哪个字段最稳定

- **最稳定 = `getSessionId()`**。跨重启/续接/compaction 不变；只有「分叉出一个新会话」才变——而那是**应该**变。
- 只有 session 文件路径的宿主（老版本、降级）⇒ 用 **`sha256("psid-v1|file:"+path.resolve(file))`** 当键，
  与 id 派生同构（设计 §1.2）。**不要**把路径本身当键：它会出现在远端目录名、git ref、终端名里。
- **现状用的是哪个身份？** `ownLegionIdentity()`（`index.ts:1732`）走的是
  `run.sessionFile` 路径相等（`findSessionRun`，`index.ts:1279`），
  并明确写着「仓内没有 session id 概念（`ChildRecord.sessionId` 是死字段），不要新造」
  （`index.ts:1271-1276`）。
  **本设计不与它冲突**：`findSessionRun` 的判据**一个字不改**（会话续接照旧按路径相等），
  psid 是给「命名空间」用的**另一个投影**，并且是从同一个 session 派生出来的，
  所以两者不会给出互相矛盾的分组。

---

## §4 其它地方能不能同样设计（用户第二问）

判断标准（本报告提出，设计 §2.0 采用）：

> **两个互不通信的父进程，能不能在没有任何共享状态的前提下算出同一个键？**
> 能 ⇒ 该键所在命名空间必须有父作用域段；不能（键里带 UUID/随机 nonce）⇒ UUID 已经足够。

### §4.1 pi-async —— **能，而且已经做完了**（结论：不需要改）

| 事实 | 出处 |
|---|---|
| 数据目录 = `<sessionDir>/pi-async/<sessionId>` | `pi-async/extensions/index.ts:38-49`（`sessionDataDir`，注释标 D-16 / PLAN §2.8） |
| 取不到会话身份时退化到 `~/.pi/async/<pid>` | `:51-54` `fallbackDataDir` |
| 每个 task 的键 = `randomUUID()`，文件 `<dataDir>/<uuid>.output` / `.json` | `pi-async/src/core/registry.ts:253-254`、`:357-358`、`:1294` |

**结论**：这是本仓应该抄的**先例**——它恰好就是「用 `getSessionId()` 给产物加命名空间」。
taskId 是 UUID ⇒ 本来就唯一，没有同类风险。
唯一要承认的代价是**同一个**代价：新会话不自动看见旧会话的 task（与 §4.3 的 D 场景完全同构）。
pi-async 的选择是「不跨会话」，legion 因为 6.2.4 D 必须跨会话，所以 legion 要比它多一档（设计 §4.2）。

### §4.2 legion 本地子会话目录 / 本地 worktree —— **不能也不需要**

- `<runDir>/<name>.jsonl`（`store.ts:281`）、`<runDir>/worktrees/<name>`（`worktree.ts:19`）、
  `<runDir>/remote/<name>.jsonl`（`remote-artifact.ts:152`）、`<runDir>/out/<name>/r<N>.md`（`artifacts.ts:79`）
  —— 键都是 `(runDir, name)`，而 `runDir` 由 `r-<8hex>` 随机 runId 构成（`store.ts:131-134`）。
- 按 §4 的标准：两个父进程**不能**算出同一个 `runDir`（随机）⇒ 已经足够。
- **唯一的新增风险**：跨会话 recover 会让两个会话写同一个 `<runDir>/remote/<name>.jsonl`。
  这不是「键不对」，是「一个 run 出现了第二个写者」⇒ 用 claim 解决（设计 §4.4），不是加作用域段。

### §4.3 anotify 的 agent/anode 会话（顺带，别深挖）

| 事实 | 出处 |
|---|---|
| 它有自己的 `namespaces` 表（`id` 主键 + `UNIQUE(slug)`），几乎所有资源都挂 `namespace_id` | `internal/store/schema.sql:138-146`；`namespace_configs` `:151`；`tasks` `:414-418` |
| 子任务用 `parent_task_id`（显式父指针），并有 `(namespace_id, parent_task_id)` 索引 | `:418`、`:490` |
| 节点身份是 `nodes.id` + `UNIQUE(name)`（**故意全局唯一**的机器名） | `:178-198` |
| `tasks.id` 是服务端生成的 id，`node_instances` 用 `UNIQUE(node_id, slot)` | `:233-247` |

**结论：不需要动。** anotify 已经用**两个正交的作用域**（`namespace_id` 是硬边界、`parent_task_id` 是血缘）
表达了我们想用 psid 表达的东西，而且它**没有**「用名字当跨作用域主键」的写法——
唯一按 name 定位的是 `nodes.name`，那是刻意的全局唯一（一台机器一个名字）。
它的 `namespace` 是**用户可见的资源边界**，psid 是**会话级的私有作用域**，两者定位不同，不要硬套。

### §4.4 通用结论：什么时候必须复合键，什么时候 UUID 够

| 情况 | 例子 | 需要 `(父作用域, 名字)`？ |
|---|---|---|
| 键要写进一个**多写者共享**的命名空间（一个目录根、一个 core 的名字空间、一次跨 run 的查询） | 远端 `session.jsonl`、hc 终端名、`recover` 的定位 | **是** |
| 键由**创建者自己**生成且带随机性 | `runId`、`taskId`、分支 nonce、`artifacts.id` | **否** |
| 键只在**一个 run/一个进程**内被读 | 本地 `(runDir,name)`、账本 `node.id` | **否** |
| 键要在**人类界面**上被区分（同名的两个 worker） | 终端名、`git branch -r` | **是**（归因，不是唯一性） |
| 「作用域」缺失时会被填成**共享常量** | `no-run` | **必须修**——不管有没有 psid |

**别为了统一而统一**：把 psid 加进 `artifacts.id` 或 taskId 只会让键变长、让老数据多一条迁移路径，
而正确性一分不涨。psid 该加的地方只有「外层命名空间比 name 的存活范围更大」的那几处。

---

## §5 推荐方案（与设计文档一致，摘要）

1. `psid = "p" + sha256("psid-v1|" + sessionId).hex[0..12]`（13 字符 / 48 bit）；
   fallback preimage = `"psid-v1|file:" + path.resolve(sessionFile)`。
2. 远端目录：`<mirrorRoot>/<psid8>/<runId>/<handle>`；**`no-run` 常量消失**
   （runId 由 orchestrator 经 per-spawn `SpawnInput` 传下来，拿不到就**拒绝**远端 launch）。
3. hc 终端名：`lgl-<psid4>-<run4>-<handle>`（prefix 14，handle 仍有 18）＋ **删掉「猜地址」兜底**
   （没有 `remote_terminal` 就报 `unknown` 并给 `hc terminal ls` 查法）。
4. 分支名：`pi-subagent/<host>/<psid8>/<name>-<hex8>`——**只做归因**，唯一性仍由 nonce 保证。
5. ledger v6：`nodes.psid` + `nodes.claimed_by`（两个 nullable，无 backfill）+ `run.json.psid`。
   **根行的 psid 才是作用域**（子节点有自己的 session 文件与自己的 id）。
6. `recover` 三档：`mine` / `orphan-of-other`（默认允许，**必须打印归属**）/ `foreign-live`
   （默认拒，`any: true` 才动）。归属判活用已有的 `owner.json` + `isPidAlive`。
7. `already settled` 的判据**不动**；只改**定位**：同名多行时回 `AMBIGUOUS_NAME` + 候选列表，不猜。
8. psid 取不到：降级到 `no-psid/<runId>/<handle>` + **一次 warning**；
   但「不知道是谁的」一律按「别人的」处理（tier 2/3），**不能**当成「我的」。

### 不能破坏的东西（6.2.4 的资产）

- 父进程自然退出 → 远端行保持 open + `orphan_detected`（`src/legion/orphan.ts`）：**不动**。
- 全新进程 `status` 能列出遗留：**范围不变**，只多一行归属。
- `recover` 在 D 场景下默认能 fetch：**必须仍然能**（设计 §4.3 的推演），靠 tier 2 而不是靠「不限作用域」。
- 第二次 `recover` → `already settled`、零 fetch：**不动**。
- 本地 child 的 `session-shutdown` → `aborted`：**不动**。

---

## §6 待定项 / 留给实现 PR 的判断题

1. claim 过期时长（草案 30 min）要不要与 renewal 预算联动。
2. tier 2 的默认开是否需要一个配置开关（倾向：不做开关，做 `any: true` 单向放开）。
3. fork 后是否用 `parentSession` 记 `parent_psid` 让新会话「继承」旧遗留（倾向：不做）。
4. `psid` 进不进 hc terminal 的 `labels`（`legion.psid`）——成本极低，`hc terminal ls` 直接可读（倾向：做）。
5. `psid4` 在终端名里够不够（16 bit vs 目录用的 32 bit）——如果实测撞了，就把 `run4` 让给 `psid`。

---

## §7 复现

```bash
# 1) session 身份的实测（只读，328 个真实文件）
bash scripts/probe-session-identity.sh

# 2) 生产上 TerminalSupervisor 确实没拿到 runId
grep -n "terminal: new TerminalSupervisor" index.ts        # 1667
grep -n "runId" src/supervisor/terminal-supervisor.ts      # 236-252, 534

# 3) 远端目录的共享常量
grep -n "no-run" src/runs/remote.ts                        # 1493-1495

# 4) recover 按裸 name 定位
grep -n "WHERE name = ?" src/legion/nodes.ts               # 551
grep -n "unsettled.at(-1)" src/runs/remote-recover.ts      # 334
```
