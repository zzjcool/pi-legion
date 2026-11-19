# 6.2.4（patch）— 父进程自然退出后的跨机 child（D2）+ status dead 块补 host/terminal（D3）

- 仓库 / 分支：`pi-legion` `fix/orphan-on-natural-exit`，基线 `origin/master` `0813b35`（= 6.2.3）
- 依据：`docs/reports/release-6.2.3-verification.md`（PR #402）§3.2 / §3.3
- PR：<https://github.com/zzjcool/pi-legion/pull/403>
- 验收方式：**真进程两步**（`pi -p` 在 `hc` 终端里 launch → 父进程**自然退出** → 全新进程 `status` + `recover`），
  加上单测 / 集成测试与变异（每条断言「改回去即红」）
- 版本：`6.2.4`；CHANGELOG `## [Unreleased] — 6.2.4（patch）`；**不发版、不打 tag**

一句话结论：

> **D2 PASS** —— 父进程自然退出（`EXIT=0`，`real 0m11.814s`，`hc run` 报 `reason:"exit"`）时，仍在远端
> `sleep 30` 的 child 被记成 **`orphaned`**（run.json 记录 + ledger `orphan_detected`，节点行保持 open），
> **不再被 kill、也不再被等待**；全新进程 `status` 看到 `state=orphaned` + `host=remote` +
> `terminal=remote/lgl-o624-b`；`recover` **真的 fetch 了 12/12 行**并 settle 成 `success` /
> `accepted (attested)`，第二次调用回到 `already settled … nothing was fetched`，且镜像文件
> `mtime` 一字未变（零 fetch 的物理证据）。**D3 PASS** —— dead 块现在带 `host=` / `terminal=`。

---

## 1. 6.2.3 的两个遗留（为什么必须修）

6.2.3 的 `session_shutdown` 对**每一个** live 子节点都做同一件事：
`markSessionInterrupted()` 把 `nodes.status` 改成 `retired` 并写
`node_retired{reason:"session-shutdown"}`，然后 `retire({cause:"session-shutdown"})` 把记录写成
`aborted (session-shutdown)`。对本地 child 这是诚实的（它随父进程而死）；对**跨机** child 是三重错误：

1. 远端进程根本没被杀（真机实测：父进程退出后远端 `pi` 又跑了 75s 并写出了真实结果）；
2. `retired` 让 `hasEnded()` 为真，`recover` 因此认为「already settled」——**零 fetch**，只回 launch
   时的 5 行快照；
3. 同一个排在 `interruptedChildren()` 里又被当作「被上一个会话打断、可以 resume」，两个功能对同一
   行的解释相反。

D3 是同一处证据链的次要项：`subagent({action:"status"})` 的 dead 块只有 name/role/state/owner/
supervisor/session，**host 与远端终端只在 `recover` 首行出现**，两个界面拼起来才齐。

---

## 2. 三态判定表（本 patch 的核心口径）

判定函数：`shutdownFate()`，`src/legion/orphan.ts:70`。

| child 在哪里 | 退出时已知的事实 | fate | ledger / record | recover |
|---|---|---|---|---|
| 本机 | （任何） | **`aborted`** | `nodes.status=retired` + `node_retired{reason:session-shutdown}`；run.json `retired`（6.2.3 逐字保留） | 无可取（进程已死） |
| 另一台机器 | 仍在跑，或问不到 | **`orphaned`** | 节点行**保持 open**（`running`）；run.json `state:"orphaned"` + `child.orphaned{...}`；ledger `orphan_detected{reason,fate}` | **fetch 允许** |
| 另一台机器 | 轮次已结束（已有判词，或本机已有完整 mirror）但结果没取回 | **`unfetched`** | 同上，`fate:"unfetched"` | **fetch 允许** |
| 另一台机器 | 收到 abort 且**确认**停止 | **`aborted`** | 走 `stop`/`abort` 的原路径（`retire` 无 cause） | 无可取（确实停了） |

两条实现口径，写进报告是为了不留歧义：

- **`orphaned` / `unfetched` 故意不是终态。** `TaskState` 新增这两个值（`src/shared/types.ts`），
  但 `nodes.status` 仍是原来的 live 值 —— 这样 `hasEnded()` 为假、`listUnsettledRemoteNodes()`
  （`/legion status` 的 recoverable 块）照旧列得出来、`recover` 的判定阶梯也允许触网。把行改成
  `retired` 正是 6.2.3 的缺陷本身。
- **`unfetched` 是新语义**（仓内原先没有这个状态，只有 `remote-recover.ts` 里一句自由文本
  `not fetched: …`）。这里用「新增 `TaskState` + `orphan_detected.fate` 字段」表达，而不是新增
  事件类型：`orphan_detected` 本来就在闭集 16 条里（`src/legion/events.ts:29`），ledger 契约不动。
- **「真的被 kill → aborted」在 shutdown 路径上对跨机 child 永不发生**，因为本 patch 之后退出
  **不再向另一台机器投递 kill**（见 §3.2）。它由 `stop`/`abort` 路径承载，那条路径的语义与
  6.2.3 完全一致（有测试：`a DELIVERED and CONFIRMED stop is still aborted`）。

---

## 3. 代码改动

### 3.1 判定与标记（新增模块）

`src/legion/orphan.ts`

- `shutdownFate(facts)`（:70）：三态判定唯一实现；`crossMachine=false` ⇒ 无条件 `aborted`。
- `isCrossMachineHost` / `remoteSessionPathFor`：`host` 与 `<remoteDir>/session.jsonl`。
- `orphanMarkFor(db,nodeId)`（:118）：读**最后一条** `orphan_detected{reason:"session-shutdown"}`，
  且**只在该事件比最后一次 settle 事件（`node_settled|node_failed|node_retired|node_abandoned`）
  更新时才算数**。这一条是「第二次 `recover` 零 fetch」的机关：recover 写下的 settle 事件比标记新，
  标记自动失效。

### 3.2 退出：不再杀、不再等

- `src/legion/interrupt.ts:49`：`markSessionInterrupted()` **跳过**跨机节点（不写 `retired`、
  不写 `node_retired`）。本地 child 逐字保留 #374 §3 的行为。
- `src/runs/orchestrator.ts:4028`：`retire({cause:"session-shutdown"})` 对跨机 child 走
  `orphanOnShutdown()`（:4117）—— 落 fate、写 `orphan_detected`、**不调 `supervisor.retire`
  （= 不 kill）**、不 abort phase、节点行不动。`remoteTurnEnded()` 只用两个本地事实挑
  `unfetched`：记录已有终态判词，或本机 mirror 已能 `deriveOutcome` 出终态。没有 wire。
- `src/extension/runtime.ts:2945` `releaseCrossMachineChildren()`：shutdown 时在 drain **之前**
  对每个跨机 job 依次（顺序承重）：
  1. `job.retire({cause:"session-shutdown"})` —— 事实还在时落 fate；
  2. `job.collectAbort.abort()` —— 取消 in-flight collect（跨机 collect 会在 ref 住的定时器上
     轮询到 deadline，那就是 `pi --print` 不退出的一半原因）；
  3. `jobs.delete(name)` —— drain 与 retire 循环都看不见它。
  `ensureCollect`（`src/extension/runtime.ts:2412`）把调用方的 signal 与
  `job.collectAbort.signal` 合并（`mergeSignals`，listener 在 collect 结束时释放），所以
  「谁先开始的 collect」不再决定能不能被取消。
- `index.ts:1957`：`shutdownRetireAll` 在写中断标记之后、drain 之前调用它。

### 3.3 recover：orphaned / unfetched 允许 fetch

`src/runs/remote-recover.ts:360`

```ts
const recorded = recordedSettle(input.db, node.id);
const orphan = orphanMarkFor(input.db, node.id);
const graded = recorded?.status !== undefined;
const settledAlready = alreadySettled && orphan === undefined && graded;
```

「已落定」从「`hasEnded` 就够」收紧为「**行已结束 + 没有更新的 orphan 标记 + ledger 真的记过判词
（`execution`）**」。于是三件事同时成立：

- `orphaned`/`unfetched` 行（本来就没结束）照常 fetch；
- 6.2.3 留下的 `aborted (session-shutdown)` 行（有 `reason`、**没有** `execution`）也会 fetch ——
  6.2.3 埋掉的真实结果在新版本里仍取得回来；
- 被 hygiene 收敛成 `failed` 的遗留行（`node_abandoned` 无判词）也会 fetch。

`recover` 成功（`settled-now`，或 `already-settled` 但记录上还挂着 orphan 标记）时，`index.ts:7142`
附近 best-effort 把 run.json 记录同步成 `retired` 并删掉 `orphaned` —— `subagent status` 读的是
run.json，否则两本账会继续互相打脸。

### 3.4 `/legion status` 列出 orphaned

数据源没变（`listUnsettledRemoteNodes`：`host<>''` 且 live 三态），行保持 open 就会列出来；新增的是
**把 fate 讲清楚**：`src/extension/legion-status.ts:244` 把行渲染成
`- <name> · <role> · host <h> · orphaned · terminal <t> · <age>`（`unfetched` 渲染成
`running (unfetched)`；没有标记的老行逐字不变），fate 由 `index.ts:2503` / `src/runs/remote-recover.ts:149`从 ledger 读
（`orphanFateOf`），`RecoverableNode` 类型只为多这一个可选字段而加宽。

### 3.5 D3：status dead 块补 host / 远端终端

- `LiveChildStatusInput` 增加 `host?` / `remoteTerminal?`（`src/extension/runtime.ts:751-752` 渲染）；
- `renderStatusOverview`（`index.ts:6635`）与 `/legion status <name>`（`index.ts:3662`）都把记录上的
  两个字段传进去；本地 child 没有值 ⇒ 不产生这两行（老输出逐字不变）。

---

## 4. 真进程两步（硬门禁，实跑）

### 4.1 环境：两容器 = 两台机器，传输/文件系统/进程都是真的

沿用仓库自带的跨机自测台（`test/docker/xm-up.sh`，契约 `docs/contracts/xm-harness-v1.md`）：
`xm-parent`（真 `hc` 0.1.21，ssh 到 `xm-remote`）与 `xm-remote`（sshd + pi），**`/plugin` 挂载的是
本次 worktree**，所以跑的就是本 patch 的代码：

```bash
$ cd /home/zzjcool/code/pi-legion-wt/fix-orphan-exit && bash test/docker/xm-up.sh
XM_STEP parent models=3 (XM_MODEL=workbuddy/hy4std)
XM_STEP hc machine ls 含 remote
XM_UP_OK parent=xm-parent remote=xm-remote host=remote hostCwd=/root/work

$ docker exec xm-parent bash -lc 'readlink -f /plugin; pi list | tail -2; hc machine ls --json'
/plugin
  ../../../plugin
    /plugin
{"machines":[{"host":"remote",…,"name":"remote","state":"connected","target":"remote","version":"0.1.21","via":false}]}
```

模型用真 provider（不是 mock LLM）：

```bash
$ docker exec xm-parent node /plugin/test/docker/xm/settings-merge.mjs \
    /root/.pi/agent/settings.json \
    '{"defaultProvider":"any-endpoint","defaultModel":"workbuddy/deepseek-v4.1-flash","subagents":{"defaultModel":"any-endpoint/workbuddy/deepseek-v4.1-flash","crossMachine":{"enabled":true,"hosts":{"remote":{"cwd":"/root/work"}}}}}'
XM_SETTINGS_MERGED path=/root/.pi/agent/settings.json existed=true packages=2 keys=defaultModel,defaultProvider,packages,subagents

$ docker exec xm-parent bash -lc 'pi -p --provider any-endpoint --model workbuddy/deepseek-v4.1-flash "Reply with exactly: ok"'
ok
```

`host:` 派发要求父 `pi` 自己在一个 `hc` 终端里（`HC_TERMINAL_SOCKET` + `HC_TERMINAL_ID`），所以第一步
用 `hc run` 起父进程，与自测台的做法一致（`test/docker/xm/drive.mjs:370-380`）。

### 4.2 第一步：launch → **立即结束回合**（不 wait / 不 collect）

`/tmp/o624-prompt-A.txt`（`o624-a`；`o624-b` 只是把名字 sed 换掉）：

```
立即调用一次 subagent 工具，参数完全如下（禁止修改参数，禁止先做调研，禁止追加第二次调用）：

agent: "centurion"
host: "remote"
hostCwd: "/root/work"
name: "o624-b"
task: "只做一件事：用 bash 工具跑 `sleep 30`（前台等它结束），然后把 hostname 与 pwd 写进 /tmp/o624-child.txt，cat 出来，最后回一句 done。不要改任何仓库文件、不要开子 agent。"

调用返回后，把返回值原文一字不改地抄出来（包括任何以 ⚠ 开头的警告行）。然后立即结束回合：
不要 wait、不要 collect、不要 sleep、不要再调用任何工具。
```

```bash
$ docker exec xm-parent bash -lc 'cd /root/work && { time pi -p -a "$(cat /tmp/o624-prompt-B.txt)"; echo "EXIT=$?"; } 2>&1 | tee /tmp/o624-logA-b.txt'
```

父进程**自然退出**的原文（`hc run --json` 的 `wait` 段说明它不是被 timeout 杀的）：

````
▶ o624-b (centurion) supervisor=terminal
↳ async: a completion message is queued when each child finishes. It wakes this session when idle; otherwise it is delivered after the current turn. Use wait or collect for results. Do not tell children to message the parent.

real	0m11.814s
user	0m1.216s
sys	0m0.287s
EXIT=0
````

```bash
$ date -Is; docker exec xm-parent bash -lc 'hc run --name o624b --timeout 300 --json -- bash /tmp/o624-runB.sh'; date -Is
2026-11-19T10:44:21+08:00
{"address":"t3","agent":"bash","cwd":"/root/work","name":"o624b",
 "output":"▶ o624-b (centurion) supervisor=terminal\n…\nreal    0m11.814s\n…\nEXIT=0",
 "state":"live","turn":0,
 "wait":{"children":[],"ended":true,"exit_code":0,"reason":"exit","signal":null,"status":null,"terminal":"t3","turn":0}}
2026-11-19T10:44:33+08:00
```

`exit_code: 0` / `reason: "exit"` / `signal: null` ⇒ **自然退出**（`timeout 300` 只是外壳，没触发；
`kill` 一次都没有）。

### 4.3 退出**之后**：远端还在跑，ledger 记的是 orphaned（不是 aborted）

```bash
$ docker exec xm-parent bash -lc 'hc get remote/lgl-o624-b'
{'state': 'live', 'turn': 0, 'exit_code': None, 'finished_ms': None, 'pid': 448,
 'status': {'app': 'pi', 'state': 'working'}}

$ docker exec xm-remote bash -lc 'ps aux | grep "[s]leep 30"; ls -l /tmp/o624-child.txt'
root         465 … /bin/bash -c sleep 30; { hostname; pwd; } > /tmp/o624-child.txt; cat /tmp/o624-child.txt
root         466 … sleep 30
ls: cannot access '/tmp/o624-child.txt': No such file or directory    # 还没有结果 —— 正是「仍在跑」
```

run.json（`/root/work/.pi-subagents/runs/r-c75f1c52/run.json`，节选）：

```json
{ "name": "o624-b", "host": "remote", "state": "orphaned",
  "remoteDir": "/root/.pi-subagents-mirror/no-run/o624-b",
  "remoteTerminal": "remote/lgl-o624-b",
  "orphaned": { "at": 1795056273002, "fate": "orphaned", "reason": "session-shutdown",
                "host": "remote",
                "remoteDir": "/root/.pi-subagents-mirror/no-run/o624-b",
                "remoteTerminal": "remote/lgl-o624-b",
                "remoteSessionPath": "/root/.pi-subagents-mirror/no-run/o624-b/session.jsonl",
                "sessionFile": "/root/work/.pi-subagents/runs/r-2d9b9b8b/o624-b.jsonl" } }
```

注意这里**没有** `retiredAt`、**没有** `execution` —— 6.2.3 会写 `aborted (session-shutdown)`。
ledger（`runs/r-c75f1c52/legion.db`）：

```bash
$ docker exec xm-parent bash -lc 'cd /plugin && node --experimental-strip-types --input-type=module -e "…"'
{"id":"root.o624-b","status":"running","host":"remote",
 "remoteDir":"/root/.pi-subagents-mirror/no-run/o624-b","remoteTerminal":"remote/lgl-o624-b"}
orphanMark={"id":3,"fate":"orphaned",…,"remoteSessionPath":"…/session.jsonl"}
```

`status: running` + `orphan_detected`，**没有** `node_retired`：行是 open 的，这正是 `/legion status`
能列出它、`recover` 能触网的原因。

### 4.4 第二步（全新进程 #1）：`status` 看到它（orphaned + host + terminal）

```bash
$ docker exec xm-parent bash -lc 'cd /root/work && { time pi -p -a "…只调用一次 subagent 工具 {\"action\":\"status\",\"all\":true}…" ; echo "EXIT=$?"; }'
```

````
```
No live children.
(2 dead)

o624-b — state=orphaned agent=centurion kind=pi
owner: dead (pid gone)
host=remote
terminal=remote/lgl-o624-b
supervisor=terminal
session=/root/work/.pi-subagents/runs/r-2d9b9b8b/o624-b.jsonl

o624-a — state=orphaned agent=centurion kind=pi
owner: dead (pid gone)
host=remote
terminal=remote/lgl-o624-a
supervisor=terminal
session=/root/work/.pi-subagents/runs/r-280cddcf/o624-a.jsonl
```

real	0m8.853s
user	0m0.859s
sys	0m0.189s
EXIT=0
````

`state=orphaned`（不是被改写成 `failed`）、`host=remote`、`terminal=remote/lgl-o624-b` —— **D3 的三行都在**。

### 4.5 第二步（全新进程 #2）：`recover` **真的 fetch** 并落定

等远端跑完（`sleep 30` 之后；`t=40s status=done 1`，`/tmp/o624-child.txt` 内容 `remote` /
`/root/.pi-worktrees/o624-b`，镜像 12 行），再开一个**全新** `pi -p`：

```bash
$ docker exec xm-parent bash -lc 'cd /root/work && { time pi -p -a "…只调用一次 subagent 工具 {\"action\":\"recover\",\"name\":\"o624-b\"}…" ; echo "EXIT=$?"; }'
```

````
```
recover: 'o624-b' is over on 'remote' (terminal 'remote/lgl-o624-b' is done); settled node root.o624-b as settled — recovered from host 'remote': execution success, 1 turn(s), read-back 12 of 12 lines, terminal live
── o624-b ──
execution: success
acceptance: accepted (attested)
read-back from host 'remote': 12 of 12 lines (complete)
done

Ran `sleep 30` in the foreground, then wrote and cat'd `/tmp/o624-child.txt`:
…
```json
{"ok": true, "reason": "Ran `sleep 30` in foreground, wrote hostname+pwd to /tmp/o624-child.txt (`remote` / `/root/.pi-worktrees/o624-b`) and cat'd it; …"}
```
```

real	0m8.909s
user	0m2.660s
sys	0m0.319s
EXIT=0
````

**关键一行**：`recover: 'o624-b' is over on 'remote' … settled node root.o624-b as settled … read-back 12 of 12 lines`。
ledger 事件序列（同一个只读脚本）：

```
node_launched {}
orphan_detected {"reason":"session-shutdown","fate":"orphaned"}
node_settled {"execution":"success","recovered":true,"summary":"recovered from host 'remote': execution success, 1 turn(s), read-back 12 of 12 lines, terminal live"}
```

`orphanMarkNow = null`（settle 事件比标记新 ⇒ 标记失效）。

### 4.6 幂等 + 零 fetch（**冷进程**，物理证据）

```bash
$ docker exec xm-parent bash -lc 'cd /root/work && { time pi -p -a "…{\"action\":\"recover\",\"name\":\"o624-b\"}…"; echo "EXIT=$?"; }'
recover: 'o624-b' is already settled (settled) — nothing was written and nothing was fetched; this is the outcome the ledger recorded at 2026-11-19T02:46:34.688Z.
── o624-b ──
execution: success
acceptance: accepted (attested)
read-back from host 'remote': 12 of 12 lines (complete)
real	0m7.247s
EXIT=0
```

零 fetch 不是只靠文案：读回会重写本机 mirror，所以**镜像文件自己的 mtime/size** 是最硬的证据：

```
before mtime=2026-11-19 02:46:34.709582417 +0000 size=44632      # 第一次 recover 的读回
（第二次 recover 之后）
after  mtime=2026-11-19 02:46:34.709582417 +0000 size=44632      # 一字未动
```

### 4.7 记录同步（两本账不再互相打脸）

同一逻辑在**再次** `already settled` 时把 run.json 记录收敛（`orphaned` 标记被读回后应消失）：

````
No live children.
(1 dead)

o624-a — state=orphaned …            # 6.2.3-era 的遗留：只有 recover 才收敛记录

retired/finished (1):
  o624-b — state=retired agent=centurion (retired at 2026-11-19T02:47:59.311Z)
````

（`o624-a` 是同一形态的第二次重复：`real 0m7.960s`、`EXIT=0`，`recover` 读回 14/14 行、`execution: success`；
它的 ledger 已在**本 patch 的 record 同步之前**被 settle，所以记录仍显示 orphaned，正好演示了为什么需要
这次回写。）

---

## 5. 变异证据（每条「改回去即红」）

| # | 改回去的内容 | 变红的测试（摘录） |
|---|---|---|
| M1 | 删掉 `Orchestrator.retire` 的跨机 orphan 分支（= 6.2.3 一律 retire/kill） | ✖ `a session exit leaves a cross-machine child OPEN as orphaned and does NOT kill it`；✖ `…whose turn already ended is unfetched, not aborted` |
| M2 | `markSessionInterrupted` 不再跳过跨机节点 | ✖ `markSessionInterrupted: a local child is paused (6.2.3), a cross-machine child stays OPEN` |
| M3 | `settledAlready` 退回 `= alreadySettled`（= 6.2.3 的「terminal 就 already settled」） | ✖ `a row 6.2.3 stamped aborted (session-shutdown) … is fetched, not refused`；✖ `hygiene converged an orphaned row to failed — the result is STILL fetched` |
| M4 | 不再把 `host` / `remoteTerminal` 传进 status 渲染（两处） | ✖ `status dead block carries host and remote terminal (D3), and an orphaned record says so` |
| M5 | `releaseCrossMachineChildren()` 变成空转（不释放 job） | ✖ `releaseCrossMachineChildren: stamps the record, cancels the collect, drops the job — local jobs untouched` |
| M6 | `ensureCollect` 不再合并 `job.collectAbort.signal`（只能被调用方取消） | ✖ 同上（`remoteSignal?.aborted === true` 那一行） |

复现方式（示例，M3）：

```bash
$ python3 - <<'PY'
p="src/runs/remote-recover.ts"; s=open(p).read()
s=s.replace("const settledAlready = alreadySettled && orphan === undefined && graded;","const settledAlready = alreadySettled;")
open(p,"w").write(s)
PY
$ env -u PI_SUBAGENT_ROLE -u PI_SUBAGENT_CHILD -u PI_LEGION_DB -u PI_LEGION_NODE_ID -u HC_TERMINAL_SOCKET -u HC_TERMINAL_ID \
    node --experimental-strip-types --test test/integration/recover-cross-machine.test.ts | grep '✖'
✖ 6.2.4 D2: a row 6.2.3 stamped `aborted (session-shutdown)` — terminal, no recorded verdict — is fetched, not refused
✖ 6.2.4 D2: hygiene converged an orphaned row to `failed` — the result is STILL fetched, not written off
```

---

## 6. 门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | pass（0 error） |
| `npm test`（unit，全部 `test/unit/*.test.ts`） | **2680 pass / 0 fail**（新文件 `test/unit/orphan-on-shutdown.test.ts` 13 条；基线同仓 2667） |
| `npm run test:integration` | **191 pass / 0 fail**（`recover-cross-machine.test.ts` 6 → 11，新增 5 条） |
| 6.2.3 回归（SIGKILL 路径、fan-out、recover 幂等） | 原有用例全绿，见上两行的总数 |

新增/修改的测试：

- `test/unit/orphan-on-shutdown.test.ts`（新）：三态判定、标记读取与「被后来的 settle 取代」、
  `markSessionInterrupted` 跳过跨机节点、runtime 释放（落记录 / 取消 collect / 移出 job 表 /
  不动本地 job）、status dead 块 host+terminal+orphaned、`/legion status` 的 fate 渲染。
- `test/integration/recover-cross-machine.test.ts`：真 `Orchestrator.retire` 的两种 fate（orphaned
  /unfetched，且**不调** `supervisor.retire`）、`recover` 对 orphaned 行的 fetch + 二次零 fetch、
  6.2.3 遗留行（terminal 无判词）的 fetch、hygiene 收敛行（failed + marker）的 fetch。

---

## 7. 已知边界与说明

1. **`/legion status` 的 slash 块无法由 `pi -p` 执行**（`pi --print` 不跑 slash 命令，6.2.3 报告
   §3.3 同口径）。该块的数据源与 `recover` 的发现函数是同一个（`listUnsettledRemoteNodes` /
   `listRecoverableLeftovers`），本 patch 让行保持 open，因此它照旧列出；fate 的渲染由
   `test/unit/orphan-on-shutdown.test.ts` 的 `/legion status: a leftover the exit kept open is
   listed, and the fate is named` 钉住。
2. **`unfetched` 是新语义**：仓内原先没有这个状态（只有一句 `not fetched: …` 文本）。它用
   `TaskState` + `orphan_detected.fate` 表达，事件类型仍在闭集 16 条内；「**已终态但未取回**」的
   判定只读两个本地事实（已有判词、或本机 mirror 已能判出终态），不触网。
3. **跨机 child 在 `session-shutdown` 时不再被 kill**（这是 D2 修法的前提）：如果保留 kill，远端
   根本不会有「后来的真实结果」可恢复。需要真停的场合走 `stop`/`abort`，它们仍然 kill 并且仍然把
   执行记为 `aborted`。
4. **6.2.3 的老遗留行现在也能被取回**（有 reason、无 `execution` 的 terminal 行 ⇒ 允许 fetch）。
   这是行为变化（improvement），报告在此显式声明；`already settled` 的幂等语义对**记过判词**的行
   不变（有测试与真机 `zero fetch` 证据）。
5. 退出时 `orphan_detected` 只写一次（`orphanOnShutdown` 幂等），重复 shutdown 不会重复盖章。
