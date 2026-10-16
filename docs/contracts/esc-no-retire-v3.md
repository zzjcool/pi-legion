# ESC 不再 retire children（v3，2026-10-15 冻结）

## 背景

v2（`esc-cascade-v2.md`）把「父 turn abort → 级联 retire children」冻结为产品语义。2026-10-15 实测事故：主会话异步派了多个 child 后用 `wait` 阻塞，用户按 Esc 打断父 turn，级联 retire 把整棵仍在生长的 legion 树抹掉（含尚未派生子 agent 的 centurion）。Esc 是高频误触键，后果不可恢复。

用户裁决推翻 v2：**Esc 只打断父 turn 的等待，不杀 children；停止 subagent 只有两条路——显式 `/legion stop`，或主进程退出。**

## 冻结决定

### A. Esc ≠ retire

1. **Idle Esc stop 删除**：不再有 `createIdleEscStop` / `onTerminalInput` 接线。裸 Esc 在 idle 时也不再 stop all。
2. **父 turn abort 不再级联**：工具 execute 各 `signal?.aborted` 分支只返回 interrupted 文案，**不**调用 `cascadeRetireAll`。`cascadeRetireAll` / `cascadePromise` / `agent_settled{aborted}` 级联钩子全部删除。
3. **`abandonLaunchedChild`**：spawn 后 abort 时 **不 retire**；`followLaunched(..., { watch: true })`，child 继续跑，settle 仍通知父会话。
4. **`runtime.waitOne` WAIT_INTERRUPTED**：**必须 re-arm watch**（`consumedByTool = false` + `watch`），否则 child 完成后无人收割、无完成通知。

### B. 中断文案

统一为：

```text
interrupted (parent turn ended; children still running)
```

不再使用 `interrupted (parent turn aborted)`（易误导为已 abort children）。

### C. 保留的 retire 路径（不变）

- 显式 `stop` action / `/legion stop` / `/legion` 视图 `x`
- `session_shutdown` → `shutdownRetireAll`（交互立刻 retire；`--print` / JSON 先 `drainBeforeShutdown` 再 retire）
- SIGINT / 进程退出 = 主进程退出 = retire

### D. TUI 提示

有 live child 时，aboveEditor 状态栏常驻 `/legion stop [--force] [name|all]`（短版 `/legion stop`）：railway header 在宽度挤压下可截断摘要以保短 hint；`PI_LEGION_STRIP=tree` 在 header 下另起一行短提示。无 idle 门控。

## 语义边界

| 动作 | children |
|---|---|
| Esc 打断 wait / 父 turn | 继续跑；re-arm watch；settle 通知 |
| `/legion stop` / `stop` action | graceful retire; `--force` / `force:true` → hard retire |
| 主进程退出 / session_shutdown | drain（print/json）+ retire |
| SIGINT | 进程退出 → retire |

## 与 v1 / v2 的关系

- **v1**（`esc-abort-v1.md`）主张「ESC ≠ 杀 children」——v3 回到这一原则，但保留 v1 没有的 drain / shutdown 归因与显式 stop。
- **v2**（`esc-cascade-v2.md`）级联 retire —— **v3 推翻**；原文保留供考古。

## 验收锚点

- 无 `cascadeRetireAll` / idle Esc 接线
- wait abort → children still alive + watching；完成通知仍达
- launch abort mid-spawn → child watched, not retired
- print-shutdown / session_shutdown / stop 回归绿
