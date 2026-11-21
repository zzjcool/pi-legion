# hold-439-peer-veto — #439 收口：让路分支可诊断，且**每条** hold 记录都带链上投票

**结论先行**

- **main 上已有的（#440，`e385aea`）**：#439 的机制性部分已经落地——`chainVote` 四态
  （`continue` / `absent` / `sentinel` / `veto`）、`peer-continue-false` 让路分支（零等待、不取通知）、
  1.5.2 行为不变的 `deepEqual` 钉、上游诉求。本 PR **不重复实现**这些。
- **本 PR 新增的**（三处代码、三条测试、本报告）：
  1. `HoldRecord.chainVote` 由可选改为**必填**，并补齐 `hold:release` / `hold:commit` 两条记录
     （#440 只让 `hold:begin` / `hold:end` / `hold:abstain` 带）——issue 第 3 条要求的是
     “**每条** hold 记录都带 `chainVote`”，这是 main 上仍然缺的那一块。
  2. `peer-continue-false` 闸门提到 `degraded` / `idle` **之前**：投票是 boundary 的事实，不是本地
     child 列表的事实。否则 boundary 上明明有前置 veto、只是恰好没有 live child 时，唯一可诊断的判决
     又退化成 `idle`。零行为差异（两条分支都零等待、不取通知、不 claim 边界），只让 trace 如实。
  3. 测试：四态矩阵一次跑齐、逐记录 `chainVote` 覆盖、1.5.2 **整条 trace** 的 `deepEqual`
     （把唯一允许不同的字段剥掉后逐条相等）。
- **本 PR 没有、也不可能**在 pi 1.5.2 上“识别”前置 veto：硬缺口仍在宿主侧（§5），
  上游诉求照旧（§5.1）。这是 issue 自己写明的天花板，本 PR 不假装跨过它。

| 项 | 值 |
|---|---|
| issue | #439（`Fixes #439` 写在 PR 正文） |
| base | `origin/master` @ `ab813c3`（已含 #440 `e385aea`、#456/#457） |
| 改动 | `src/extension/hold.ts`、`test/unit/settle-hold.test.ts`、本报告 |
| 未触碰 | `src/extension/runtime.ts`、`index.ts`、`notice-delivery.ts`、任何 `legion.db` 写入路径、hold 的唯一 `agent_before_settle` owner 模型 |
| 单测 | **2966 → 2969**（+3），`pass 2969 / fail 0 / skipped 0` |
| `settle-hold.test.ts` | **32 → 35**（+3） |
| 集成 | 221 → 221，`pass 221 / fail 0` |
| typecheck | exit 0 |
| lint | 本仓库**没有** lint 脚本/配置（`package.json` 无 `lint`，无 eslint/biome/prettier 配置）→ 静态门禁只有 typecheck；没有假装跑过 |
| 变异 | 4 条**全红**（含任务书点名的两条），恢复后 35/35 绿 |

---

## 0. main 现状核对（先看，再决定做什么）

| issue #439 验收 | main（#440）状态 | 本 PR |
|---|---|---|
| 1. 可表达就让路：宿主能表达“没人说话”后，`false` = 否决 → hold 放弃、零等待、不取通知、`outcome: "peer-continue-false"` | **已有**：`chainVote()` 学会 `absenceIsExpressible`，`vote === "veto"` 时 abstain，reason 逐字 `hold skipped: peer continue:false`（`hold.ts:289/354-361/400-402`）；有测试 `#421 … the hold stands down` | 不动机制；只把闸门提前到本地问题之前（§2.2），并让**所有**记录都带 `chainVote`（§2.1） |
| 2. 不可表达就逐字不变：1.5.2 上边界行为与上一版逐字相同，`deepEqual` 钉住 | **部分已有**：`deepEqual(order)` / `deepEqual(sleeps)` / `deepEqual(result)` 三条 | **补强**：把剥掉 `chainVote` 后的**整条 record stream** 也 `deepEqual`（§3） |
| 3. 不再静默覆盖：**每条** hold 记录都带 `chainVote` | **部分**：`hold:begin` / `hold:end` / `hold:abstain` 带；`hold:release` / `hold:commit` **漏**，且字段是可选 | **补齐**：两处记录加字段、类型改必填、加逐记录测试（§2.1） |
| 4. 上游诉求：`BoundaryState.continue` 三态或 `prior: BoundaryResult[]` | **已有**（`legion-hold-gaps.md` §2.5） | 本报告 §5 重述，不重复代码 |
| 5. 变异：恢复无条件 `continue:true` → 红 | **已有证据**（M421-1） | 本 PR 重跑并**新增**两条（无学习、false 一律否决）与一条记录级变异（§6） |
| — | — | 四态矩阵测试（§4）在 main 上是零散的，本 PR 一次跑齐 |

---

## 1. 症状与事实底座（不变，引用 issue）

- `pi 1.5.2` 的 `emitBoundary`：`let shouldContinue = false`（`runner.js:770`）→
  `event = { …, continue: shouldContinue }`（`:775-780`）→ 每个 handler 的非 `undefined` 返回值覆盖它
  （`:785-786`，最后一次生效）。
- 于是**前置 handler 的 `continue:false` 与“还没人说话”是同一个字节**，对下游不可观测
  （无 per-handler 记录、`ctx` 无入口、`on` 无优先级）——`docs/reports/hold-spike.md` 1f/1i2 真机两次运行逐字节相同。
- 因此“把 `false` 一律当否决”等于回滚 #417；本 PR 不这么做（§6 M3 就是这条红线，变异必红）。

---

## 2. 本 PR 的代码改动（`src/extension/hold.ts`）

### 2.1 每条记录都带 `chainVote`（issue 验收 3 的字面要求）

```diff
-	/** The chain's continuation vote at the moment this boundary opened (#421). */
-	chainVote?: ChainVote;
+	/** … #439: REQUIRED, not optional. … `hold:release` and `hold:commit` included … */
+	chainVote: ChainVote;
```

```diff
-	record({ ev: "hold:release", at, outcome: exitOutcome });
+	record({ ev: "hold:release", at, outcome: exitOutcome, chainVote: vote });
```

```diff
-	record({ ev: "hold:commit", at, outcome: "completed", noticeChars: taken.content.length });
+	record({ ev: "hold:commit", at, outcome: "completed", noticeChars: taken.content.length, chainVote: vote });
```

`abstain()` 的 `chainVote` 也从可选变必填（所有调用点本来就都传了），类型层面不再允许一条没有投票
的记录被写进 trace。**为什么这是缺口而不是洁癖**：1.5.2 用户今天唯一能拿到的就是 trace；
`hold:release` / `hold:commit` 正是“通知被放回”和“通知被吞下/投递”的那两行，缺了投票，
“这一轮链上是什么”在最需要它的两行上仍然不可诊断。

### 2.2 `peer-continue-false` 闸门提到本地问题之前（不是新机制，是让判决可见）

```diff
 			if (outcome !== undefined && outcome !== "completed") return abstain("cancelled", …);
+			// #439: the vote is a fact about the BOUNDARY, so it is answered before any local
+			// question (`degraded`, `idle`) … every branch below is read-only …
+			if (vote === "veto") {
+				return abstain("peer-continue-false", startedAt, "hold skipped: peer continue:false", vote);
+			}
 			const children = deps.liveChildren();
 			if (children === undefined) return abstain("degraded", …);
 			if (children.length === 0) return abstain("idle", …);
-			// #421: … 原位置的 veto 闸门
-			if (vote === "veto") {
-				return abstain("peer-continue-false", startedAt, "hold skipped: peer continue:false", vote);
-			}
```

- **行为差异：零。** 原位置与新位置都在 `deps.ownsBoundary()` 之前，都 `return undefined`，都不 `sleep`、
  都不 `takeNotice()`、都不 claim 边界；`degraded` / `idle` 也是同样的零成本出口。
- **唯一差异**：会表达缺席的宿主上，一个“有 veto 但此刻没有 live child”的 boundary，outcome 从
  `idle` 变成 `peer-continue-false`，`chainVote` 仍是 `veto`。issue 要的正是这个判决被如实记录
  （`vetoed` 是 boundary 的事实，不取决于本 hold 有没有孩子要等）。
- `disposed` / `nested` / `mode` / `cancelled` 仍排在前面：它们回答的是“这个实例有没有资格动作”，
  与链上投票无关。hold 的唯一 owner 模型、`index.ts` 的单一 `agent_before_settle` 注册**未动**。

---

## 3. “不可表达就逐字不变”——`deepEqual` 钉在整条 trace 上

`test/unit/settle-hold.test.ts:684-720`（既有用例，本 PR 只**追加**断言，没有删改任何旧断言）：

```ts
const stripVote = (records: HoldRecord[]): Omit<HoldRecord, "chainVote">[] =>
	records.map(({ chainVote: _vote, ...rest }) => rest);
assert.deepEqual(stripVote(withFalse.records), stripVote(control.records));
```

- `control`：`{ entries: [], outcome: "completed" }`（无字段）
- `withFalse`：`{ entries: [], outcome: "completed", continue: false }`（1.5.2 的形状）
- 既有三条 `deepEqual(order)` / `deepEqual(sleeps)` / `deepEqual(result)` 原样保留；
  新增这条把 **`hold:begin` / `hold:commit` / `hold:end` 的每个字段**都比对一遍——除 `chainVote`
  外必须逐字相同。`withFalse` 的每条记录都是 `sentinel`，`control` 的每条都是 `absent`。

---

## 4. chainVote 四态（本 PR 一次跑齐的矩阵）

`test/unit/settle-hold.test.ts:767-798`。四态不可能来自**同一个**宿主：能表达缺席的宿主上，看错过
一次缺席之后的 `false` 只能是 veto；1.5.2 的字段永远在场且初始值就是 `false`，同一个字节只能是哨兵。
所以测试同时驱动两种宿主：

| 值 | 何时出现 | 宿主 | 本 PR 断言 |
|---|---|---|---|
| `continue` | 前置 handler 明确要求续跑 | 任意 | 照旧 hold、`result.continue === true`、`chainVote: "continue"` |
| `absent` | boundary 上**没有** `continue` 字段 = 还没人说话 | 会表达缺席的宿主 | 照旧 hold（这不是否决！），学到此宿主能表达缺席 |
| `sentinel` | `false`，且宿主从没显示过它能表达缺席（pi 1.5.2） | 1.5.2 | 行为与上一版逐字相同（§3），**不**读成否决 |
| `veto` | `false`，且宿主已显示过它能表达缺席 | 会表达缺席的宿主 | hold 放弃：零等待、不取通知、`outcome: "peer-continue-false"`、`reason: "hold skipped: peer continue:false"` |

```ts
const votes = new Set([...legacy.records, ...threeState.records].map((record) => record.chainVote));
assert.deepEqual([...votes].sort(), ["absent", "continue", "sentinel", "veto"]);
```

另有 `test/unit/settle-hold.test.ts:800-832` 逐条断言“**每条**记录都带四者之一”，并断言这组 fixture
真的覆盖了 `hold:begin` / `hold:commit` / `hold:end` / `hold:release` 四种记录——M4 变异就是靠它红的。

---

## 5. 上游诉求（宿主侧，选择其一即可）

1. `BoundaryState.continue` 改成三态：`boolean | undefined`，**不写就不写**（`undefined` = 还没人发言）——
   这样“没人说话”与“有人否决”从字节上分开，§4 的第 4 行在 1.5.2 上当场变成真实行为；
2. 或给 `BoundaryState` 加 `prior: BoundaryResult[]`（`priorContinue: (boolean | undefined)[]`），
   把每个 handler 的票留痕，扩展侧就能看见“前面有人投了 `false`”。

**诚实标注（残留盲区）**：即使宿主改成三态，本实现仍有一个**首边界**盲区——进程里第一次
`agent_before_settle` 就带 `false`、此前从未见过“缺席”的边界时，宿主能力未知，这一票仍按 `sentinel`
处理（会覆盖它）。这是“能力靠观察学习”的固有代价；只有上游诉求（三态或 `prior`）能消掉。
本 PR 不改变这个判断，也不把 `false` 一律当否决。

**1.5.2 上的硬缺口仍在**：前置 veto 与空链同字节，hold 依旧会写回 `true`。本 PR 把它保持在
“可诊断”（每条记录 `sentinel`），不假装修掉。

---

## 6. 变异验证（4 条全红，恢复后 35/35 绿）

每条的流程固定为：改 `src/extension/hold.ts` → 只跑
`node --experimental-strip-types --test test/unit/settle-hold.test.ts` → 记录 → 从备份恢复。
脚本 `/tmp/439-mutations.sh`，日志 `/tmp/439-mutations.log`。

```bash
# M1 恢复“无条件 continue:true”：删掉让路闸门（任务书点名 1）
perl -0pi -e 's/\t+if \(vote === "veto"\) \{\n\t+return abstain\("peer-continue-false", startedAt, "hold skipped: peer continue:false", vote\);\n\t+\}\n//' src/extension/hold.ts
# M2 删掉“宿主可表达缺席”的学习 → 让路分支永远不可达（任务书点名 2）
sed -i 's/return absenceIsExpressible ? "veto" : "sentinel";/return "sentinel";/' src/extension/hold.ts
# M3 把 false 一律当否决（#417 回滚，红线）
sed -i 's/return absenceIsExpressible ? "veto" : "sentinel";/return "veto";/' src/extension/hold.ts
# M4 只把 chainVote 从 release/commit 记录拿掉（本 PR 新增的逐记录要求）
sed -i 's/, chainVote: vote });/ });/g' src/extension/hold.ts
```

真实输出（`/tmp/439-mutations.log`，逐字）：

```text
== M1 unconditional continue:true (delete the veto gate)  exit=1
✖ #421: a handler BEFORE us that refused the continuation is not overwritten — the hold stands down
✖ #439: a vetoed boundary is peer-continue-false even when there is nothing to hold
✖ #439: the four chain votes are all diagnosable — continue / absent / sentinel / veto
ℹ fail 3
ℹ pass 32
ℹ tests 35

== M2 no absence learning (veto unreachable)  exit=1
✖ #421: a handler BEFORE us that refused the continuation is not overwritten — the hold stands down
✖ #439: a vetoed boundary is peer-continue-false even when there is nothing to hold
✖ #439: the four chain votes are all diagnosable — continue / absent / sentinel / veto
ℹ fail 3
ℹ pass 32
ℹ tests 35

== M3 every false is a veto (#417 rollback)  exit=1
✖ #421: on a host whose "nobody spoke" value IS `false` (pi 1.5.2) the same boundary behaves exactly as before
✖ #439: the four chain votes are all diagnosable — continue / absent / sentinel / veto
ℹ fail 2
ℹ pass 33
ℹ tests 35

== M4 release/commit records without chainVote  exit=1
✖ #439: EVERY hold record carries the chain vote — release and commit included
✖ #439: the four chain votes are all diagnosable — continue / absent / sentinel / veto
ℹ fail 2
ℹ pass 33
ℹ tests 35

== RESTORED (green control)  exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

- **M1**：任务书第 5 条要求的第一条——恢复“无条件 `continue:true`”后，让路用例、零 child 用例、四态矩阵全红。
- **M2**：任务书第 5 条要求的第二条——让路分支还在，但“何时算否决”的判断被删掉，同三条红（它证明红来自让路语义，不是来自单个 if）。
- **M3**：红线守卫——把 `false` 一律当否决就是回滚 #417，1.5.2 对照用例当场红。
- **M4**：本 PR 新增要求的守卫——记录级 `chainVote` 缺失会让逐记录测试与四态矩阵红（矩阵里会多出 `undefined`）。

---

## 7. 测试与门禁（前后对比）

```text
npm test                 → ℹ tests 2966 → 2969   ℹ pass 2969   ℹ fail 0   ℹ skipped 0
npm run test:integration → ℹ tests 221            ℹ pass 221    ℹ fail 0
npm run typecheck        → exit 0
npm run lint             → 本仓库没有这个脚本（package.json 无 lint，也无 eslint/biome 配置）
```

- 新增 **3** 条（`settle-hold.test.ts` 32 → 35）；既有用例**一条未删、一条断言未放宽**——
  唯一被改的既有用例是 1.5.2 对照条，只**追加**了一条整 trace 的 `deepEqual`。
- 既有的变异证据（#440 的 M421-1/2/3）不重复列出；本 PR 重新跑并扩成 4 条（§6）。
- 没有跳过、没有 `.skip`、没有改时间预算/轮询常量。

---

## 8. 未做 / 残留（明确边界）

1. **1.5.2 上前置 veto 仍会被 hold 覆盖**：宿主无传感器（§5），本 PR 只保证“**每条**记录都写明链上是
   `sentinel`”，不声称修掉。
2. **首边界盲区**：见 §5 末；需要宿主三态或 `prior`。
3. **hold 结果仍没有 status/doctor 出口**（`legion-hold-gaps.md` §2.8 的残留）：本 PR 继续只保证
   `PI_LEGION_HOLD_TRACE` 的 JSONL 可读；没有新增 doctor 区块。
4. `docs/reports/legion-hold-gaps.md` 是 #438/#439 的过程报告，本报告只记增量，不改写它。
