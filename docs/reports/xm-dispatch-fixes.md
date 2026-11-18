# 跨机派发实跑缺陷修复报告（xm-dispatch）

- 仓库 / 分支：`pi-legion` `feat/xm-fixes`，基线 `master 962992f`（6.2.0）
- 现场：Mac 父机（6.2.0）→ `hw-nj`，真机跨机派发
- 性质：**bugfix（建议 patch，6.2.1）**，无破坏性接口变更
- 冻结契约：`docs/contracts/xm-dispatch-fixes-v1.md`（D1–D4）

> 本机**没有 `hc`**（`command -v hc` 空），因此复现全部由仓库既有的 fake `hc` core
> （`test/helpers/fake-hc-core.mjs`，协议级 NDJSON，`machine.exec` 真跑 `sh -c`）+ fake
> supervisor 完成。真机报错原文来自现场日志，逐条引用在下面。

---

## Bug 1｜扩展入口校验假阳性（阻断派发）

### 真实报错原文

```
host 'hw-nj': package 'pi-autoresearch' IS installed there at
/home/zzjcool/.pi/agent/npm/node_modules/pi-autoresearch,
but it does not expose './extensions/pi-autoresearch/index.ts'
(declared: ./extensions -> /home/zzjcool/.pi/agent/npm/node_modules/pi-autoresearch/extensions);
the launch would have loaded a different entry than the one this machine asked for.
```

事实：该文件在远端真实存在；两机同为 `pi-autoresearch@1.9.0`，`package.json` 写的是
`pi.extensions: ["./extensions"]`（**目录**），`extensions/pi-autoresearch/index.ts` 两边都在。

### 根因

两个解析器的展开深度不同，再用**字符串全等**对齐：

| 侧 | 代码 | 结果 |
|---|---|---|
| 远端探测 | `src/runs/remote.ts` 的内联 probe（`fs.existsSync(abs)` + `path.relative`） | 把 `./extensions` **原样**记成一条 entry：`relative = "extensions"`。从不展开子目录。 |
| 本机 | `src/runs/extension-inheritance.ts` `expandDeclaredEntry` / `discoverExtensionFiles`（契约 R1-a） | 把目录**展开**成文件：`extensions/pi-autoresearch/index.ts` |
| 对齐 | `resolvePackagePathOnHost`：`declared.find(e => e.relative === relative)` | `"extensions" !== "extensions/pi-autoresearch/index.ts"` ⇒ `entry-missing` |

也就是说校验**从来没问过那个文件在不在**，只在问「远端 manifest 有没有把这个字符串写出来」。
报错文案与远端事实并不矛盾——它描述的正是这个比较失败。

### 修法

`src/runs/remote.ts` `resolvePackagePathOnHost`：精确匹配之后增加**目录前缀匹配**（以 `/` 为界），
命中则把请求路径拼到远端声明目录下：

```ts
const under = declared.find((e) => e.relative.length > 0 && relative.startsWith(`${e.relative}/`));
if (under !== undefined) {
  return { ok: true, path: path.posix.join(under.path, relative.slice(under.relative.length + 1)), ... };
}
```

为什么这样安全：**一个声明为文件的条目不可能成为另一条路径的目录前缀**（文件没有子路径），
所以这条规则不可能把「文件声明」放宽成目录声明；`extensions-other/x.ts` 也**不会**被
`extensions` 覆盖（前缀以 `/` 结尾）。判据变成契约 D1 的真值表：只有「声明的是具体文件、
远端不是那一个」才失败。

### 测试红绿

`test/unit/cross-machine-discovery.test.ts`

| 新增用例 | 断言 |
|---|---|
| `D1: a package that declares a DIRECTORY covers the entries inside it (pi-autoresearch@1.9.0 layout)` | 目录声明 + 子目录入口 ⇒ `ok`，映射到远端 `<pkg>/extensions/pi-autoresearch/index.ts`，并穿过 `mapRemoteArgv` 产出该 argv |
| `D1: a directory declaration is matched on the \`/\` boundary, never as a bare string prefix` | `extensions` 不覆盖 `extensions-other/...` |
| `D1: a FILE declaration still refuses an entry it does not name (the only failing case)` | 远端 `dist/index.js` vs 请求 `extensions/pi-autoresearch/index.ts` ⇒ 仍 `entry-missing` |

---

## Bug 2｜继承扩展缺失时逐个撞、默认行为错

### 真实现场

派 scout 先被 `pi-autoresearch` 挡，排掉后又被 `pi-sop`（远端没装）挡——**一个包一次调用**：

```
host 'hw-nj': the extension '/Users/…/node_modules/pi-sop/src/index.ts' belongs to package 'pi-sop',
which is not installed on that machine (the launch would have silently dropped it). Install 'pi-sop' on 'hw-nj' …
```

### 根因

`mapRemoteArgv` 就是 `args.map(...)`（`src/runs/remote.ts`），第一个不合格元素**当场 throw**：

```ts
return args.map((arg) => mapRemoteArgPath({ arg, ...opts }));   // fail-fast，单趟单抛
```

后面的扩展根本没被评估。v1.2 为了消灭「静默丢扩展」把 pre-v1.2 的 drop 机制删掉了，改成
零容忍——对**继承**扩展来说过度了（继承集是父机「碰巧装了」的东西，不是任务契约）。

### 修法

1. **双出口**：`mapRemoteArgvAllowingSkips` 按 argv 顺序走，遇到 `-e/--extension` 的**值**在
   `not-installed` / `entry-missing` 时**丢掉整对**（switch + value，两种拼写都认，含
   `--extension=<path>`）并记录；其他任何绝对路径参数（`--skill`、镜像文件…）保持 D6 硬拒绝；
   `no-package` 也不跳过（那是配置错误）。`mapRemoteArgv` 保留为**严格**入口，且仍是
   「argv 顺序第一处不可映射即抛」——它有自己的单趟实现，不走「先收集 skip 再抛」那条路，
   所以混合 argv 下的抛错顺序与 6.2.0 一致。
2. **一条汇总 warning**：`planSkippedExtensions` 纯函数产出
   `skipped N inherited extensions that machine cannot install/load: pi-sop, pi-sysmon… Install them
   there, or exclude them permanently: {"subagents":{"agentOverrides":{"<agent>":{"excludeExtensions":[…]}}}}`
3. **只在角色卡显式声明必需时硬失败**：新字段 `requiredExtensions?: string[]`
   （`AgentConfig` + frontmatter 白名单 `AGENT_FRONTMATTER_FIELDS` + 解析 + `OVERRIDE_FIELDS` +
   settings 类型校验，四处一起改，否则「接受但静默无效」）。匹配同时接受三种写法：包名、
   绝对路径、以及**包内相对路径**（`extensions/x/index.ts`，`matchesExcludedExtension` 两条分支
   都看不见它，单独比对以免 fail-open）。命中则**一条聚合错误**，只列必需项。
4. **投递通道**：`ChildHandle.warnings?: string[]` → `Orchestrator.launch` → `Handle.warnings` →
   唯一的渲染器 `launchNoticeLines(name, handle)`（`index.ts` 的 `▶` 之后 + **排队放行 notice**
   都调它；fan-out 排队时没有 `▶` 行，这是唯一可见处）。刻意不写 `process.stderr`——tool 结果里
   看不见。

### 测试红绿

`test/unit/cross-machine-discovery.test.ts`

| 用例 | 断言 |
|---|---|
| `D2: …SKIPPED, and the whole launch yields ONE aggregated warning` | 3 个 skip → argv 里 `-e` 对全部消失；`plan.warnings.length === 1`；文案含 `skipped 2 inherited extensions` + `pi-sop, pi-sysmon` + 可粘贴 `agentOverrides` 片段 |
| `D2: a card that declares the extension REQUIRED gets one aggregated refusal…` | `requiredExtensions: [pi-sop, pi-sysmon]` ⇒ 一条错误同时点名两个；`required: [pi-lens]`（远端可加载）⇒ 仍只是 skip |
| `D2: the skip is scoped to \`-e/--extension\` — any other unmappable path still refuses` | `--skill /opt/loose/thing.md` 仍硬拒绝；严格入口仍抛原文案 |
| `D2: an \`entry-missing\` skip is skipped too` | 第二种可跳过原因（版本/布局不同）也跳过，且 required 时照样硬失败 |
| `D2: a path that is not inside a package keeps the hard refusal` | `no-package` 不跳过 |
| `D2: the one-token \`--extension=<path>\` form takes the same rules` | 两种拼写同规则（堵住「父机绝对路径原样落到远端 pi」的潜伏口） |

`test/unit/agents.test.ts`：`requiredExtensions` 真的被 frontmatter 解析、缺省保持 absent、
且在 `OVERRIDE_FIELDS` 里（否则 override 会被静默丢弃）。

`test/integration/fake-core-host-discovery.test.ts`（真 `HcCliClient` + fake core）

| 用例 | 断言 |
|---|---|
| `D2: …is SKIPPED — the launch proceeds and says so once` | **`terminal.run` 有 1 条**（不阻断）；argv 不含缺失路径；`handle.warnings.length === 1` 且文案正确 |
| `D2: …REQUIRED still hard-fails, with ONE aggregated message` | 两个必需缺失 ⇒ 一条消息同时点名；旁边那个非必需项**不出现在**错误里；`terminal.run` 为空 |

`test/unit/xm-dispatch-remote-transcript.test.ts`：`launchNoticeLines` 渲染两条来源（B5 的
`warning` + D2 的 `warnings`）、空串不产生 `⚠` 行；`Orchestrator.launch` 把 backend 的
`warnings` 原样带上 Handle。

---

## Bug 3｜判成 aborted，但 child 其实跑完了（最严重）

### 真实输出

```
execution: aborted (no assistant message for the last prompt)
acceptance: rejected (none)
read-back from host 'hw-nj': 5 of 5 lines (complete)
```

远端 `/home/zzjcool/code/.pi-subagents-mirror/no-run/xm-demo-scout3/session.jsonl` **11 行**
（system → user → assistant + 2×bash → assistant "Now write the report."）；
远端 `xm-demo-3b`（worker）确实在 hw 上创建了 `/tmp/xm-demo-proof.txt`，父端却判 aborted / no output。

现场还给出了决定性的一对数字：本地 `runs/<id>/remote/xm-demo-3b.jsonl` = **5 行**（只有
session/model_change/thinking_level_change/system/user —— child 还没说话时的快照），
远端 `session.jsonl` = **8 行**；而判定读的 `runs/<id>/xm-demo-3b.jsonl` = **0 字节**。

### 根因（三个独立缺陷）

**(1) 快照时机太早（决定性）**——`collect()` 在 `awaitSupervisor` **之前**读回一次，随后整轮
collect 反复 `parseSessionFile(this.sessionFileOf(child))` 读的是**同一份冻结镜像**。launch 后 ε
时刻远端确实只有 5 行 —— 所以 `5 of 5 (complete)` 是**自洽的**（不是截断伪装），它只是**陈旧**。
判词却在孩子 settle 之后才算：快照末条是 user ⇒ 最后一个 turn `assistants.length === 0`
⇒ `NO_ASSISTANT_ABORT_REASON`（`src/shared/session.ts`）。放大后果：`aborted` 让
`shouldRecycleAfterCollect` 判定可回收，**retire 一个还在远端干活的 child**，并把判词写进
`finished` 缓存，后续 `wait` 命中同一份旧判词。

**(2) 读路径分裂（跨进程）**——写入方落 `<runDir>/remote/<name>.jsonl`，而记录里的
`sessionFile` 是**本机预创建的空占位文件**（远端 child 永远不写它）。同一进程内有内存态读回所以
能对上；换了进程（rehydrate / `cachedCollect` / `retire`）就回落到 0 字节占位文件。

**(3) 读不到转录被当成「child 没说话」**——read-back 失败时 `sessionFileOf` 指向从未写入的镜像，
解析出 0 turn / 半截 turn，于是 `deriveOutcome` 给出 `aborted (no assistant message …)` 或
`no messages in session`。**「我读不到」与「它没说」是两件事**，只有后者才配 `aborted`。
更隐蔽的一半：如果磁盘上留着**上一轮完整的** mirror，`deriveOutcome` 会给出 `success` ——
父端会把上一轮的产出当这一轮交付，而渲染同时写着 "the verdict rests on no transcript at all"。

**wait 超时是否被误当 abort**：**不是**（已核对）。超时路径是
`wait === "timeout" && isAlive` ⇒ `status: "running" + COLLECT_DEADLINE_REASON`；
父 turn 结束走 `interruptedCollect`（reason `aborted by parent`），两者与 `NO_ASSISTANT` 不共用
产出点。本次仍补了**回归测试**把这条语义钉死。

### 修法

1. **D3.1 读回时机**：新增 `refreshRemoteSession(child)`，在 **wait 落定后**、`classifyOutcome`
   的 blip 重解析前、`retryEmptyGeneration` 的判词前重新读回；判词只允许建立在**最后一次**读回上。
   `canRefreshRemote` 是**同步**判定，本地 child 因此零新增 `await`（`collect()` 仍能在第一个
   await 前到达 supervisor 的 `waitSettled`，这是既有测试依赖的时序）。
   `collectArtifactGrowing` 对远端 child 改为按**远端行数**增长（原来探本地占位文件 ⇒ 第一轮就
   break，运行中的 child 永远看不到已产出部分）；每个宽限窗只做**一次**读回（远端读回是新建
   client + 两次 `file.read`，按本地 50ms tick 轮询会白烧十次）。
2. **D3.2 路径归一**：`sessionFileOf` 在**没有内存态读回**时优先**磁盘上已存在的 mirror**，
   最后才回落记录里的占位文件。选择「读取方统一 remote/ 优先」而不是双写：一个文件一个来源，
   避免两份内容漂移；本地 child 没有 `remote/` 这一层，行为零变化。
3. **D3.3 计数与失败语义**：
   - `lines`/`returned` 来自**同一次**读回；settle 后 `N === M === 远端真实行数`（< 4000 行）。
   - read-back 失败 ⇒ 任何**非 running** 的判词一律改写为 `status: "unknown"`，reason 为
     `transcript not retrieved from host '<h>': the child's work cannot be graded from here…`，
     且 `output` 强制为空（不许把旧 mirror 的文本当本轮交付）。`running` 不动：活着的 child
     已经在说真话，而且 `shouldRecycleAfterCollect("running")` 为假、不会 retire 它。
   - 「进程已死 + 最后一轮完整」的**快路径**在读回失败时也不再走（否则会绕过上面的改写）。
   - 渲染在失败块新增 `remote: <远端路径> — retrieve it with: hc exec --on <host> -- cat <path>`；
     `unreachable` 类失败（hc core 起不来）也带路径（target 已解析，路径可算）。
   - `lines === 0` 且本地 mirror 已有字节 ⇒ 判**失败**（`fate: path`），既不清空旧字节，也不把
     陈旧镜像标成 "0 of 0 (complete)"。

### 测试红绿

`test/unit/xm-dispatch-remote-transcript.test.ts`（真 `Orchestrator` + fake supervisor + **按阶段**
作答的读回 seam）

> seam 按**阶段**而不是调用序号作答：`waitSettled` 被问过之前一律返回「launch 时的形状」，之后
> 返回「settle 后的形状」。这样才能区分「wait 之后再读」与「wait 之前多读一次」——本文件确实
> 出过一次那种假绿（`collect` 开头一度同时存在 inline 读回和 `refreshRemoteSession` 两处调用）。

| 用例 | 断言 |
|---|---|
| `D3.1: an assistant message written before the wait settles is never \`aborted\`` | 读回阶段序列**必须是** `["before-wait","after-wait"]`；`execution.status === "success"`、reason ≠ `NO_ASSISTANT_ABORT_REASON`、`output` 含最后一条 assistant 文本、`lines === returned === 11`、渲染 `11 of 11 lines (complete)` |
| `D3.1: a remote transcript that GROWS during the grace window earns the extension` | 行数递增 ⇒ `waitSettled` 至少 3 次（宽限被授予）且最终 `lines > 5`；删掉远端增长分支则只有 1 次 |
| `D3.3: a read-back that never arrived is \`unknown\`` | 陈旧 5 行快照 + 读回失败 ⇒ `status === "unknown"`、reason === `transcriptNotRetrievedReason(...)`、渲染**不含** `aborted`、含远端路径与 `hc exec --on hw-nj -- cat …` |
| `D3.3: a failed read-back does not grade a PREVIOUS mirror as this turn's delivery` | 每次读回都失败 + 磁盘上留着**完整**的旧 mirror ⇒ `status === "unknown"`、`output === ""`（不许是旧 turn 的文本） |
| `D3.3: a wait that runs out on a LIVE cross-machine child is \`running\`` | `immediateTimeout` + alive ⇒ `status === "running"`、reason === `COLLECT_DEADLINE_REASON`、渲染不含 `aborted` |
| `D3.2: a reader with no read-back in memory parses the on-disk mirror` | 无内存读回（另一进程形态）⇒ `retire()` 从 mirror 得到 `execution.status === "success"`，而不是空占位文件的 `no messages in session` |
| `D3.3: a \`lines: 0\` answer over a non-empty mirror is a FAILURE that keeps the old bytes` | 假 `HcClient` 直接返回 `lines: 0` ⇒ `ok: false`、`fate === "path"`、`remotePath` 存在、本地旧字节**未被覆盖** |

---

## 追加｜默认只允许 centurion 跨机（用户设计意图）

> 用户原话：「为什么 scout 和 worker 可以派发跨机器？我设计的应该是只有 centurion 可以跨机器」

### 现状根因

`host` 有 7 个入口、6 个白名单（3 个 tool schema、frontmatter `AGENT_FRONTMATTER_FIELDS`、
`OVERRIDE_FIELDS`、`settings.ts` 两处硬编码字符串数组），**没有任何角色限制**——契约 D1 只写了
「host 是否可解析」。`kind` 恒为 `"pi"`（`AGENT_KINDS`），角色身份只能用 `agent.name`。

### 修法

- 新配置 `subagents.crossMachine.allowRoles?: string[]`，默认常量
  `DEFAULT_CROSS_MACHINE_ALLOW_ROLES = ["centurion"]`（`src/shared/types.ts`）。
- 解析器 `parseCrossMachine` 校验形状（非数组 / 空数组按**形状错误**拒绝——想关掉请用 `enabled: false`）。
- 值随 `HostTarget.allowRoles` 传递（**只在配置写了时出现**，未配置的 target 逐字保持旧形状；
  同一条承诺 `piExtensions` 也有），**同步与异步两个解析器都 stamp**（工具派发走 async）。
- 守卫在 `Orchestrator.launch` 的跨机段、`utilityDispatch` 拒绝之后（`vexillatio` 的既有文案不变）：
  **只拦新派发**（`previous === undefined`）。已有记录的同名 launch 不重复过角色门，否则一次
  设置收紧会让在跑的远端 child 不可控。
- 文案点名理由 + 可粘贴放行片段：
  `host 'hw-nj' cannot be dispatched to agent 'scout': cross-machine launch is for a DELIVERY UNIT,
   and only 'centurion' may cross. Dispatch a centurion to that machine and let IT create its scout
   team there. To allow it anyway: "subagents": { "crossMachine": { "allowRoles": ["centurion", "scout"] } }`

### 测试红绿

`test/unit/cross-machine-orchestrator.test.ts`

| 用例 | 断言 |
|---|---|
| `D4: a scout cannot cross machines by default` | 默认被拒（`INVALID_PARAMS`）、文案含理由与片段、**没有 spawn** |
| `D4: a worker is refused too, unless the target's allowRoles says otherwise` | 默认拒；`allowRoles: ["centurion","worker"]` ⇒ 正常启动 |
| `D4: …a name that ALREADY exists over there is not re-gated` | 收紧 allowlist 后同名 launch 不被角色门拦住，并**显式断言它确实又 spawn 了一次**（说明豁免的是"不重复过门"，不是"resume"） |

`test/unit/cross-machine-target.test.ts` / `cross-machine-params.test.ts` /
`cross-machine-discovery.test.ts`：默认不写字段、显式值随 target 传递（**含 async 解析器**）、
非数组/空数组按名字拒绝。

---

## 门禁

```
npm run typecheck        → exit 0
npm test                 → ℹ tests 2580   ℹ pass 2579   ℹ fail 0   (1 skipped)
npm run test:integration → ℹ tests 169    ℹ pass 169    ℹ fail 0
```

### 「改回去即红」的实测输出

回滚脚本逐条把修复处还原成 6.2.0 的写法、跑对应测试、再把文件复原（`/tmp/redproof.py`，
11 条全红）：

```
=== R1 bug1: 恢复"只认声明文件"（纯全等） ===
  RED  ✖ xm-dispatch D1: a package that declares a DIRECTORY covers the entries inside it (pi-autoresearch@1.9.0 layout)

=== R2 bug2: 恢复"逐个硬失败"（跳过路径失效） ===
  RED  ✖ xm-dispatch D2: a missing inherited extension is SKIPPED, and the whole launch yields ONE aggregated warning
  RED  ✖ xm-dispatch D2: a card that declares the extension REQUIRED gets one aggregated refusal instead of a skip
  RED  ✖ xm-dispatch D2: an `entry-missing` skip is skipped too (a different layout is not a hard failure)

=== R2b bug2: 同上，集成层（真 hc core）也必须红 ===
  RED  ✖ xm-dispatch D2: an inherited extension that machine cannot load is SKIPPED — the launch proceeds and says so once
  RED  ✖ xm-dispatch D2: a card that declares the extension REQUIRED still hard-fails, with ONE aggregated message

=== R3a bug3.1: 删掉 wait 之后的重新读回 ===
  RED  ✖ D3.1: an assistant message written before the wait settles is never `aborted` — the mirror is re-read after the wait
  RED  ✖ D3.3: a read-back that never arrived is `unknown` ('transcript not retrieved'), never 'the child never spoke'

=== R3b bug3.3: 读回失败时不再改写判词 ===
  RED  ✖ D3.3: a read-back that never arrived is `unknown` …
  RED  ✖ D3.3: a failed read-back does not grade a PREVIOUS mirror as this turn's delivery

=== R3b2 bug3.3: 允许用旧 mirror 的 success 当本轮交付 ===
  RED  ✖ D3.3: a failed read-back does not grade a PREVIOUS mirror as this turn's delivery

=== R3b3 bug3.3: 把旧 mirror 的文本当本轮 output ===
  RED  ✖ D3.3: a failed read-back does not grade a PREVIOUS mirror as this turn's delivery

=== R3c bug3.3: 把 wait 超时报成 aborted ===
  RED  ✖ D3.3: a wait that runs out on a LIVE cross-machine child is `running`, never `aborted`
  RED  ✖ D3.1: a remote transcript that GROWS during the grace window earns the extension

=== R3d bug3.2: 删掉 mirror 回落（读空占位文件） ===
  RED  ✖ D3.2: a reader with no read-back in memory parses the on-disk mirror, not the empty local placeholder

=== R4 角色门: 删掉 allowRoles 守卫 ===
  RED  ✖ xm-dispatch D4: a scout cannot cross machines by default — only a delivery-unit role may
  RED  ✖ xm-dispatch D4: a worker is refused too, unless the target's allowRoles says otherwise
```

> 期间发现并修掉了一个**测试假绿**：collect 开头一度同时存在「inline 读回」和
> `refreshRemoteSession` 两处调用（重复读），使 D3.1 用例在删掉 post-wait 刷新后仍然通过。
> 已删掉重复调用，并把 seam 改成**按阶段**作答（见上），R3a 的红灯是清理后重测的结果。

---

## 对抗式 review 轮次（2 路，均 `ok: false`，findings 全部处理）

两路 reviewer（正确性/回归、测试/契约）各 4–8 条 major。逐条处置：

| reviewer finding | 处置 |
|---|---|
| `unreachableFailure` 三处不传 `remotePath` ⇒ 「hc core 掉了」这类失败永远不渲染远端路径与 `hc exec` | **修**：target 已解析的那处在作用域内直接传（`attemptedPath`）；target 都解析不出来的那处诚实保持 absent |
| 读回失败仍会 grade **旧 mirror**：末轮完整时直接 `success`，还会把上一轮产出当本轮交付 | **修**：任何非 `running` 判词改写为 `unknown`；`output` 强制为空；「进程已死 + 末轮完整」快路径在读回失败时禁用。新增两条用例 + R3b2/R3b3 红灯 |
| `shouldRecycleAfterCollect("unknown")` 也为真，注释却暗示不会 retire 活着的 child | **改注释**（行为不变，且这是既有语义：`settled` 之后的回收与任何终态一致）。真正的伤害（**mid-turn** retire）由 `running` 分支挡住——超时/alive 一律 `running` |
| 排队放行的 notice 只拼 `handle.warning`，D2 的 `warnings` 在 fan-out 排队时**完全静默** | **修**：抽 `launchNoticeLines`/`noticeWithWarnings`，`index.ts` 的 `▶` 之后与排队 notice 共用；单测覆盖两条来源 |
| `lines: 0` 不截断但仍报 "0 of 0 (complete)" ⇒ 陈旧镜像永久留存且标完整 | **修**：改为显式失败（`fate: path` + 保留旧字节 + 给出 `hc exec` 校对命令） |
| 远端增长探测每窗最多 10 次完整读回（每次新建 client + 2 次 `file.read`） | **修**：每窗一次 |
| 严格入口 `mapRemoteArgv` 变成「先收集后抛 `skipped[0]`」，混合 argv 抛错顺序与 6.2.0 不同 | **修**：恢复独立单趟实现（argv 顺序第一处即抛） |
| `--extension=<path>` 单 token 形态会整串下传（父机绝对路径到达远端 pi） | **修**：两种拼写同规则，加测试 |
| `requiredExtensions` 写包内相对路径时 fail-open（被跳过而非硬失败） | **修**：相对路径也参与匹配，加测试 |
| D3.1/D3.3 的 seam 按调用序号 ⇒ 分不清「wait 后再读」与「wait 前多读一次」（历史假绿形态） | **修**：seam 按**阶段**作答 + 断言阶段序列 `["before-wait","after-wait"]` |
| D4 的 "resume" 用例其实 retire 后重起，没走 resume，却断言成铁证 | **修**：改名为「已有记录不被重复过门」，并显式断言它**确实又 spawn 了一次**；resume 判据（`admission:"never"`）与角色门无关，已在注释里点名 |
| D2 的 `Handle.warnings → ⚠` 通道无测试 | **修**：`launchNoticeLines` 单测 + `Orchestrator.launch` 透传测试 |
| `existingBytes` 0 行保护、远端增长分支、`requiredExtensions` 四处接线、async `allowRoles` 透传 无测试 | **修**：各补一条（见测试表；增长分支的用例会因删掉远端分支而红） |
| `collectArtifactGrowing` 远端分支从未被证明返回 true | **修**：增长用例断言 `waitSettled >= 3` 且最终 `lines > 5` |

### 接受（不改）的项，理由

- **`subagents.crossMachine` 整块被 project settings 覆盖**：既有语义
  （`settings.ts` 的 `crossMachine` 整体替换，6.1 就是这样），新键踩进同一语义。项目文件想保留
  用户级白名单就写全 `allowRoles`；改成分块深合并会动到所有 `crossMachine` 键的语义，超出本次
  bugfix 范围。
- **`unknown` 在 `shouldRecycleAfterCollect` 里可回收**：与 `settled` 的其它终态一致（回收发生在
  回合结束之后）。本次把「回合还在跑时被误 retire」的路径堵死（live ⇒ `running`）。
- **`cache`/`no-run` 镜像目录命名**：现场能看到 `no-run`（launch 没记 run id），本次不改命名与
  记录格式——读回路径由 `remoteDir`（记录里）与 `mirrorRoot`（配置）决定，两者一致时读取正确，
  不一致时 `classifyReadbackFailure` 会把「recorded dir vs configured dir」作为证据打印出来。

## 已知遗留（不在本次范围，但与本路径命名同源）

- **远端镜像目录在生产里恒为 `no-run`**：`index.ts:1635` 是唯一的生产构造点
  `new TerminalSupervisor()`，**不传 `runId`**（构造函数注释也写了"index.ts 在构造 supervisor 时
  拿不到 run id"），于是 `remoteDirFor(target, undefined, name)` → `<mirrorRoot>/no-run/<name>`。
  测试全部显式传了 `runId`（`test/integration/fake-core-remote-fate*.test.ts`），所以这个形状
  只出现在真机上。`no-run` 本身**不是故障信号**（`docs/contracts/remote-child-fate-v1.md` 已写明）。
- **由此带来的跨 run 撞名风险（既有，非本次引入）**：同一台机器上，两个不同 run 若派生**同名**
  child（`worker-0` 是最常见的名字），在远端会用**同一个** `<mirrorRoot>/no-run/worker-0/session.jsonl`
  ——`--session` 是显式指到那个路径的（`terminal-supervisor.ts:561-570`）。后一个 child 启动会接着写
  或覆盖同一个文件；前一个 run 之后若再 collect，读到的可能是**另一个 run 的转录**。
  本次修复把判词改成"读最后一次"，因此这一场景的失败形态从"陈旧快照 → `aborted`"变成
  "读到别人的转录 → 看起来正常的判词"，**更隐蔽**，故在此明写。
  缓解方向（未实现，需要单独设计）：把真实 run id 传进 `TerminalSupervisor`，让远端镜像目录成为
  `<mirrorRoot>/<runId>/<name>`；不能只改 `remoteDirFor` 的 fallback——launch 与 read-back 必须同时
  切换，否则两边算出两个路径。

## 版本建议

三个 bug 都是**行为错误修复 + 一个默认收紧**（`allowRoles` 默认只放 centurion）。默认收紧对
「今天就在跨机派 worker/scout」的用户是可感知的行为变更，但它正是设计意图、且提供了显式放行键。
建议 **patch：6.2.0 → 6.2.1**（若团队把「默认值变更」视为 minor，则 `6.3.0` 并列可接受。）
CHANGELOG 已加 `[Unreleased]` 条目并按 patch 描述，`Changed` 段明写默认值与放行方法；
**版本号本身未改动**（本次不发版）。
