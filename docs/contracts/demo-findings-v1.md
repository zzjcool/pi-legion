# demo-findings v1 — 演示暴露的四条文案/语义缺陷

- 状态：**FROZEN**（2026-11-26）
- 来源：`pi-legion-real` 容器的两轮 live 演示（11 个子节点、12 次 verify、47 条事件）。
- 全部为**既有缺陷**，与 `collect-merge` / `dispatch-boundary` 无关。

---

## F1 — `accepted (verified)` 与「these gate the verdict」同屏

**现象**（演示里出现 11 次，每条 worker 结果都有）：

```
acceptance: accepted (verified)
verified by `test -f demo/ctl/green.txt && grep -q GREEN demo/ctl/green.txt`
unverified criteria — these gate the verdict:
  [ ] typecheck-test-pass: 项目自己的验证手段全绿…
```

**根因**：角色卡声明的 `typecheck-test-pass` 有 `evidence: ["verification-output"]` 但**没有 `command`**，
`acceptance.ts:344` 明确"不猜命令"→ 保持 `attested` 并把 criterion 挂进 `pendingCriteria`；
同时父节点在 `verify` 参数上给了机械命令，那条走 `applyVerification` 的另一道门把 `level` 抬成 `verified`。
`pendingCriteria` **从不影响** `status`（`acceptance.ts` 全程只 carry 它），所以"会否决裁决"从一开始就不成立。

**最强证据**：演示自己的根会话把它复述成了「标注 *do not gate the verdict*」——原文是
「these gate the verdict」。文案已经把人（和模型）都带反了。

**D1 决定**：banner 按**裁决是否已定**分支，由 `AcceptanceResult.status` 决定，不新增字段：

| `status` | banner |
| --- | --- |
| `unknown` + 有必需项 | `unverified criteria — these gate the verdict:`（**保持原文**） |
| `accepted` / `rejected` + 有必需项 | `unverified criteria — the verdict is already settled; confirm them from the pasted output:` |
| 只有 optional | `optional criteria — fix them if cheap, but they do not gate the verdict:`（**保持原文**） |

位置：`index.ts` 的 `gating` 分支（现约 `:8098-8110`）。

## F2 — 被中断的 turn 仍跑父配 `verify`，并把结果记成 `rejected`

**现象**：`abort` 掉正在 `sleep 45` 的 turn → 该轮 `(no output)` → 父配
`verify: test -f demo/ctl/abort_resumed.txt` 照跑 → 文件还没出现 → 记成
`stopped … acceptance: rejected (attested)`。演示的根会话为此花掉整整一个 turn 才澄清。

**保留的行为**（用户裁决）：**verify 继续跑**，不跳过。`orchestrator.ts:3564` 那句
"Only `running` is skipped" 保持不动。

**D2 决定**：把「turn 被中断」这件事写进 acceptance，且**不允许**它是 `rejected`
—— 对没有产出的 turn 记 `rejected`，正是 F1 要消灭的同一类自相矛盾
（`acceptance.ts` 对 `unknown` 的既有口径就是 "a verdict about work that was not measured"）。

- 触发条件：**该次 collect 对应的 turn 完成状态不是 `completed`**（`stopped` / `failed` / 其它非 completed 值）。
- `status` = `"unknown"`，`level` = `"attested"`。
- `reason` = `turn was interrupted, so its work was not assessed — the parent's verify still ran and {passed|failed}`。
- `pendingCriteria` 照常 carry。
- 实现方式：把「是否中断」作为一个**显式入参**从调用点传进 `applyVerification`
  （`orchestrator.ts` 的 `execution.status` 已在作用域内），不要在 `acceptance.ts` 里反推。
- 未中断时行为**逐字不变**（缺失该入参 = 旧行为）。

## F3 — `verification: STALE` 没说清是"先验证后提交"

**现象**：verify 通过 `13:37:25`，squash commit `13:37:48`（晚 23s）→
`verification: STALE — the checkout changed after the pass`。digest = `HEAD + git status --porcelain`
（`legion-tools.ts:2626`），所以"先验证、后提交"**必然** STALE。设计意图正确（nudge 会自愈），
但读的人得自己推出原因。

**D3 决定**：两处文案各加一句，指出正确顺序是**先 commit / squash，再进 verifying**：

1. 渲染行 `index.ts`（现约 `:8034`）：`verification: STALE — …` 句尾追加
   `— commit or squash BEFORE entering verifying, then verify again`。
2. nudge 自消息 `src/extension/legion-tools.ts`（现约 `:974`）：在现有句子后追加同义一句。

**不改**：digest 的算法、STALE 的判据、nudge 的触发条件。

## F4 — `diagnose` 指向一个不存在的日志

**现象**：`session errors: 1 (log ~/work/.pi-subagents/session-errors.jsonl)`，但该文件不存在。
`SessionErrorSummary.logPath` 是**算出来的**（`sessionErrorsLogPath(storeRoot)`），不检查存在性；
`total` 在有内存环形缓冲时来自内存（`source = disk.length > 0 ? disk : [...recent].reverse()`）。

**D4 决定**：`logPath` 只在**磁盘上真有这个文件**时才给出。

- `src/extension/session-errors.ts`：`logPath: logExists ? logPath : undefined`（`statSync` 成功即存在，
  今天的实现已经 `statSync` 过，只是没用它的成败决定 `logPath`）。
- `src/extension/legion-doctor.ts:918`：没有 `logPath` 时不要留空，改成
  `- session errors: {total} (in-memory only; no log file on disk)`。
- `legion-doctor.ts:864` 的 `fix:` 行与 `:1124` 的 `?? sessionErrorsLogPath(storeRoot)` 回退**保持不变**。
- `test/unit/session-errors.test.ts:70`（断言现有文件的 `logPath` 等于该路径）必须仍然成立。

---

## 归属（文件所有权）

`index.ts`、`src/runs/acceptance.ts`、`src/runs/orchestrator.ts`、`src/extension/legion-tools.ts`、
`src/extension/session-errors.ts`、`src/extension/legion-doctor.ts`、相关 `test/**`。

**禁止**：`src/runs/store.ts`、`src/runs/child-scope.ts`、`src/supervisor/**`、`src/legion/**`、
`agents/**`、`src/extension/action-surface.ts`、其它 `docs/contracts/**`。

## 验收门禁

`npm run typecheck` / `npm test` / `npm run test:integration` 三条全绿；首个非零退出即 rejected。

## 验收断言（必须存在并被实测）

1. `accepted (verified)` + 必需 pending criterion → banner 是 **"the verdict is already settled"** 版，
   不再是 "these gate the verdict"；`status: "unknown"` 时**仍是** "these gate the verdict"（两向都要测）。
2. 只有 optional criteria 时 banner 不变。
3. 中断 turn（`execution.status !== "completed"`）+ 父配 verify 失败 → `status: "unknown"`、
   reason 含 `not assessed`；同样条件下未中断 → 仍是 `rejected`（两向都要测）。
4. 中断 turn + verify 成功 → 仍是 `unknown`，reason 说明 verify 跑过且通过（不谎报 `verified`）。
5. `applyVerification` 不传新入参时行为**逐字不变**（既有测试保持绿）。
6. STALE 渲染行与新 nudge 文案各含"先 commit/squash"指引；`stale` 判据与 nudge 触发条件未变。
7. `summarizeSessionErrors`：无日志文件时 `logPath === undefined`；有文件时等于该路径。
   `legion-doctor` 在这两种情形下分别输出 `(log …)` / `(in-memory only; no log file on disk)`。

## 非目标
1. 不改 F1 的 `pendingCriteria` 语义（它永远不影响 `status` —— 这是既有设计，只是文案说错了）。
2. 不跳过中断 turn 的 verify（用户明确保留）。
3. 不改 digest 算法、STALE 判据、nudge 触发条件。
4. 不改 `acceptance` 的 `rejected`/`unknown` 对**正常完成**turn 的既有判据。

---

## 附录 A — 实现后修正（以本附录为准）

### A1 正文写错了状态名

正文说「`execution.status !== "completed"`」。实际类型是：

```ts
ExecutionStatus = "success" | "failed" | "aborted" | "truncated" | "running" | "unknown"
```

**没有 `completed`，也没有 `stopped`**。

### A2 `interrupted` 只认 `aborted`（必须收窄）

第一轮实现用了 `execution.status !== "success"`，后果：

- **`unknown` 被吞进去**。而 `unknown` 是跨机路径 D14 的地盘——“机器没测到，把原因告诉父节点”，它的 reason 带 `on host '<host>'`。
  被 D2 覆盖后，该细节丢掉，一条既有跨机用例的附带断言被迫改写。**这是回退，不允许**。
- `failed` / `truncated` 也被一并改判。那是另外两种 turn，各有自己的语义，本轮没有证据支持改它们。

**决定**：`interrupted` 的判据**恰好是 `execution.status === "aborted"`**。
只有它对应“父节点主动打断了这一轮”（演示里 `sleep 45` 被 abort 的那个）。

要求的回归断言：

1. `aborted` + 父 verify 失败 → `status: "unknown"`、reason 含 `not assessed`；
2. `aborted` + 父 verify 成功 → 仍是 `unknown`，reason 说明 verify 跑过且通过；
3. **`unknown`（跨机机器失败）不受影响**：仍是 D14 的 `unknown`，reason **保留 `on host '<host>'`**；
4. `failed` / `truncated` 不受影响（保持既有判据）；
5. 该用例的附带断言恢复原样。
