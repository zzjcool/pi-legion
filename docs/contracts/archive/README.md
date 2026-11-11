# Archived contracts

本目录存放**已被取代或已全额落地**的冻结契约。它们被原封保留（历史 + 审计证据），
但**不是现行行为依据**：与代码冲突时以代码为准，实现前请读「现行依据」那一列。

归档规则：

- 归档 = `git mv` 移动 + 文首加 `STATUS: HISTORICAL` 或 `STATUS: LANDED` 抬头，**正文不改**。
- 归档文件里的行号/文件名引用是它冻结时的快照，不要按它操作。
- 现行契约仍在 `docs/contracts/` 平铺；非契约类历史文档在 `docs/archive/`。

| 归档文件 | 状态 | 取代者 / 现行依据 | 归档理由（代码证据，2026-11-07 实测） |
| --- | --- | --- | --- |
| `esc-cascade-v2.md` | HISTORICAL | `../esc-no-retire-v3.md` | 被 v3 推翻；`rg -n "cascadeRetireAll\|cascadingJobs" src index.ts` → 无命中 |
| `esc-abort-v1.md` | HISTORICAL | `../esc-no-retire-v3.md` | 被 v3 取代：v1 的核心原则「ESC ≠ 杀 children」已被 v3 恢复，但 v1 自身不是现行文本（缺少 drain/shutdown 归因与显式 stop）；被它推翻过的 v2 不是现行行为 |
| `drop-non-pi-kinds-v4.md` | LANDED (v4.0.0) | 无（已全额落地，无后续版本） | `AGENT_KINDS = ["pi"]`、`src/backends/` 已删、7 个 `herdr` DEFAULTS 键清零 |
| `notice-claim-v1.md` | HISTORICAL | `../result-ledger-v1.md`（D4/D12） | 内存 claim 集合被账本投影取代，P4c 一次性删除（无兼容层）；`rg -n -e claimReported -e unclaimUndelivered -e consumedByTool src/ index.ts` → 无命中。`snapshotOrigins` 仍存在，但只剩 D4a 的 origin 戳职责（条目 round 标签 + `deliveredOnce` 键），不再参与任何 claim/回滚判定 |

相关但不在本目录：

- `docs/archive/design-herdr-era.md` — herdr/pane 时代的实验记录（F1–F46），非契约。
- `docs/archive/legion-v2-delivery.md`、`docs/archive/performance-2026-10-19.md`、
  `docs/archive/qa-hunting-round-2026-10-16.md` — 历史交付 / 测量 / 复盘快照，非契约。
