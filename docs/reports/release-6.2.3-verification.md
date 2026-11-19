# 发布验证报告 — pi-legion 6.2.3（真进程实跑，重点 D / E）

- 仓库 / 分支：`pi-legion` `chore/verify-623`，基线 `0813b35`（= 6.2.3）
- 验证对象：**已安装的 6.2.3**（父机 `~/.pi/agent/npm/node_modules/pi-legion/package.json` = `6.2.3`，
  目标机同一份 = `6.2.3`；两侧 `pi --version` = `1.5.2`）
- 验证方式：**真进程 `pi -p -a`**（不是只读源码、不是单测替身）；D 与 E 各自可粘贴的命令 + 原文输出
- 本提交**只新增本报告**，未改动任何产品代码
- PR：<https://github.com/zzjcool/pi-legion/pull/402>

一句话结论：

> **D PASS**（父进程被硬杀后，全新进程 `recover` 拿到 16/16 行转录并落定为 `success`，二次调用
> `already settled` 且零 fetch）；**E PASS 2/2**（跨机 centurion 判词 `execution: success` /
> `acceptance: accepted (attested)`，`pi -p` 自己退出 **25.293s / 25.159s**，`EXIT=0`，无 `failed`、
> 无残留 `hc connect`）。同时实测到两条**新的边界事实**（§3.1、§3.2）：`crossMachine.enabled` 未显式
> 写 `true` 时 launch 能跑而 collect 拒读；父进程“自然退出”会把仍在跑的跨机 child 记成
> `aborted (session-shutdown)`，而远端进程继续跑完——该情形 `recover` 按已落定行返回 5/5 的陈旧快照。

---

## 0. 环境与两处必须说明的偏离

### 0.1 目标机是容器，但传输是真的（与 6.2.2 报告同口径）

任务书写的是「三台真机、你在 hw-nj 上跑」。实际落地：

```
$ hostname
hw
$ hc machine ls --json
{"machines":[]}
$ ls ~/.ssh/config
ls: cannot access '/home/zzjcool/.ssh/config': No such file or directory
```

本机（`hw`）的 hc core **一台机器都不认识**，也没有到 `hw-nj` 的通路，所以从本机不可能直接派发到
真 `hw-nj`。为了仍然使用**真的机器边界 + 真的 hc machine 传输 + 真的远端 pi 进程**，用 hc 自己的
`--via` 造了一台独立机器（独立文件系统 / 独立进程空间 / 独立 home）：

```
$ docker run -d --name v623-nj pi-legion-xm:latest sleep infinity
b15d5c533d2f
$ docker exec v623-nj sh -lc 'node -v'
v24.22.2

# 把本机已装的 6.2.3 运行时装进去（pi 1.5.2 + pi-legion 6.2.3 + provider 扩展 + 凭据）
$ tar -C /home/zzjcool/.pi/agent -cf - install npm bin auth.json models.json models-store.json settings.json \
  | docker exec -i v623-nj tar -C /root/.pi/agent -xf -
$ docker exec v623-nj sh -lc 'chown -R root:root /root/.pi; ln -sf /root/.pi/agent/bin/pi /usr/local/bin/pi'
$ docker exec v623-nj sh -lc 'pi --version; grep "\"version\"" /root/.pi/agent/npm/node_modules/pi-legion/package.json | head -1'
1.5.2
  "version": "6.2.3",

# 远端 checkout：同一提交、同一 origin
$ git clone --no-hardlinks -q /home/zzjcool/code/pi-legion /tmp/v623-clone
$ git -C /tmp/v623-clone remote set-url origin 'git@github.com:zzjcool/pi-legion.git'
$ tar -C /tmp -cf - v623-clone | docker exec -i v623-nj tar -C /root/code -xf -
$ docker exec v623-nj sh -lc 'mv /root/code/v623-clone /root/code/pi-legion; chown -R root:root /root/code/pi-legion;
    cd /root/code/pi-legion && git rev-parse HEAD && git remote get-url origin'
0813b35fa5e448b97bae20db41c3c0431c31f98c
git@github.com:zzjcool/pi-legion.git

# 注册成 hc 的一台机器
$ hc machine add --temp --name v623-nj --via 'docker exec -i v623-nj sh -c' --install --json
docker exec -i v623-nj sh -c now has hc 0.1.21
{"host":"b15d5c533d2f","id":"88ad3a3e8042198be19d843efb5f1cce", ...,"name":"v623-nj",
 "state":"connected","target":"docker exec -i v623-nj sh -c","temporary":true,"version":"0.1.21","via":true}

$ hc exec --on v623-nj -- sh -c 'hostname; pwd; node -v'
b15d5c533d2f
/root
v24.22.2
```

远端 pi 真的能起一个 turn（凭据、provider、模型都在）：

```
$ docker exec v623-nj sh -lc 'cd /tmp && timeout 120 pi -p "Reply with exactly: ok"'
ok
EXIT=0
```

**偏离的边界（请按这个口径读结论）：**

| 覆盖到 | 没覆盖到 |
|---|---|
| 真 `pi -p` 父进程、真 hc machine 传输（`machine.exec` / `file.read` / `terminal.*`）、真远端 pi 进程、真远端 worktree / transcript、真角色策略与模型清单 | 第二台**物理**主机（ssh 传输本身）；真 `hw-nj` 上「装的包不一样」这类差异 |

### 0.2 配置：`subagents.crossMachine.enabled` 必须显式 `true`

父机原来的 `~/.pi/agent/settings.json` 只有 `subagents.defaultModel`。为了让 collect / read-back 能解析
同一台机器，本次验证期间加了一段并在结束后还原（备份 `settings.json.bak-v623-verify`）：

```json
{"subagents": {"defaultModel": "magpie/workbuddy/deepseek-v4.1-flash", "crossMachine": {"enabled": true}}}
```

**为什么必须加：** 不加时 **launch 成功、collect 拒读** —— 见 §3.1（这是本次实测到的一条新边界事实，
不是环境噪音）。`hosts.v623-nj` 没有配置：目录由 6.2.3 的零配置发现（`d0` 的那条路径）现场探出来。

### 0.3 一次作废的试跑（环境缺 `jq`，不计入结论）

第一次试跑时容器里没有 `jq`，孩子的第一次 turn 直接死在校验命令上：

```
{"role":"assistant","stopReason":"error",
 "errorMessage":"API key auth failed for provider magpie: Failed to resolve API key for provider \"magpie\"
 from shell command: jq -r '.[\"any-endpoint\"].access' \"$HOME/.pi/agent/auth.json\""}
```

装上 `jq`（`apt-get install -y jq`，容器内 `jq-1.6`）后重跑即正常。**这是验证环境的缺件，不是 6.2.3 的缺陷**；
它同时说明「远端缺 jq」会让孩子的 turn 直接 error（记录，不归因）。

---

## 1. D — 全新会话恢复上一个进程遗留的跨机 child

### 1.1 先撞到的边界：父进程「自然退出」会把还在跑的跨机 child 记成 aborted

任务书第一步是「launch 后立即结束回合」。第一次照做（父进程 50s 后被 `timeout -s KILL` 杀掉，
用来模拟「父进程没了」）：

```bash
$ cat /tmp/v623-prompt-D1.txt
立即调用一次 subagent 工具，参数完全如下（禁止修改参数，禁止先做调研，禁止追加第二次调用）：

agent: "centurion"
host: "v623-nj"
cwd: "./v623-repo"
hostCwd: "/root/code/pi-legion"
name: "v623-d"
task: "只做一件事：用 bash 工具跑 `sleep 60`（前台等它结束），然后把 hostname 与 pwd 写进
       /tmp/v623-child.txt，cat 出来，最后回一句 done。不要改任何仓库文件、不要开子 agent。"

调用返回后，把返回值原文一字不改地抄出来（包括任何以 ⚠ 开头的警告行）。然后立即结束回合：
不要 wait、不要 collect、不要 sleep、不要再调用任何工具。

$ cd /tmp && { time timeout -s KILL 50 pi -p -a "$(cat /tmp/v623-prompt-D1.txt)" ; echo "EXIT=$?" ; }
（原文，/tmp/v623-logs/D1.log）
```

````
```
▶ v623-d (centurion) supervisor=terminal
  ⚠ v623-d: host 'v623-nj': skipped 1 inherited extension that machine cannot install/load: pi-sop. Install them there, or exclude them permanently: {"subagents":{"agentOverrides":{"centurion":{"excludeExtensions":["pi-sop"]}}}}
↳ async: a completion message is queued when each child finishes. It wakes this session when idle; otherwise it is delivered after the current turn. Use wait or collect for results. Do not tell children to message the parent.
```

回合结束。

real	0m50.006s
EXIT=137
````

孩子当时**确实还在远端跑**：

```
$ hc ls --all | grep v623-d
{'address': 'v623-nj/t3', 'name': 'lgl-v623-d', 'state': 'live', 'status': 'working', 'turn': 0,
 'cwd': '/root/code/.pi-worktrees/v623-d'}
$ docker exec v623-nj sh -lc 'ps aux | grep "[s]leep 60"'
root 2436 … /bin/bash -c sleep 60; echo "sleep finished"
root 2437 … sleep 60
```

但在**全新的进程**里 `recover` 得到的是：

```bash
$ cd /tmp && { time pi -p -a "$(cat /tmp/v623-prompt-D2.txt)" ; echo "EXIT=$?" ; }   # 见 §0.3 后的 D2 试跑
```

```
recover: 'v623-d' is already settled (retired) — nothing was written and nothing was fetched; this is the outcome the ledger recorded at 2026-11-19T01:55:11.808Z.
── v623-d ──
execution: aborted (session-shutdown)
acceptance: rejected (none)
read-back from host 'v623-nj': 5 of 5 lines (complete)
(no output)
```

落定时间是 `01:55:11`，而父进程是 `01:55:48` 才被杀的 —— 也就是说：**回合结束时的
`pi -p` shutdown 已经把孩子判成 `aborted (session-shutdown)` 并写进 ledger，而它既没有杀掉远端进程，
也没有取回它后来的结果**。孩子随后仍在远端跑完（写了文件、回了 `done`），但 ledger 里是 aborted，
`recover` 按「已落定」处理、只给出 launch 时的 5 行快照、**零 fetch**。

把它单列为 §3.2。**为了让 D 的前提成立**（ledger 里真的留着一条**未落定**的行），
1.2 改成在 launch 返回后立刻 `SIGKILL` 父进程，不给 shutdown 机会。

### 1.2 造出真正的遗留（launch 返回后 1.5s 硬杀父进程）

```bash
$ rm -rf /tmp/.pi-subagents /tmp/v623-child*.txt
$ cd /tmp
$ pi -p -a "$(cat /tmp/v623-prompt-D2a.txt)" > /tmp/v623-logs/D2a.log 2>&1 &
parent_pid=1367838 start=09:58:04
ledger_child_state=working at 9s 09:58:12
killed=09:58:13
PARENT_GONE
```

（prompt 与 D1 相同，只把 `name` 换成 `v623-d2`、`sleep 60` 换成 `sleep 45`、文件换成
`/tmp/v623-child2.txt`。）

launch 的返回值原文（父进程被 SIGKILL 时 stdout 未落盘，这是**被杀的父会话 JSONL** 里
`toolResult` 的原文，`timestamp` = `2026-11-19T01:58:12.389Z`，即杀掉前 1.5s）：

```
▶ v623-d2 (centurion) supervisor=terminal
  ⚠ v623-d2: host 'v623-nj': skipped 1 inherited extension that machine cannot install/load: pi-sop. Install them there, or exclude them permanently: {"subagents":{"agentOverrides":{"centurion":{"excludeExtensions":["pi-sop"]}}}}
↳ async: a completion message is queued when each child finishes. It wakes this session when idle; otherwise it is delivered after the current turn. Use wait or collect for results. Do not tell children to message the parent.
```

父进程死后的 ledger（`/tmp/.pi-subagents/runs/*/run.json`，节选）：

```
r-182aad97/run.json   sessionFile= /home/zzjcool/.pi/agent/sessions/--tmp--/2026-11-19T01-58-04-365Z_01a1f186-….jsonl
{'name': 'v623-d2', 'agent': 'centurion', 'host': 'v623-nj', 'state': 'working',
 'worktreePath': '/root/code/.pi-worktrees/v623-d2',
 'remoteDir': '/root/code/.pi-subagents-mirror/no-run/v623-d2',
 'remoteTerminal': 'v623-nj/lgl-v623-d2',
 'sessionFile': '/tmp/.pi-subagents/runs/r-dcd21453/v623-d2.jsonl',
 'settledAt': None, 'execution': None}
```

远端那一刻**还在跑**：

```
$ hc get v623-nj/lgl-v623-d2
{'address': 'v623-nj/t4', 'name': 'lgl-v623-d2', 'state': 'live',
 'status': {'app': 'pi', 'state': 'working'}, 'turn': 0, 'exit_code': None,
 'finished_ms': None, 'pid': 2562, 'cwd': '/root/code/.pi-worktrees/v623-d2'}

$ docker exec v623-nj sh -lc 'ps aux | grep "[s]leep 45"'
root 2647 … /bin/bash -c sleep 45; echo "sleep done"
root 2648 … sleep 45
```

### 1.3 父进程已不在，孩子照样在远端跑完

```
$ for i in $(seq 1 24); do
    st=$(hc get v623-nj/lgl-v623-d2 | jq -r '.status.state, .turn' | paste -sd' ');
    lines=$(docker exec v623-nj sh -lc 'wc -l < /root/code/.pi-subagents-mirror/no-run/v623-d2/session.jsonl');
    echo "t=$((i*5)) status=$st lines=$lines"; case "$st" in done*) break;; esac; sleep 5;
  done
t=5   status=working 0 lines=6
t=10  status=working 0 lines=6
…
t=55  status=working 0 lines=15
t=60  status=done 1 lines=16

$ docker exec v623-nj sh -lc 'cat /tmp/v623-child2.txt'
b15d5c533d2f
/root/code/.pi-worktrees/v623-d2

$ hc get v623-nj/lgl-v623-d2
{'state': 'live', 'status': {'app': 'pi', 'state': 'done'}, 'turn': 1,
 'exit_code': None, 'finished_ms': None, 'pid': 2562}
```

注意这一行就是 6.2.2 判 FAIL 的形态：**kept 终端 `state: live`，`exit_code`/`finished_ms` 都是 None，
只有 program status 是 `done`**。6.2.2 的 `recover` 会永远答 `still live`。

### 1.4 完全新的进程里恢复它

```bash
$ cat /tmp/v623-prompt-D3.txt
这是一次验证任务。按下面顺序执行，每一步的返回值**原文一字不改**地抄出来（用代码块包住），
不要总结、不要改写、不要省略：

1) 调用 subagent 工具，参数 {"action":"status","all":true}，把返回值原文抄出来。
2) 调用 subagent 工具，参数 {"action":"recover","name":"v623-d2"}，把返回值原文抄出来。
3) 再调用一次 subagent 工具，参数同样 {"action":"recover","name":"v623-d2"}，把返回值原文抄出来（这是幂等性检查）。

三次调用都做完之后结束回合，不要做别的事，不要读文件。

$ cd /tmp && { time pi -p -a "$(cat /tmp/v623-prompt-D3.txt)" ; echo "EXIT=$?"; }
```

输出原文（`/tmp/v623-logs/D3.log`）：

````
三次调用结果，原文如下。

**1) `subagent({"action":"status","all":true})`**

```
No live children.
(1 dead)

v623-d2 — state=failed agent=centurion kind=pi
owner: dead (pid gone)
supervisor=terminal
session=/tmp/.pi-subagents/runs/r-dcd21453/v623-d2.jsonl
```

**2) `subagent({"action":"recover","name":"v623-d2"})`**

```
recover: 'v623-d2' is over on 'v623-nj' (terminal 'v623-nj/lgl-v623-d2' is done); settled node root.v623-d2 as settled — recovered from host 'v623-nj': execution success, 1 turn(s), read-back 16 of 16 lines, terminal live
── v623-d2 ──
execution: success
acceptance: accepted (attested)
read-back from host 'v623-nj': 16 of 16 lines (complete)
done

文件内容（`/tmp/v623-child2.txt`）：
```
b15d5c533d2f
/root/code/.pi-worktrees/v623-d2
```

说明：
- 前台执行 `sleep 45` 已结束，随后把 hostname 与 pwd 写入该文件并 cat 出来。
- 未修改任何仓库文件（`git status --porcelain` 为空），未开子 agent，未触碰父 checkout。
- 因无任何文件改动，没有新的 commit 可交付；分支 `pi-subagent/v623-nj/v623-d2-ddb43f51` 仍停在 `0813b35`。
- 按约束尝试推送该分支失败：SSH 远端不可达（`Host key verification failed`，`git ls-remote` 同样失败），非本地可修复问题；无改动因此也没有 MR 可开。未编造 URL。

{"ok": true, "reason": "sleep 45 前台完成；hostname+pwd 已写入 /tmp/v623-child2.txt 并 cat 验证（内容: b15d5c533d2f / /root/code/.pi-worktrees/v623-d2）。任务为只读，未改任何仓库文件（git status 干净）、未开子 agent。分支 pi-subagent/v623-nj/v623-d2-ddb43f51 无新提交，HEAD=0813b35；推送失败：origin SSH 报 Host key verification failed（git ls-remote 亦失败），无改动故无 MR。"}
```

**3) `subagent({"action":"recover","name":"v623-d2"})` 第二次（幂等性）**

```
recover: 'v623-d2' is already settled (settled) — nothing was written and nothing was fetched; this is the outcome the ledger recorded at 2026-11-19T01:59:36.368Z.
── v623-d2 ──
execution: success
acceptance: accepted (attested)
read-back from host 'v623-nj': 16 of 16 lines (complete)
done

文件内容（`/tmp/v623-child2.txt`）：
```
b15d5c533d2f
/root/code/.pi-worktrees/v623-d2
```
…
```

real	0m27.715s
EXIT=0
````

对成功标准逐条：

| 标准 | 实测 |
|---|---|
| 新进程能列出遗留 child | `subagent({"action":"status","all":true})` → `No live children. (1 dead)` + `v623-d2 — state=failed agent=centurion kind=pi` / `owner: dead (pid gone)` / `supervisor=terminal` / `session=…` |
| 名字 / 角色 / **host** / 状态 / **远端终端** | 状态与角色在 `status` 块里；**host 与远端终端在 recover 首行**：`terminal 'v623-nj/lgl-v623-d2' is done`、`recovered from host 'v623-nj'` |
| transcript 行数 > 0 且含最终 assistant 文本 | `read-back from host 'v623-nj': 16 of 16 lines (complete)`，且 `done` 之后就是孩子的最终回复与 `{"ok": true, …}` |
| **落定**（不是一直 live） | `settled node root.v623-d2 as settled` / `execution: success` / ledger 时间戳 `2026-11-19T01:59:36.368Z` |
| 再调一次 `already settled` | 同进程第二次 + §1.5 冷进程都返回 `already settled … nothing was written and nothing was fetched` |

### 1.5 冷进程幂等复核（另一个全新进程）

```bash
$ cd /tmp && { time pi -p -a '这是一次验证任务。只调用一次 subagent 工具，参数 {"action":"recover","name":"v623-d2"}，把返回值原文一字不改地抄出来（用代码块包住），然后结束回合。不要做别的事。' ; echo "EXIT=$?"; }
```

输出原文（`/tmp/v623-logs/D4.log`）：

````
```
recover: 'v623-d2' is already settled (settled) — nothing was written and nothing was fetched; this is the outcome the ledger recorded at 2026-11-19T01:59:36.368Z.
── v623-d2 ──
execution: success
acceptance: accepted (attested)
read-back from host 'v623-nj': 16 of 16 lines (complete)
done
…
```

real	0m8.035s
EXIT=0
````

8.0s（对比第一次 27.7s 里还有模型/工具开销）：**零 fetch**，与文案一致。

### 1.6 D 判定：**PASS**（限定在「父进程非正常死亡」这一前提）

- 6.2.2 的三条缺陷都实测翻了：新进程不再需要先 launch 一次（**没有** `No legion ledger in this session`）、
  kept 终端的 `state: live` 不再冒充活进程（`status.app.state = done` 即落定）、第二次调用真的零 fetch。
- **前提是父进程没有跑完自己的 shutdown**（SIGKILL）。走「回合结束 → shutdown」的正常路径时，见 §3.2：
  行会在孩子还在跑的时候就被记成 `aborted (session-shutdown)`，`recover` 之后不会再取结果。

---

## 2. E — 成功的跨机 child 不再被判 `failed`，`pi -p` 自己退出

### 2.1 命令（第一次）

```bash
$ cat /tmp/v623-prompt-E.txt
这是一次验证任务。按顺序执行，返回值**原文一字不改**地抄出来（用代码块包住），不要总结：

1) 调用 subagent 工具，参数如下：
   agent: "centurion"
   host: "v623-nj"
   cwd: "./v623-repo"
   hostCwd: "/root/code/pi-legion"
   name: "v623-e"
   task: "只回一句话：hostname 与 pwd 是什么。不要改任何文件、不要开子 agent。"
   把 launch 的返回值原文抄出来（含任何 ⚠ 行）。
2) 然后调用 subagent 工具，参数 {"action":"wait","name":"v623-e"}（timeoutMs 用 300000），把 wait 的返回原文抄出来，尤其是 execution / acceptance 那几行和最后一段 JSON。
3) 抄完就结束回合。不要自己 sleep、不要额外调用。

注意：不要给 launch 传 model 参数。

$ cd /tmp && { time pi -p -a "$(cat /tmp/v623-prompt-E.txt)" ; echo "EXIT=$?"; }
```

输出原文（`/tmp/v623-logs/E.log`）：

````
**1) launch 返回值：**

```
▶ v623-e (centurion) supervisor=terminal
  ⚠ v623-e: host 'v623-nj': skipped 1 inherited extension that machine cannot install/load: pi-sop. Install them there, or exclude them permanently: {"subagents":{"agentOverrides":{"centurion":{"excludeExtensions":["pi-sop"]}}}}
↳ async: a completion message is queued when each child finishes. It wakes this session when idle; otherwise it is delivered after the current turn. Use wait or collect for results. Do not tell children to message the parent.
```

**2) wait 返回值：**

```
── v623-e ──
execution: success
acceptance: accepted (attested)
read-back from host 'v623-nj': 8 of 8 lines (complete)
optional criteria — fix them if cheap, but they do not gate the verdict:
  [ ] legion-team-delivery (optional): 完成子树阶段验证、收齐成员结果，并交付可审查的 squash 分支（分支名 + HEAD sha；仓库有 remote 时再附 MR/PR URL）
hostname 是 b15d5c533d2f，pwd 是 /root/code/.pi-worktrees/v623-e。

{"ok": true, "reason": "hostname=b15d5c533d2f；pwd=/root/code/.pi-worktrees/v623-e；未改任何文件、未开子 agent（无 remote、无提交需求：no remote: branch pi-subagent/v623-nj/v623-e-b1f7131e at 未产生新提交）"}
full text: legion_output({ name: "v623-e", round: 1 })
1 done, 0 still running
```

real	0m25.293s
EXIT=0
````

### 2.2 第二次（同一形态，换名字 `v623-e2`，确认不是偶然）

```bash
$ sed 's/v623-e/v623-e2/g' /tmp/v623-prompt-E.txt > /tmp/v623-prompt-E2.txt
$ cd /tmp && { time pi -p -a "$(cat /tmp/v623-prompt-E2.txt)" ; echo "EXIT=$?"; }
```

`/tmp/v623-logs/E2.log` 的关键行（原文）：

```
execution: success
acceptance: accepted (attested)
read-back from host 'v623-nj': 10 of 10 lines (complete)
real	0m25.159s
EXIT=0
```

### 2.3 判词与退出

```
$ grep -nE "failed|delivered with cleanup|secondary:" /tmp/v623-logs/E.log /tmp/v623-logs/E2.log
grep_exit=1                      # 两次都**没有** failed / cleanup warning / secondary

$ grep -nE "real|EXIT=" /tmp/v623-logs/E.log /tmp/v623-logs/E2.log
/tmp/v623-logs/E.log:25:real	0m25.293s
/tmp/v623-logs/E.log:28:EXIT=0
/tmp/v623-logs/E2.log:27:real	0m25.159s
/tmp/v623-logs/E2.log:30:EXIT=0

$ pgrep -af "hc connect" | grep -v pgrep
pgrep_exit=1                     # 退出后没有残留的会话级 hc 传输子进程
```

ledger 里这一轮的记录（`/tmp/.pi-subagents/runs/*/run.json`）：

```
{'name': 'v623-e', 'host': 'v623-nj', 'state': 'retired', 'settledAt': None} | success accepted
```

### 2.4 E 判定：**PASS**

- 判词 `execution: success` / `acceptance: accepted (attested)`，**2/2 不是 failed**（6.2.2 是 2/2 failed）。
- `pi -p` **自己退出**，`EXIT=0`，耗时 **25.293s / 25.159s**；全程没有 `timeout`、没有 `kill`。
- 退出后 0 个残留 `hc connect`（6.2.2 是 `ps --ppid` 里挂着一个 `hc connect` 不退出）。
- 清理失败的降级路径（`delivered with cleanup warning` + `secondary:`）**本次没有触发**：两次 run 的清理都成功，
  所以没有 cleanup 失败可报。该降级本身由 6.2.3 的单测/变异覆盖（见 `docs/reports/recover-and-false-failed.md`），
  **不是本报告的实测结论**。

---

## 3. 附带发现（必须报，但不改本次 D/E 判定）

### 3.1 零配置 launch 能跑，collect 拒读（`crossMachine.enabled` 必须显式 `true`）

`subagents.crossMachine` 整块不写时（只有 `defaultModel`）：

```bash
$ cd /tmp/v623-smoke && { time pi -p -a "$(cat /tmp/v623-prompt-smoke.txt)" ; echo "EXIT=$?"; }
```

输出原文（`/tmp/v623-logs/smoke3.log`，孩子真的在远端跑起来了）：

````
```
▶ smoke3 (centurion) supervisor=terminal
  ⚠ smoke3: host 'v623-nj': skipped 1 inherited extension that machine cannot install/load: pi-sop. …
── smoke3 ──
execution: unknown (transcript not retrieved from host 'v623-nj' (host 'v623-nj' needs subagents.crossMachine.enabled = true): the child's work cannot be graded from here) · read-back: unreachable
acceptance: unknown (none)
read-back from host 'v623-nj': FAILED (unreachable) — host 'v623-nj' needs subagents.crossMachine.enabled = true (the verdict below rests on no transcript at all)
  evidence: the host target could not be resolved
  next: fix subagents.crossMachine.hosts.v623-nj (enabled, cwd, piExtensions): the launch and this read-back must resolve the same target
…(no output)
```

real	0m31.557s
EXIT=0
````

（这一次模型的调用里自己加了 `"async":false`，所以 launch 与 collect 合成一个返回值；不影响结论。）

成因在源码里是**两条不同的判据**：

- launch 走 `resolveHostTargetAsync`：只在 `config?.enabled === false` 时拒绝（`src/runs/remote.ts:2290`），
  没写 = 允许，于是零配置发现照常工作；
- read-back 走 6.2.3 新增的 `resolveReadTarget`：要求 `config?.enabled === true`（`src/runs/remote.ts:1205-1211`），
  没写 = 拒读。单测把这个拒绝**钉住**了（`test/unit/remote-read-target.test.ts:50`：
  `assert.throws(() => resolveReadTarget(HOST, undefined), /crossMachine\.enabled = true/)`）。

因此这不是「我少配了」那么简单：**同一个会话里 launch 与 collect 的 enabled 语义不一致**，
`d0` 修好的「零配置 collect」只在 `hosts.<h>` 缺省、而 `crossMachine.enabled` 已显式 `true` 时成立。
最小复现：只注册机器、settings 里不写 `crossMachine` 块，`subagent({agent:"centurion", host:"<h>", …})` 能起，
随后 collect 的 read-back 必回 `needs subagents.crossMachine.enabled = true`。

### 3.2 父进程自然退出：跨机 child 被记成 `aborted (session-shutdown)`，而远端进程继续跑完

§1.1 的证据链，按时间排：

| 时刻（同日） | 事件 |
|---|---|
| 01:54:58 | 父 `pi -p` 启动，launch 返回 `▶ v623-d (centurion) supervisor=terminal` |
| **01:55:11** | ledger 把 `v623-d` 落定为 `aborted (session-shutdown)`；此时孩子还在远端 `sleep 60` |
| 01:55:48 | 50s 的 `timeout -s KILL` 杀掉父进程（`EXIT=137`）；此后 `hc ls` 仍显示 `lgl-v623-d` `working` |
| ~01:56:30 | 孩子跑完：`/tmp/v623-child.txt` 写入成功、最终回复 `done`、mirror 16 行 |
| 之后 | 新进程 `recover` → `already settled … aborted (session-shutdown)`，`read-back 5 of 5`（陈旧快照，零 fetch） |

两点事实：

1. shutdown 只**记账**（`retired` + `reason: session-shutdown`，`src/shared/types.ts:352` 明确写着
   「the parent process leaving, not a model failure」），并没有杀掉远端进程 —— 孩子继续跑完并产出了真实结果。
2. `recover` 对「已落定」的行**按设计不 fetch**（`src/runs/remote-recover.ts:351-392`），
   于是这条真实结果永远取不回来；而 `interruptedChildren()`（`index.ts:1369-1412`）把同一行当作
   「被上一个会话打断、可以 `resume`」。两个功能对同一行的解释相反。

这不在本次 D/E 的验收项里（D 的验收前提是「父进程没跑完 shutdown」），但它决定**现实路径**
（用户 launch 完就关掉/结束会话）下 D 的价值，建议单开 issue 决定口径：远端进程还活着时，
`session-shutdown` 到底算不算终局；若算，至少要让 `recover` 能强制刷新一次转录。

### 3.3 `subagent({action:"status"})` 的 dead 块不含 host / 远端终端

§1.4 的 status 原文里只有名字、角色、`state=failed`、`owner: dead (pid gone)`、`supervisor=terminal`、
`session=…`；**host 与远端终端只在 `recover` 的首行出现**。任务书要求「列出（名字/角色/host/状态/远端终端）」，
实际是两个界面拼起来才齐。`/legion status` 的 recoverable 块无法在 `pi -p` 里验证：

```bash
$ cd /tmp && { time pi -p '/legion status' ; echo "EXIT=$?"; }
（除 time 输出外没有任何内容）
real	0m7.551s
EXIT=0
```

`pi --print` 不执行 slash 命令，所以本次用的是等价的 `subagent({action:"status", all:true})`。

### 3.4 环境：远端缺 `pi-sop`，launch 上有一条 `⚠`

每次 launch 都有：

```
⚠ <name>: host 'v623-nj': skipped 1 inherited extension that machine cannot install/load: pi-sop.
Install them there, or exclude them permanently: {"subagents":{"agentOverrides":{"centurion":{"excludeExtensions":["pi-sop"]}}}}
```

这是父机装了 `pi-sop`（git 包）、目标机没有（容器里 `git clone` 需要交互凭据）导致的**环境差异**，
告警本身给出了可执行的去路，不归因 6.2.3。它不阻塞 launch，也不影响判词。

---

## 4. 最小复现清单

| # | 场景 | 一条命令 | 期望 |
|---|---|---|---|
| D-前置 | 注册一台可达机器 + 目标机有 6.2.3、同提交、同 origin | `hc machine add --temp --name <h> --via '<reach>' --install` | `hc exec --on <h> -- pi --version` = 1.5.2 |
| D | 遗留未落定 child | `cd /tmp && pi -p -a "$(cat /tmp/v623-prompt-D2a.txt)" &`，launch 返回后 `kill -9 <pid>` | ledger 行 `state=working, settledAt=None`；`hc get <h>/lgl-<name>` = `live/working` |
| D | 新进程恢复 | `cd /tmp && pi -p -a '{"action":"recover","name":"<name>"} …'` | `read-back N of N lines (complete)` + `execution: success` + `settled`；二次 `already settled` |
| E | 正常跨机 launch + 等完 | `cd /tmp && time pi -p -a "$(cat /tmp/v623-prompt-E.txt)"` | `execution: success` / `accepted (attested)`，`EXIT=0`，自然退出（本次 25s） |
| 3.1 | 不写 `crossMachine.enabled` | 去掉 `subagents.crossMachine` 块后跑 E 的 launch | launch 成功，collect `needs subagents.crossMachine.enabled = true` |
| 3.2 | 自然退出后的遗留 | 照 D-前置 但不 `kill -9`，让孩子 `sleep 60`，回合结束 | 行 `aborted (session-shutdown)`；孩子仍跑完；`recover` 返回 5/5 陈旧快照 |

---

## 5. 结论

| 项 | 判定 | 一行证据 |
|---|---|---|
| **D** 全新会话恢复遗留跨机 child | **PASS**（前提：父进程非正常死亡） | 新进程 `recover`：`settled node root.v623-d2 as settled … execution success, 1 turn(s), read-back 16 of 16 lines, terminal live`；二次 `already settled … nothing was fetched`（27.7s → 冷进程 8.0s） |
| **E** 成功不再误判 `failed` | **PASS** | 2/2 `execution: success` + `acceptance: accepted (attested)`，两次日志 `grep failed` 无命中 |
| **E** `pi -p` 自己退出 | **PASS** | `real 0m25.293s` / `real 0m25.159s`，`EXIT=0`，无 timeout/kill，退出后无残留 `hc connect` |

**新发现的边界事实（不改本次判定，建议单独立项）：**

1. §3.1 `crossMachine.enabled` 在 launch 与 read-back 上语义不一致（launch 缺省允许、read 缺省拒绝），
   `d0` 的「零配置 collect」只在显式 `enabled: true` 时生效。
2. §3.2 父进程自然退出把仍在跑的跨机 child 落定为 `aborted (session-shutdown)`，远端进程却继续跑完；
   `recover` 按设计零 fetch，真实结果从此不可取。
3. §3.3 status 的 dead 块不含 host / 远端终端。

---

## 6. 清场

```bash
$ cp /home/zzjcool/.pi/agent/settings.json.bak-v623-verify /home/zzjcool/.pi/agent/settings.json
$ python3 -c "import json;print(json.load(open('/home/zzjcool/.pi/agent/settings.json'))['subagents'])"
{"defaultModel": "magpie/workbuddy/deepseek-v4.1-flash"}      # crossMachine 块已还原

$ hc machine rm v623-nj
{"removed":"v623-nj"}
$ hc machine ls --json
{"machines":[]}

$ docker rm -f v623-nj
v623-nj
```

- 证据副本留在 `/tmp/v623-logs/`（D1/D2/D2a/D3/D4、E、E2、smoke3、legion-status 的原始日志）
  以及被杀父会话的 JSONL（`~/.pi/agent/sessions/--tmp--/2026-11-19T01-58-04-365Z_*.jsonl`）。
- `/tmp/v623-repo` 是指向本 worktree 的符号链接（launch 的 `cwd: "./v623-repo"` 用它把父机 checkout 交给预检）。
- 本报告只改这一个文件。
