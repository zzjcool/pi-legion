# L2 stall notice：阈值级去重 + `extend` 语义（#413 第 1 层）

- 基线：`origin/master` `b720fdf`（6.2.5 开发线）。分支
  `pi-subagent/host-workspace/legion-413-30879cd4`。
- 范围（任务冻结）：**只做 #413 的第 1 层**——同一 `(child, threshold)` 只通知一次、
  `extend` 把阈值整体外推。第 2/3 层（跨机 child 的 quiet 判据恒为真、#411 的实时镜像）
  **不在本 PR**，见 §6。
- 不涉及：`legion status` / `subagent status` 的渲染（#412 已合）、mail 投递链、
  限流、`phase_timeout` 去重键。

---

## §1 现象（issue 原文）

同一个 child 停在 30m 阈值之外、被判 idle 之后，**每一次检查都重新「检测」并投递一封**：

```
mail #2  detectedAt 2026-11-19T07:18:36.358Z  running 30m 1s
mail #3  detectedAt 2026-11-19T07:18:36.992Z  running 30m 1s
mail #4  detectedAt 2026-11-19T07:18:36.173Z  running 30m 1s      ← 三封，同一阈值
        ↓（其间执行了 subagent({action:"steer"}) 与 extend(ms=2400000)）
mail #5  detectedAt 2026-11-19T07:23:37.730Z  running 30m 0s
mail #6  detectedAt 2026-11-19T07:23:38.734Z  running 30m 1s      ← extend 之后 1s 又到
mail #7  detectedAt 2026-11-19T07:23:39.407Z  running 30m 1s
```

`running` 时长几乎不变、`detectedAt` 每次都是「投递那一刻」——所以不是同一封被重复投递，
而是**同一个已越过阈值的事实被反复重新判定**。`extend` 只改了 deadline 的值，没有记录
「这条阈值线已经通知过」，因此拦不住后续。

## §2 根因（第 1 层）

旧去重状态是 `(name, kind, sinceBucket)` + 一个**重复时钟**：下一封的条件是
`now - 上一封.lastAt >= thresholdMs`。它把「这条阈值线通知过没有」编码成了**一个时间差**：

- 时间差不能回答「**这条**阈值线通知过吗」——它只知道「上一封是什么时候」，不知道上一封
  对应哪条线；
- 一个重新创建 / 另一条路径上的 detector 实例没有 `lastAt`，于是它每次检查都判定
  「已过阈值」并投递一封（`extend` 也只作用于它链路可达的那个实例）；
- `detectedAt` 更不能当键：它每次检查都不同（§1 的 6 个时间戳），拿它去重等于不去重。

正确的键是 **`(child, threshold)`**：`floor(elapsed / thresholdMs)` 就是「越过了第几条
阈值线」，它由 `(base, thresholdMs, now)` 直接算得，**不需要**「上一封什么时候发的」。

## §3 改法

### 3.1 纯判定（`src/legion/stall-notice.ts`）

`StallLineState` 从 `{ count, lastAt }` 变成 `{ tier, count, lastAt? }`：

- `tier` = 已通知过的**最高阈值线**（`0` = 还没发过）；
- `count` = 本窗口已发封数（D6 的上限 3 / 2 仍然按它算）；
- `lastAt` 只留作诊断，**不再参与任何判定**。

两个 detector 都把 `sequence/count` 那段之前先做一次

```ts
const tier = Math.floor(elapsedMs / thresholdMs);
if (tier <= window.<kind>.tier) return undefined;   // 这条线（或更晚的）已经通知过
```

`Math.floor` 不是 `round`：阈值线的翻转点必须正好是 `base + n × threshold`，与
`elapsed >= thresholdMs` 用的是同一条边界。公告里新增 `tier`，调用方据此记账。

### 3.2 postman（`src/extension/legion-tools.ts`）

- `stallAnnouncements` 的值变成 `{ bucket, thresholdMs, tier, count, lastAt }`：`bucket` 是窗口
  （L1 `lastEventAt` / L2 `loopBaseAt`），`thresholdMs` 也进键——`tier=2` 只在「相对这个半径」
  时才有意义（角色卡/`extend` 改了半径就是另一条阶梯）。
- `stallAnnouncedState(name, kind, bucket, thresholdMs)` 在窗口或半径变化时返回空状态
  （`tier: 0, count: 0`），否则返回已通知的 `tier`。
- 记帐只在 `messages` 行真的写成功之后（保持「失败可重试」的既有规则）。
- `extendStallWindow`：`loopBaseAt = now`（可选改半径）之外，**显式清掉该 child 的 L2 已通知
  状态**。下一封在 `now + loopRadiusMs`——整条阈值重新起算，而不是旧线的尾巴；同一毫秒的
  `extend`（bucket 不变）也不会继承旧的 `tier`。

### 3.3 行为差异

| 场景 | 旧（time-since-last-line） | 新（boundary key） |
|---|---|---|
| 停在同一条阈值线，检查 N 次 | 单实例内 1 封；丢失 `lastAt` 的实例 **每次 1 封** | **1 封**（键由 base/threshold/now 直接算得） |
| 越过下一条线 | `上一封 + radius` 才再发 | 越过即再发 |
| 首次观察已远超阈值（如 3h） | 1 封，然后 `radius` 后再 1 封 | 1 封（记 `tier=4`），下一条线再 1 封 |
| 子又活动了再静默（L1） | 新窗口，1 封 | 新窗口（`bucket` 变），1 封 |
| `extend` | 基准前移、计数重置 | 基准前移、**阶梯清零**（显式） |

## §4 测试与变异

新增 5 条（`test/unit/stall-notice.test.ts`）：

1. `#413: N checks inside ONE boundary announce exactly once`（纯函数，10 次检查 → 1 封，且边界
   正好在 `2×` 翻转）；
2. `#413: the NEXT boundary re-arms — one threshold after the last line was the old rule`（190m
   首次观察到 225m 的下一条线就再发；旧规则要等到 235m）；
3. `#413 postman: ten checks inside ONE boundary write ONE mail`（postman 真 tick 10 次 → inbox 1 封、
   投递 1 次）；
4. `#413 postman: activity then a second silence re-arms ONE more line`（同窗口内多 tick 不加封；
   事件打开新窗口后 1 封，再静默 1 封）；
5. `#413 postman: extend pushes the WHOLE threshold out and re-arms the ladder`（非边界时刻
   extend、半径改成 2×，`+2r-1` 不发、`+2r` 发）。

另外把旧「上一封 + radius」口径的断言改写成阈值线口径（L1/L2 节奏、D6 late first line、M2 等），
语义不变的用例原样保留。

**变异矩阵**（每个变异单独注入，跑 `test/unit/stall-notice.test.ts`）：

| 变异 | 变异内容 | 变红的用例（摘） |
|---|---|---|
| M1 | 忽略已通知的 `tier`（`tier <= 0` 即发） | 纯函数 #413 ×2、postman #413 ×3、L1/L2 节奏、M2、late-first-line（共 10 条） |
| M2 | `Math.floor` → `Math.round` | `#413: NEXT boundary`、`#413: N checks`、L1/L2 边界（4 条） |
| M3 | `stallAnnouncedState` 不比较 `bucket` | `#413 postman: activity…`、`D5 复活重启时钟`（2 条） |
| M4 | `extend` 不移动基准 | `#413 postman: extend…`、`postman L2: 3 lines…`（2 条） |

四个变异全部被新增用例咬住（M1/M2 咬纯函数 + 接线，M3 咬「活动 → 新窗口」，M4 咬 `extend`）。

## §5 门禁

```
flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test"
```

- `tsc --noEmit`：clean；
- `npm test`（`test/unit/*.test.ts`）：**2698 tests / 2697 pass / 0 fail / 1 skipped**；
- 额外：`node --experimental-strip-types --test test/integration/vexillatio.test.ts` → 25 pass
  （该文件构造 stall notice 行，`tier` 字段是本次新增）。

## §6 范围与未决

- **第 2/3 层不在本 PR**（任务冻结）：#411 落地前，跨机 child 在本地没有实时镜像，
  `subagent status` 的 `quiet` 与「无工具在飞」判据对它**恒为真**；本 PR 只保证
  「同一阈值线只通知一次」，不改变「何时算越过阈值」的输入正确性。
- **同账本多 detector 实例**：本 PR 遵循 D4/D5 把去重状态放在 postman 内存里。§1 中
  `extend` 与下一封只差 1s，说明当时有两条独立的检测路径（各自一份内存账）；让它们共享
  状态需要把「已通知的阈值线」持久化（`events` 表被 D9 禁止，`messages` 行是唯一的候选），
  那是契约变更，需要单独立项，不塞进第 1 层。
