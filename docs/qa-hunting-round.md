# QA 狩猎 round 编排手册（multi-agent orchestration）

> **给谁看**：任何要在这个仓库组织「一轮」多子 agent 缺陷狩猎的主 agent（或人）。读完即可开跑。
>
> **和 `tui-qa-playbook.md` 的分工**：那份是**单人狩猎手册**——三层证据链、容器/tmux 基建、
> 单个角度怎么取证、issue 怎么写。本手册是**round 级编排**——多角色怎么拆、派发顺序、
> 判据纪律怎么跨角色执行、卡死了怎么止损。两份都要读，先读那份。
>
> **实战背书**：2026-10-16 round2（v2.0.4 @ b00d4c7）：4 角度并行 → 29 candidate →
> 判 true 9（major 6 / minor 3）→ issue #172–#181，转化率 31%。全程含一次卡死事故处置（§5）。

---

## 0. 核心原则：四角色拆权，发现者不验证，验证者不提交

单路 hunter 自搜自证，误报率高且慢。流水线把权力拆开：

| 角色 | 只做 | 永不 |
| --- | --- | --- |
| 主 agent（你） | 冻结狩猎面、派发、steer 补给、裁决、收官 | 自己跑侦察读代码 |
| `scout` | 冻结面事实清单（带 file:line） | 出方案、下结论 |
| `qa-hunter` × N | 按一个角度找 candidate + 原始证据 + **detector 原文** + 自陈伪影风险 | 验证、自证、提 issue |
| `qa-repro` × N | 独立复现，判 true / false / downgraded | 沿用 hunter 的判据、提 issue |
| `qa-reporter` × 1 | 查重后按模板提交已判 true 的 finding | 提 candidate、并发多路提交 |

角色卡在 `agents/`（`agents/qa-hunter.md` 等），团队编排在 `.pi/settings.json` 的
`subagents.teams["qa-hunting"]`。切换团队：会话里 `/subagents` 或写 settings 后重启会话。

## 1. Round 流程（按序，别跳步）

```markdown
0. 冻结基线：commit hash / 版本 / 容器 / 已 open issue 清单 / 上一轮已推翻的怀疑点
1. 冻结面 scout（1 路，只读，先发）
   └─ 产出：带 file:line 的事实清单——env 读取点 / 契约条款落点 / 跨面口径 /
      状态机转移表 / 可执行复现入口
2. hunter 并行派发（4 路足够，角度互斥见 §2）——不等 scout 完也可以先发，
   但 scout 产出一到就 steer 补给各 hunter
3. steer 补给：把 scout 事实按角度切给各 hunter，并声明「哪些怀疑点已被推翻，别再扫」
4. 每路 hunter 交卷 → 立即派对应 qa-repro（流水线化，别攒齐）
5. repro 判 true → 派 reporter（全轮只用 1 路串行提交，防查重竞态；
   后续判 true 的追加 steer 给同一个 reporter）
6. 收官：round notes 落库 `.qa-hunt/<date>-roundN/notes.md`（战果表 +
   被推翻清单 + 事故 + 下轮改进 + 未覆盖）
```

**实测收益**：冻结面 scout 前置为每路 hunter 省 ~20 分钟定位时间，且常直接推翻
主 agent 一半的怀疑点（round2：「env 全带 `Number.isFinite`，NaN 穿透 0 命中」）。

## 2. 角度切法（互斥，4 路足够）

| 角度 | 内容 | 边界（不做什么） |
| --- | --- | --- |
| A 契约 vs 实现 | 冻结契约（`docs/tui-viewer-contract.md` 等）逐条在真实 TUI 跑 | 不做非契约项的打磨建议 |
| B 配置边界 | 每个 env / settings 字段喂 `""`/`0`/`-1`/`NaN`/`Infinity`/浮点/`abc`/`1e18` | 不做 TUI 视觉 |
| C 跨面口径 + 单位混淆 | 同一数据在多处渲染是否同口径；截断按码点还是显示宽度 | 不做交互/键位 |
| D 状态机 / 生命周期 / 清理 | 转移表交叉、槽位释放、清理阈值、子进程回收、doctor | 不做 A/B/C 已覆盖面 |

角度数 >4 时 hunter 上下文互相重叠，总产出反而下降。

## 3. 派发任务卡（hunter 模板，必填项别省）

每路 hunter 的任务卡必须包含：

```markdown
## 环境
- 仓库 / 版本 / commit
- 容器：docker exec <name> bash -lc '<cmd>'（/plugin 挂载，pi/tmux 可用）
- 先读 docs/tui-qa-playbook.md §3 铁律，再读相关契约章节

## 你的角度（+ 明确边界：不做什么，撞到别的是别人的）
## 时间预算（如 60min）+ candidate 上限（≤8，防跑飞）
## 硬性规则
- 每个 bash 调用必须 `timeout 60 <cmd>` 包裹（命令级 timeout 是必填项，
  时间预算替代不了它——见 §5 事故）
- 禁止调用 poll-loop 等待型 API（如 acquireVerifySlot）；长脚本内加
  `setTimeout(() => process.exit(9), 30_000)` 自杀兜底
- 产物落 .qa-hunt/<round>/<角度>/，issue 内联最小复现脚本

## 输出格式
- 每个 candidate：症状 + file:line + detector 原文（「我用什么表达式/符号判断状态成立」）
  + 原始证据路径 + 自陈「我未排除的伪影可能」
```

**明确列出已提交 issue 的根因**，hunter 撞到同根因直接跳过。

## 4. 判据纪律（决定转化率的关键）

### hunter 侧
- **detector 必须写进报告**，供 repro 独立审查——这是 repro 换判据的依据。
- **禁止自证**：别用被测代码自己的查询去数被测代码。要验槽位上限，别用编排器内部那条
  SQL 去数，把同一份 DB 状态喂给**已发布的** `checkLaunchBudget()` 交叉比对。
- **报下游可观测后果**：别报「解析器返回了这个值」，报「用户实际看到的字节数 /
  目录在不在 / 子进程起没起来」。

### repro 侧
- **判据必须与 hunter 不同**，否则等于自证。先 grep hunter 的 detector 是否有歧义，再自建。
- 优先攻 hunter 自陈的伪影风险。不可达路径按 playbook §4 降级为理论风险。
- **先读既有测试再判**：作者的测试可能已把某行为断言为设计意图（round2：
  `state-machine.ts:108` `parent_decision` 直放被单测断言为设计意图，不报）。
- 修过的历史行为要查 issue 历史，别把有意的两套语义判成不一致。

### 高频证伪模式（round2 推翻 20 条中的代表，新 round 先对照这份清单）
- 「A/B 两面不一致」→ 查契约是否**明文定义**了这个拆分（fanout vs maxActiveNodes，
  契约 §11.1 明文，非缺陷）
- 「状态字面冲突」→ 查**可达性**（`awaiting`/`unknown` 经 `runtime.ts:1210-1216`
  映射掉，永不进 `node.status`）
- 「边界系统性差 1」→ 实测是不是只有极窄边界带（round vs floor 仅 500ms 带）
- 「截断/宽度有 bug」→ pi-tui 自己处理 ANSI/OSC8/宽字符/ZWJ，**先证伪再报**
- 「某模式下功能静默」→ 用**非本仓库的对照扩展**证明是宿主行为还是本仓库行为
  （`print` 下 `/legion` 静默 → 根因在 pi 宿主 `runner.js:132` noOpUIContext，本仓库无责）
- 「敏感信息泄露」→ **必须真实触发**，别用构造的假密钥（round2 真实触发后结论反转）

## 5. ⚠️ 卡死止损（round2 事故：130 分钟）

**现象**：`subagent status` 一直 `working`，但零进展。

**判据（三条同时成立即卡死，不是慢）**：
1. 子会话 JSONL 静默 >60min（`stat` mtime）——改进阈值：**>15min 即查**
2. 最后一条记录是 `toolCall` 而**无对应 toolResult**
3. 产物目录 mtime 冻结，之后 0 个新文件

**止损流程**：
```text
1. 取证不急着 kill：stat JSONL mtime / tail 最后一条 / 查产物 mtime / ps 找子进程
2. subagent({ action: "stop", name: <child> }) → 确认 RPC 子进程回收（ps 复查 gone）
3. 清理孤儿进程（mock-llm 等，ps -eo pid,cmd | grep "[m]ock-llm" 定点 kill，
   禁 pkill -f 自杀）
4. 补派接手者：任务卡带上已完成部分 + 防挂死硬性规则（§3），别从零重跑
```

round2 根因：hunter 调了 `acquireVerifySlot()`（轮询等槽位的阻塞 API），bash 调用无
`timeout` 包裹 → 子进程挂死 → 永久 working。**根因是派发漏洞**：任务卡写了时间预算
却没写命令级 timeout。这就是 §3 把它列为必填项的原因。

## 6. 收官 checklist

- [ ] 所有判 true 的 finding 已提交 issue（reporter 报告里有 # 号清单）
- [ ] round notes 写入 `.qa-hunt/<date>-roundN/notes.md`：战果表 / 被推翻清单及原因 /
      事故记录 / 下轮改进 / 未覆盖留给下轮
- [ ] `.qa-hunt/` 目前 untracked：issue 里必须内联最小复现脚本，别只引用本地路径
- [ ] 检查无遗留 mock-llm / pi 孤儿进程
- [ ] 仓库 `git status` 干净（hunter/repro 只许写 `.qa-hunt/`，不许碰 `src/`）

## 7. 角色卡与团队配置

- 角色定义：`agents/qa-hunter.md`、`agents/qa-repro.md`（若有）、`agents/scout.md`、
  `agents/advisor.md`
- 团队编排示例：`docs/subagents-teams.md`；本仓库实配：`.pi/settings.json`
  → `subagents.teams["qa-hunting"]`
- 子 agent 卡死重试 2 次仍失败 → 升级咨询 `advisor`（见各角色卡的失败止损节）
