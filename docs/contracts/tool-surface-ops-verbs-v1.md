# tool-surface-ops-verbs v1 — Step 2a：撤掉 `list`，保留 `diagnose`

- 状态：**FROZEN**（2026-11-26）
- 前置：`docs/contracts/tool-surface-dedup-v1.md`（已合入 master）
- 范围：`subagent` 的 action 从 **14 → 13**（删一个），**不拆工具、不改工具名、不改任何其它 action**。

---

## 0. 依据（本地 67 个主会话 + 9 个 child 会话实测，587 次 `subagent` 调用）

```
wait 355  status 90  steer 37  continue 32  stop 24  collect 18  resume 12
launch 6  retire 2   list 1    extend 1     diagnose 1            abort 1   recover 0
```

`action` 字段的描述散文 1,186 字符里，`diagnose`+`extend`+`recover` 占 **882 字符（74%）**。

---

## D1 — 删除 `list`

**决定**：从动作面彻底删除 `list`（不是隐藏、不是 deferred）。

理由（**不是**"调用少"）：

1. **它提供的信息已经在模型眼前**。角色 roster 由 `renderParentRoster` 注入 systemPrompt
   （`index.ts:2116`，`src/agents/agents.ts:1188-1191`）。模型想知道有哪些角色，读提示词即可，
   不需要调工具。
2. 它占 `action` 描述 **0 字符**（描述里从未解释 `list`），所以它的"可读性成本"全部体现为
   **让模型多判断一个动词**。
3. `renderAgentList`（`index.ts:7544`）只有这一个消费者。

**不许顺手做**：不要把 `list` 改成 deferred、不要保留一个"看不见但能调"的别名。

## D2 — 保留 `diagnose`（并记录为什么这不是遗漏）

**决定**：`diagnose` 与 `section` 参数**保留不动**。

**这是本契约最容易做错的一条。** 侦察数据显示 `diagnose` 只被调过 1 次，且它输出的是
`/legion doctor` 的同一份报告——看起来是纯冗余。**它不是**：

- 宿主内置工具只有 `read/bash/powershell/edit/write/grep/find/ls`
  （`pi-coding-agent/dist/core/tools/index.js:73-99`），**没有任何"执行斜杠命令"的工具**。
  `/legion doctor` 是用户敲的 TUI 命令（`pi.registerCommand`），模型无法调用。
- 因此 `subagent({action:"diagnose"})` 是**模型唯一能自己诊断的能力**。删掉它，模型只能
  让用户去敲 `/legion doctor`。
- 旁证：`src/extension/spawn-hints.ts:99,117,164,177` 全部写成
  "`/legion doctor` **or** `subagent action=diagnose`"——那个 "or" 就是
  "人能做的，模型做不到"。同理 `src/extension/auto-doctor.ts:89`。
- 另：`src/extension/legion-doctor.ts` 的报告正文自己会广告
  `subagent({ action: "diagnose", section? })`（`test/unit/legion-doctor.test.ts:226-229` 钉住）。

所以：`spawn-hints.ts` / `auto-doctor.ts` / `legion-doctor.ts` 的 `diagnose` 文案**一律不动**。

## D3 — `list` 的替代品是什么

| 需求 | 删掉 `list` 之后 |
| --- | --- |
| 模型想知道加载了哪些角色 | systemPrompt 的 roster（已有，无需工具） |
| 模型想知道当前 team / team warnings | 同一段 roster（`formatAgentRoster` 带 team 段） |
| 用户想浏览/切换 | `/legion` 命令（不动） |

如果发现某个场景真的只能靠工具拿到角色清单，**回 verdict 上报，不要自己加回一个 action**。

---

## 归属（文件所有权）

**可改**：

- `src/extension/action-surface.ts`（`ACTION_NAMES` / `ACTION_SPECS` 去掉 `list`）
- `index.ts`（去掉 `action === "list"` 分支；`renderAgentList` 若确认无其它消费者则一并删除，
  否则保留并在注释里写明"不再被工具调用"）
- `README.md`（删 `list` 那一行）
- `docs/design.md`（§9.3 的清单与 `N 个动作` 计数：14 → 13）
- `skills/pi-legion/SKILL.md`（第 25 行的 `subagent({ action: "list" })` 改成指向注入的 roster）
- `test/unit/action-surface-drift.test.ts`
- `test/unit/inert-params.test.ts`（若它引用 `list`）
- `test/unit/teams.test.ts`（`:486` 的 mock 调用）
- `test/integration/vexillatio.test.ts`（`:639` 的 `{action:"list"}` 调用）

**禁止触碰**：`src/extension/spawn-hints.ts`、`src/extension/auto-doctor.ts`、
`src/extension/legion-doctor.ts`、`src/extension/legion-tools.ts`、`src/extension/playbook.ts`
（playbook 没有 `list` 散文，`Actions:` 行自动派生）、`src/runs/**`、`src/supervisor/**`、
`agents/**`、其它 `docs/contracts/**`。

---

## 验收门禁

- `npm run typecheck`
- `npm test`
- `npm run test:integration`

三条全绿；首个非零退出即 rejected。

## 非目标

1. 不删 `diagnose`、`extend`、`recover`、`retire`（2b/2c，需产品判断 + 宿主机制前置）。
2. 不拆工具、不改工具名、不改白名单、不改角色卡。
3. 不碰 inert-param 硬拒表的结构（`section` 仍属于 `diagnose`；`ACTION_NAMES` 少一项后
   求逆推导会自动跟上，`inert-params.test.ts:44-61` 的手写治理锚点表**必须同步删掉 `list`**）。
