# pi-legion v2 冻结契约：军团树架构

> 状态：**FROZEN-1**（2026-10-11 CEO 批准冻结；修订必须走 §15 流程）
> 依据：2026-10-10/11 军团需求对齐（侦察底稿：`r-584dd563` scout-0/scout-1、`r-20cc52a2` scout-2，共 226 条带行号事实；RPC/SQLite/浮窗三项本机实测通过）
> 修订规则：见 §15。worker 发现契约矛盾时**停下上报**，禁止自行解释。

---

## 0. 术语表（用户语言 → 代码语言）

| 用户术语 | 代码术语 | 含义 |
|---|---|---|
| CEO | root session | 用户直接控制的 pi 主会话，树根 |
| 军团 | legion tree | 整棵递归派生树，一棵树一个 `legion.db` |
| 百夫长 | `centurion` | 组长角色，可递归派生自己的队 |
| 百人队 / 组 | squad | 一个 centurion 及其直接组员构成的子树 |
| 组员 | squad member | centurion 的直接子节点（现有角色：scout/worker/reviewer…） |
| 派生 | launch / spawn | 上级节点创建下级节点 |
| 召唤 | resume | 用 session 文件复活已退场节点，上下文无损（已实测） |
| 收队 | squad retire | 状态机走到终态后整队回收 |

## 1. 决策记录（ADR，全部已拍板）

| # | 决策 | 备注 |
|---|---|---|
| D1 | 任意节点可递归派生子树，深度/扇出/并发有硬上限（§11） | 树状组织架构 |
| D2 | 组长角色命名 **centurion**（百夫长），与仓库名 legion 同词源 | 2026-10-10 定 |
| D3 | centurion 权力 = 汇总权 + 对**自己组员**的标准 steer/retire | 不越界管别人的队 |
| D4 | 越级通道（叶子直达 CEO）**不做** | v2 明确出清，见 §16 |
| D5 | 规模目标：数十 ～ 300 节点 | 决定 RPC headless 架构 |
| D6 | MR 树状合并：子树 squash MR → 逐级上交，根统一合入默认分支 | 现有纪律的递归推广 |
| D7 | 传输层换 **pi RPC 模式**（`RpcClient` 子进程），去 herdr 展示依赖 | 实测：`--mode rpc --session <file>` 可用、resume 无损 |
| D8 | worktree **仅支持 git**（裸 `git worktree add`，现有实现） | 不做 herdr worktree 分支 |
| D9 | resume 必须支持；父死 = 子死（stdin close），恢复走 resume 链 | F13 语义变化，已知并接受 |
| D10 | 浮窗**点击才订阅**事件流（按需） | 控制内存与转发开销 |
| D11 | 可视化三层：常驻树面板（折叠）/ `/legion` 全屏树视图 / 实时浮窗 overlay | 键盘全路径，点击是糖 |
| D12 | 树级账本 **SQLite**（`node:sqlite`，`legion.db`，WAL） | 实测：本机 node 26.8.1 可用，跨连接 `data_version` 感知可用 |
| D13 | 四阶段状态机；**状态事实由 supervisor+DB 持有**，centurion 只能经 `legion_phase` 工具请求迁移 | 防幻觉、防泄漏 |
| D14 | verifying 阶段**无 LLM**：supervisor 直接执行验收命令 | review 管 judgment，verify 管事实 |
| D15 | rework 上限 2 次（继承现有"重试 ≤2"纪律） | 超限 → failed 上抛 |
| D16 | 方案 C：`src/herdr/` 冻结归档 `src/backends/legacy/`；v2 仅支持 pi kind | 过渡期 = pin v0.16.x |
| D17 | 通信五通道（§8）；邮件走 DB 总线 + 宿主邮差；权限 = 树边（父/子/同父兄弟） | 跨子树须经理转交 |
| D18 | **可视化只读机器事实，永不解析 LLM 陈述** | 铁律，见 §10.4 |
| D19 | 事件总线抽象（`LegionEventBus`）预留动画；跨进程感知 = `data_version` + 游标增量读，禁 `fs.watch` | 动画本身不在本期 |
| D20 | `run.json` 保留为 per-run 权威记录；`legion.db` 是树级聚合层，可从前者重建 | §4.4 |

## 2. 架构总览

```text
用户 (CEO) — root pi 会话（TUI）
 ├─ pi-legion 扩展
 │   ├─ LegionSupervisor（宿主层，替代 src/herdr/）
 │   │   ├─ RpcClient × N            ← 子节点 = headless `pi --mode rpc` 子进程
 │   │   │   ├─ 事件流订阅（text_delta / tool / agent_settled）
 │   │   │   ├─ extension_ui_request 上浮（§3.5）
 │   │   │   └─ get_session_stats → usage 表
 │   │   ├─ 邮差循环（每 2s 收件箱轮询 + 注入/唤醒，§8.3）
 │   │   ├─ 状态机引擎（不变量校验 + 迁移 + 超时，§7）
 │   │   └─ 孤儿扫描（§11.3）
 │   ├─ legion.db（node:sqlite，WAL，全树共享，env 下发绝对路径）
 │   └─ 可视化（§10：树面板 / 全屏树 / 浮窗 ← LegionEventBus）
 │
 └─ centurion 子进程（RpcClient，cwd = 子树 worktree）
     ├─ 同款 pi-legion 扩展（子模式）
     │   ├─ LegionSupervisor（管自己的组员，递归）
     │   ├─ legion_mail / legion_tree 工具（所有子节点注册）
     │   └─ legion_phase 工具（centurion 注册）
     └─ worker / scout / reviewer … 组员（RpcClient，worktree:false）
```

**分层原则**：传输（RPC 进程）／状态（legion.db + supervisor）／决策（各节点 LLM）／展示（TUI 三层）四层正交。核心保留资产（scout-2 证实）：`runtime.ts` 监督循环、`session.ts` 判定链、`store.ts` run.json、budget、lineage、worktree、acceptance——全部对 herdr 零依赖。

## 3. 进程与传输层（RPC supervisor）

### 3.1 Supervisor 接口（orchestrator 的唯一后端缝）

```ts
interface LegionSupervisor {
  spawnChild(input: SpawnInput): Promise<ChildHandle>;   // RpcClient 启动 + 首个 prompt
  prompt(name: string, text: string): Promise<void>;
  steer(name: string, text: string): Promise<void>;      // RPC steer：本轮工具后、下次 LLM 前送达
  followUp(name: string, text: string): Promise<void>;   // 空闲后送达
  abort(name: string): Promise<void>;
  waitSettled(name: string, timeoutMs?: number): Promise<SettleResult>;  // 事件驱动，替代轮询
  isAlive(name: string): boolean;                        // 替代 agentGet presence
  stats(name: string): Promise<UsageSnapshot | null>;    // get_session_stats → usage 表
  retire(name: string, opts?: { graceful?: boolean }): Promise<void>;    // stdin close / SIGTERM
}
```

`SpawnInput` 承载现有 `buildPiArgs` 全套 flag（`--session`/`--model`/`--tools`/`--extension`/`--append-system-prompt`），经 `RpcClient` 构造参数 `{cliPath, cwd, env, args}` 传入。**M1 验收项 a** 即验证此承载。

### 3.2 生命周期映射

| 现有（herdr） | v2（RPC） |
|---|---|
| `agent start` + `agent prompt` | `RpcClient` spawn + `prompt()` |
| `agent wait` 2s 切片轮询 | `agent_settled` 事件 |
| `agent get` presence | `isAlive`（进程/连接状态） |
| `agentSendKeys y/n/enter/ctrl+d` | `extension_ui_request` 应答 / stdin close |
| `pane close` 杀进程 | stdin close 优雅退出；超时 SIGTERM |
| `run.json` herdr 字段 | 载体改为 `{supervisor: "rpc", node_id}`，`paneId/tabId` 删除 |

### 3.3 判定链不变：成败仍以 session jsonl 为唯一权威（F26–F33）。collect 复用 `waitForQuiet` + `parseSessionFile` + `deriveOutcome`，收割后顺手写 `node_settled` 事件 + 更新 nodes 行。

### 3.4 每节点身份：`ownerToken` 语义改为「树根 session id + node id」；多会话同 repo 隔离靠 node id 命名空间（替代 `parentPaneId` 过滤）。

### 3.5 UI 请求上浮：子节点扩展的 `ctx.ui.confirm/select/...` 在 RPC 模式变成 `extension_ui_request`，沿宿主链逐级上浮至根 TUI（带来源标注 `centurion-fe/worker-a2 请求确认…`），CEO 应答后逐级回传。**默认人工应答**；策略化自动应答是开放问题（§16）。

### 3.6 herdr 残留清理：`Placement` 设置项删除（三值全部无意义）；`maxConcurrentAgents` 从 hint 升级为真闸门（并入 §11 全局预算）；`announceChild`/`ParentPaneLabeler`/`nonPiPaneStillWorking`/`readPaneOutput` 整链删除。

## 4. legion.db（树级账本）

### 4.1 位置与传递

- 根会话**首次 launch 时**创建：`<rootRunDir>/legion.db`（`.pi-subagents/runs/<runId>/` 下）
- 绝对路径经 env **`PI_LEGION_DB`** 随 `lineageEnv()` 逐层下发——任何深度的 supervisor 直连同一个库，不经父节点转发（RPC spawn 的 env 由宿主直接控制，F35 类丢失坑不复存在）
- 连接约定：每 supervisor 进程一连接；`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`；写入均为短事务 prepared statement

### 4.2 Schema（`PRAGMA user_version = 1`）

```sql
PRAGMA user_version = 1;   -- 未来迁移用

CREATE TABLE nodes (
  id            TEXT PRIMARY KEY,     -- 树形 id（§5）
  parent_id     TEXT REFERENCES nodes(id),
  name          TEXT NOT NULL,        -- 父内唯一显示名
  role          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'pi',
  depth         INTEGER NOT NULL,
  run_id        TEXT,                 -- 该节点自己的 run 目录
  session_file  TEXT,                 -- resume 凭据（绝对路径）
  worktree_path TEXT,                 -- 子树 worktree（仅 centurion）
  model         TEXT,
  team          TEXT,
  status        TEXT NOT NULL,        -- starting|running|blocked|settled|failed|retired
  phase         TEXT,                 -- centurion 专有：planning|implementing|reviewing|verifying|done|failed|aborted
  phase_since   INTEGER,              -- 当前阶段起始时刻（超时判定）
  rework_count  INTEGER NOT NULL DEFAULT 0,
  contract_path TEXT,                 -- planning 产物（§7.2）
  task_summary  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL      -- 心跳：邮差循环每次刷新
);
CREATE INDEX idx_nodes_parent ON nodes(parent_id);
CREATE INDEX idx_nodes_status ON nodes(status, updated_at);

CREATE TABLE events (                -- append-only 树级事件日志（机器写，§10 的唯一状态事实源）
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  type    TEXT NOT NULL,             -- 见 §4.3
  data    TEXT,                      -- JSON
  ts      INTEGER NOT NULL
);
CREATE INDEX idx_events_node ON events(node_id, id);
CREATE INDEX idx_events_type_ts ON events(type, ts);

CREATE TABLE usage (                 -- 成本账本（stats 轮询 upsert）
  node_id    TEXT PRIMARY KEY REFERENCES nodes(id),
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd   REAL NOT NULL DEFAULT 0,
  updated_at INTEGER
);

CREATE TABLE messages (              -- 邮件（§8）
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_node    TEXT NOT NULL,
  to_node      TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  kind         TEXT,                 -- question|report|handoff|notice（display-only，§10.4）
  urgency      TEXT NOT NULL DEFAULT 'info',   -- info | action-needed
  delivered    INTEGER NOT NULL DEFAULT 0,     -- 0=pending 1=injected 2=bounced
  delivered_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_messages_inbox ON messages(to_node, delivered, id);
```

### 4.3 事件类型枚举（闭集，新增需修订契约）

`node_launched` `node_settled` `node_failed` `node_retired` `node_resumed` `node_blocked` `phase_change` `phase_timeout` `mail_sent` `mail_delivered` `mail_bounced` `budget_refused` `orphan_detected` `tree_finalized`

**事件粒度**：只记树级语义事件。工具调用级明细留在 session jsonl，不入 events（防低价值流水账）。

### 4.4 与 run.json 的关系（D20）：run.json 保留为 per-run 权威记录（resume 凭据、原子写、写锁、坏文件隔离原样不动）。legion.db 是树级索引+账本，**可重建**：`legion-rebuild` 命令遍历 nodes 各 run_id 的 run.json + session jsonl 重建 nodes/events（best effort，验收项 M2-h）。

### 4.5 写入权责：节点行由**其父的 supervisor** 写（launch 插入、settled/failed 更新、心跳刷新）；phase 字段仅由状态机引擎（§7）迁移；usage 由各 supervisor 轮询 upsert（默认 30s，仅 running 节点）。LLM 永不直连库——唯一入口是扩展实现的工具（§8.4），child-guard 禁止 bash 触碰 legion.db（§13）。

## 5. 节点标识与命名

- **node id** = `<父id>.<name-slug>`，根节点 id 为 `root`；例：`root.centurion-fe`、`root.centurion-fe.worker-a2`
- name-slug 语法 = `[a-z][a-z0-9_-]{0,31}`（与 src/shared/name.ts 的 herdr 名字语法一致，**禁止点号**——点是 id 分隔符；`sanitizeNameForFs` 不适用于 slug，因其允许点号会制造 `a.b` vs `a`+`b` 的 id 歧义）。**父内唯一**，重名拒绝（BUDGET_EXCEEDED 同级错误通道）；launch 时的 `name` 参数先按 makeName 风格净化到该语法再拼 id
- RPC 子进程不在 herdr 命名空间，全局撞名问题（F16）随之消失；树内寻址一律用 node id
- 工具寻址简写：对**自己的直接子节点**可用短名；`legion_mail` 的 `parent`/`squad`/`children` 广播糖在发送方 supervisor 内展开

## 6. 角色与团队

### 6.1 centurion 角色卡（M2 落库为 `agents/centurion.md`）

```yaml
---
name: centurion
description: 百夫长/组长：携带一支团队递归派生的指挥角色。负责冻结契约、
  调度组员、推进四阶段状态机、整队交付（squash MR）。
kind: pi
allowNestedSubagents: true
maxSubagentDepth: 2          # R=本角色子树代数上限（含自身；与所在深度无关；只收紧不放宽）：1=叶子禁派生；2=可派一层组员、组员不可再派；3=组员（如孙代 centurion）可再派一层
worktree: true               # 子树 worktree：本人 cwd 即队的工作区（§9）
team: be-value               # 默认队；launch 可覆盖（subagent({team:"fe-premium"})）
---
```

角色正文要点（写给 LLM 的职责说明）：只管自己队；planning 先出契约再开工；implementing 按文件所有权并行派工；reviewing 多角度对抗审查；`legion_phase` 请求迁移被拒时按拒绝理由修正后重试（不算 rework）；收队时 squash MR + 汇总 verdict；组员卡死按现有止损纪律（重试≤2 → 咨询 advisor 或上报）。

### 6.2 团队绑定：角色 frontmatter `team` 为默认，launch 参数覆盖，经现有 `PI_SUBAGENTS_TEAM` env 通道下发——centurion 的 roster 即所选队的成员（现成机制，README:498）。

### 6.3 既有角色不动语义；v2 内所有角色 kind 必须 `pi`（非 pi kind 在 rpc 后端直接拒绝，错误信息指引迁移或 pin v0.16.x）。

## 7. 百夫队状态机

### 7.1 状态与迁移

```text
                 ┌────────── rework（≤2，D15）──────────┐
                 ↓                                      │
PLANNING → IMPLEMENTING → REVIEWING → VERIFYING → DONE
   │            │             │            │
   └──────── FAILED / ABORTED（上级砍）────────┘
```

| 迁移 | 触发 | 进入条件（supervisor 校验的不变量） |
|---|---|---|
| →planning | 队创建 | 无 |
| planning→implementing | centurion 经 `legion_phase` 请求 | `contract_path` 存在且非空（契约已落盘） |
| implementing→reviewing | 同上 | 全部 worker 子节点 settled（failed 的须已处理：rework 重派或转 failed） |
| reviewing→verifying | 同上 | ≥1 个 reviewer settled 且 verdict `ok:true` |
| reviewing→implementing | 同上（rework） | `rework_count += 1`；>2 拒绝并转 failed |
| verifying→implementing | 验收命令有红 | 同上（rework） |
| reviewing→planning | 同上（centurion 裁量：计划本身错了） | 允许，但**必须**写 `phase_change` 事件并 mail 通知上级知悉 |
| verifying→done | 验收全绿 | **supervisor 自动迁移，无 LLM 参与**（D14） |
| *→failed | rework 超限 / 组员全部失败 / 上级裁决 | 终态 |
| *→aborted | 上级 retire 整队 | 终态 |

不变量（违反即拒绝迁移 + 报警事件）：implementing 中不允许存在 running 的 planner；DONE 时全部子节点必须终态；reviewing 至少一个 reviewer settled 过才可采信 verdict。

### 7.2 契约文件（planning 产物）

位置：`<子树worktree>/.pi-legion/contract.md`（read-only 队放 runDir）。人读正文 + 机器可读验收块：

````markdown
```legion-verify
npm run typecheck
npm test -- --filter <scope>
```
````

正文必须包含：目标、接口形状（wire 字段）、**文件所有权清单**（继承现有纪律）、验收清单。契约修订 = 更新文件 + `squad` 广播"契约已更新，重读 contract.md"（内容走文件，信只做通知）。

### 7.3 verifying 执行：supervisor 在子树 worktree cwd 逐条执行 `legion-verify` 块内命令（`timeout` 包裹，默认 600s/条，可设），输出落 runDir + 事件记录。空块 = 直通 done（read-only 队常见）。

### 7.4 超时（每阶段独立时钟，默认可设，role/task 可覆盖）：planning 15m / implementing 60m / reviewing 30m / verifying 15m。超时**不自动杀**：写 `phase_timeout` 事件 + mail 通知该 centurion 的上级，由上级裁决（steer 续期 / abort 收队）。确定性优先，避免意外屠杀。

### 7.5 DONE 收队流（全在 centurion 进程内自动编排）：
1. verifying 全绿 → supervisor 迁移 phase=done（事件）
2. 注入收队 prompt：汇总 verdict、squash 分支、开 MR
3. centurion settle → 其父 collect → retire centurion
4. worktree 保留至根节点合 MR 后由 `legion-gc` 清理（文件不删库记录）

## 8. 通信协议

### 8.1 五通道（各司其职）

| 通道 | 机制 | 方向 | 接收方成本 | 用途 |
|---|---|---|---|---|
| 命令 | RPC `prompt`/`steer`/`abort` | 父→子 | 一次注入 turn | 派活、纠偏、中止 |
| 观察 | `legion_tree` 只读工具（查库） | 任意→树 | **零**（不打扰被观察者） | "A2 干完了吗""B 队到哪阶段了" |
| 工件 | 共享 worktree 文件 | 队内 | 零 | 契约、接口、大内容 |
| 邮件 | `legion_mail`（本节） | 树边 + 同级 | 一次注入 turn | 事件、提问、通知 |
| 成果 | verdict + collect | 子→父 | 收割时 | 交付物 |

**设计原则**：大部分"通信需求"是观察需求——查库零成本，把邮件流量压到只剩需要对方"知道并反应"的事件。

### 8.2 权限（D17，发送时由扩展校验树边）

| 收件对象 | 允许 |
|---|---|
| 直接上级（`parent`） | ✅ |
| 直接下级（`children` / 短名） | ✅ |
| 同父兄弟（短名） | ✅ |
| 跨子树表亲 | ❌ 拒发 + 提示经双方 centurion 转交 |
| 越级直达根 | ❌（D4） |

### 8.3 邮差（投递方 = 收件人的宿主 supervisor）

每 supervisor 对自己的直接子节点每 2s 轮询收件箱（索引查询 `to_node AND delivered=0`），按收件人状态选注入方式：

| 收件人状态 | 注入 | 语义 |
|---|---|---|
| running + `action-needed` | `steer` | 本轮工具后、下次 LLM 前送达 |
| running + `info` | `follow_up` | 排队等空闲 |
| idle/settled 但进程在 | `prompt` | 直接开新 turn |
| retired 且非终态 | **resume 后投递**（D9：`--session` 唤醒，首条消息即此信） | 邮件即召唤令 |
| 终态（done/failed/aborted） | 退信（delivered=2）+ 回执邮件给发送方 | — |

根节点收件箱 → `pi.sendMessage` 注入（复用现有 notify 机制）。**异步无等待**：发送即返回；刻意不做同步请求-响应（两个 LLM 互等 = 死锁 + token 焚烧炉）。

### 8.4 工具签名（注册给所有子节点，与 `allowNestedSubagents` 无关）

```ts
legion_mail({ to, subject, body, kind?, urgency? })   // to: 短名|node id|parent|squad|children
  // body 软上限 4KB（超限警告建议走文件），硬上限 32KB 拒发
legion_tree({ scope?: "children"|"squad"|"subtree"|"tree", depth? })  // 只读节点行摘要
legion_phase({ to, note?, evidence? })                // 仅 centurion（§7）
```

### 8.5 护栏：每节点发送速率默认 10 封/5 分钟（超限拒发）；投递成功以 RPC 命令 success 落 `delivered=1`（崩溃恢复最坏重复投递，信带 id 可去重——dup 可忍，丢不可忍）；速率/上限进 settings（§11.4）。

## 9. 隔离与交付（子树 worktree、MR 树）

- **per-subtree worktree**：centurion launch 时由**其父**创建（复用现有 `createChildWorktree`：`git worktree add -b pi-subagent/<slug>-<nonce>`，D8 仅 git）；centurion 的 cwd 即该 worktree；**组员一律 `worktree:false` 原地干活**。隔离边界从"每个 writer"上移到"每个子树"，MR 数量从 O(组员数) 降到 O(子树数)
- 孙代 centurion 在子树 worktree 内再开 nested worktree（git 原生支持），递归成立
- **MR 树**（D6）：每棵子树一个 squash MR → 父节点（或其队）合并 → 逐级上交 → 根合入默认分支。合并权在各级父节点，叶子永不 merge（现有纪律的递归推广）
- 文件所有权清单随契约（§7.2）逐层传递；契约矛盾 = 正确拒绝，上报修订后重派

## 10. 可视化与事件总线

### 10.1 三层 UI（D11）

1. **常驻树面板**（升级 `tui/status.ts`，aboveEditor 常驻组件模式已具备）：默认只展开前两级；**深度 >2 自动折叠**为一行（`▸ worker-a2 +3 collapsed`）；运行中子树不折叠、已完成默认折叠；每行 `● name (role) · model · elapsed` + `⎿ phase/status · turn N · tools`
2. **`/legion` 全屏树视图**（新 `tui/tree-view.ts`，`ctx.ui.custom()`）：完整树、展开/收起（键盘 + 鼠标）、`ScrollView` 滚动、搜索定位
3. **实时浮窗**（新 `tui/live-overlay.ts`，`overlay: true` + `MouseRegion`）：点击 agent 名或 `/legion <name>` 打开；**打开才订阅**该节点 RPC 事件流（D10）；ESC 关闭

**输入双通道**：`MouseRegion` 为主 + agent 名渲染 OSC 8 超链接为备（链接优先级高于点击区域，herdr/ghostty 嵌套环境已验证可点）。**键盘全路径**是硬要求（terminal 鼠标模式的文档铁律）。

### 10.2 LegionEventBus（D19，动画预留口）

```ts
interface LegionEventBus {
  on(type: LegionEventType, handler: (ev: LegionEvent) => void): () => void;
}
```

事件类型分两域（REV-13 明确）：**存储域**（对齐 §4.3 的 14 种，经 createDbEventSource 脏检查入总线）与**进程内域**（node_launched/node_steered/node_retired/node_aborted/ui_request + 细粒度观察流 text_delta/tool_call/turn_start/agent_settled，由扩展层在调用 supervisor 方法与接收 uiProxy 回调时同步 emit；事件带 nodeId，不落库）。消费端（面板/树视图/浮窗/未来动画）只订阅总线，永不直连 DB 或进程事件。**喂料端可插拔**：
- 进程内直发（supervisor 执行命令/投递邮件的瞬间，方法调用级零延迟——覆盖"主干戏份"：直接子节点全部活动）
- 跨进程增量读：UI 进程每 200–500ms `PRAGMA data_version` 脏检查（一次整数比较，实测可用）→ 变了才 `SELECT * FROM events WHERE id > <游标>`（append-only + AUTOINCREMENT 天然游标）
- **禁止** `fs.watch` 盯 db 文件（WAL 写入不触主文件 mtime，必漏）

### 10.3 数据源（每一段渲染内容从哪来）：nodes/events/messages 表元数据（信封）+ RPC 事件流 + session jsonl。详见各层验收。

### 10.4 铁律（D18）：**Viz reads facts, never parses claims.** 状态渲染只用机器事实（supervisor 写的表/事件/协议流）；LLM 陈述（邮件正文、verdict 理由）只做展示（点开看原文），永不驱动任何状态。邮件 `kind` 枚举纯为面板图标，标错不触发逻辑。

## 11. 恢复、治理与预算

### 11.1 硬上限（settings 可覆盖，launch 时查库强制）

| 项 | 默认 | 判定 |
|---|---|---|
| `maxDepth`（全树深度） | 4 | 硬顶 = `MAX_NESTED_PATH_ENTRIES`（血缘路径在 4 处饱和；settings/env 超 4 截断——告警在 M1-integration 的 launch 路径接入，M0 阶段截断静默可接受）。每进程生效上限 C：根 `C = min(env 运营者覆盖, settings.legion.maxDepth, 4)`；深度 d、上限 C 的父 launch 角色 R：先过闸门 `d+1 > C` → BUDGET_EXCEEDED；再经 `PI_SUBAGENT_MAX_DEPTH` 下发 `C子 = min(C, d + R, 4)`（R 缺省=不收紧；非法值按叶子 R=1 处理；语义 = 子树代数含自身，位置无关，只收紧不放宽）。不变量：C子 ≤ C父，且每进程 depth ≤ maxDepth |
| `maxChildrenPerNode`（单节点扇出） | 8 | 父 supervisor 查自己子节点数 |
| `maxActiveNodes`（全树并发 running+starting） | 30 | **全树真闸门**（替代只当 hint 的 maxConcurrentAgents）：launch 前一条 SQL，超限 BUDGET_EXCEEDED + `budget_refused` 事件 |

### 11.2 心跳与孤儿：postman 循环每次刷新直接子节点 `updated_at`。根 supervisor 每 60s 扫描：非终态 + `updated_at` 超 90s = `orphan_detected` 事件 + mail 通知 CEO。恢复 = resume 链（CEO 裁决，auto-resume 默认关）。孤儿判定可判定化：**非终态 ∧ 无活跃进程 ∧ 心跳超时**。

### 11.3 泄漏四闸门：进程（终态自动 retire + phase 超时兜底）／预算（§11.1 + usage 表入账）／状态（终态闭集 + 孤儿扫描）／文件（**故意不防**：worktree/jsonl 是 resume 凭据，MR 合并后 `legion-gc` 清理，只删文件不删库记录）。

### 11.4 v2 settings 增量

```jsonc
"subagents": {
  "legion": {
    "maxDepth": 4, "maxChildrenPerNode": 8, "maxActiveNodes": 30,
    "phaseTimeouts": { "planning": 900000, "implementing": 3600000,
                       "reviewing": 1800000, "verifying": 900000 },
    "verifyCommandTimeoutMs": 600000,
    "mailRatePer5Min": 10,
    "usagePollMs": 30000, "orphanStaleMs": 90000
  }
}
```

`herdr.*` 设置键：**过渡期保留解析并标 deprecated**（用户仍在用；解析代码随 legacy 后端归档，读取处打 deprecation 警告；正式移除排 v3）；`Placement` 移除（§3.6）。

## 12. 遗留后端与迁移（方案 C，D16）

- `src/herdr/{client,runner}.ts` → `src/backends/legacy/`，`HerdrClient`/`PaneInfo`/`TabInfo` 等专属类型随迁；**只挪不改逻辑**；顺手删 3 个零调用死方法（`version`/`tabRename`/`paneProcessInfo`）
- v2 orchestrator 只对接 `LegionSupervisor`；legacy **不承诺接入 v2 主线**。过渡期需要 herdr pane 形态 = 安装 v0.16.x（锁版本），旧版本原样可用
- 非 pi kind（cursor 等）：v2 拒绝（明确报错 + 指引）；`search` 等用户角色在 v2 配置改 `kind: pi`。legacy 测试套件标记 legacy，不阻塞主线 CI

## 13. 安全边界（child-guard 演进）

**删除**（pane 语义消失）：herdr 命令封锁组、pane 读写规则、"不 prompt 其他 pane"类任务卡文案（注意：文案变更影响历史 run.json 可读性，只新增不重写历史）。
**保留**：read-only 角色文件写保护（含 `=>`/`>=`/`&>` 重定向坑）、`WRITE_HEADS`/`WRITE_GIT`/`WRITE_NPM`、`sed -i` 禁、budget 拦截（maxToolCalls/maxTurns）、`timeout` 包裹、JSON verdict 完成守卫。
**新增**：bash 直接读写 `legion.db` 禁止（工具通道是唯一合法入口，§4.5）；任务卡嵌套条款改为 RPC 语义（"Nested subagents via `subagent` tool only"）。

## 14. 里程碑（文件归属 + 验收清单）

> 纪律：每里程碑先出任务卡再派工；共享文件按序串行；worker 自跑 lint/typecheck/测试；review 是合并门禁。

### M0 地基修复（在现有后端上先行，独立发布）

- **归属**：`src/runs/orchestrator.ts`（maxDepth 接线 + 三个实测陷阱修复：`??` 优先级会丢 env 继承必须改 min、`<1→4` 会把禁止变放行、硬顶 4 必须写进 min）、`src/runs/store.ts`（maxDepth 落盘一致性）、`index.ts`（两处 `new Orchestrator` 传深度 + **测试脚本 env 隔离**：`test`/`test:integration`/`test:live`/`test:docker` 入口统一 `env -u PI_SUBAGENT_ALLOW_NESTED -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_MAX_DEPTH -u PI_SUBAGENT_PARENT_PATH`，防 worker 环境继承导致 96/107 假红）、`src/agents/settings.ts`（**仅新增** `subagents.legion` 设置块解析，契约 §11.4 全块一次加齐：maxDepth/maxChildrenPerNode/maxActiveNodes/phaseTimeouts/verifyCommandTimeoutMs/mailRatePer5Min/usagePollMs/orphanStaleMs，含默认值；**不动** herdr.* 键——那是 M1 的事）、`src/shared/types.ts`（**仅新增** legion 设置类型，其余不动）、`test/integration/nesting.test.ts`（新增，覆盖行为表 a/b/b2/b3/c1/c3/e：a=根派 X(R=1) 后 X 派孙被拒；b=根派 X(R=2)→Y 可、Y 派被拒；b2=X(R=3)→Y(R=2)→Z 可、Z 派被拒；b3=X(R=2)→Y(R=4)：**Y 允许启动**，但继承收紧预算 C_Y=min(2,1+4,4)=2，Y 成叶子（Y 派任何子节点被拒）——「只收紧不放宽」由继承公式的 min 强制，不是拒绝启动；c1=centurion(R=2) 派 worker(R=1) 后 worker 派被拒但 centurion 派 advisor 可；c3=centurion(R=3)→worker(R=2)→advisor 可、advisor 派被拒；e=env PI_SUBAGENT_MAX_DEPTH=0 时禁派、=10 时截断到 4）
- **内容**：接通 `agent.maxSubagentDepth` → Orchestrator（生效公式见 §11.1，INCL 语义）；run.json 记录**运行时实际** maxDepth（修"落盘 1 / 运行时 4"矛盾）；端到端嵌套测试。**语义总纲：R = 自己这一代 + 往下还能派的代数；R−1 = 还能往下派几层。** 角色文件不改（7 个内置角色 R=1 本就是叶子，§6.3 成立）；仓库外 `~/.pi/agent/agents/worker.md`（R=1 + allowNested + 自带 advisor 止损路径）由 CEO 迁移：改 R=2 或设 `subagents.agentOverrides.worker.maxSubagentDepth: 2`（M2 写 centurion.md 时另定队内止损归属）
- **验收**：(a) `maxSubagentDepth:1` 的子进程派孙被拒（BUDGET_EXCEEDED）；(b) `:2` 可派一层孙、孙再派被拒；(b2) `:3` 派 `:2` 派孙可、孙再派被拒（位置无关分界点）；(b3) `:2` 派 `:4`：Y 可启动、继承 C=2、Y 成叶子（『只收紧不放宽』= 继承预算不扩大，非拒绝启动；advisor 行为表 b3 行的 Y(2,2) 即此意）；(c) run.json maxDepth == 运行时值；(d) 干净 env 全仓 typecheck + 613 unit + 107 integration 全绿（含 env 隔离后 worker 环境同样全绿）；(e) env=0 禁派、env>4 截断到 4

### M1 RPC 宿主层（换发动机，单层语义不变）

> REV-2 补充（REV-3 勘误）：M1-core 新增文件为 `src/supervisor/{types,rpc-supervisor,ui-proxy}.ts` + 平铺单测 `test/unit/supervisor.test.ts`（`npm test` 的 glob 是 `test/unit/*.test.ts`，只认 unit 目录下的平铺文件）。

- **归属**：新增 `src/supervisor/{rpc-supervisor,types,ui-proxy}.ts`；重写 `src/runs/orchestrator.ts`、`index.ts`、`src/extension/child-guard.ts`、`src/extension/playbook.ts`、`src/shared/types.ts`；移动 `src/herdr/*` → `src/backends/legacy/`；删除/归档 `src/runs/layout.ts`、`src/extension/parent-label.ts`、`src/shared/cursor-chat.ts`、`src/shared/progress.ts` 的 pane 分支。REV-9 补充归属：`src/api.ts`（公共导出面：legacy 符号改从 `src/backends/legacy/` 重导出或标 @deprecated，layout/Placement/pane-progress 导出移除，`./api` 入口保持可用）、`test/unit/{layout,parent-label}.test.ts` 与其他直接 import src/herdr/* 的测试（随迁移改路径或归档）、`test/integration/nesting.test.ts`（若受迁移影响需适配）、`test/live/rpc-live.test.ts`（M1 验收 (a) 的 live e2e 补充用例）。REV-10/11 归属（最终形态）：① **测试侧 = 整个受影响测试套件**——主链切换破坏的一切既有测试（import `src/herdr/*` 或 `test/helpers/fake-herdr*` 的、经 fake-herdr/HERDR_BIN 驱动 index.ts 的、断言 herdr 行为语义的——含 progress/layout/parent-label/herdr-client/child-mode/context-injection/playbook/teams/presents-regression 等）均迁移到 fake-supervisor、改写断言、或删除并在交付报告列明；判定锚点：切换后 typecheck + 全量 unit/integration 必须绿，为此所需的一切测试改动在归属内。② **生产侧**：另含 `src/extension/summary.ts`、`src/agents/agents.ts` 与 `src/agents/settings.ts` 中 Placement 相关行（placement 解析/默认值，REV-12：删除 Placement 会波及这两文件，属锚点必然）、以及因切换而编译失败的其他 src 生产文件（仍不含 `src/supervisor/*`、`src/legion/*`、`src/tui/*`、docs/*）
- **验收**：(a) `RpcClient` args 承载 `buildPiArgs` 全套 flag 实测通过；(b) 单层 launch→steer→collect→retire 全链路 e2e；(c) resume 复刻 ping-ok 实验（新进程同 session 上下文无损）；(d) steer 用 RPC `steer` 命令（流式中排队语义生效）；(e) blocked 审批经 ui-proxy 上浮根 TUI 可应答；(f) 改造后测试套件全绿（fake-supervisor 替换 fake-herdr，1064 行假件重写为 RPC mock）；(g) legacy 目录编译通过、不进主 bundle

### M2 军团树（组织层：db + centurion + 状态机 + 邮件）

- **归属**：新增 `src/legion/{db,nodes,events,usage,mail,state-machine,budget,rebuild}.ts`、`agents/centurion.md`、`src/extension/legion-tools.ts`；修改 `orchestrator.ts`（launch 落库/树命名/预算查库/子树 worktree）、`src/runs/worktree.ts`（subtree 模式）、`src/runs/args.ts`（env 增 `PI_LEGION_DB`/`PI_LEGION_NODE_ID`）、`src/agents/agents.ts`、`index.ts`（队级 resume、collect 落库）
- **验收**：(a) 三层树 e2e：CEO→centurion→workers×2 全阶段走通（契约落盘→并行实施→review verdict→verify 实跑→done 收队 + squash MR）；(b) rework 循环：review major→回 implementing→复审通过；(c) rework≥2 → failed 上抛；(d) kill centurion 进程 → 孤儿报警 → resume 恢复整队、settled 组员不复活、运行中组员上下文延续；(e) `maxActiveNodes` 超限拒派 + 事件；(f) 邮件：同级/父子/父←子通、跨子树拒发并提示路由、retired 收件人唤醒投递、终态收件人退信；(g) WAL 压测：60 模拟 supervisor 并发写 5 分钟，busy 超时率 <0.1%；(h) `legion-rebuild` 从 run.json+jsonl 重建 nodes/events；(i) 非 pi kind 明确拒绝

### M3 可视化

- **归属**：新增 `src/tui/{tree-view,live-overlay}.ts`、`src/extension/event-bus.ts`；修改 `src/tui/status.ts`（树形+折叠）、`src/extension/runtime.ts`（喂总线 + data_version 游标）、`skills/pi-legion/SKILL.md`
- **验收**：(a) 常驻面板深度>2 折叠、运行子树展开、宽度自适应不溢出；(b) `/legion` 全屏滚动/展开/搜索可用；(c) 浮窗点击与 `/legion <name>` 双入口、仅订阅目标节点、ESC 关闭；(d) 全部交互有键盘路径；(e) 300 合成节点树渲染刷新 <500ms、内存不随事件无限增长；(f) 总线单测：进程内直发零延迟、跨进程 data_version 感知 ≤1s

## 15. 契约修订规则

1. 只有主会话（或经 CEO 授权的修订 MR）可改本文件；修订记录：日期 + 条款号 + 原因，追加于文末修订日志
2. worker 报契约矛盾 = 正确拒绝：停下、引用条款号与冲突点、等修订后重派
3. 计划/契约文档在别的分支看不到时，向父会话要内容，禁止自建同名文件
4. 冻结后新增事件类型、schema 变更、权限变更必须走修订，不允许实现时顺手加

## 16. 明确不做 / 开放问题（v2 出清清单）

**不做**：越级通道（D4）；跨子树直通邮件（走经理转交）；动画渲染（总线已预留，D19）；detached supervisor（父死后子树独立存活——v2 语义 = 父死子死 + resume，D9）；UI 请求自动应答策略；跨主机分布（herdr machines）；非 pi kind 的 RPC 支持；邮件富内容/附件（文件指针模式覆盖）。

**开放问题**（实现期可再议，不阻塞）：usage 轮询与 collect 的合并时机；`/legion` 视图的过滤预设；legion.db 的长期留存与 GC 策略（默认不删）。

---

## 修订日志

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-11 | DRAFT-1 | 初稿：整合军团需求对齐全部决策（D1–D20）与三份侦察报告事实 |
| 2026-10-11 | FROZEN-1 | CEO 批准；修正 §6.1 maxSubagentDepth 注释（R=1 禁派生、R=2 一层）与 M0 验收语义对齐 |
| 2026-10-11 | REV-1 | 修 §14-M0 归属缺口：`subagents.legion` 设置块（§11.4）原本无任何里程碑认领解析文件，M0 无法实现 §11.1 生效公式。M0 归属增加 `src/agents/settings.ts`（仅新增 legion 块解析）与 `src/shared/types.ts`（仅新增类型）。触发：worker-0 按契约 §15-2 正确拒绝（改动零，无提交） |
| 2026-10-11 | REV-2 | 两个新车道任务卡勘误：(1) `npm test` glob 是 `test/unit/*.test.ts` 不含子目录（package.json:49，CONTRIBUTING.md:22），新模块单测一律平铺（M1-core 用 `test/supervisor.test.ts`，M2-core 用 `test/legion-*.test.ts`），§14-M1 已加注；(2) 事件类型闭集确认为 14 种（§4.3 原文即 14，派工卡笔误写 15）。触发：worker-1/worker-2 按契约 §15-2 正确拒绝（均零改动） |
| 2026-10-11 | REV-3 | REV-2 勘误的勘误：平铺路径应为 `test/unit/supervisor.test.ts` 与 `test/unit/legion-*.test.ts`（REV-2 误写成顶层 `test/*.test.ts`，不在 npm test glob 内）。live smoke 路径 `test/live/rpc-live.test.ts` 归 `npm run test:live`，正确。触发：worker-4 按 §15-2 正确拒绝（零改动） |
| 2026-10-11 | REV-4 | 修 §5 节点 id 歧义：slug 语法从「沿用 sanitizeNameFs」改为 `[a-z][a-z0-9_-]{0,31}`（禁止点号，点是 id 分隔符）。原因：sanitizeNameForFs 允许点号，会使 `父.a` + 子 `b` 与 `父` + 子 `a.b` 生成相同节点 id，违反 §4.2 主键约束。触发：worker-5 按 §15-2 正确拒绝（零改动） |
| 2026-10-11 | REV-5 | §4.2 把 `PRAGMA user_version = 1;` 落进 SQL DDL 块首行（原先只在节标题注记，实现者无 DDL 可抄，哨兵测试也只能存在性匹配）。非 schema 变更，仅语句归位。触发：reviewer-0 对 PR #6 的 major finding |
| 2026-10-11 | REV-6 | §6.1/§11.1/§14-M0 深度语义统一为 INCL（advisor 裁决）：`maxSubagentDepth R` = 子树代数含自身（位置无关、只收紧不放宽）；launch 下发 `C子 = min(C, d+R, 4)`。否决字面 ABS（同卡多深度不可表达、会落盘 depth>maxDepth）与任务卡 C 语义（R=1 可派孙，违反验收 (a)）。M0 归属新增 package.json（测试入口 env 隔离，防 96/107 假红）与三陷阱修复要求。触发：worker-3 按 §15-2 正确拒绝 → advisor-4 裁决（含 3 个实测实现陷阱 + 用户 worker.md 迁移指引） |
| 2026-10-11 | REV-7 | 澄清 b3 措辞（advisor 裁决的忠实转译）：『只收紧不放宽』指**继承预算不扩大**（min 强制），不是拒绝启动。X(R=2) 派 Y(R=4) 允许，Y 继承 C=2 成叶子。REV-6 转译时把「Y 派生被拒」误写为「Y 启动被拒」，与 §11.1 公式矛盾（公式下闸门 2>2 为假，启动放行）。触发：worker-6 按公式推演发现并按 §15-2 正确拒绝（零改动） |
| 2026-10-11 | REV-8 | §11.1「超 4 截断并告警」的告警归属明确给 M1-integration（launch 路径 console.warn + 事件），M0 静默截断可接受。触发：reviewer-4 对 PR #10 的 minor finding（告警半边无主） |
| 2026-10-11 | REV-9 | M1-integration 派工勘误三件：① §11.4 herdr.* 键改为「过渡期保留解析 + deprecated 警告，正式移除排 v3」（原「移除」与任务卡「保留 deprecated」矛盾，取后者——方案 C 过渡期语义）；② §14-M1 归属补入 `src/api.ts`（公共导出面，legacy 符号重导出/标 deprecated，layout/Placement/pane-progress 导出移除）；③ 归属补入受影响测试文件（layout/parent-label 等单测迁移或归档、nesting.test.ts 适配、rpc-live.test.ts 补 e2e 用例）。触发：worker-8 按 §15-2 正确拒绝（零改动，三个阻塞点全部属实） |
| 2026-10-11 | REV-10 | REV-9 测试归属从枚举改为类别授权：凡直接 import `src/herdr/*`、`src/runs/layout.ts`、`src/extension/parent-label.ts` 或被删 pane-progress/Placement API 的既有测试文件均在 M1 归属内（含 progress.test.ts 等，不再逐一枚举）。触发：worker-8 第二次按 §15-2 正确拒绝（progress.test.ts 未在 REV-9 枚举内，零改动） |
| 2026-10-11 | REV-11 | 归属最终形态（终结逐类补丁）：主链切换型里程碑的边界 = 验收本身。测试侧：切换破坏的一切既有测试（含经 fake-herdr 驱动 index.ts 的 teams/presets-regression、断言 herdr 行为的 child-mode/context-injection/playbook 等）均归 M1，锚点 = 切换后全量绿。生产侧：补入 summary.ts 及其他因切换编译失败的 src 文件（仍排除 supervisor/legion/tui/agents/docs）。触发：worker-8 第三次按 §15-2 正确拒绝（fake-herdr 驱动型与行为断言型测试不在 REV-10 类别内，零改动） |
| 2026-10-11 | REV-12 | REV-11 生产侧排除清单修正：删除 `Placement` 必然波及 `src/agents/agents.ts`（frontmatter 解析/默认值）与 `src/agents/settings.ts`（herdr.defaultPlacement）——锚点「切换后全量绿」自身要求的改动范围，从排除清单移入归属（仅 Placement 相关行，agents/ 其余不动）。触发：worker-8 第四次按 §15-2 正确拒绝（Placement 删除 vs agents/ 排除的矛盾，零改动） |
| 2026-10-11 | REV-13 | §10.2 总线事件分两域：存储域（§4.3 的 14 种，经 createDbEventSource）与**进程内域**（node_launched/node_steered/node_retired/node_aborted/ui_request + 观察流 text_delta/tool_call/turn_start/agent_settled，带 nodeId 不落库，由扩展层在调 supervisor 方法/接 uiProxy 回调时 emit）。M3-integration 归属增加 `src/extension/event-bus.ts` 的类型集扩展（仅加进程内域类型，不动脏检查逻辑）。原因：RpcSupervisor.onEvent 是 per-child RPC 协议事件，操作级事件（launch/steer/retire）不在其中，须由扩展层显式 emit。触发：worker-12 按 §15-2 正确拒绝（类型闭集不含操作事件，零改动） |
