# xm-harness v1 — 跨机真机自测台（冻结契约）

状态：**FROZEN**（父会话冻结；worker 不得偏离，发现矛盾先回报，不得自行解释）
基线：`origin/master` `e9ed558`（6.2.1），分支 `feat/xm-harness`。
性质：**测试基建**。产品代码（`src/`、`index.ts`、`agents/`、`skills/`）**零改动**。

## 1. 为什么是它（问题陈述）

`test/helpers/fake-hc-core.mjs` 把「另一台机器」实现成同一个文件系统里的另一个根目录，
同一个进程树。因此最近三个只在真双机才暴露的 bug 在单测里全绿：

| bug | 只在真机上的原因 | 定位 |
|---|---|---|
| transcript 0 字节 | 父机预创建的空占位文件 vs 远端真 session | `src/runs/store.ts:280-300`、`src/runs/remote-artifact.ts:146-151` |
| 入口校验假阳性 | 校验的是父机路径，远端根本没有 | `src/runs/remote.ts` probe 链路 |
| 预检不认 cwd | 远端 `git -C <cwd>` 才是唯一事实 | `src/runs/cross-machine-preflight.ts:310-488` |

自测台必须提供：**两个容器、两套文件系统、两个进程树、一条真实网络传输**，并且用
`make xm` 一条命令、非交互、可断言地跑完。

## 2. 拓扑（已在本机实测通过，实际命令见 §6）

```
        docker network: xm-net (bridge)
        docker volume:  xm-origin → /srv/git (both containers)

  ┌──────────────── xm-parent ───────────────┐      ┌─────────── xm-remote ───────────┐
  │ hc (herdr-core, real binary)             │      │ sshd :22                        │
  │ pi 1.5.x + /plugin (this repo, ro mount) │      │ pi 1.5.x + /plugin (same mount) │
  │ /root/work  (git checkout, origin=…)     │      │ /root/work  (git checkout)      │
  │ /root/.pi/agent/{auth,models,settings}   │      │ (same creds mounted)            │
  └──────────┬───────────────────────────────┘      └──────────┬─────────────────────┘
             │ hc connect (JSON-RPC on stdio)                  │
             │   machine.exec / file.read / file.write         │
             └────────── ssh (hc core → remote hc) ────────────┘
                        terminal.run lands on remote fs
```

关键事实（全部实测，勿再猜）：

1. `hc` = **herdr-core**，本机 `/root/.local/bin/hc`（`hc 0.1.21`，静态链接，可在容器内直接跑），
   **不在 PATH**。真 hc 只通过 ssh 到目标机；`hc machine add --name <n> --install --temp <target>`
   会把 hc 拷到远端并起 agent（实测输出 `remote now has hc 0.1.21`）。
2. 产品的传输是 `hc connect` 上的 JSON-RPC（`src/hc/client.ts:36-49` allowlist），
   所以**必须**用真 hc + 真 ssh；用自造 RPC 服务端就等于另一个 fake core，不算数。
3. 父容器里 pi **必须跑在 hc 终端内**：`orchestrator.ts:1449-1462` 要求
   `HC_TERMINAL_SOCKET` + `HC_TERMINAL_ID`。非交互手段：`hc run --name X --timeout N --json -- bash -lc '…'`
   （实测：注入 `HC_TERMINAL_SOCKET=/root/.local/state/herdr-core/default/default.sock`、`HC_TERMINAL_ID=t1`，
   结束时返回 JSON，含 `wait.exit_code` 与 `output`）。
4. 镜像 `ghcr.io/zzjcool/pi-legion/tui-sandbox:latest` 已含 node24 / pi 1.5.0 / git / tmux，
   **缺 openssh-server + openssh-client**（`test/docker/Dockerfile.xm` 补）。
   它的 `/root/.pi/agent/settings.json` 里 `packages` 是 provider（`pi-any-endpoint`）与 `/plugin` 的注册来源，
   **覆盖写会静默丢掉全部模型**（实测：`pi --list-models` → `No models available`）。
   写 settings 必须 **merge**。
5. 交付预检（`cross-machine-preflight.ts`）要求：父机 cwd 是带 `origin` 的 checkout、远端 cwd 是
   git 仓库、两端 origin **归一化后同名**。因此用**共享 bare origin 卷** `/srv/git/app.git`
   挂进两个容器，两端 `origin` 都是同一路径字符串。
6. `/root/work` 是镜像预置的空提交仓库（`e0ea965`），两端同哈希 —— 双方 origin 指向同一个
   bare 仓库即可，不需要 clone。

## 3. 交付物与文件归属（并行 worker 的边界）

| 文件 | 归属 | 说明 |
|---|---|---|
| `test/docker/Dockerfile.xm` | W1 | `FROM` 沙箱镜像 + `openssh-server`/`openssh-client`；key-only ssh |
| `test/docker/xm-up.sh` | W1 | 建网络/卷、起两容器、merge settings、建 bare origin + 两端 origin、ssh 密钥、真 `hc machine add` |
| `test/docker/xm-down.sh` | W1 | 停/删两容器 + 网络（默认保留卷，`XM_KEEP=0` 时连卷删） |
| `test/docker/Makefile` | W1 | 新增 `xm-build` / `xm` / `xm-up` / `xm-down` / `xm-model`；`help` 自动收录 |
| `test/docker/xm/assert.mjs` | W2 | 四个断言的执行器，打印证据 JSON，失败 exit 1 |
| `test/docker/xm/drive.mjs` | W2 | 在 parent 容器内用 `hc run` 驱动 pi，产出可断言的落盘证据 |
| `test/docker/README.md` | W2 | 新增「跨机自测」一节 |
| `docs/runbooks/cross-machine-live-e2e.md` | W2 | 顶部加一句硬规定（见 §5.5） |
| `docs/reports/xm-harness.md` | 父会话 | 需要真实输出，父会话最后写 |

**W1 与 W2 共享的接口（冻结，不得改）**

- `xm-up.sh` 成功时向 stdout 打印最后一行：`XM_UP_OK parent=xm-parent remote=xm-remote host=remote hostCwd=/root/work`
- 环境变量（都可覆盖）：`XM_IMAGE`（默认 `pi-legion-xm:latest`）、`XM_NET`（`xm-net`）、
  `XM_VOL`（`xm-origin`）、`XM_PARENT`/`XM_REMOTE`（容器名）、`XM_HOST`（默认 `remote`）、
  `XM_HOST_CWD`（默认 `/root/work`）、`XM_MODEL`（默认 `workbuddy/hy4std`）、`HC_BIN`（默认
  `~/.local/bin/hc`，回退 `command -v hc`）。
- `assert.mjs` 只通过 `docker exec <parent> …` 与 `docker exec <remote> …` 取证，不假设宿主有 hc/pi。
- 失败时两个脚本都 `exit 1`，且把「哪一侧、哪条命令、原始输出」打出来。

## 4. 四个断言（不许放宽）

证据全部来自**容器内实测**，任何一条失败 → `exit 1` 并打印实测 JSON。

### a. 角色策略（两条，缺一不可）

a1. `scout + host=remote` 必须被拒，错误文案必须同时含：
`allowRoles`（原文片段，如 `"allowRoles"`）、被允许角色名 `'centurion'`、以及拒绝的角色名 `'scout'`。
证据源：`src/runs/orchestrator.ts:1490-1503`。
a2. 未知机器必须被拒并**列出可用机器清单**：`host=no-such-machine` 的错误必须含
`hc machine ls` 字样与真实机器名 `remote`。证据源：`src/runs/remote.ts:1957-1963`
（清单只出现在这条准入错误里，**不在 a1 的角色错误里** —— 这是产品现状，见 §7）。
断言必须断言 `parent` 侧**没有**产生远端 worktree（`git -C /root/work worktree list` 不含
`no-such-machine`/`scout` 相关新条目），确保是「拒绝」不是「静默改本地跑」。

### b. 零配置启动成功

settings 中除 `subagents.crossMachine.enabled: true` 外**不得**出现 `hosts` 条目。
`centurion + host=remote + hostCwd=/root/work` 必须启动成功：工具返回里能取到 child 名
（形如 `centurion-0`），且没有 `INVALID_PARAMS` / `refused` / `machine_unknown`。

### c. 产物落地在 remote

- `docker exec xm-remote git -C /root/work worktree list` 含 `/root/.pi-worktrees/<child>`
  且该行分支匹配 `pi-subagent/remote/<child>-<hex8>`（`remote-worktree.ts:76-78`）。
- `docker exec xm-remote test -d /root/.pi-worktrees/<child>/.git` 成立（真 checkout，
  证明是远端 `git worktree add`，不是父机自嗨）。
- 任务产物文件存在：任务的 child 在自己的 worktree 里写 `XM_READY.txt`（内容含唯一 nonce），
  `docker exec xm-remote test -s /root/.pi-worktrees/<child>/XM_READY.txt` 成立且内容含 nonce。

### d. transcript 回传（必须是最终文本，不是 launch 时快照）

- 父机 `runs/<runId>/remote/<child>.jsonl` 行数 > 0（`remote-artifact.ts:146-151`）。
- 该文件必须包含 **远端 session 里最后一条 assistant 文本**（从 remote 读
  `/root/.pi-worktrees/<child>/…session.jsonl` 的最后一条 assistant 消息）。
  `verify` 用：`mirror.includes(lastAssistantText)` 且 `lastAssistantText.length > 0`。
  这天然排除「launch 时快照」：快照里还没有这句话。
- mirror 的 mtime 必须晚于 launch 开始时间（父机时钟），证明是**事后**写的。

**不许**用 `<runDir>/<child>.jsonl`（父机预创建的空占位文件）当作通过证据 —— 那就是原来的
0 字节 bug。它必须被显式检查为「0 字节且不参与判定」，并在证据里打印出来作对照。

## 5. `make xm` 行为规范

```
cd test/docker && make xm          # 全流程：build(如需) → up → 四个断言 → 报告 → exit 0/1
make xm-up    / make xm-down       # 只起/只清
make xm XM_MODEL=workbuddy/deepseek-v4.1-flash
make xm-model                      # 额外一次「父机模型在远端不存在」
```

### 5.1 前置与失败模式

- 缺 docker → `SKIPPED: docker not available` + **exit 1**（不是 0）。
- 缺真 hc 二进制（`HC_BIN` 与 PATH 都没有）→ `SKIPPED: no herdr-core (hc) binary` + exit 1。
- 缺宿主 `~/.pi/agent/{auth.json,models.json}` → `SKIPPED: no host pi credentials` + exit 1。
- 缺插件 provider（容器里 `pi --list-models` 为空）→ 直接 FAIL（这是环境坏，不是 skip）。

### 5.2 耗时

镜像已存在时 ≤ 4 分钟（两容器起来 + 1 次真实派发 + 1 次模型调用）；首次 build ≤ 6 分钟。
默认单次模型调用（`XM_MODEL` 可换）；断言 a 用两次短调用。

### 5.3 只看这几行判断通过

```
XM_ASSERT a1 PASS  role-policy
XM_ASSERT a2 PASS  machine-list
XM_ASSERT b  PASS  launch
XM_ASSERT x0 PASS  the parent pi --print exits on its own
XM_ASSERT c  PASS  remote-artifact
XM_ASSERT d0 PASS  zero-config collect delivers the transcript
XM_ASSERT c2 PASS  remote-artifact          （Run B）
XM_ASSERT d  PASS  transcript-readback      （Run B）
XM_ASSERT d1 PASS  collect on a remote child delivers
XM_ASSERT x0 PASS  the parent pi --print exits on its own  （Run B）
XM_ALL_PASS run=r-xxxx,r-yyyy child=centurion-0,centurion-b
```

任何 `FAIL` 后面必须紧跟 `evidence:` 一行 JSON。

### 5.3.1 d0 / d1（原 known-gap，6.2.3 翻成正向）

这两条曾是「钉住现状」的断言（产品有 bug 时它们 PASS，修好后变红）。6.2.3 修掉了两个 bug，
断言随之翻成正向 —— **不要再把它们改回 known-gap**：

- **d0（Run A，零配置）**：settings 只有 `subagents.crossMachine.enabled: true`。要求 `collect`
  真的把 transcript 拉回来：`<runDir>/remote/<child>.jsonl` 行数 > 0、**包含远端 session 最后
  一条 assistant 文本**、collect 文本里有 verdict 行，且**不出现**任何旧拒绝句
  （`collect failed` / `belongs to host` / `local filesystem and git operations on it are refused`
  / `has no entry in subagents.crossMachine.hosts`）。根因是 read-back 用了 launch 解析器
  （要求 `hosts.<h>.cwd`），修法是 `resolveReadTarget`（读只需要 host）。
- **d1（Run B，有 `hosts.remote`）**：要求 collect **出 verdict**：read-back 行（`read-back from
  host '<h>': N of M lines`）、`execution:` 行、child 自己的最后文本，且无 ownership 句子。
  根因是 `assertLocalWorktree(child)` 无条件站在验收路径上（跨机 child 拥有自己的树）；修法是把
  D13 守卫收窄到「本机 fs/git 操作」。
- **x0（Run A + B）**：父 `pi --print` 必须**自己退出**（`rc` 落盘、`natural_exit=true`、
  `killed=false`）。`runParentStep` 曾经为这个缺陷写了容错（等 sentinel 然后自己 kill 终端），
  现在把「有没有被 kill」变成断言：`killed` 即失败。根因是终端后端的会话级 `hc connect`
  从未关闭，而 `pi --print` 靠事件循环排空退出。

### 5.4 `make xm-model`

跑一次 `centurion + host=remote + model=<远端不存在的模型>`，断言：
- 现状（回退逻辑未合入）：必须以 `model-missing` 类错误拒绝，错误里**列出远端可见模型**
  （`terminal-supervisor.ts:767-780`），且 **不** 产生远端 worktree。
- README 里标注：`待远端模型回退逻辑合入后翻绿`（把断言从「拒绝」改成「回退 + warning」）。
- 该 target 失败 = `exit 1`，不许静默 skip。

### 5.5 回路约束（写进 runbook 顶部）

```
> 硬规定：任何跨机改动的交付，必须附 `cd test/docker && make xm` 的实测输出（含
> `XM_ALL_PASS` 那一行）；没有实测输出的跨机改动不算完成。
```

## 6. 已实测通过的命令序列（W1 照抄，别改顺序）

```bash
# 1. 镜像：沙箱镜像 + openssh（key-only）
docker build -t pi-legion-xm:latest -f test/docker/Dockerfile.xm .

# 2. 网络 + 共享 origin 卷
docker network create xm-net
docker volume create xm-origin

# 3. 两容器（同一镜像；parent 挂插件与宿主凭据）
docker run -d --name xm-remote --hostname remote --network xm-net \
  -v "$ROOT:/plugin:ro" -v xm-origin:/srv/git \
  -v "$AGENT/auth.json:$AGENT/auth.json:ro" -v "$AGENT/models-store.json:$AGENT/models-store.json" \
  -v "$AGENT/models.json:$AGENT/models.json:ro" -e HOME=/root \
  pi-legion-xm:latest /usr/sbin/sshd -D -e
docker run -d --name xm-parent --hostname parent --network xm-net \
  -v "$ROOT:/plugin:ro" -v xm-origin:/srv/git \
  -v "$AGENT/auth.json:$AGENT/auth.json:ro" -v "$AGENT/models-store.json:$AGENT/models-store.json" \
  -v "$AGENT/models.json:$AGENT/models.json:ro" -e HOME=/root \
  pi-legion-xm:latest sleep infinity

# 4. settings：MERGE（不是覆盖）crossMachine.enabled
#    见 test/docker/xm/settings-merge.mjs

# 5. 共享 bare origin + 两端同名 origin
git init -q --bare /srv/git/app.git           # 在 parent 里
git -C /root/work remote add origin /srv/git/app.git
git -C /root/work push -q origin HEAD:master  # 两端都执行（同一 baseline 提交，幂等）

# 6. ssh 密钥（parent → remote）
ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519
#   remote 的 /root/.ssh/authorized_keys 由 up.sh 用 docker exec 灌入（bootstrap，不是产品路径）
#   parent 的 /root/.ssh/config: Host remote → HostName remote, User root, IdentityFile …

# 7. 真 hc 注册（在 parent 容器里）
hc machine add --name remote --install --temp --json remote   # → remote now has hc 0.1.21

# 8. 驱动（在 parent 容器里，产出落盘）
hc run --name xm-scenario --timeout 850 --json -- bash -lc 'cd /root/work && pi --model $MODEL --print …'
```

**实测断言证据样例（本机已跑出）**

```
hc read probe3                      → RESULT: centurion-0 async (launched; completion queued)
hc exec --on remote "git -C /root/work worktree list"
  /root/work                        e0ea965 [master]
  /root/.pi-worktrees/centurion-0   e0ea965 [pi-subagent/remote/centurion-0-d2fbae02]
```

## 7. 已知偏差与硬限制（必须写进 README + 报告，不许静默）

1. **可用机器清单不在角色错误里**：a1 的角色拒绝文案含 `allowRoles` 与角色名，
   清单在 a2 的准入错误里。契约要求两条都断言（比原任务表述更严），不得合并成一条。
2. **`hc` 二进制必须由宿主提供**：容器不联网装 herdr-core（npm 上 `herdr` 是 0.0.0 占位）。
   没有它的机器上 `make xm` 只能 `SKIPPED` + exit 1。这是本自测台的**硬限制**，报告里要写明。
3. **ssh 是 hc 的传输层**，因此 `openssh-server` 必须在镜像里；`hc machine add --install`
   会把 hc 拷到远端。远端容器重建后需重跑 `make xm-up`。
4. **模型凭据来自宿主**（`~/.pi/agent/auth.json` + `models.json` + `models-store.json`）。
   容器里 `pi --list-models` 为空 → 不能 skip，直接 FAIL（环境坏）。
5. **`make xm` 会真花钱**（1–2 次模型调用）。CI 不跑，它属于 `test:docker` 家族。
6. **`--print` 依赖模型正确调用工具**；模型胡来时先看 `XM_RAW` 原始输出。
   `XM_MODEL` 可换更稳的模型。断言本身不看模型自由度，只看落盘事实。

## 8. 验收（合并门禁）

- `npm run typecheck` 绿。
- `npm run test` 绿（本改动不碰 `src/`，必须零回归）。
- `npm run test:integration` 绿。
- `cd test/docker && make xm` **在本机跑通**，输出贴进 `docs/reports/xm-harness.md`。
- 没有产品代码改动（`git diff --stat origin/master -- src/ index.ts` 为空）。

---

# 修订 v1.1（父会话，2026-11-18）— 驱动必须是确定性的

## 为什么改（实测证据）

真模型驱动**不可靠**，两次实测都失败但方式不同：

1. `workbuddy/deepseek-v4.1-flash`：完全忽略 `host=remote`，直接在父机本地起了
   `centurion-1`（`run.json` 里无 `host` 字段、worktree 在
   `/root/work/.pi-subagents/runs/<id>/worktrees/…`）。自测台会「绿」但**根本没跨机**。
2. `workbuddy/hy4std`：第一次正确（`remote/t1`、`pi-subagent/remote/centurion-0-d2fbae02`），
   第二次却本地起了同名 child（`spawnMode: "terminal"`、无 `host`）。

结论：**模型自由度过高 = 断言在测模型，不是在测产品**。`make xm` 必须用仓库自带的
`test/mock-llm`（`--script` 支持精确 `tool_call` 参数）驱动，模型输出不参与变量。

## 冻结的驱动设计

两个 mock 监听在 **parent 容器**里，远端通过 docker DNS 访问：

| 谁 | provider baseUrl | 端口 | 脚本职责 |
|---|---|---|---|
| parent pi | `http://parent:8765/v1` | 8765 | 第 0 轮 → `subagent{agent:centurion, host:remote, hostCwd:/root/work, task:…}`；第 1 轮 → `subagent{action:"wait", all:true}`；第 2 轮 → 文本 `RESULT: done` |
| remote child | `http://parent:8766/v1` | 8766 | 第 0 轮 → `bash{command:"printf … > XM_READY.txt"}`；第 1 轮 → 文本（含 `XM_CHILD_FINAL` 标记） |

- **两个端口 = 两套脚本 = 零角色歧义**。不要用 `when.role` / `turnIndex` 去区分父子
  （父的 tool result 会把 child 的任务文本带回来，`promptIncludes` 会串味）。
- 每个容器**各自一份 `models.json`**：provider id 与 model id 都必须**跨机同名**
  （父机 argv 里传的 `<provider>/<model>` 要在远端能解析），只有 `baseUrl` 不同。
  `/plugin` 仍共享同一个 ro 挂载。
- parent 与 remote 的 `settings.json` 都要 `defaultModel: "xm/flash"`（或按次 `--model xm/flash`），
  并保留镜像原有的 `packages`（merge，不覆盖）。
- 每轮断言用的 nonce 由 `assert.mjs` 随机生成并塞进 mock 脚本（`{{NONCE}}` 占位），
  远端 `.pi-worktrees/<child>/XM_READY.txt` 的内容必须含它 —— 这条同时证明
  「文件真的在远端写的」和「是本轮写的」。

## 场景（同一套拓扑，换脚本 + 换断言）

| 场景 | 脚本差异 | 断言 |
|---|---|---|
| `launch`（`make xm` 默认） | 父轮0 用 `agent=centurion, host=remote` | a1 / a2 / b / c / d |
| `model-missing`（`make xm-model`） | 远端 `models.json` **不含**该 model id | 远端 `pi --list-models` 无该 model；派发被 `model-missing` 拒绝且错误里列出远端可见模型；远端不产生新 worktree |

`make xm-real` 保留为**可选**：用真模型跑同一套断言，失败不算门禁失败，只打印
`XM_REAL_FAIL（模型自由度导致，非产品缺陷）`。

## 断言 a1/a2 用 mock 怎么产生

- a1：脚本第 0 轮发 `subagent{agent:"scout", host:"remote"}`，断言父侧工具结果为
  `INVALID_PARAMS` 且含 `allowRoles`、`'centurion'`、`'scout'`。
- a2：另一个 `make` 子步骤，脚本发 `subagent{agent:"centurion", host:"no-such-machine"}`，
  断言错误含 `hc machine ls` 与真实机器名 `remote`。
  两条都用**独立 mock 端口/独立 pi 进程**，互不干扰（8767 / 8768）。

## 文件归属 v1.1

- `test/docker/xm-up.sh`、`test/docker/Makefile` 的 xm target：**W2 现在可以改**
  （mock 服务、双 models.json 属于拓扑的一部分）。
- `test/docker/xm/**`：W2。
- `test/docker/README.md`、`docs/runbooks/cross-machine-live-e2e.md`：W2。
- `docs/reports/xm-harness.md`：父会话。
