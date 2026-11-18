# 跨机真机自测台（`make xm`）

状态：**已在本机跑通**（2026-11-18；基线 `origin/master` `4611ce3` = 6.2.2）
契约：`docs/contracts/xm-harness-v1.md`（含 v1.1 确定性驱动修订）
入口：`cd test/docker && make xm` / `make xm-model`

---

## 1. 为什么要有它

仓库里所有跨机用例都跑在 `test/helpers/fake-hc-core.mjs` 上：**同一个进程、同一台机器**，
只是把 `FAKE_HC_REMOTE_ROOT` 指到另一个目录，然后脚本说这是「另一台机器」。它能证明协议形状，
不能证明：

- 真 `hc` 会不会把 `on` 送到另一台机器；
- 远端 shell 是不是真的在目标目录里起来的；
- 远端写出的 transcript 能不能被父机读回来。

最近三个只在真双机才暴露的 bug 都栽在这里：

| bug | 单机测试为什么绿 | 真机才暴露的部分 |
|---|---|---|
| transcript 0 字节 | fake core 的「远端」就是本机路径，父机预创建的空占位文件看起来像转录 | 远端 session 与父机占位文件是**两个文件系统上的两个文件** |
| 入口校验假阳性 | 校验的路径在「本机」真的存在 | 远端根本没有那个文件 |
| 预检不认 cwd | `git -C <cwd>` 在本机一定成功 | 远端的 cwd 可能是空的 / 不是仓库 / origin 不同 |

`make xm` 把这三件事变成可以断言的事实。**它不需要人肉开两台机器**：两个容器就是两台机器。

## 2. 拓扑

```
                     docker network xm-net (bridge)
                     docker volume  xm-origin → /srv/git

  ┌──────────────────── xm-parent ─────────────────────┐
  │  hc (herdr-core 0.1.21, 静态二进制，宿主拷入)       │
  │  pi 1.5.x + /plugin (= 本仓库, ro 挂载)             │
  │  models.json → http://parent:8765/v1 (mock 父机脚本) │
  │  /root/work   git checkout, origin=/srv/git/app.git │
  │  /root/.pi/agent/{auth,models-store,settings}       │
  └───────────┬─────────────────────────┬──────────────┘
              │ hc connect (JSON-RPC)   │ ssh (hc 的传输层)
              │ machine.exec            │
              │ file.read / file.write  │
              │ terminal.run            ▼
  ┌───────────┴─────────────────────────────────────────┐
  │  xm-remote                                          │
  │  sshd :22 · pi 1.5.x + /plugin · git 2.39           │
  │  models.json → http://parent:8766/v1 (mock 子机脚本) │
  │  /root/work   git checkout, origin=/srv/git/app.git │
  │  /root/.pi-worktrees/<child>  ← 真 worktree 在这里   │
  └─────────────────────────────────────────────────────┘
```

要点（全部实测，不是设计意图）：

1. **传输是真的**：父机 `hc` 通过 ssh 连到远端 core，`machine.exec` / `file.read` / `file.write`
   / `terminal.run` 跨网络往返。远端 `pi` 是远端容器里真的进程。
2. **文件系统是两套**：远端 worktree `/root/.pi-worktrees/<child>` 只在 `xm-remote` 里存在；
   父机侧写的是 `runs/<id>/remote/<child>.jsonl`（mirror）。
3. **共享 origin 是必需的**：交付预检（`src/runs/cross-machine-preflight.ts`）要求两端
   `origin` 归一化后同名，否则派发在预检就被拒。所以 `xm-origin` 卷挂在两侧 `/srv/git`。
4. **两个 mock 端口 = 零歧义**：8765 给父机 pi 的脚本，8766 给远端 child 的脚本。
   父机 pi 的 tool result 会把 child 任务文本带回来，所以**不能**用 `promptIncludes` /
   `role` 区分父子，只能分端口 —— 否则父子脚本互相串味。

## 3. `make xm` 输出原文（2026-11-18，6.2.2，exit 0）

```
XM_STEP preflight
XM_STEP hc=/root/.local/bin/herdr-core hc 0.1.21
XM_STEP image present pi-legion-xm:latest
XM_STEP models dir /tmp/xm-models.XXXXXX scenario=launch
XM_MODELS_WRITTEN out=/tmp/xm-models.XXXXXX/parent/models.json providers=any-endpoint,xm xm=yes baseUrl=http://parent:8765/v1 models=flash stripped_api_keys=0
XM_MODELS_WRITTEN out=/tmp/xm-models.XXXXXX/remote/models.json providers=any-endpoint,xm xm=yes baseUrl=http://parent:8766/v1 models=flash stripped_api_keys=0
XM_STEP cleanup (idempotent) xm-parent xm-remote xm-net xm-origin
XM_STEP models-store copied per container (parent/remote)
XM_STEP run xm-remote (sshd :22)
XM_STEP run xm-parent
XM_STEP sshd ready remote:22
XM_SETTINGS_MERGED path=/root/.pi/agent/settings.json existed=true packages=2 keys=defaultModel,defaultProvider,packages,subagents
XM_SETTINGS_MERGED path=/root/.pi/agent/settings.json existed=true packages=2 keys=defaultModel,defaultProvider,packages,subagents
/srv/git/app.git
/srv/git/app.git
XM_STEP authorized_keys lines=1
XM_STEP ssh config xm-parent:/root/.ssh/config → Host remote
XM_STEP ssh xm-parent → remote 通
hc 0.1.21
hc: no systemd user manager here: the core ends with whatever started it
remote now has hc 0.1.21
{"host":"remote", … "version":"0.1.21","via":false}
XM_STEP parent models=3 (XM_MODEL=workbuddy/hy4std)
XM_STEP hc machine ls 含 remote
XM_UP_OK parent=xm-parent remote=xm-remote host=remote hostCwd=/root/work
XM_DRIVER mock model=xm/flash scenario=launch
XM_SETTINGS XM_SETTINGS_MODE path=/root/.pi/agent/settings.json mode=zero-config host=remote hosts=no packages=2
XM_ASSERT a1 PASS role-policy
XM_ASSERT a2 PASS machine-list
XM_ASSERT b PASS launch
XM_ASSERT c PASS remote-artifact
XM_GAP {"id":"d0","child":"centurion-0","mirror_path":"…/runs/r-d081cab2/remote/centurion-0.jsonl","mirror_bytes":0,"gap_signature":"local filesystem and git operations on it are refused","ownership_guard":true,"collect_result":"collect failed: SubagentError: worktree '/root/.pi-worktrees/centurion-0' belongs to host 'remote': local filesystem and git operations on it are refused (a remote path may exist on this machine and mean something else; deliver through the shared git remote instead)"}
XM_ASSERT d0 PASS known-gap: zero-config collect refused by the worktree-ownership guard, masking the missing hosts.<name> read-back (src/runs/remote.ts:976-982)
XM_SETTINGS XM_SETTINGS_MODE path=/root/.pi/agent/settings.json mode=host-entry host=remote hosts=yes packages=2
XM_ASSERT c2 PASS remote-artifact
XM_CONTRAST {"child":"centurion-b","mirror_path":"…/runs/r-530bd963/remote/centurion-b.jsonl","mirror_bytes":38778,"mirror_lines":8,"mirror_mtime":1795027470,"launch_start":1795027466,"collect_failed":true,"placeholder_path":"…/runs/r-334a05a0/centurion-b.jsonl","placeholder_bytes":0,"parent_run_placeholder_path":"…/runs/r-530bd963/centurion-b.jsonl","parent_run_placeholder_bytes":0,"placeholder_used":false}
XM_ASSERT d PASS transcript-readback
XM_GAP {"id":"d1","child":"centurion-b","mirror_path":"…/runs/r-530bd963/remote/centurion-b.jsonl","mirror_bytes":38778,"signature":true,"collect_result":"collect failed: SubagentError: worktree '/root/.pi-worktrees/centurion-b' belongs to host 'remote': local filesystem and git operations on it are refused …"}
XM_ASSERT d1 PASS known-gap: collect on a remote child is refused by assertLocalWorktree (src/runs/orchestrator.ts:3515)
XM_ALL_PASS run=r-d081cab2,r-530bd963 child=centurion-0,centurion-b
XM_EXIT=0
```

耗时：镜像已存在时 **1 分 10 秒 – 3 分 40 秒**（热缓存实测 48s；x86_64 Linux / Docker 29.9.0）。
`make xm` 一共 **4 次** mock 驱动的 pi 运行（a1、a2、launch-a、launch-b）。

## 4. `make xm-model` 输出原文（exit 0）

```
XM_STEP models-store: parent copied, remote emptied (model-missing scenario)
XM_MODELS_WRITTEN …/remote/models.json providers=any-endpoint,xmock xm=no baseUrl=http://parent:8766/v1 models=other
XM_STEP parent models=3 (XM_MODEL=workbuddy/hy4std)
XM_STEP hc machine ls 含 remote
XM_UP_OK parent=xm-parent remote=xm-remote host=remote hostCwd=/root/work
XM_DRIVER mock model=xm/flash scenario=model-missing
XM_ASSERT m1 PASS remote-model-absent
XM_ASSERT m2 PASS fallback-warning
XM_ASSERT m3 PASS fallback-is-real
XM_ASSERT m4 PASS no-local-fallback
XM_ALL_PASS run=r-f9d0808b child=centurion-0
XM_MODEL_EXIT=0
```

**这条 target 已经翻成正向**：6.2.2 的 `567417a feat(cross-machine): fall back to a model on the
target instead of refusing` 把「远端没有该模型」从硬拒绝改成**回退 + 一条 warning**，
所以断言从「必须拒绝」换成「必须回退」。四条：

| id | 断言 | 证据来源 |
|---|---|---|
| m1 | 远端模型表**没有**父机请求的 `xm/flash` | 远端 `pi --list-models` |
| m2 | 派发**成功**且工具结果含三句语义：`model 'xm/flash' is not visible there` / `using 'xmock/other' from that machine's listing` / `subagents.crossMachine.hosts.remote.model`（可粘贴的 pin 位置） | subagent 工具结果（warning 由 `src/runs/remote.ts:997-1004` 生成） |
| m3 | 远端 child 转录里的 `provider`/`model` 就是 `xmock`/`other`，且远端新增 `pi-subagent/remote/…` worktree | 远端 session + `git worktree list` |
| m4 | 父机**没有**无 `host` 的 child —— 回退发生在目标机，不是偷偷本地跑 | `run.json` |

确定性来自三个实测事实（缺一个就不可重复）：
1. 远端 `models.json` 必须**整条缺 provider**（pi 对「已知 provider + 未注册 id」只答
   `Using custom model id`，产品探针明确不判拒绝，见 `src/runs/remote.ts:871-878`）；
2. 远端模型表**只有一行**且由 mock 提供（`planRemoteModelFallback` 是「同 provider 优先，否则第一行」）；
3. model-missing 场景要**清空远端 `models-store.json`**，否则宿主缓存的真实模型排在最前，
   回退会落到真模型（第一版就这么翻车过，证据见下）。

## 5. 四个断言（任务要求）各自的证据

### a1 角色策略（Run A / 零配置）

mock 直接发 `subagent{agent:"scout", host:"remote"}`。断言：工具结果文本同时含
`allowRoles`、`'centurion'`、`'scout'`，且 `run.json` 没有创建 child，且远端
`git worktree list` 无新增。产品依据 `src/runs/orchestrator.ts:1490-1503`。

> 任务原文要求「错误里含 allowRoles 与可用机器清单」。实测产品把**清单放在准入错误**
> （`src/runs/remote.ts:1957-1963`），角色错误里没有清单。所以拆成 **a1 + a2 两条**
> （更严，不是更松），a2 单独断言清单。

### a2 可用机器清单（Run A）

mock 发 `subagent{agent:"centurion", host:"no-such-machine"}`。断言：错误文本含
`hc machine ls` **和**清单片段 `lists: remote`（不用裸单词 `remote` —— 那在本仓库文案里到处都是），
同样无 child、无新远端 worktree。

### b 零配置启动（Run A）

settings 里**只有** `{"subagents":{"crossMachine":{"enabled":true}}}`（`XM_SETTINGS … hosts=no` 是证据）。
断言：派发工具的**那条结果**不是错误、不含 `INVALID_PARAMS`/`refused`/`machine_unknown`，
且 `run.json` 里确实有 `host=remote` 的 child。

> 这条被 reviewer 抓过一次：第一版扫的是 pi 的 stdout，而工具错误根本不在那个字段里 → 恒真。
> 现在扫的是 subagent 工具结果本身（`text` + `isError`）。

### c 产物落地在远端（Run A）+ c2（Run B）

- 远端 `git -C /root/work worktree list` 出现 `/root/.pi-worktrees/<child>`，该行分支匹配
  `pi-subagent/remote/<child>-<hex8>`；`git rev-parse --show-toplevel` 指向该 worktree、
  `--abbrev-ref HEAD` 是那条分支（真 checkout，不是父机自嗨）。
- 任务产物：child 在**自己的 worktree 里**写 `XM_READY.txt`，内容含**本轮随机 nonce**，
  所以既不可能是上一轮残留，也不可能是父机写的。
- 产品依据：`src/runs/remote-worktree.ts:76-78`、`:753-763`。

> 契约 §4c 原文写 `test -d <worktree>/.git`；linked worktree 的 `.git` 是**文件**，
> 实现改成 `test -e` + `rev-parse`（更强），契约里已注明。

### d 转录回传（Run B）——必须是最终文本

```
XM_CONTRAST {"mirror_bytes":38778,"mirror_lines":8,
             "mirror_mtime":1795027470,"launch_start":1795027466,
             "collect_failed":true,
             "placeholder_bytes":0,"parent_run_placeholder_bytes":0,
             "placeholder_used":false}
```

- `runs/<runId>/remote/<child>.jsonl` 存在、38778 字节、8 行 JSONL。
- 内容包含**远端 session 里最后一条 assistant 文本**（`XM_CHILD_FINAL_<nonce>`）——
  这句话 launch 时还不存在，所以「launch 时快照」不可能通过。
- mirror 的 mtime 晚于 launch 开始；`mirror_seen_ms_after_start` 也进 evidence。
- 对照组：父机预创建的空占位（child 自己的 run 目录 + **父 run 目录**下各一份）**都是 0 字节**，
  且明确 `placeholder_used: false`。那正是原来「0 字节 bug」的文件，现在只能当反例。

## 6. 它发现了什么（这次就发现了 5 件事）

1. **真模型不能当测试驱动**：`workbuddy/deepseek-v4.1-flash` 完全忽略 `host=remote`，直接在父机
   本地起 child（`run.json` 无 `host`、worktree 在 `runs/<id>/worktrees/…`）；
   `workbuddy/hy4std` 一次对一次错。不修的话 `make xm` 会「绿」但根本没跨机 —— 测试测的是模型。
   修法：mock 双端口脚本驱动。
2. **`d0`：零配置 collect 连 fetch 都没有**。read-back 用同步 `resolveHostTarget`
   （`src/runs/remote-artifact.ts:199`），它要求 `hosts.<name>`（`src/runs/remote.ts:976-982`）。
3. **`d1`：collect 一个远端 child 必被工作树归属守卫拒**。`finishCollect` 在
   `src/runs/orchestrator.ts:3572` 无条件 `assertLocalWorktree(child)`，远端树必然命中。
   **转录其实是拿得到的**（mirror 由 collect 开头的 `refreshRemoteSession` 写出，`:3036`），
   但 collect 本身返回失败 —— 两个事实必须分开断言，否则「绿」会和自己的证据相反
   （reviewer 的 critical 就是这一条）。6.2.2 的 `recover` 没有修掉它。
4. **镜像 reset 坑**：沙箱镜像 `settings.json` 里的 `packages` 是 provider（`pi-any-endpoint`）
   与 `/plugin` 的注册来源；覆盖写会让 `pi --list-models` 变空而**退出码仍是 0**。
   自测台因此强制 merge，并把「模型数=0」判成 FAIL 而不是 skip。
5. **交付预检要 origin**：第一次真派发就撞上 `/root/work has no git origin, so no child was
   spawned`。共享 bare origin 卷由此而来。

另外两条是调试成本，不是产品 bug，但写进 README 免得下一个人重踩：
`waitSettled` 对远端 child 的 `turn > promptTurn` 判据（`terminal-supervisor.ts:1076`）在
`status.done && turn==1` 时永不成立（所以驱动改用 `hc wait` + `collect`）；
`docker exec` 阻塞被杀会把 hc core 一起带走（所以驱动用 `docker exec -d` + 轮询）。

## 7. 已知限制（哪一步在没有真 hc 的环境下不可用）

| 限制 | 事实 | 没有它时 |
|---|---|---|
| **`hc` 必须由宿主提供** | `hc` = herdr-core；npm 上 `herdr` 是 `0.0.0` 占位包，不能从 registry 装。本机在 `/root/.local/bin/hc`（0.1.21，静态链接，已在容器内实测可跑） | `SKIPPED: no herdr-core (hc) binary` + **exit 1** |
| **ssh 是 hc 的传输层** | 远端容器必须跑 `sshd`（`Dockerfile.xm` 装 openssh），`hc machine add --install` 把 hc 拷过去 | ssh 不通 → `XM_FAIL`，不静默降级 |
| **需要 docker** | 两容器 + 网络 + 卷 | `SKIPPED: docker …` + exit 1 |
| **真模型凭据** | `make xm` / `make xm-model` 不需要（全 mock）；`make xm-real` 需要 `~/.pi/agent/{auth,models}.json` 两者齐全 | 缺 → `SKIPPED: no host pi credentials` + exit 1 |
| **CI 不跑** | 与 `test:live` 同级（`ci.yml` 明写 “not in this job: test:live, test:docker”） | 门禁仍靠 typecheck + 单测 + integration |
| **`make xm-real` 非门禁** | 模型自由度会导致 `XM_REAL_FAIL` | 不影响 `make xm` |

## 8. 复现

```bash
cd /root/code/pi-legion-wt/xm-harness/test/docker
make xm            # 全流程（镜像缺则先 build）：1–4 分钟
make xm-model      # 远端模型不可见 → 回退 + warning（约 30 秒）
make xm-down       # 清理（卷保留；XM_KEEP=0 连卷删，/tmp/xm-models.* 一并清）
```

调试单步：

```bash
make xm-up         # 只起拓扑，末行 XM_UP_OK
docker exec -it xm-parent bash -lc 'export PATH=/usr/local/bin:$PATH; hc machine ls; hc ls'
docker exec xm-remote bash -lc 'git -C /root/work worktree list; ls /root/.pi-worktrees'
```

## 9. 门禁（本分支，rebase 到 6.2.2 之后）

- `npm run typecheck` → 0
- `npm run test` → **fail 0**（2635+ pass）
- `npm run test:integration` → **fail 0**（173 pass）
- `git diff --stat origin/master -- src/ index.ts` → **空**（本卡零产品代码改动）

## 10. review

一轮对抗式 review 提了 13 条（1 critical + 2 major + 10 minor），全部修复在
`test/docker` 内（`541b80a`），其中 critical 就是 §6 第 3 条「d 绿但 collect 真失败」——
那条如果没人指出，自测台会长期给出与自己的 evidence 相反的绿灯。
