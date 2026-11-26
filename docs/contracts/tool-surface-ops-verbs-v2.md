# tool-surface-ops-verbs v2 — Step 2b：删 `retire`，`recover`/`extend` 只砍散文

- 状态：**FROZEN**（2026-11-26）
- 前置：`tool-surface-dedup-v1`（合入）、`tool-surface-ops-verbs-v1`（合入，`list` 已删，现 13 个动作）
- 范围：动作 **13 → 12**（删 `retire`）+ 两段描述散文压缩。**不新增斜杠命令。**

---

## 0. 依据

本地 587 次 `subagent` 调用：`retire` 2 次、`recover` 0 次、`extend` 1 次。
`action` 字段描述 1,186 字符中，`extend`(307) + `recover`(413) 占 **720 字符（61%）**。

---

## D1 — 删除 `retire`

**决定**：删掉 `retire` action，以及只被它调用的 `retireChild`（`index.ts:4240`，全仓仅
`index.ts:3702` 一处消费者，无测试驱动 `action:"retire"`）。

**为什么零能力损失**：`stop` + `name` 是严格超集——`stopAction` 走同一个 retire 回调，
另外还有 `cancelWatch` 与 `force`（SIGTERM→SIGKILL）。`retire` 既不能 `all` 也不能 `force`。

**记录的行为变化**（可接受）：删除前有**三种** already-retired 措辞（`retire` 的
`formatAlreadyRecycled`、`stop` 的 `No non-retired children to stop. X is already retired …`、
以及汇总的 `Retired N already-settled child: …`）。**删除后剩两种**（后两者），所以本契约
"合并成一种"属**早期误写**，实际只减一种。真正的收益是：**同一个"优雅回收"语义不再有
两个动作入口**，而不是措辞归一。

**回执信息不得丢失**（review 补充）：`retire` 的回执带 `Session kept for resume: <sessionFile>`
与 `execution=`，`stop` 原本两者都缺。删除 `retire` 的同时必须把这些信息补回 `stop` 的回执——
否则模型不知道子节点可以 `resume`，而那是这条回执的主要价值。

**不许**：不要把 `retire` 保留成别名、不要给它加 `force`、不要改 `stop` 的语义。

## D2 — `recover` 保留，只压缩散文

**决定**：动词保留。**不**新建 `/legion recover` 斜杠命令（见 D4）。

理由（侦察事实，推翻了 v1 里"移到 /legion recover"的想法）：

1. `/legion recover` **不存在**（`src/extension/legion-commands.ts` 只有 `status`/`stop`/
   `doctor`/`team`/`agents`）。移过去等于**新造一个命令面**，不是收水。
2. 模型**本来也无法自己发现可 recover 的目标**：root 没有 `legion_tree`；注入给模型的
   interrupted 段落（`index.ts:1410-1413`）叫它用 **`resume`**，从未提 `recover`。
   所以 `recover` 是人发现、人发起的动作，砍掉它不会让模型少做任何它现在会做的事——
   但它确实会让"用户口头说一声、模型代跑"这条路径消失，而那正是它的价值。

`action` 描述里 `recover` 那一段**替换为**（逐字，不要再扩写）：

```
recover = adopt a child a PREVIOUS session launched on another machine: `name` required, no `runId`. It settles the ledger row and answers like `collect`; a still-live child is only reported. `/legion status` lists what is recoverable.
```

（413 → 约 235 字符。`runId` 那句保留，因为共享字段表里 `runId` 对 `recover` 的豁免是真实规则。）

## D3 — `extend` 保留，只压缩散文

**决定**：动词保留，`action` 描述里 `extend` 那一段**替换为**（逐字）：

```
extend = defer the `may be looping` reminder for one direct child by `ms`. Reminder only: it never changes a collect/wait budget or the child's own timeout, and never restarts, revives or steers it.
```

（307 → 约 190 字符。）三条否定语义（不延预算 / 不重启复活 / 不是 steer）必须保留——
它们是防止误用的关键，删掉就会退化成 #313 那类事故。

## D4 — 非目标（明确不做）

1. **不**新建 `/legion recover`。要收掉 `recover` 动词是另一个功能（需要命令面 + 保留人发起路径），单独决策。
2. **不**碰 `diagnose` / `section`（模型唯一能自查的手段，见 v1 D2）。
3. **不**拆工具、不改工具名、不改白名单、不改角色卡。
4. **不**动 `src/extension/spawn-hints.ts` / `auto-doctor.ts` / `legion-doctor.ts`。

---

## 归属（文件所有权）

**可改**：

- `src/extension/action-surface.ts`
- `index.ts`（删 `action === "retire"` 分支与 `retireChild`；`ActionName` 相关收窄）
- `src/extension/playbook.ts`（只改 `action` 字段描述？**不**——那在 `index.ts:339`。本文件只在
  `Actions:` 行受影响时自动派生，**预期零改动**）
- `README.md`（删 `retire` 行；`recover`/`extend` 行若与新描述不一致则同步）
- `docs/design.md`（§9.3 清单与 `N 个动作`：13 → 12）
- `skills/pi-legion/SKILL.md`（`:184`/`:193` 的 retire 示例改成 `stop`）
- 相关测试（`test/unit/action-surface-drift.test.ts`、`test/unit/inert-params.test.ts`、
  `test/unit/playbook.test.ts` 若断言了 retire；先 grep 确认再改）

**禁止触碰**：`src/runs/**`、`src/supervisor/**`、`src/extension/legion-tools.ts`、
`src/extension/legion-output.ts`、`agents/**`、`src/extension/slash.ts`、
`src/extension/legion-commands.ts`、其它 `docs/contracts/**`。

---

## 验收门禁

- `npm run typecheck`
- `npm test`
- `npm run test:integration`

三条全绿；首个非零退出即 rejected。

## 验收断言（必须存在）

1. `ACTION_NAMES` 长度为 12，且 `retire` 不在其中；schema union 与 `Actions:` 行一致（drift 测试已覆盖）。
2. `TOOL_DESCRIPTION` / `action` 描述里不再出现 `retire` 作为动作名（正文里"retires them"这种英文动词用法不算）。
3. `action` 描述字符数 **≤ 950**（当前 1,186）。
4. `recover` / `extend` 两段与新文本逐字一致（防止写成"第三份变体"）。
