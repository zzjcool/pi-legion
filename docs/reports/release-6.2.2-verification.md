# 发布验证报告 — pi-legion 6.2.2（真进程实跑）

- 仓库 / 分支：`pi-legion`（`pi-legion`）`chore/verify-622`，基线 `4611ce3 docs(report): the 6.2.2 release record`（已发布 6.2.2 = `4d9ea75` + 该文档提交）
- 验证对象：已发布并安装好的 **6.2.2**（本机 `~/.pi/agent/npm/node_modules/pi-legion/package.json` = `6.2.2`，pi = `1.5.2`）
- 验证方式：**真进程 `pi -p -a`**（不是只读源码），四条修复各自一条可粘贴命令 + 原文输出
- MR：<https://github.com/zzjcool/pi-legion/pull/400>（本报告单独一个提交，不改产品代码）
- 本报告只写证据与判定；**未改动任何产品代码**（唯一改动的仓库文件就是本报告）

---

## 0. 环境与一处必须说明的偏离

任务书写的是三台真机（Mac / host-workspace / hw-nj 都已装 6.2.2）。实际落地时：

```
$ hc machine ls --json
{"machines":[]}
$ cat ~/.ssh/config        # 无 hw-nj 条目（文件不存在）
```

本机（`host-workspace`）的 hc core **一台机器都不认识**，也没有到 `hw-nj` 的 ssh 通路，
所以从本机不可能直接派发到真 `hw-nj`（会先撞 `machine_unknown`，见 `src/runs/remote.ts:2166`，
那条路径根本没进到本次要验的 6.2.2 代码）。

为了让「跨机」这一段仍是**真的机器边界 + 真的 hc machine 传输 + 真的远端进程**，
用 hc 自己的 `--via` 造了一台独立机器（独立文件系统 / 独立进程空间 / 独立 home）：

```
$ docker run -d --name v622-hw-nj pi-legion-xm:latest sleep infinity
$ docker exec v622-hw-nj sh -lc 'node -v; git --version'
v24.22.0
git version 2.39.5

# 把本机已装的 6.2.2 运行时装进去（pi 1.5.2 + pi-legion 6.2.2 + any-endpoint）
$ tar -C /root/.pi/agent -cf - install npm auth.json models.json models-store.json settings.json \
  | docker exec -i v622-hw-nj tar -C /root/.pi/agent -xf -
$ docker exec v622-hw-nj sh -lc 'cat /root/.pi/agent/npm/node_modules/pi-legion/package.json | head -3;
    /usr/local/bin/node /root/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --version'
  "name": "pi-legion",
  "version": "6.2.2",
1.5.2

# 远端 checkout（origin 与父机 checkout 相同，worktree 交付才可能过预检）
$ docker exec v622-hw-nj sh -lc 'cd /home/zzjcool/code/pi-legion && git log --oneline -1 && git remote -v | head -1'
4611ce3 docs(report): the 6.2.2 release record (sha, gates, run id, registry)
origin  https://github.com/zzjcool/pi-legion.git (fetch)

# 把容器注册成 hc 的一台机器，名字就用任务书里的 hw-nj
$ hc machine add --temp --name hw-nj --via 'docker exec -i v622-hw-nj sh -c' --install --json
docker exec -i v622-hw-nj sh -c now has hc 0.1.21
{"host":"593f64db2948","id":"68dadd1b19943e6c9933a6b619ef68a6","name":"hw-nj","state":"connecting",
 "target":"docker exec -i v622-hw-nj sh -c","temporary":true,"version":"0.1.21","via":true}

$ hc exec --on hw-nj -- sh -c 'pwd; node -v'
/root
v24.22.0
```

`~/.pi/agent/settings.json` 的 `subagents.crossMachine.hosts.hw-nj` 只把 `cwd/node/piCli/piLegionRoot/piExtensions`
指到容器内路径（备份在 `settings.json.bak-v622-verify`，验证结束已还原；临时机器已 `hc machine rm hw-nj`）。

**偏离的边界（请按这个口径读结论）：**

| 覆盖到 | 没覆盖到 |
|---|---|
| 真 `pi -p` 父进程、真 hc machine 传输（`machine.exec` / `file.read` / `terminal.*`）、真远端 pi 进程、真远端 worktree / transcript、真角色策略、真模型清单探测 | 第二台**物理**主机（ssh 传输本身）；真 hw-nj 上「装的包不一样」这类差异 |
| 相对 `cwd` + 非仓库会话目录的解析（就是 6.2.1 那条 `this session's directory is not one` 的场景） | 真机间的 ssh 断链、时区/权限差异 |

> B 项的「机器上没有这个模型」是**我制造的**，做法与真机一致：改那台机器自己的模型清单（见 §B）。

---

## A. 相对 `cwd` + 非仓库会话目录（6.2.2 修复 1）

### 命令（原文）

```bash
ln -sfn /root/code/pi-legion /tmp/lrepo
cd /tmp                      # 会话目录不是仓库
pi -p -a "$(cat /tmp/v622-prompt-A.txt)"
```

`/tmp/v622-prompt-A.txt`（原文，含「不传 model」这条）：

```
立即调用一次 subagent 工具，参数完全如下（禁止修改参数，禁止先做任何调研/读文件，禁止追加第二次调用）：

agent: "centurion"
host: "hw-nj"
cwd: "./lrepo"
hostCwd: "/home/zzjcool/code/pi-legion"
worktree: true
name: "v622-a"
task: "只回一句话：hostname 与 pwd 是什么。不要改任何文件、不要开子 agent。"

（注意：不传 model 参数。）

调用返回后，把返回值原文抄出来；如果 handle 上有以 ⚠ 开头的警告行，也一字不改地抄出来。然后结束，不要再做别的事。
```

### 输出（原文，`/tmp/v622-logs/A.log`）

````
返回值原文：

```
▶ v622-a (centurion) supervisor=terminal
  ⚠ v622-a: host 'hw-nj': model 'workbuddy/deepseek-v4.1-flash' is not visible there; using 'any-endpoint/workbuddy/hy4std' from that machine's listing (pin it with subagents.crossMachine.hosts.hw-nj.model)
↳ async: a completion message is queued when each child finishes. It wakes this session when idle; otherwise it is delivered after the current turn. Use wait or collect for results. Do not tell children to message the parent.
```
Extension error (<boundary>): turn_end could not resolve the persisted assistant entry ID
````

**6.2.1 的那句报错没有再出现**（整份日志里没有 `not one` / `this session's directory`），
launch 成功，且远端真的起了 child：

```
$ hc ls --all        # 只列 hw-nj 的
{'address': 'hw-nj/t1', 'agent': 'pi', 'cwd': '/home/zzjcool/code/.pi-worktrees/v622-a',
 'name': 'lgl-v622-a', 'state': 'live', 'status': 'done', 'turn': 1}
```

`/tmp/.pi-subagents/runs/r-061990a0/run.json` 里记录的孩子（节选）：

```
"name": "v622-a",     "agent": "centurion",   "host": "hw-nj",
"worktreePath":   "/home/zzjcool/code/.pi-worktrees/v622-a",
"worktreeBranch": "pi-subagent/hw-nj/v622-a-0f4576e7",
"worktreeHost":   "hw-nj",
"remoteDir":      "/home/zzjcool/code/.pi-subagents-mirror/no-run/v622-a",
"remoteTerminal": "hw-nj/lgl-v622-a"
```

远端会话第一行也证明 worktree 是在**那台机器**上建的（`cwd` 是远端路径）：

```
{"type": "session", ..., "cwd": "/home/zzjcool/code/.pi-worktrees/v622-a"}
```

**判定：PASS。** 相对 `cwd: "./lrepo"`（父机 checkout）+ `hostCwd`（远端目录）这一组合按 6.2.2 的语义工作：
相对值在父机解析成交付来源，绝对值只当远端目录；预检不再问「会话目录」。

> 复现 2 次（`v622-a2`，同样的参数只换名字）：`▶ v622-a2 (centurion) supervisor=terminal` 同样 launch 成功
> （`hw-nj/t3`，`cwd` = `/home/zzjcool/code/.pi-worktrees/v622-a2`）。第二次**没有** `⚠`，原因见 §B。

---

## B. 不指定 model 的自动回退（6.2.2 修复 2）

上面那次调用**没有传 `model`**。要触发的条件是「父机要用的模型不在那台机器的清单里」，
所以先把两台机器的清单核对清楚，再让远端清单缺那一行（**改的是那台机器自己的模型目录，不是产品代码**）：

```bash
# 远端清单（未改前）：父机默认模型在
$ hc exec --on hw-nj -- sh -c 'cd /home/zzjcool/code/pi-legion && node …/cli.js --list-models | head -5'
provider      model                          context  max-out  thinking  images
any-endpoint  workbuddy/deepseek-v4.1-flash  1M       128K     yes       yes
any-endpoint  workbuddy/hy4std               960K     64K      yes       yes

# 把那台机器上的 workbuddy/deepseek-v4.1-flash 从它自己的 models.json / models-store.json 摘掉
$ docker exec v622-hw-nj sh -lc 'node -e "…filter(x=>x.id!==\"workbuddy/deepseek-v4.1-flash\")…"'
remaining: [ 'workbuddy/hy4-preview-ioa', 'workbuddy/glm-5.3-ioa', 'workbuddy/claude-opus-5.5',
             'workbuddy/claude-sonnet-5.5', 'workbuddy/gpt-6-luna' ]
models-store.json any-endpoint 2 -> 1

# 摘掉之后，那台机器的清单里就只剩一个 any-endpoint 模型
$ hc exec --on hw-nj -- sh -c '… --list-models | head -10'
provider      model             context  max-out  thinking  images
any-endpoint  workbuddy/hy4std  960K     64K      yes       yes
```

然后在 `cwd`/`hostCwd` 完全不变、**仍然不传 model** 的调用里，launch 没有硬失败，handle 上出现：

> **警告原文（一字未改，来自 A 的 handle）**
>
> ```
>   ⚠ v622-a: host 'hw-nj': model 'workbuddy/deepseek-v4.1-flash' is not visible there; using 'any-endpoint/workbuddy/hy4std' from that machine's listing (pin it with subagents.crossMachine.hosts.hw-nj.model)
> ```

对照源码，这段正是 6.2.2 的「三级回退」第 3 级（`src/runs/remote.ts:978-985` 的 warning 模板，
`src/runs/orchestrator.ts:470-478` 加 `  ⚠ <name>: ` 前缀）：**从 X 换成 Y，Y 来自那台机器自己的 listing**，
并给出钉住它的键名。

远端会话的 `model_change` 行证明孩子**真的用了**回退后的模型：

```
{"type": "model_change", "provider": "any-endpoint", "modelId": "workbuddy/hy4std"}
```

**判定：PASS。**

两点如实记录：

1. `run.json` 里的 `"model": "workbuddy/deepseek-v4.1-flash"` 是**请求**的模型（launch 输入），
   真正跑的是上面 `model_change` 里的 `hy4std` —— 回退是原地改 argv，不改这份请求记录。
2. 第二次调用（`v622-a2`）**没有** `⚠`：孩子跑完后远端 pi 把 provider 的模型目录刷新回来了
   （`models-store.json` 又出现 `workbuddy/deepseek-v4.1-flash`，`--list-models` 也能看到它）。
   这与「listing 是每次 launch 现读的」一致，不是回退失效；要稳定复现就得让那台机器的清单真的没有它。

---

## C. transcript 回传 + 角色策略（6.2.2 修复 0 / 拒绝文案）

### C1. 转录落盘且包含**最终回复**

`runs/<id>/remote/<name>.jsonl` 在 launch 结束、孩子落定后被**整文件重写**（不是 launch 快照）：

```
# launch 刚结束（孩子还在跑）时读一次：只有 5 行，最后一行是 user task —— 这是启动快照
$ wc -l /tmp/.pi-subagents/runs/r-17594eed/v622-a.jsonl        # 本地占位文件
0 /tmp/.pi-subagents/runs/r-17594eed/v622-a.jsonl
$ wc -l /tmp/.pi-subagents/runs/r-061990a0/remote/v622-a.jsonl  # 镜像（快照）
5 /tmp/.pi-subagents/runs/r-061990a0/remote/v622-a.jsonl

# 孩子落定后再读：8 行，最后一行是 assistant 的最终回复
$ wc -l /tmp/.pi-subagents/runs/r-061990a0/remote/v622-a.jsonl
8 /tmp/.pi-subagents/runs/r-061990a0/remote/v622-a.jsonl
```

镜像里 8 行的角色序列（`jq` 等价输出）：

```
0 session | 1 model_change | 2 thinking_level_change | 3 message system
4 message user      | 5 message assistant | 6 message toolResult | 7 message assistant
```

**最后一条 assistant 文本（原文）：**

```
hostname 是 `593f64db2948`，pwd 是 `/home/zzjcool/code/.pi-worktrees/v622-a`。

{"ok": true, "reason": "hostname=593f64db2948; pwd=/home/zzjcool/code/.pi-worktrees/v622-a; branch=pi-subagent/hw-nj/v622-a-0f4576e7; HEAD=4611ce3f1b0d158d95934f5c2baa569ab0f12193; 只读作答，未改文件、未开子 agent，无改动可提交或推送"}
```

这与远端机器上那份 `…/.pi-subagents-mirror/no-run/v622-a/session.jsonl` 逐字节一致（同一份内容被读回本地镜像）。
**判定：PASS**（镜像 8 行 > 0，且末行是孩子的最终回复，不是 launch 时的 user 快照）。

### C2. 角色策略拒绝（`allowRoles`）

命令（`/tmp/v622-c2` 是另一个非仓库目录）：

```bash
cd /tmp/v622-c2 && pi -p -a "$(cat /tmp/v622-prompt-C2.txt)"
# prompt 原文：
#   立即调用一次 subagent 工具，参数完全如下（禁止修改参数，禁止先做任何调研/读文件）：
#   agent: "scout"
#   host: "hw-nj"
#   hostCwd: "/home/zzjcool/code/pi-legion"
#   task: "应被拒绝"
#   调用返回后，把错误/拒绝文案原文一字不改地抄出来（尤其是 allowRoles 与可用机器清单的部分），然后结束。
```

输出（原文，`/tmp/v622-logs/C2.log`）：

```
错误原文（一字未改）：

```
✗ scout: INVALID_PARAMS: host 'hw-nj' cannot be dispatched to agent 'scout': cross-machine launch is for a DELIVERY UNIT, and only 'centurion' may cross. Dispatch a centurion to that machine and let IT create its scout team there. To allow it anyway: "subagents": { "crossMachine": { "allowRoles": ["centurion", "scout"] } }
```

说明：返回文案中只包含 `allowRoles` 的建议配置，**没有**给出可用机器清单部分。
EXIT=0
```

**没有启动任何远端进程**的证据（拒绝发生在 spawn 之前）：

```
$ hc ls --all | grep hw-nj          # C2 之后立刻取
[{'address': 'hw-nj/t1', 'name': 'lgl-v622-a', 'state': 'live', 'status': 'done', ...}]   # 只有 A 那个
$ ls /tmp/v622-c2/.pi-subagents/runs/r-12dd728f/
legion.db  owner.json  run.json      # 没有孩子、没有 remote/ 镜像、没有 session 文件
```

**判定：PASS**（被拒；文案含 `allowRoles` 默认值与放行片段）。
一处与任务书措辞的差异：文案点的是**允许的角色清单**（`only 'centurion' may cross`），
**不含机器清单**（机器清单在另一条 `machine_unknown` 文案里，见 `src/runs/remote.ts:2166-2168`）。

---

## D. 遗留跨机 child 的恢复（6.2.2 修复 3，尽力而为）

本机原本**没有**历史遗留（`legion_tree` 只有本会话自己的树；本机不存在 `~/.pi/subagents`，
store 永远跟着会话 `cwd` 走）。为了实测，人为造出「上一个会话启动、本会话没接手」的状态：

```bash
# 1) 一个会在远端睡 300s 的跨机 child，父进程 75s 后被 timeout 杀掉（= 父会话退出）
cd /tmp && timeout -s TERM 75 pi -p -a "$(cat /tmp/v622-prompt-D1.txt)"
#   prompt: agent centurion / host hw-nj / cwd "./lrepo" / hostCwd /home/zzjcool/code/pi-legion
#           name "v622-d" / task "只做一件事：用 bash 跑 `sleep 300`…回一句话 done"
```

```
$ tail -2 /tmp/v622-logs/D1.log
↳ async: a completion message is queued when each child finishes. …
EXIT=124                                   # ← 父进程被 timeout 杀掉，孩子还在远端跑

$ hc ls --all | grep hw-nj
{'address': 'hw-nj/t2', 'name': 'lgl-v622-d', 'state': 'live', 'status': 'working', 'turn': 0}
$ docker exec v622-hw-nj sh -lc 'ps aux | grep -E "[s]leep 300"'
root  1297  … /bin/bash -c sleep 300; echo "sleep finished"
root  1298  … sleep 300
```

于是本机有了一条「遗留跨机 child」。接下来按任务书的调用方式恢复：

```bash
# 2) 新会话（同一 cwd /tmp）
cd /tmp && pi -p -a "$(cat /tmp/v622-prompt-D2.txt)"
#   prompt: subagent({ action: "recover", name: "v622-d" })
```

**输出（原文，`/tmp/v622-logs/D2.log`）：**

```
No legion ledger in this session: there is no cross-machine child to recover, because no row recording one exists here. `recover` works on the tree a PREVIOUS session of this conversation left behind.
EXIT=0
```

同样失败的三次尝试（不同入口，同一句话）：

| 入口 | 命令要点 | 输出 |
|---|---|---|
| 新会话 | `cd /tmp && pi -p -a` + recover | `No legion ledger in this session: …` |
| 续同一会话文件 | `pi -p --session /root/.pi/agent/sessions/--tmp--/2026-11-18T18-05-28-733Z_01a1efd5-….jsonl -a` + recover | `No legion ledger in this session: …` |
| 续最近会话 | `pi -p -c -a` + recover | `No legion ledger in this session: …` |

`pi -p --session` 那次之后，`runs/r-c92ee068/run.json`（**正是**那条遗留 child 的 ledger）确实被进程碰过，
但 `recover` 仍然说没有 ledger。原因在源码里很直白：`recover` 用的是 `input.legion`，
而根身份只会由「本进程自己发起的一次 launch」创建（`createRootLegion` → `reopenSessionRun`）；
`ownLegionIdentity()` 在没有 cached 根时直接 `return undefined`（`index.ts:1186-1189`：
`// A root runtime belongs to the current Pi session. Do not adopt a different session's most recent tree…`）。
`subagent({action:"list"})` 不会创建它（D4 实测：list 正常返回角色清单，紧接着 recover 仍是这句）。

#### 让 ledger 先建立起来之后，recover 本身是工作的（正向证据）

在同一条遗留 ledger（同一 session 文件）里，先做一次**本机** launch（这一步会 `reopenSessionRun`），再 recover：

```
1) subagent({ agent: "scout", task: "只回一句话：ok", name: "tiny-local" })
   ── tiny-local ──  execution: success / acceptance: accepted (attested) / ok

2) subagent({ action: "recover", name: "v622-d" })
```

**输出（原文，`/tmp/v622-logs/D5.log`）：**

```
recover: terminal 'hw-nj/lgl-v622-d' is still 'live' on 'hw-nj' — the child is still working there, so nothing was settled.
── v622-d ──
execution: running (terminal 'hw-nj/lgl-v622-d' is still 'live' on host 'hw-nj': the child is still working there, so nothing was graded)
acceptance: unknown (none)
read-back from host 'hw-nj': 8 of 8 lines (complete)
done

{"ok": true, "reason": "Ran `sleep 300` in the foreground and it completed successfully after 300s; no files were changed and no subagents were launched. No worktree commit was needed (branch pi-subagent/hw-nj/v622-d-08316673 is untouched/no diff), so there was nothing to push or open an MR for."}
```

即：**transcript 补取成功（8 of 8 行，含最终回复 "done"）**，但**判词没有落定** —— 它认为孩子「还在跑」。

而事实上那个孩子已经结束了：

```
$ docker exec v622-hw-nj sh -lc 'ps aux | grep -c "[c]li.js"'
0
$ hc ls --all | grep lgl-v622-d
{'address': 'hw-nj/t2', 'name': 'lgl-v622-d', 'state': 'live', 'status': 'done', 'turn': 1}
```

原因：`recover` 的「活着」判定只看 hc 终端的 **state**，不看 agent 的 **status**
（`src/runs/remote-artifact.ts:245`：`live: state === "live" || state === "running" || state === "idle"`），
而 hc 的 kept 终端在程序退出后仍然是 `state: "live"`（`status: "done"`）。于是
`remote-recover.ts:206-217` 的 `if (terminal.live)` 分支永远命中，落定分支走不到。

**判定：FAIL（部分工作）。** 两点实证缺陷：

1. **入口不可达**：父会话退出后，新会话（含 `--session` / `-c` 续会话）里 `recover` 的第一句话是
   `No legion ledger in this session`；必须先在本会话里发起过一次 launch 才「接上」旧 ledger。
   而 `/legion status` 的 recoverable 块同样取 `ownLegionIdentity()`，同一堵墙。
2. **落定判定用的是 kept 终端的状态**：孩子进程已退出（容器内 0 个 pi 进程、`status: done`），
   recover 仍回 `still 'live' … nothing was settled`，`read-back 8 of 8` 明明已经拿到了完整转录。

---

## E. 附带发现（不在四条验收项里，但实跑撞到了，必须报）

### E1（major）成功跑完的跨机 centurion，判词被「worktree 归属」守卫覆盖 —— 2/2 复现

A 与 A2 两次都在 launch 阶段就回了 handle，孩子都跑完并给出最终回复，但父会话收到的是：

```json
{"status":"failed","name":"v622-a2","execution":{"status":"failed",
 "reason":"worktree '/home/zzjcool/code/.pi-worktrees/v622-a2' belongs to host 'hw-nj': local filesystem and git operations on it are refused (a remote path may exist on this machine and mean something else; deliver through the shared git remote instead)"}}
```

这条文案只可能来自 `assertLocalWorktree`（`src/runs/remote.ts:611-619`），而 launch 路径里唯一的调用点是
**失败回滚**：`src/runs/orchestrator.ts:2029`

```ts
if (createdWorktree && worktreePath) removeChildWorktree({ repoCwd: this.cwd, dest: worktreePath });
```

`removeChildWorktree`（`src/runs/worktree.ts:311-324`）拿到的 `dest` 是**远端**路径，且没有传 `worktreeHost`，
于是它先抛守卫错 —— 这个错在 `throw error` 之前替换掉了**真正的失败原因**。
表现就是：孩子答得好好的，父会话只看到一句「这个 worktree 属于 hw-nj」，原始错误丢失（且远端 worktree 也回滚不了）。

### E2（major）`pi -p` 在失败落定后不退出

A：父进程 18:01:24 起，18:02:39 收到 failed 通知，到 18:08 仍存活（0.8% CPU，挂着 `hc connect` 子进程），
最后被手工 `kill -TERM`；日志里从未出现 `EXIT=`。
A2 用 `timeout -s TERM 240` 兜底（18:12:53 起，本该 18:16:53 到期），到期后 pi 仍未退出
（日志始终没有 `EXIT=` 行），最后手工 `pkill`。两次都不是「跑完了不退」，是**卡在落定/驶出**。

```
$ ps -o pid,etime,stat,pcpu -p 3697070
    PID     ELAPSED STAT %CPU
3697070       03:58 Sl    0.8
$ ps --ppid 3697070 -o pid,cmd
3697358 /root/.local/bin/hc connect
```

### E3（事实，不是缺陷）centurion 的 `worktree: false` 会被强制成 true

D1 那次我显式传了 `worktree: false`，仍然撞到交付预检。源码是刻意的：

```ts
// src/runs/orchestrator.ts:1469-1476
let worktree = isCenturion
	? (this.legion ? true : resolveLaunchWorktree({ … }))
```

顺带拿到 6.2.2 新文案的真身（`the directory it delivers from (<dir>)`，且不再建议改派 worker）：

```
✗ centurion: INVALID_PARAMS: cross-machine delivery needs a git checkout on this machine too, and the directory it delivers from (/tmp/v622-d) is not one. Two ways out: 1) run the launch from a checkout — start pi inside yours, or pass a relative cwd that points at one plus hostCwd for the directory ON that machine: subagent({ agent: "centurion", host: "hw-nj", cwd: "../my-repo", hostCwd: "/abs/path/on/hw-nj", task: "..." }); 2) dispatch the centurion instead and let IT create the worker on 'hw-nj' — a role outside subagents.crossMachine.allowRoles cannot be dispatched from this session at all (the default list is ["centurion"]), while a scout or a worker is created ON that machine by the centurion running there.
```

### E4（minor，与 6.2.2 无关但同场出现）父会话日志多一行

每次 `pi -p` 结束都打印：

```
Extension error (<boundary>): turn_end could not resolve the persisted assistant entry ID
```

这句是**宿主**在 `turn_end` 边界上打印的（`index.ts:2786-2800` 的注释把机制写得很清楚），
而 pi-legion 6.2.2 **刻意不注册** `pi.on("turn_end")`，就是为了让宿主没有理由跑那个边界：

```ts
// Deliberately NOT `pi.on("turn_end", ...)`.
// … it is also where it emits "turn_end could not resolve the persisted assistant entry ID"
// — a message it can only produce when `hasHandlers("turn_end")` is true …
```

所以在这一台机器上，是**本机环境里的其它扩展**（宿主侧还装了 pi-sysmon / pi-async / any-endpoint 等）
注册了 `turn_end`；容器里那个干净环境没有这行。只作记录，不归因到 6.2.2。

---

## F. 最小复现清单

| # | 场景 | 一条命令 | 期望 |
|---|---|---|---|
| A | 相对 cwd + 非仓库会话目录 | `cd /tmp && pi -p -a "$(cat /tmp/v622-prompt-A.txt)"` | launch 成功，无 `not one` 报错 |
| B | 不传 model 的回退 | 同上（A 的调用本身不传 model；远端清单需缺父机默认模型） | handle 上有 `⚠ … using '<x>' from that machine's listing` |
| C1 | 转录回传 | `wc -l /tmp/.pi-subagents/runs/<root>/remote/v622-a.jsonl` | > 0，含最终 assistant 文本 |
| C2 | 角色策略 | `cd /tmp/v622-c2 && pi -p -a "$(cat /tmp/v622-prompt-C2.txt)"` | `✗ scout: INVALID_PARAMS: …only 'centurion' may cross…` |
| D | 遗留 child 恢复 | 父进程 `timeout 75` 杀掉后，新会话 `subagent({action:"recover", name:"v622-d"})` | **实测** `No legion ledger in this session`（先 launch 一次后才读到 8/8 行，但仍不落定） |

---

## G. 结论

| 项 | 判定 | 一行证据 |
|---|---|---|
| A 相对 cwd + 非仓库会话目录 | **PASS** | `▶ v622-a (centurion) supervisor=terminal`，`cwd` = `/home/zzjcool/code/.pi-worktrees/v622-a`，无 `this session's directory is not one` |
| B 无 model 自动回退 | **PASS** | `⚠ v622-a: host 'hw-nj': model 'workbuddy/deepseek-v4.1-flash' is not visible there; using 'any-endpoint/workbuddy/hy4std' from that machine's listing (pin it with subagents.crossMachine.hosts.hw-nj.model)`；远端 `model_change` = `hy4std` |
| C transcript + 角色策略 | **PASS** | `remote/v622-a.jsonl` 8 行、末行 `hostname 是 593f64db2948，pwd 是 /home/zzjcool/code/.pi-worktrees/v622-a`；scout 被 `only 'centurion' may cross` 拒、`r-12dd728f` 下无孩子 |
| D 遗留 child 恢复 | **FAIL** | 新会话/`--session`/`-c` 三种入口都是 `No legion ledger in this session`；先 launch 一次后 `read-back from host 'hw-nj': 8 of 8 lines (complete)` 但仍判 `still 'live' … nothing was settled`（孩子进程已不存在） |

附带必须处理的（本报告第 E 节）：跨机 centurion 失败落定的**原因被 worktree 守卫覆盖**（E1，2/2 复现），
以及该情形下 `pi -p` **不退出**（E2）。

---

### 附录：本次现场的清场动作

- `~/.pi/agent/settings.json` 已从 `settings.json.bak-v622-verify` 还原（`hosts.hw-nj` 回到原值）；
- 临时机器注册已删：`hc machine rm hw-nj`（`hc machine ls --json` 回到 `{"machines":[]}`）；
- 容器 `v622-hw-nj` 已 `docker stop`（`docker rm -f v622-hw-nj` 可彻底清掉；
  重建步骤见 §0，仓库与 transcript 证据副本在 `/tmp/v622-logs/`）；
- 远端残留的 kept 终端（`hw-nj/t1..t3`）随机器注册删除而不可达，容器停止后一并消失。
