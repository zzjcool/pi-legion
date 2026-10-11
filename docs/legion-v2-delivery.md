# Legion v2 delivery summary

本摘要以冻结契约 [`legion-v2-contract.md`](./legion-v2-contract.md) 与
`master` 上的 PR merge commit 为事实来源。v2 的最后一个里程碑 M3 已由
PR #14 合入；以下账目覆盖 M0、M1/M2/M3 core 与 integration，以及 schema
sentinel。

## 里程碑账目

| 里程碑 | PR / merge commit | 交付要点 |
| --- | --- | --- |
| Schema sentinel | [#6](https://github.com/zzjcool/pi-legion/pull/6) · `f3f02a2` | 新增契约 schema 哨兵测试；校验 `user_version`、闭集事件列表和预算默认值，并用 mutation probe 证明越界 DDL 会令哨兵变红。 |
| M1-core：RPC supervisor | [#7](https://github.com/zzjcool/pi-legion/pull/7) · `32a0ad5` | 新增 RPC supervisor、类型与 UI proxy；建立 headless Pi RPC 子进程的 supervisor 宿主层，并补 RPC live smoke。 |
| M2-core：树账本 | [#8](https://github.com/zzjcool/pi-legion/pull/8) · `cb23822` | 新增 SQLite `legion.db` 的 schema、nodes/events/usage/mail、预算、状态机和 rebuild 核心及对应单测。 |
| M1-core patch | [#9](https://github.com/zzjcool/pi-legion/pull/9) · `afaad13` | 补齐 supervisor abort/settle 可观测性、fallback retire 时 waiter 收敛、`isAlive` 无副作用及相应回归与 live 测试。 |
| M0：深度预算地基 | [#10](https://github.com/zzjcool/pi-legion/pull/10) · `aad3195` | 接通 `maxSubagentDepth` 与累计深度预算，落实硬顶 4、只收紧不放宽的 INCL 继承语义、`subagents.legion` 设置解析及测试入口 env 隔离。 |
| M3-core：可视化核心 | [#11](https://github.com/zzjcool/pi-legion/pull/11) · `05d3076` | 新增 Legion event bus、全屏树视图和 live overlay 的可视化组件与单测。 |
| M1-integration：RPC 主线 | [#12](https://github.com/zzjcool/pi-legion/pull/12) · `3feb43e` | 将主执行路径切到 Pi RPC，旧 Herdr 后端归档至 `src/backends/legacy/`；把主线测试切到 fake supervisor，并将遗留测试归档。 |
| M2-integration：组织层接线 | [#13](https://github.com/zzjcool/pi-legion/pull/13) · `efa0754` | 接通 centurion、递归子树、树级预算/账本、邮件与阶段工具、子树恢复和组织层集成测试；修复整队 retire、终态邮件及精确孤儿判定等问题。 |
| M3-integration：可视化接线 | [#14](https://github.com/zzjcool/pi-legion/pull/14) · `9490a1c` | 接通常驻树面板、`/legion` 命令、节点 overlay 和事件流；更新 SKILL 与可视化集成测试，完成 M3。 |

## 契约演进索引（REV-1～REV-15）

修订触发模式：worker 按 §15 正确拒绝是主线——REV-1～4、REV-6～7、
REV-9～14 共 12 次修订、13 次拒绝记录（REV-2 有两次）；reviewer 发现或
观察触发 REV-5、REV-8、REV-15；advisor 参与 REV-6、REV-7 的语义裁决；
FROZEN-1 由 CEO 批准冻结，REV-15 将 centurion 的 team 默认值收敛为可选。

| 修订 | 一句话索引 |
| --- | --- |
| REV-1 | 将 `subagents.legion` 设置解析与类型归入 M0，补齐深度预算配置的所有权。 |
| REV-2 | 修正新单测必须落在 `test/unit/*.test.ts` 的 glob 范围内，并确认 schema 事件枚举为 14 种。 |
| REV-3 | 勘误 REV-2：明确新单测路径为 `test/unit/` 下的平铺文件。 |
| REV-4 | 将树节点 slug 收紧为禁止点号的语法，避免点号造成 node id 歧义。 |
| REV-5 | 把 `PRAGMA user_version = 1` 放入 schema DDL，供哨兵完整校验。 |
| REV-6 | 统一 `maxSubagentDepth` 的 INCL 语义与继承公式，并把测试 env 隔离及深度边界陷阱纳入 M0。 |
| REV-7 | 澄清 R=2 的父节点可以启动 R=4 的子节点，但子节点继承 C=2、成为叶子。 |
| REV-8 | 指定“深度上限超过 4 被截断”的告警由 M1-integration 接线；M0 可静默截断。 |
| REV-9 | 修正 M1-integration 的迁移所有权：Herdr 键过渡期 deprecated、补公共 API 与受影响测试范围。 |
| REV-10 | 将 M1 测试归属从文件枚举改为按 RPC 主线切换影响的测试类别授权。 |
| REV-11 | 最终界定 M1 主线切换边界：受影响测试全部迁移，编译受影响的生产侧文件也纳入，但排除未授权模块。 |
| REV-12 | 将 `Placement` 移除导致的 `agents.ts` / `settings.ts` 相关行纳入 M1 所有权。 |
| REV-13 | 将事件总线拆分为 §4.3 存储事件域和不落库的进程内事件域。 |
| REV-14 | 将 OSC 8 降级为视觉锚点；overlay 通过组件鼠标事件或键盘路径打开。 |
| REV-15 | 去掉 centurion 示例队名作为默认值；team 仅在明确配置真实队名时绑定。 |

## 已知残留

以下事项作为已知边界记录，不应被误读成 v2 已解决：

- child-guard 的 shell 文本守卫仍可被 `bash -c` / `xargs` 绕过。
- Docker 外层 wrapper 尚未真实跑过。
- `emitMail` 仍依赖回读匹配。
- resume 使用 settings 中的 `maxDepth`。
- postman 对 `blocked` 状态仍采用乐观语义。

## v3 开放问题（契约 §16）

- **越级通道：** v2 不提供叶子越级直达 CEO；后续若要引入，需重新裁定权限与路由。
- **动画：** v2 预留 event bus，但不实现动画渲染。
- **detached supervisor：** v2 语义是父进程退出会结束子进程，恢复走 resume 链；父死子存活不在本期支持。
- **跨主机：** 不支持跨主机派生或通过 Herdr machines 分布式运行。
