# 发布验证报告 — pi-legion 6.2.4（重点：父进程**自然退出**后，跨机 child 可被全新进程恢复）

- 仓库 / 分支：`pi-legion` `chore/verify-624`，基线 `a330da9`（= `release: 6.2.4`）
- 验证对象：**npm 上装好的 6.2.4**（不是分支）。两端的
  `~/.pi/agent/npm/node_modules/pi-legion/package.json` 都是 `"version": "6.2.4"`，
  且与发布提交 `a330da9` **逐字节一致**：

  ```bash
  $ cd ~/code/pi-legion-wt/verify-624 && git rev-parse --short=8 HEAD
  a330da9c
  $ diff -rq src ~/.pi/agent/npm/node_modules/pi-legion/src; echo "src diff exit=$?"
  src diff exit=0
  $ diff -q index.ts ~/.pi/agent/npm/node_modules/pi-legion/index.ts; echo "index.ts diff exit=$?"
  index.ts diff exit=0
  $ grep '"version"' ~/.pi/agent/npm/node_modules/pi-legion/package.json | head -1
    "version": "6.2.4",
  ```

- 验证方式：**真进程 `pi -p -a`**（不是只读源码、不是单测替身），每一步贴命令原文 + 输出原文
- 本提交**只新增本报告**，未改动任何产品代码；未跑全量 e2e

一句话结论：

> **三条全 PASS**。父进程 `pi -p` **自然退出**（`EXIT=0`，`19.646s`，远早于 child 的 `sleep 30`）；
> child 在 ledger 里是 **`orphaned`**（不是 6.2.3 的 `aborted (session-shutdown)`），远端进程**没被 kill**，
> 自行跑完并写下结果；全新进程 `status` 看到 **`state=orphaned` + `host=hw-nj` + `terminal=hw-nj/lgl-v624-a`（D3）**；
> `recover` 取回 **10/10 行**转录（含 child 最终 assistant 文本与其 JSON 判词）并落定
> **`execution: success` / `acceptance: accepted (attested)`**；二次 `recover` **`already settled` 且零 fetch**
> （marker 探针证明：远端会话被加到 11 行，recover 仍只吐出 10 行且本机 mirror 的 md5/mtime 一字未动）；
> 反向检查里**正常完成**的跨机 child 判 **`success`/`accepted`**（不是 `orphaned`/`failed`），`pi -p` **自行退出**
> （`42.934s`，`EXIT=0`，无 kill、无 timeout）。

---

## 0. 环境与两处必须说明的偏离

### 0.1 机器边界：hc 的 `--via` 通道 + 容器 = 第二台机器（与 6.2.3 报告同口径）

本机 `hc` **一台机器都不认识**，也没有到真 `hw-nj` 的通路：

```bash
$ hc machine ls --json
{"machines":[]}
```

所以「远端机器」按仓库自带跨机自测台的同一手法造：容器 `v624-hw-nj`（image `pi-legion-xm:latest`）
+ hc 的 `--via 'docker exec -i v624-hw-nj sh -c'` 注册成机器 `hw-nj`。

```bash
$ docker exec v624-hw-nj sh -lc 'pi --version; grep "\"version\"" /root/.pi/agent/npm/node_modules/pi-legion/package.json | head -1; node -v; jq --version'
1.5.2
  "version": "6.2.4",
v24.22.0
jq-1.6

$ hc machine add --temp --name hw-nj --via 'docker exec -i v624-hw-nj sh -c' --install --json
docker exec -i v624-hw-nj sh -c now has hc 0.1.21
{"host":"d1f0d1c01b49","id":"a2e557fa5b7bf0b17c58cdaf9c278e19","name":"hw-nj","state":"connected",
 "target":"docker exec -i v624-hw-nj sh -c","temporary":true,"version":"0.1.21","via":true}

$ hc exec --on hw-nj -- sh -c 'cd /root/work && timeout 120 pi -p --provider any-endpoint --model workbuddy/deepseek-v4.1-flash "Reply with exactly: ok"'
ok
```

父机（本会话所在的 `hc` 终端 `t7g`，`HC_TERMINAL_ID=t7g`，`host:` 派发需要它）。
两端的运行时（`piCli` / `piLegionRoot` / `node` / provider 扩展）都按 `settings.json` 的
`subagents.crossMachine.hosts.hw-nj` 原样解析到实际文件：

```bash
$ hc exec --on hw-nj -- sh -c 'ls -d /home/zzjcool/.local/share/mise/installs/node/latest/bin/node \
    /home/zzjcool/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
    /home/zzjcool/.pi/agent/npm/node_modules/pi-legion \
    /home/zzjcool/.pi/agent/npm/node_modules/pi-any-endpoint/extensions/index.ts'
/home/zzjcool/.local/share/mise/installs/node/latest/bin/node
/home/zzjcool/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
/home/zzjcool/.pi/agent/npm/node_modules/pi-legion
/home/zzjcool/.pi/agent/npm/node_modules/pi-any-endpoint/extensions/index.ts
```

交付预检要求两端 `origin` 归一化后同名，所以照自测台的做法在两端的**同一路径**上挂同一个 bare origin：

```bash
# 父机：/tmp/v624-git/app.git（bare），父机 checkout /tmp/v624-parent，origin=/tmp/v624-git/app.git
# 远端：同路径挂载到容器里（-v /tmp/v624-git:/tmp/v624-git），checkout /root/work，origin 相同
$ git -C /tmp/v624-parent remote get-url origin      → /tmp/v624-git/app.git
$ hc exec --on hw-nj -- git -C /root/work remote get-url origin → /tmp/v624-git/app.git
```

**偏离的边界（请按这个口径读结论）：**

| 覆盖到 | 没覆盖到 |
|---|---|
| 真 `pi -p` 父进程（自然退出）、真 hc machine 传输（`machine.exec` / `file.read` / `terminal.*`）、真远端 pi 进程、真远端 worktree 与会话文件、真角色策略与模型 | 第二台**物理**主机（ssh 传输本身）；真 `hw-nj` 上「装的包不一样」这类差异 |

### 0.2 偏离：父会话必须是一个 git checkout（任务书写的是 `cd /tmp`）

第一次完全照任务书在 `/tmp` 里跑，6.2.4 **按设计拒绝**（这不是缺陷，是它自带的、可自修的拒绝）：

```bash
$ cd /tmp && { time pi -p -a "$(cat /tmp/v624-prompt-A.txt)"; echo "EXIT=$?"; } 2>&1 | tee /tmp/v624-logs/A.log
✗ centurion: INVALID_PARAMS: cross-machine delivery needs a git checkout on this machine too, and the directory it delivers from (/tmp) is not one. Two ways out: 1) run the launch from a checkout — start pi inside yours, or pass a relative cwd that points at one plus hostCwd for the directory ON that machine: subagent({ agent: "centurion", host: "hw-nj", cwd: "../my-repo", hostCwd: "/abs/path/on/hw-nj", task: "..." }); 2) dispatch the centurion instead and let IT create the worker on 'hw-nj' — a role outside subagents.crossMachine.allowRoles cannot be dispatched from this session at all (the default list is ["centurion"]), while a scout or a worker is created ON that machine by the centurion running there.

real	0m11.451s
EXIT=0
```

**注意这次调用里是带 `worktree: false` 的**（父会话转录可查：
`{"agent":"centurion","host":"hw-nj","hostCwd":"/root/work","worktree":false,"name":"v624-a",...}`），
仍然要求 checkout —— 即 **centurion 的 worktree 交付在跨机时不受 `worktree: false` 影响**
（`orchestrator.ts` 里 centurion 分支的 `worktree = this.legion ? true : …`）。这是一条值得写进
release note 的事实，不是本次缺陷。

随后采用**它自己给的第一条出路**：父进程仍 `cd /tmp`，launch 传 `cwd: "v624-parent"` +
`hostCwd: "/root/work"`（`/tmp/v624-parent` 与 `/root/work` 是同一个 bare origin 的两个 checkout）。
本文 §1～§3 的全部数据都来自这一配置。

---

## 1. 第一步：launch → 立即结束回合 → 父进程**自然退出**（EXIT=0，19.646s）

### 1.1 prompt（`/tmp/v624-prompt-A.txt`，原文）

```
立即调用一次 subagent 工具，参数完全如下（禁止修改参数，禁止先做调研，禁止追加第二次调用）：

agent: "centurion"
host: "hw-nj"
cwd: "v624-parent"
hostCwd: "/root/work"
name: "v624-a"
task: "只做一件事：用 bash 工具跑 `sleep 30`（前台等它结束），然后把 hostname、pwd 与当前时间（date -Is）写进 /tmp/v624-child.txt，cat 出来，最后回一句 done。不要改任何仓库文件、不要开子 agent。"

调用返回后，把返回值原文一字不改地抄出来（包括任何以 ⚠ 开头的警告行）。然后立即结束回合：
不要 wait、不要 collect、不要 sleep、不要再调用任何工具。
```

### 1.2 命令与输出（`/tmp/v624-logs/step1.log`）

```bash
$ cd /tmp && date -Is && { time timeout 240 pi -p -a "$(cat /tmp/v624-prompt-A.txt)"; echo "EXIT=$?"; } 2>&1 | tee /tmp/v624-logs/step1.log
2026-11-19T03:38:46+00:00
```

````
返回值原文如下：

```
▶ v624-a (centurion) supervisor=terminal
↳ async: a completion message is queued when each child finishes. It wakes this session when idle; otherwise it is delivered after the current turn. Use wait or collect for results. Do not tell children to message the parent.
```

本次操作已结束。

real	0m19.646s
user	0m2.122s
sys	0m0.556s
EXIT=0
````

```
2026-11-19T03:39:06+00:00
```

- **`EXIT=0`**，`real 19.646s` ≪ child 的 `sleep 30`；`timeout 240` 只是外壳，**没有触发**（触发会是 124）
- 父进程是**自己走完回合退出的**（`pi -p` 的 print 模式回合结束即退），没有 `kill`、没有 `timeout`
- 启动的 child 名：**`v624-a`**，`supervisor=terminal`

### 1.3 退出**之后**：远端还在跑，ledger 记的是 `orphaned`（不是 `aborted`）

父进程退出后 5 秒（本地时间 03:39:11，child 于 03:39:02 起跑）：

```bash
$ hc get hw-nj/lgl-v624-a      # 远端终端：live / working（节选）
{"address":"hw-nj/t1","cwd":"/root/.pi-worktrees/v624-a","state":"live","status":{"app":"pi","state":"working"},
 "foreground":{"argv":["pi"],"cwd":"/root/.pi-worktrees/v624-a","pid":1809},"pid":1809,"turn":0,
 "labels":{"legion.host":"hw-nj","legion.role":"centurion"},"name":"lgl-v624-a"}

$ docker exec v624-hw-nj sh -lc 'ps aux | grep "[s]leep 30"; ls -l /tmp/v624-child.txt'
root        1872 … /bin/bash -c sleep 30; echo "slept ok"
root        1873 … sleep 30
ls: cannot access '/tmp/v624-child.txt': No such file or directory
```

run.json（`/tmp/.pi-subagents/runs/r-a7f86909/run.json`，节选）——**父进程退出后 0.3s 写的标记**：

```json
{
 "runId": "r-a7f86909",
 "cwd": "/tmp",
 "children": [{
   "name": "v624-a", "nodeId": "root.v624-a", "agent": "centurion", "kind": "pi",
   "state": "orphaned",
   "host": "hw-nj",
   "spawnMode": "terminal",
   "worktreePath": "/root/.pi-worktrees/v624-a",
   "worktreeBranch": "pi-subagent/hw-nj/v624-a-4ab8ef20",
   "worktreeHost": "hw-nj",
   "remoteDir": "/root/.pi-subagents-mirror/no-run/v624-a",
   "remoteTerminal": "hw-nj/lgl-v624-a",
   "orphaned": {
     "at": 1795059546294, "fate": "orphaned", "reason": "session-shutdown",
     "host": "hw-nj",
     "remoteDir": "/root/.pi-subagents-mirror/no-run/v624-a",
     "remoteTerminal": "hw-nj/lgl-v624-a",
     "remoteSessionPath": "/root/.pi-subagents-mirror/no-run/v624-a/session.jsonl",
     "sessionFile": "/tmp/.pi-subagents/runs/r-a831c057/v624-a.jsonl"
   }
 }]
}
```

`orphaned.at = 1795059546294` = **03:39:06.294**，与父进程退出时刻（03:39:06）一致；
这里**没有 `retiredAt`、没有 `execution`** —— 6.2.3 会在同一时刻写 `aborted (session-shutdown)`
（对照：`docs/reports/release-6.2.3-verification.md` §1.1 与 `docs/reports/orphan-on-natural-exit.md` §4.3）。
远端进程**没有被杀**（`sleep 30` 还活着），也**没有被等待**（父进程 19.6s 就退了）。

child 在父进程死后**自己跑完了**：

```bash
$ docker exec v624-hw-nj cat /tmp/v624-child.txt      # 03:39:40 写出
hostname: d1f0d1c01b49
pwd: /root/.pi-worktrees/v624-a
time: 2026-11-19T03:39:40+00:00

$ hc get hw-nj/lgl-v624-a                             # turn 1 / done
{"state":"live","exit_code":null,"pid":1809,"status":{"app":"pi","state":"done"},"turn":1,"reason":null}
```

> 说明：`d1f0d1c01b49` 是本次取证环境对容器 hostname 的脱敏占位符（文件里的真实值就是容器
> `/etc/hostname` 的内容），下文出现同一占位符处含义相同。

---

## 2. 第二步：全新进程恢复（status → recover → recover）

### 2.1 prompt（`/tmp/v624-prompt-B.txt`，原文）

```
严格按顺序做，每步之间不要做别的事，把每步返回的原文完整贴出（禁止截断、禁止改写、禁止总结）：

第一步：调用一次 subagent({action:"status"})，贴出返回原文。

第二步：调用一次 subagent({action:"status", all:true})，贴出返回原文。

第三步：调用一次 subagent({action:"recover", name:"v624-a"})，贴出返回原文（含 read-back 行与转录）。

第四步：再调用一次 subagent({action:"recover", name:"v624-a"})，贴出返回原文，并用一句话说明这次是 settled-now 还是 already settled、有没有从远端重新取回内容。

然后结束回合。
```

### 2.2 命令与退出

```bash
$ cd /tmp && { time timeout 300 pi -p -a "$(cat /tmp/v624-prompt-B.txt)"; echo "EXIT=$?"; } > /tmp/v624-logs/step2.log 2>&1
2026-11-19T03:40:05+00:00   →   2026-11-19T03:40:31+00:00

real	0m25.799s
EXIT=0
```

（`pi -p` 只把**最后一条** assistant 消息打到 stdout，所以下面四步的返回原文是从这个新进程的
session JSONL `/root/.pi/agent/sessions/--tmp--/2026-11-19T03-40-05-774Z_01a1f1e3-….jsonl` 的
`toolResult` 里逐字取出的，未做改写。）

### 2.3 第 1/2 步：`status` 看得到它，且带 host + 远端终端（D3 PASS）

```
No live children.
(1 dead)

v624-a — state=orphaned agent=centurion kind=pi
owner: dead (pid gone)
host=hw-nj
terminal=hw-nj/lgl-v624-a
supervisor=terminal
session=/tmp/.pi-subagents/runs/r-a831c057/v624-a.jsonl
```

`status`（无参）与 `status all:true` 的输出**逐字相同**。三行关键值都在：
`state=orphaned`（没有被改写成 `failed`）、`host=hw-nj`、`terminal=hw-nj/lgl-v624-a`。

### 2.4 第 3 步：`recover` 取回 transcript 并落定

```
recover: 'v624-a' is over on 'hw-nj' (terminal 'hw-nj/lgl-v624-a' is done); settled node root.v624-a as settled — recovered from host 'hw-nj': execution success, 1 turn(s), read-back 10 of 10 lines, terminal live
── v624-a ──
execution: success
acceptance: accepted (attested)
read-back from host 'hw-nj': 10 of 10 lines (complete)
done

- `sleep 30` 前台跑完
- 写入并 cat 了 `/tmp/v624-child.txt`：
  - hostname: d1f0d1c01b49
  - pwd: /root/.pi-worktrees/v624-a
  - time: 2026-11-19T03:39:40+00:00

未改任何仓库文件，未开子 agent。注意：本次没有代码改动，因此没有需要提交/推送的内容（工作区保持原样）。

```json
{"ok": true, "reason": "Ran sleep 30 in foreground, writing hostname/pwd/date to /tmp/v624-child.txt and cat'ed it. No repo files changed, no subagents spawned; nothing to commit or push for this no-op task (branch pi-subagent/hw-nj/v624-a-4ab8ef20 untouched)."}
```
```

- `read-back 10 of 10 lines (complete)`：行数 > 0 **且完整**
- 转录里含 child 的**最终 assistant 文本**与它自己的 **JSON 判词**（= 不是 launch 时的 5 行快照）
- 判词：**`execution: success` / `acceptance: accepted (attested)`**，`1 turn(s)`
- 落定时刻：ledger 记 `2026-11-19T03:40:20.716Z`；run.json 同步收敛为
  `state:"retired"`, `retiredAt:"2026-11-19T03:40:20.764Z"`，**`orphaned` 块消失**

```bash
$ node -e 'const c=require("/tmp/.pi-subagents/runs/r-a7f86909/run.json").children[0];
  console.log(JSON.stringify({state:c.state,host:c.host,remoteTerminal:c.remoteTerminal,retiredAt:c.retiredAt,orphaned:c.orphaned},null,1))'
{
 "state": "retired",
 "host": "hw-nj",
 "remoteTerminal": "hw-nj/lgl-v624-a",
 "retiredAt": "2026-11-19T03:40:20.764Z"
}
```

### 2.5 第 4 步：二次 `recover` = `already settled`

```
recover: 'v624-a' is already settled (settled) — nothing was written and nothing was fetched; this is the outcome the ledger recorded at 2026-11-19T03:40:20.716Z.
── v624-a ──
execution: success
acceptance: accepted (attested)
read-back from host 'hw-nj': 10 of 10 lines (complete)
done
…（以下转录与 2.4 逐字相同）
```

### 2.6 「零 fetch」的物理证据（含一个决定性探针）

先说清楚**该看哪个文件**：跨机 child 的取回内容落在
`<run>/remote/<name>.jsonl`（本机 mirror），而 `run.json` 里 `sessionFile` 指的那个
`<run>/<name>.jsonl` 全程是 0 字节 —— 只盯后者会看错结论（本次实测到的取证要点）。

```bash
# ① recover 之前的基线（本机 mirror 是 0 字节，从来没有取回过东西）
$ ls -l /tmp/.pi-subagents/runs/r-a831c057/v624-a.jsonl
-rw------- 1 root root 0 … /tmp/.pi-subagents/runs/r-a831c057/v624-a.jsonl

# ② 第 3 步 recover 取回之后（这时才出现 mirror）
$ stat -c '%n size=%s mtime=%y' /tmp/.pi-subagents/runs/r-a7f86909/remote/v624-a.jsonl
/tmp/.pi-subagents/runs/r-a7f86909/remote/v624-a.jsonl size=46336 mtime=2026-11-19 03:40:20.747444150 +0000
$ md5sum /tmp/.pi-subagents/runs/r-a7f86909/remote/v624-a.jsonl ; wc -l < …/remote/v624-a.jsonl
f62e63a3b15973b884c1a41884c3e870  /tmp/.pi-subagents/runs/r-a7f86909/remote/v624-a.jsonl
10
$ hc exec --on hw-nj -- sh -c 'wc -l /root/.pi-subagents-mirror/no-run/v624-a/session.jsonl; md5sum /root/.pi-subagents-mirror/no-run/v624-a/session.jsonl'
10 /root/.pi-subagents-mirror/no-run/v624-a/session.jsonl
f62e63a3b15973b884c1a41884c3e870  /root/.pi-subagents-mirror/no-run/v624-a/session.jsonl
```

镜像文件可能因 `settled-now` 被顺手写一次，所以「mtime 未变」单独用来说二次 recover 零 fetch **不够硬**。
用一个**决定性探针**：在**远端**会话文件尾部追加一条**合法的**第 11 行（带 marker），然后再跑一次
全新的 `recover` —— 若它真的又去 fetch，行数会变 11、marker 会出现在转录里：

```bash
# 远端：10 → 11 行（合法 JSONL，含 MARKER）
$ hc exec -i --on hw-nj -- sh -c 'cat >> /root/.pi-subagents-mirror/no-run/v624-a/session.jsonl' < /tmp/v624-probe-line.jsonl
$ hc exec --on hw-nj -- sh -c 'wc -l …/session.jsonl; md5sum …/session.jsonl; tail -1 …/session.jsonl'
11 /root/.pi-subagents-mirror/no-run/v624-a/session.jsonl
414d4099a438ea59aa0dd4d226e4cd90  /root/.pi-subagents-mirror/no-run/v624-a/session.jsonl
{"type":"message","id":"ffff0011","parentId":"85e306bb","timestamp":"2026-11-19T03:45:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"MARKER-11-FETCH-PROBE"}]}}

# 全新进程，只做一次 recover
$ cd /tmp && { time timeout 200 pi -p -a '只调用一次 subagent({action:"recover", name:"v624-a"})，把返回原文完整贴出，不要做别的事、不要总结。' ; echo "EXIT=$?"; } 2>&1 | tee /tmp/v624-logs/step2b-zero-fetch.log
2026-11-19T03:42:14+00:00
recover: 'v624-a' is already settled (settled) — nothing was written and nothing was fetched; this is the outcome the ledger recorded at 2026-11-19T03:40:20.716Z.
── v624-a ──
execution: success
acceptance: accepted (attested)
read-back from host 'hw-nj': 10 of 10 lines (complete)
…（转录与 2.4 逐字相同，**没有** MARKER-11-FETCH-PROBE）
real	0m9.794s
EXIT=0
2026-11-19T03:42:24+00:00

# 本机 mirror：md5 / mtime / 行数一字未变
$ stat -c '%n size=%s mtime=%y' /tmp/.pi-subagents/runs/r-a7f86909/remote/v624-a.jsonl
/tmp/.pi-subagents/runs/r-a7f86909/remote/v624-a.jsonl size=46336 mtime=2026-11-19 03:40:20.747444150 +0000
$ md5sum …/remote/v624-a.jsonl ; wc -l < …/remote/v624-a.jsonl
f62e63a3b15973b884c1a41884c3e870  …
10
$ ls /root/.pi/agent/sessions/--tmp--/2026-11-19T03-42-14*.jsonl
/root/.pi/agent/sessions/--tmp--/2026-11-19T03-42-14-948Z_01a1f1e5-d9a3-76bc-8dd5-1c76bbf7b831.jsonl
$ grep -c "MARKER-11-FETCH-PROBE" /root/.pi/agent/sessions/--tmp--/2026-11-19T03-42-14*.jsonl; echo "grep exit=$?"
0
grep exit=1
```

远端有 11 行、`recover` 仍然只吐出 10 行且没有 marker、本机 mirror 的 md5/mtime/行数全未变
⇒ **二次 `already settled` 真的零 fetch，转录是账本回放**，不是又拉了一遍。

探针之后把远端 fixture 复原（`head -10` → md5 回到 `f62e63a3…`，10 行）。

---

## 3. 第三步：反向检查 —— 正常完成的跨机 launch 必须判 `success`/`accepted`

### 3.1 prompt（`/tmp/v624-prompt-C.txt`，原文）

```
立即调用一次 subagent 工具，参数完全如下（禁止修改参数，禁止先做调研，禁止追加第二次调用）：

agent: "centurion"
host: "hw-nj"
cwd: "v624-parent"
hostCwd: "/root/work"
name: "v624-c"
task: "只做一件事：用 bash 工具跑 `sleep 5`（前台等它结束），然后把 hostname、pwd 与当前时间（date -Is）写进 /tmp/v624-child-c.txt，cat 出来，最后回一句 done。不要改任何仓库文件、不要开子 agent。"

调用返回后，用 subagent({action:"wait", name:"v624-c", timeoutMs:300000}) 等它结束，把 wait 返回原文一字不改地抄出来，然后结束回合。
```

### 3.2 命令、耗时与判词

```bash
$ cd /tmp && { time timeout 400 pi -p -a "$(cat /tmp/v624-prompt-C.txt)"; echo "EXIT=$?"; } > /tmp/v624-logs/step3.log 2>&1
2026-11-19T03:42:35+00:00  →  2026-11-19T03:43:18+00:00
```

````
── v624-c ──
execution: success
acceptance: accepted (attested)
read-back from host 'hw-nj': 16 of 16 lines (complete)
unverified criteria — these gate the verdict:
  [ ] legion-team-delivery: 完成子树阶段验证、收齐成员结果，并提供上级可审查的 squash MR/PR URL
完成：

- `sleep 5` 已在前台跑完。
- `/tmp/v624-child-c.txt` 已写入 3 行（hostname / pwd / `date -Is`）并已 `cat` 出来：
  - hostname: `d1f0d1c01b49`
  - pwd: `/root/.pi-worktrees/v624-c`
  - time: `2026-11-19T03:42:57+00:00`
- 未改任何仓库文件（`git status --porcelain` 为空），未开任何子 agent。
- 交付分支：`pi-subagent/hw-nj/v624-c-59003173` @ `31c4a32`（无新提交，因无文件变更）；已推送至 `origin`（`/tmp/v624-git/app.git`），并设置 upstream。远端为本地裸仓库、非托管平台，故无 MR/PR URL（也无需，因无改动）。

done

```json
{"ok": true, "reason": "sleep 5 ran in foreground; wrote hostname/pwd/date -Is to /tmp/v624-child-c.txt (3 lines) and catted it; no repo files changed (clean git status), no subagents; branch pi-subagent/hw-nj/v624-c-59003173 at 31c4a32 pushed to origin with upstream set; no MR because remote is a local bare path, not a hosting service"}
```
full text: legion_output({ name: "v624-c", round: 1 })
1 done, 0 still running

real	0m42.934s
user	0m2.713s
sys	0m0.632s
EXIT=0
````

- 判词 **`execution: success` / `acceptance: accepted (attested)`** —— 不是 `orphaned`，也不是 `failed`
- `pi -p` **自行退出**：`42.934s`、`EXIT=0`；`timeout 400` 没触发，**没有任何 kill**
- 远端真的跑了并写了文件（`/tmp/v624-child-c.txt`，03:42:57），分支 `pi-subagent/hw-nj/v624-c-59003173`
  推到了共享 bare origin

### 3.3 run.json：`retired` + 有判词，**没有** `orphaned`

```bash
$ node -e '…读 /tmp/.pi-subagents/runs/r-438d7a23/run.json 的 v624-c…'
{
 "run": "r-438d7a23",
 "name": "v624-c",
 "state": "retired",
 "host": "hw-nj",
 "remoteTerminal": "hw-nj/lgl-v624-c",
 "worktreePath": "/root/.pi-worktrees/v624-c",
 "worktreeBranch": "pi-subagent/hw-nj/v624-c-59003173",
 "retiredAt": "2026-11-19T03:43:13.457Z",
 "execution": { "status": "success", "stopReason": "stop", "turns": 1, "toolErrors": 0, … },
 "acceptance": { "status": "accepted", "level": "attested", "reason": "sleep 5 ran in foreground; …" }
}
```

（对比 §1.3 的 `state:"orphaned"` + 无 `retiredAt`/`execution`：两条路径分得干干净净，
正常完成**没有**被误判成 orphaned。）

---

## 4. 结论

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 父 `pi -p` **自然退出**，`EXIT=0`，耗时明显小于 child 的 30s | **PASS** | `real 19.646s`、`EXIT=0`，`timeout 240` 未触发（§1.2） |
| 2 | 退出后 child 记 **`orphaned`**（不是 `aborted`） | **PASS** | run.json `state:"orphaned"`，`orphaned.reason:"session-shutdown"`，无 `retiredAt`/`execution`（§1.3） |
| 3 | 退出后远端 child **仍在跑**，没被 kill、也没被等待 | **PASS** | `sleep 30` pid 1873 仍活；03:39:40 自行写出 `/tmp/v624-child.txt`，turn 1 `done`（§1.3） |
| 4 | 全新进程 `status` 看得到，`state=orphaned` + **host** + **远端终端**（D3） | **PASS** | `host=hw-nj` / `terminal=hw-nj/lgl-v624-a`（§2.3） |
| 5 | `recover` 拿到 transcript（行数 > 0，含 child 最终 assistant 文本） | **PASS** | `read-back 10 of 10 lines (complete)` + 最终文本与 JSON 判词（§2.4） |
| 6 | `recover` 落定 `success` / `accepted` | **PASS** | `execution: success` / `acceptance: accepted (attested)`（§2.4） |
| 7 | 二次 `recover` = `already settled` | **PASS** | 原文 `already settled (settled)`（§2.5） |
| 8 | 二次 `recover` **零 fetch** | **PASS（决定性探针）** | 远端 11 行有 marker，recover 仍 10/10、无 marker，本机 mirror md5/mtime/行数未变（§2.6） |
| 9 | 正常完成的跨机 launch 判 `success`/`accepted`（不是 orphaned/failed） | **PASS** | §3.2 判词 + run.json `state:"retired"`、无 `orphaned`（§3.3） |
| 10 | 正常完成时 `pi -p` 自行退出，无需 kill | **PASS** | `real 42.934s`、`EXIT=0`、`1 done, 0 still running`（§3.2） |

**没有 FAIL 项，也没有发现 6.2.4 的回归。**

---

## 5. 边界与观察（记录，不归因）

1. **父会话必须在 git checkout 里**（§0.2）：`cd /tmp` 直跑会被 `INVALID_PARAMS` 拒绝，且即使传
   `worktree: false` 也一样 —— 跨机 centurion 的交付始终是 worktree 交付。拒绝文案自带两条出路，
   本次用第一条（相对 `cwd` + `hostCwd`）。任务书里的 `cd /tmp` 因此**必须**加上这一条才能成立。
2. **零 fetch 该看 `<run>/remote/<name>.jsonl`**，不是 `run.json` 的 `sessionFile`（后者全程 0 字节，§2.6）。
3. **`acceptance: accepted (attested)`** 的含义是「以 child 自报的 JSON 判词 + 完整读回为准」；
   centurion 的 `legion-team-delivery`（squash MR URL）在本 fixture 里**始终 unverified**
   （本次 child 是单 turn 的 no-op，没有任何代码改动，也没有托管平台）——这是 fixture 的性质，
   不是 6.2.4 的行为差异；步骤 1 与步骤 3 的判词口径因此完全一致。
4. 机器 `hw-nj` 的 `host` id 是容器 id 前缀（镜像里没有 `hostname` 二进制），不影响任何判词。
5. 未覆盖：真第二台**物理**主机（ssh 传输本体）、真 `hw-nj` 上的包差异、TUI 内的 `/legion status`
   渲染（§3.4 那条只读了代码路径，未在本次真进程里点开）。

---

## 6. 复现（最小步骤）

```bash
# 0) 机器边界：容器 = 第二台机器，两端同一个 bare origin（同一绝对路径）
docker run -d --name v624-hw-nj -v /tmp/v624-git:/tmp/v624-git pi-legion-xm:latest sleep infinity
tar -C ~/.pi/agent -cf - install npm bin auth.json models.json models-store.json settings.json agents \
  | docker exec -i v624-hw-nj tar -C /root/.pi/agent -xf -
docker exec v624-hw-nj sh -lc 'apt-get install -y -qq jq; ln -sf /root/.pi/agent/bin/pi /usr/local/bin/pi'
docker exec -w /root v624-hw-nj sh -lc 'ln -sfn /root /home/zzjcool; git clone -q /tmp/v624-git/app.git /root/work'
# 父机 checkout：git clone /tmp/v624-git/app.git /tmp/v624-parent（两端 origin 同名才能过交付预检）
hc machine add --temp --name hw-nj --via 'docker exec -i v624-hw-nj sh -c' --install --json

# 1) launch → 立即结束回合 → 父进程自然退出
cd /tmp && { time timeout 240 pi -p -a "$(cat /tmp/v624-prompt-A.txt)"; echo "EXIT=$?"; }

# 2) 全新进程：status ×2 → recover ×2
cd /tmp && { time timeout 300 pi -p -a "$(cat /tmp/v624-prompt-B.txt)"; echo "EXIT=$?"; }

# 2b) 零 fetch 的决定性探针（远端 10 行 → 11 行带 marker，再 recover 一次）
hc exec -i --on hw-nj -- sh -c 'cat >> /root/.pi-subagents-mirror/no-run/<name>/session.jsonl' < /tmp/v624-probe-line.jsonl
cd /tmp && time pi -p -a '只调用一次 subagent({action:"recover", name:"v624-a"})，把返回原文完整贴出。'

# 3) 反向检查：正常完成必须判 success/accepted，且 pi 自行退出
cd /tmp && { time timeout 400 pi -p -a "$(cat /tmp/v624-prompt-C.txt)"; echo "EXIT=$?"; }
```

三个 prompt 的全文分别在 §1.1、§2.1、§3.1；fixture 脚本与全部日志在
`/tmp/v624-setup.sh`、`/tmp/v624-logs/{A,setup2,step1,step2,step2b-zero-fetch,step3}.log`、
`/tmp/v624-logs/{step2,step3}.time`（单次验证的临时目录，不入库）。

---

## 7. 范围声明

- 本次验证**只新增本报告**，未改动任何产品代码（`git status` 只有这一个新文件）
- 未跑全量 e2e；未改 `settings.json`（`subagents.crossMachine.enabled` 本来已是 `true`，
  `hosts.hw-nj` 原样使用）
- fixture 侧的唯一「侵入」是 §2.6 的 marker 探针：写远端会话文件第 11 行，验证后立即复原
  （md5 回到 `f62e63a3…`，10 行）
