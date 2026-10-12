# 契约：retire 链加固（SIGKILL 升级 + 后代清场）

状态：FROZEN-1（2026-10-12，主会话冻结）
触发事故：2026-10-12 两个孤儿 `node --test` 进程（PPID=1）持续 110% CPU 各烧 4h20m，SIGTERM 无效，最终需人工 SIGKILL。根因：retire 链止步于 SIGTERM→RETIRE_FAILED，且孙进程（子 pi 经 bash 工具 `detached:true` 派生的测试进程）不在任何击杀范围内，父死后 reparent 到 init 泄露。

主契约关联：`docs/legion-v2-contract.md` §3.2 表行 + 修订日志 REV-16。

## 0. 侦察已定事实（HEAD 96098c2，worker 直接引用，勿重查）

- retire 链现状：`src/supervisor/rpc-supervisor.ts:750-819` `retireChild` = closeInput(:783) → waitForExit(retireTimeoutMs=5s) → `process?.kill("SIGTERM")`(:787) → waitForExit(signalTimeoutMs=1s)(:805) → 仍活则 `throw RETIRE_FAILED`(:807-812)。**无 SIGKILL，无孙进程处理。**
- `waitForExit` 定义 :832-850，timer 未 unref。`closeInput` :821-830。
- `RpcSupervisorOptions`（:66-76）：`clientFactory? / uiProxy? / retireTimeoutMs?(5000) / signalTimeoutMs?(1000)`，常量 :78-79。
- `RpcProcessHandle`（`src/supervisor/types.ts:69-90`）：`pid?: number`、`stdin`、`exitCode`、`signalCode`、`once/on/off("exit")`、`kill(signal?)`。`kill` 是 `RpcProcessHandle` 自身方法（单 pid 语义），本契约不改它。
- SDK spawn 硬编码：`spawn("node", [cliPath, ...args], { cwd, env, stdio:["pipe","pipe","pipe"] })`，**无 detached 选项、无任何进程组开关**（rpc-client.js:42-46）。因此子 pi 与 supervisor 同进程组，`kill(-child.pid)` 会误杀宿主自己——**禁止对子 pi 自身 pid 做组击杀**。
- 子 pi 的 bash 工具孙进程是 `detached:true`（自成会话/进程组），父死后拿不到信号——必须靠 /proc 祖先链在子 pi 存活时枚举。
- 测试 harness：`test/unit/supervisor.test.ts:191-209`，`FakeRpcProcess`（:36-94，`pid = 10_000 + clients.length`，`kill(signal)` 未忽略则立即 exit，`signals` 数组记录全部信号）、`FakeRpcClient`（:96-158，`stop()` 内部 `process.kill("SIGTERM")`）。`retireTimeoutMs/signalTimeoutMs` 在 harness 里压到 100/100。**无 fake timers，全真实定时器。**
- 现有硬约束测试：`:287`（graceful retire 后 `signals` deepEqual `[]`）、`:353`（子进程无视 SIGTERM → RETIRE_FAILED + 可重试 + 信号序列硬编码）、`:430`（client 隐藏 process 时 retire 仍 resolve waiter）。retire 行为回归面 = `test/unit/supervisor.test.ts` 唯一（live 测试默认 skip）。

## 1. 冻结语义：retire 四级递进 + 后代清场

```
retire(name, {graceful}) 流程（retireChild 内，frozen）：
 1. 早退：!isAlive → 原样保留（:750-786 路径），无枚举无清场（子已死，祖先链已断）
 2. 枚举：child.process?.pid 存在 → descendants = enumerateDescendants(pid)；否则 []（null-process 分支无 pid，不清场）
 3. graceful 时 closeInput → waitForExit(retireTimeoutMs)        【不变】
 4. SIGTERM：process?.kill("SIGTERM")；!process 时 client.stop() 兜底【不变】→ waitForExit(signalTimeoutMs)
 5. SIGKILL 升级（新）：仍 alive → process?.kill("SIGKILL") → waitForExit(killTimeoutMs)
 6. 后代清场（新）：sweepDescendants(descendants) —— 无论子已退出还是杀不动，都执行
 7. 仍 alive → throw RETIRE_FAILED（重试语义保留：retirePromise 失败后清除，可再次 retire）
 8. 收尾 state=retired 等原逻辑不变
```

- `killTimeoutMs` 新 option，默认 `DEFAULT_KILL_TIMEOUT_MS = 1_000`。
- SIGTERM 升 SIGKILL 语义变化：原「无视 SIGTERM → RETIRE_FAILED + 子仍活」改为「无视 SIGTERM → 吃到 SIGKILL → 退出」；**只有连 SIGKILL 都无效（仅 fake 场景）才 RETIRE_FAILED**，重试语义不变。
- graceful:false 语义不变：跳过 stdin close，直接从 SIGTERM 起。

## 2. 后代枚举（新模块 `src/supervisor/proc-tree.ts`）

```ts
// types.ts 新增（supervisor 契约类型）
export interface DescendantInfo { pid: number; pgid: number }

// proc-tree.ts 导出（frozen API）
export function parseProcStatLine(line: string): { pid: number; ppid: number; pgid: number } | null;
export function enumerateDescendants(rootPid: number): DescendantInfo[];
export function currentPgid(): number | null;
```

- `parseProcStatLine`：解析 `/proc/<pid>/stat` 单行。**陷阱：comm 字段可含空格与括号，必须 `lastIndexOf(")")` 后切分**；之后空格分隔：`[0]=state [1]=ppid [2]=pgrp`。解析失败/非有限数 → null。
- `enumerateDescendants(rootPid)`：扫 `/proc/*/stat` 建 pid→ppid 全表 → 反向 BFS 收集 rootPid 的全部后代（**不含 rootPid**），返回 `{pid, pgid}` 列表（遇到读失败/条目消失的 pid 跳过）。**非 Linux（无 /proc）或 win32 → 返回 []**。**空结果或 rootPid 不存在 → []**。
- `currentPgid()`：读 `/proc/self/stat` 取 pgrp；非 POSIX / 失败 → null。
- 纯同步函数，不做任何信号操作。

## 3. 清场算法（frozen）

```
sweepDescendants(descendants: DescendantInfo[]): Promise<void>
  if empty → 立即 return（不做任何等待）
  ownPgid = currentPgid()
  pgids = unique(descendants.pgid) 中排除 ownPgid 与负数/非法值，保持枚举遭遇顺序
  pids  = unique(descendants.pid)，保持枚举遭遇顺序
  TERM 相：对每个 g in pgids → signalProcess(-g, "SIGTERM")；再对每个 p in pids → signalProcess(p, "SIGTERM")
  等待 signalTimeoutMs（setTimeout，timer.unref()）
  KILL 相：同样顺序 pgids → (-g, "SIGKILL")，pids → (p, "SIGKILL")，无条件执行（幂等，ESRCH 由 signalProcess 吸收）
  全程不得抛出（signalProcess 返回 boolean；seam 抛错也 catch 继续）
```

**安全红线**：
- **绝不组击杀 ownPgid**（会杀掉 supervisor 宿主自己）。pgid === ownPgid 的后代只做单 pid 击杀。
- **绝不组击杀子 pi 自身 pid**（子与宿主同组，见 §0）。
- `signalProcess` 默认实现：`try { process.kill(target, signal); return true } catch { return false }`（ESRCH/EPERM 全部 → false，静默）。
- 已接受的残余风险（文档化即可，不要求处理）：枚举与清场之间 pid 复用误杀（窗口=retire 时长秒级，与 SDK killProcessTree 同等假设）；子 pi 异常崩溃（非 retire 路径）时祖先链已断，枚举不可能——该残留归主机 watchdog（明确不做，见 §6）。

## 4. 注入缝（可测试性，frozen）

`RpcSupervisorOptions` 新增：
```ts
killTimeoutMs?: number;                                     // 默认 1_000
enumerateDescendants?: (rootPid: number) => DescendantInfo[]; // 默认 proc-tree 实现
signalProcess?: (target: number, signal: NodeJS.Signals) => boolean; // 默认 process.kill+catch
```

**测试安全强制项**：`test/unit/supervisor.test.ts` 的 `harness()` 必须默认注入 `enumerateDescendants: () => []`。原因：FakeRpcProcess 的 pid 是 10000+ 递增的假 pid，若走默认 /proc 枚举器，一旦撞上系统真实 pid 会把真实进程的后代杀掉。清场专项测试自行覆盖注入；**禁止任何 supervisor 单测让默认枚举器接触 FakeRpcProcess 的假 pid**。proc-tree 的真实行为由 `test/unit/proc-tree.test.ts` 用真实进程验证（本测试进程 `process.pid` 为 root，spawn 真实 `sleep`/`sh` 后代断言被枚举到；parser 边界用 `parseProcStatLine` 直接喂 fixture 字符串测）。

## 5. 文件归属（worker 全权，其他文件禁碰）

| 文件 | 动作 |
|---|---|
| `src/supervisor/types.ts` | +`DescendantInfo`、3 个新 option 类型 |
| `src/supervisor/proc-tree.ts` | 新建（§2 API） |
| `src/supervisor/rpc-supervisor.ts` | retireChild 四级链 + sweepDescendants + 新 option 接线 + `waitForExit` timer `.unref?.()` |
| `test/unit/supervisor.test.ts` | harness 默认缝 + `:353` 用例重写 + 新用例（见 §7） |
| `test/unit/proc-tree.test.ts` | 新建（真实进程枚举 + parser fixture） |

不碰：`src/runs/*`、SDK、`handleProcessExit`、`rollbackSpawn`、`disposeRecord`、live 测试、其他一切。

## 6. 明确不做

- 主机级 watchdog（孤儿进程定期清扫）——后续独立方案。
- `package.json` 测试 `--test-timeout` ——独立方案。
- handleProcessExit 崩溃路径的常驻后代登记簿（需常驻枚举，watchdog 范畴）。
- SDK/RpcClient spawn 改造（detached/setsid）——SDK 硬编码无注入口，收益/风险比差，否决。
- null-process 分支（client 隐藏 process）：行为保持逐字节不变（`:430` 用例是守卫）。

## 7. 验收清单

命令（注意：本环境 `npx` 被拦截，用 `npm run typecheck` / `node_modules/.bin/tsc`）：
1. `npm run typecheck` → 0 错误。
2. `npm test` 全绿（含既有 `:287`、`:430`、`:353-重写` 与全部新用例）。

新/改用例（frozen 名称）：
- 「retire resolving timeout is retryable after a child ignores SIGTERM and SIGKILL」：ignoredSignals={SIGTERM,SIGKILL} → reject RETIRE_FAILED，signals=["SIGTERM","SIGKILL"]，isAlive=true；随后解除 SIGTERM 忽略 → 二次 retire 成功，signals=["SIGTERM","SIGKILL","SIGTERM"]，isAlive=false。（重写自 :353）
- 「SIGKILL escalation retires a child that ignores SIGTERM」：仅忽略 SIGTERM → retire(graceful:false) 正常 resolve，signals=["SIGTERM","SIGKILL"]，isAlive=false。
- 「retire sweeps enumerated descendants with SIGTERM then SIGKILL」：注入枚举器返回 `[{pid:4242,pgid:4242},{pid:5150,pgid:4242}]` + 记录器 signalProcess → 断言调用序列恰为 `(-4242,TERM),(4242,TERM),(5150,TERM)` → 宽限 → `(-4242,KILL),(4242,KILL),(5150,KILL)`。
- 「descendant sweep never signals the supervisor's own process group」：注入枚举器返回 `[{pid:777, pgid: <currentPgid()>}]` → 断言只有 `(777,TERM),(777,KILL)`，绝无负数目标。
- 「retire completes without sweep when no descendants」：harness 默认 `()=>[]` → signalProcess 记录器零调用，retire 正常完成。
- `proc-tree.test.ts`：a) 真实 spawn `sleep 300`（含一层 `sh -c` 中间进程）后代能被 `enumerateDescendants(process.pid)` 枚举到且 pgid 正确；b) rootPid 不存在（如 999999999）→ []；c) `parseProcStatLine` 对含空格/括号 comm 的 fixture 行解析正确，垃圾行 → null。

其余验收锚点：`:287` graceful 生命周期用例的 `signals == []` 断言必须继续成立（清场零目标）；`:430` null-process 用例行为不变；retire 失败重试语义不变。

## 8. 提交要求

- 分支：`retire-hardening`；conventional commit（如 `feat(supervisor): escalate retire to SIGKILL and sweep descendant processes`）。
- 自报 verdict JSON（含 typecheck/test 结果与全部用例名单）。
- 契约矛盾 = 正确拒绝：引用条款号停下报告，禁止自行解释。
