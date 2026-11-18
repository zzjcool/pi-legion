# xm-dispatch-fixes-v1 — 跨机派发实跑暴露的四个缺陷（冻结契约）

基线：`master 962992f`（6.2.0）。分支 `feat/xm-fixes`。性质：**bugfix（patch）**，无新功能语义变更，除 D4 的角色策略属"实现既有设计意图"。

真机现场：Mac 父机 6.2.0 → `hw-nj`。三条报错原文见 `docs/reports/xm-dispatch-fixes.md`。

---

## D1 — `pi.extensions` 声明为**目录**时，其下的入口必须合法（Bug 1）

**判定规则**（唯一）：设 `relative` = 本机请求入口在包内的相对路径（posix，无前导 `./`），`declared` = 远端该包声明的条目集合。

| # | 远端声明 | 请求 `relative` | 结局 |
|---|---|---|---|
| T1 | `./extensions/index.ts` | `extensions/index.ts` | `ok`（原样映射） |
| T2 | `./extensions`（目录） | `extensions/pi-autoresearch/index.ts` | **`ok`**，映射到 `<远端包目录>/extensions/pi-autoresearch/index.ts` |
| T3 | `./extensions`（目录） | `extensions` | `ok`（映射到目录本身，保持 v1.2 行为） |
| T4 | `./dist/index.js`（文件） | `extensions/x.ts` | `entry-missing`（**只有这种情况失败**） |
| T5 | 包未安装 | — | `not-installed` |

前缀匹配以 `/` 为界：`extensions-other/x.ts` **不得**被 `extensions` 覆盖。
理由：一个声明为**文件**的条目不可能成为另一条路径的目录前缀（文件没有子路径），所以前缀匹配不会把"文件声明"放宽。

**不做**：不对映射结果额外发 `test -e`（那是 Bug 2 的跳过语义的地盘，见 D2）。

---

## D2 — 缺失/入口不符的继承扩展：默认跳过 + 一条汇总 warning（Bug 2）

- 适用范围：**只有** `-e/--extension` 的值。其它绝对路径参数（`--skill`、argv 里的杂项）保持 v1.2 硬拒绝 —— 那些不是可继承项。
- 可跳过原因：`not-installed`、`entry-missing`。`no-package`（不是包内路径）**不跳过**，那是配置错误。
- 聚合：一次 launch **一条** warning，列出全部被跳过的扩展 + 一条可直接粘贴的 `agentOverrides` 片段：
  `"subagents": { "agentOverrides": { "<agent>": { "excludeExtensions": ["pi-sop", ...] } } }`
- 硬失败**仅当**角色卡显式声明必需：新字段 `requiredExtensions?: string[]`（frontmatter + agentOverrides 合法键）。匹配规则复用 `matchesExcludedExtension`（路径或包名）。
  - 一条 `requiredExtensions` 命中即 **一条** 聚合错误（列出全部必需但不可映射的项），而不是每包一条。
- 未被跳过的项语义零变化（v1.2 的 `entry-missing`/`not-installed` 对必需项仍报原文案）。
- 投递通道：`ChildHandle.warnings?: string[]`（与既有 `warning` 并列；`warning` 是模型解析的**单条**通知，不动它）→ `Orchestrator.launch` 返回值 → `index.ts` 渲染 `  ⚠ <name>: <text>`。**禁止**只写 `process.stderr`（tool 结果里不可见）。

---

## D3 — 跨机转录：读的必须是"settle 之后的那份"（Bug 3）

三个独立缺陷，三条都要修：

**D3.1 读回时机。** 现在 read-back 只在 `collect()` 开头做一次，判词在 `awaitSupervisor` 之后用那份**冻结快照**。改为：wait 结论落定后（settled / gone / timeout 且在 grace 循环内每次重试前）**重新 read-back** 一次，再解析。判词只允许建立在最后一次 read-back 上。
运行中的 child（`wait === "timeout"` 且 alive）也要能看到已产出的部分，不得停在 launch 时快照。

**D3.2 路径归一。** 写入方落 `<runDir>/remote/<name>.jsonl`；读取方 `sessionFileOf` 优先内存 read-back，其次**磁盘上已存在的 mirror**，最后才回落到记录里的本地占位文件。本地 child 行为零变化（它们没有 `remote/` 这一层）。
不做双写（不把 mirror 拷进 `<runDir>/<name>.jsonl`）：一个文件一个来源，避免两份内容漂移。

**D3.3 计数与失败语义。**
- `lines`（"of M"）与 `returned`（"N"）必须来自**同一次** read-back，且 settle 后 `returned === lines === 远端真实行数`（< 4000 行时）。
- read-back 失败**不得**产出 `aborted (no assistant message for the last prompt)`：改为 `unknown`，reason 明说 `transcript not retrieved from host '<h>'`，并带远端路径 + `hc exec` 取回命令。工作成果与"父端能否读转录"分开 —— 读不到转录不等于子 agent 没干活。
- `wait` 超时**不是** abort：仍是 `running (collect deadline …)`。加回归测试钉死。
- 一次 `lines === 0` 的读**不得**把已存在的非空 mirror 截成 0 字节。

---

## D4 — 默认只允许 `centurion` 跨机（用户设计意图）

- 新配置键 `subagents.crossMachine.allowRoles?: string[]`，默认 `["centurion"]`。
- 约束点：**launch 前**（`orchestrator.launch` 的跨机守卫），按 `agent.name` 判定（`kind` 只有 `"pi"`，不能用）。
- 被拒文案必须点明理由：跨机是**交付单元**的能力，scout/worker 应当由远端 centurion 在其本机派生；并给出显式放行片段
  `"subagents": { "crossMachine": { "allowRoles": ["centurion", "<role>"] } }`。
- 角色卡 / `agentOverrides` 里的 `host` 同样受此约束（它们只是 host 的来源，不是绕过口）。
- resume 路径（`admission: "never"`）**不受影响**：那是重连既有远端子，不是新跨机派发。
- 测试：scout+host 默认被拒 / 配置放行后可用 / centurion+host 正常；改回去即红。

---

## 验收清单

1. 目录声明 + 子目录入口 ⇒ 通过；只认声明文件 ⇒ 红。
2. 缺失扩展 ⇒ 跳过 + 一条汇总 warning + 不阻断；逐个硬失败 ⇒ 红。
3. 有 assistant 消息 ⇒ 不 aborted；read-back 计数 == 真实行数；wait 超时文案非 abort（三条各一测试）；快照不刷新 ⇒ 红。
4. `scout + host` 默认被拒；`allowRoles` 放行；`centurion + host` 正常。
5. `npm run typecheck` + `npm test` + `npm run test:integration` 全绿。
