# 容器化测试（test/docker）

把本仓库源码挂进干净容器，验证「模型能调通 + 插件真加载 + legion 工具真注册」。
镜像固化 pi + `pi-any-endpoint` + TUI 取证工具链，`~/.pi/agent/bin` 不再需要联网下载 rg/fd。

模式对齐 [`pi-async/test/docker`](https://github.com/zzjcool/pi-async/tree/master/test/docker)
（那边已跑通 40+ issue，别自创）。

## 一键用法

```sh
cd test/docker
make run          # 起容器 + 直接进入 pi（真模型）—— 日常用这个
make it           # 同上（别名）
make help         # 全部目标
```

容器已在跑就复用，不重建、不丢会话状态。换模型：`make run MODEL=workbuddy/gpt-6-luna`。

**其余目标：**

```sh
make build        # 构建镜像（>300s，tee 到 /tmp/pi-legion-build.log）
make up           # 只起容器，不进 pi
make smoke        # 三层冒烟：模型可达 → 插件加载 → legion 工具注册
make print PROMPT="你好"   # 非交互问一句
make shell        # 只进容器 bash
make status       # 容器 + 镜像状态
make clean        # 删容器（镜像保留）

make tui-visual   # mock 模型确定性 TUI 回归

make xm           # 跨机伪真机自测台：两容器 + 真 hc + 真 ssh，跑四个断言（见下）
make xm-model     # 跨机特例：远端没有该模型时回退到目标机可见模型（6.2.2）+ warning
make xm-real      # 同上但用真模型驱动（非门禁：模型自由度会失败）
make xm-up        # 只起双容器拓扑（调试用）
make xm-down      # 清掉双容器 + 网络（卷默认保留）
```

路径全部从 Makefile 位置反推仓库根，不硬编码 `/root/...`。

## 改完插件代码后怎么测（agent 可执行）

`/plugin` 是**宿主源码的只读挂载**，所以改代码**不需要重建镜像**——重建只在改了
`Dockerfile`、或镜像里烧的 pi 版本要换时才有意义。

```sh
cd test/docker
make rebuild     # 只在改 Dockerfile / 换 pi 版本时；>300s，日志 /tmp/pi-legion-build.log
make up          # 起容器（不进 pi）。rebuild 会删掉容器，这两步别漏
make smoke       # L1 模型 → L2 插件真加载 → L3 subagent 工具注册 → L4 worktree 角色可跑
make rpc         # 11 个 RPC 主线 verify；改了 args.ts / 子进程 argv 时必须跑
```

`make run` 是**交互 TUI**（`docker exec -it`），要真终端；agent / CI 用 `make print`，
或下面这些 `docker exec … --print`。

### 探针一：子 agent 真实的工具表

```sh
docker exec pi-legion-real pi --model workbuddy/hy4std --print \
  '调用 subagent 派一个 scout，task 原样传：“列出你当前可用的工具名（逗号分隔，不要猜），\
并回答：有没有 codemode / legion_mail / 任何 mcp__ 开头的工具。”把它的输出原样贴出来。'
```

### 探针二：MCP 工具（**必须走 codemode**）

MCP 工具的默认 `exposure` 是 `codemode`→`deferred`，**不进程工具列表**，所以「探针一」
里自报工具表永远看不到 `mcp__*`——用 codemode 脚本数 `ALL_TOOLS` 才是真信号：

```sh
docker exec pi-legion-real pi --model workbuddy/hy4std --print \
  '派一个 scout，task：“用 codemode 跑：const hits = ALL_TOOLS.filter(t => t.name.startsWith("mcp__")).map(t => t.name); return hits.length ? hits.length + ":" + hits.join(",") : "NONE"; 把输出原样贴出。”'
```

容器里**默认没有 MCP 配置**（`run-tui-real.sh` 只挂 `auth.json` / `models-store.json`），
要测得先把宿主配置塞进去：

```sh
docker cp ~/.pi/agent/mcp.json pi-legion-real:/root/.pi/agent/mcp.json
```

关掉兜底开关再测一遍，应当一个都没有：

```sh
docker exec -e PI_LEGION_CHILD_MCP=0 pi-legion-real pi --model workbuddy/hy4std --print '<同一条探针>'
```

### 基线（2026-11-06，master `0d8dd03`，真模型）

| 探针 | 结果 |
| --- | --- |
| `make smoke` | L1–L4 全过 |
| `make rpc` | 11/11 PASS |
| 探针一 | `read, grep, find, ls, bash, codemode, legion_mail, legion_tree`（`legion_phase` 只属于有 phase machine 的 centurion） |
| 探针二（默认） | `4:mcp__search_hub__web_search,mcp__search_hub__web_fetch,mcp__search_hub__search_status,mcp__search_hub__search_login` |
| 探针二（`PI_LEGION_CHILD_MCP=0`） | `NONE` |

## macOS（结构性限制，未在 Mac 上实测）

**真模型沙箱（`make run` / `make smoke` / `make print`）目前是 Linux-only**，三处假设：

1. `run-tui-real.sh:38` 用 `--network=host`。Docker Desktop for Mac 默认不共享宿主
   loopback，容器里的 `localhost:3425` 到不了宿主网关。
2. 挂载用**宿主绝对路径挂到容器内同名路径**（`-v "$HOST_AGENT/auth.json:...:ro"`）。
   Linux 上宿主 `$HOME=/root` 恰好等于容器里的 `HOME=/root`，所以能读到；macOS 上
   宿主是 `/Users/<you>/.pi/agent`，而容器里的 pi 仍然只找 `/root/.pi/agent`
   ⇒ auth 读不到，模型起不来。
3. `CHILD_EXT=/root/.pi/agent/npm/...` 也是容器内路径，这条本身没问题；
   真正的问题来自第 2 条。

**可以跨平台的**：`make rpc`（`verify-*.sh` 把 host config 复制到 `/tmp` 暂存目录再挂到
容器 `/root`，且用 mock LLM / 不需要宿主网关）与 `make tui-visual`（mock 模型）。
这两项按设计不依赖宿主网络与宿主 HOME 布局，但**尚未在 macOS 上实跑验证**。

要真在 Mac 上跑真模型沙箱，至少得改两处：容器内 `-e HOME=<宿主 agent 目录的父目录>`
加把挂载路径对齐，或改用 `host.docker.internal` 并重写 `auth.json` 的 `baseUrl`。

## 两条路

| 路 | 用途 | 网络 | 模型 |
| --- | --- | --- | --- |
| `make run` | 真模型交互/体验 | `--network=host`（**必须**：接入点是宿主进程） | 宿主网关 |
| `make tui-visual` | 确定性 TUI 回归 | bridge | 容器内 mock LLM |

### 为什么必须是 `--network=host`

网关是**宿主进程**。bridge 网络下容器里的 `localhost:3425` 是容器自己，
`host.docker.internal` 默认也不解析（实测 `getent hosts` 失败、`curl` 返回 000）。
用 host 网络后 `localhost:3425` 直通，**`auth.json` 的 baseUrl 一个字都不用改**。

真模型容器的三个挂载缺一不可：

```text
<repo>                        → /plugin           ro  源码，改宿主即生效
~/.pi/agent/auth.json         → 同路径             ro  模型接入点
~/.pi/agent/models-store.json → 同路径             rw  pi 要写回 checkedAt
```

源码是 `:ro` 挂载 —— **不要在容器里 `cd /plugin` 再跑 pi**，插件按 `cwd` 落盘
（`cwd/.pi-subagents/`）会写失败。镜像 WORKDIR 是 `/root/work`。

## 镜像里烧了什么、为什么

- `pi-any-endpoint@0.1.3`：注册 any-endpoint provider。挂宿主的那个包不行 ——
  settings.json 里的 `npm:` 包和绝对路径扩展要重跑安装，直接烧进镜像最稳。
- `pi install /plugin`：**必须登记挂载点**，否则容器里 `pi list` 只有镜像自带的包，
  本仓库插件静默缺席（模型照样能调通，所以不查 `pi list` 发现不了）。
- `ripgrep` + `fd-find`：缺了 pi 每次启动从 GitHub 下静态二进制到 `~/.pi/agent/bin`
  （容器层，重建即丢 + 起手 10s 网络抖动）。验收：跑完 `ls ~/.pi/agent/bin` 应不存在。
- tmux / python3-pil / fonts-noto-cjk：TUI 驱动、ANSI→PNG 渲染、CJK 不渲染成方框。
- `set -g extended-keys on`：不加 tmux 每次捕获都带一行 warning banner，且 modified Enter 异常。

## 为什么 L2/L3 不能省

L1 只证明模型可达。镜像自带的包照样能跑模型，但本仓库插件可能压根没加载 ——
`/plugin` 未登记为 package 时就是这个状态，静默无报错。只有 `pi list` 出 `/plugin`
（L2）+ 模型认得 `subagent` 工具（L3）才算验证。

## 跨机自测（`make xm`）—— 改跨机代码前后都必须跑

单机测试证明不了跨机。仓库里其他所有跨机用例都跑在 `test/helpers/fake-hc-core.mjs` 上：
同一个进程、同一台机器，只是脚本说成两台。连续三个线上 bug（转录 0 字节 / 入口校验
假阳性 / 预检不认 cwd）在它上面全绿，只在真双机才暴露。`make xm` 就是为了堵这个洞。

### 拓扑

```
  xm-parent  ── hc connect(JSON-RPC) ──┐        xm-remote
  (hc + pi + /plugin + mock 8765/8766) │        (sshd + pi + /plugin + git)
        │                              └── ssh ──→ hc core → terminal.run 真跑在远端
        └── 共享 bare origin 卷 /srv/git/app.git ←── 远端 push 的交付分支
```

两容器同一镜像（沙箱镜像 + openssh），跑在两个文件系统上，传输是真的：
父机 `hc` 用 ssh 连远端 core，`machine.exec` / `file.read` / `file.write` 全部跨网络。

### 前置

| 需要 | 缺失时 |
|---|---|
| docker | `SKIPPED: docker …` + **exit 1** |
| 真 `hc`（herdr-core，`HC_BIN` / `PATH` / `~/.local/bin/hc`） | `SKIPPED: no herdr-core (hc) binary` + **exit 1** |
| 宿主 `~/.pi/agent/auth.json` **和** `models.json`（两个都要有） | `SKIPPED: no host pi credentials` + **exit 1** |

镜像缺失会自动 build。模型凭据只用于 `make xm-real`；`make xm` 默认全部走仓库自带的
`test/mock-llm`（两个端口：8765 父机、8766 远端 child），所以**不花钱、不受模型自由度影响**。
`models-store.json` 不是硬要求：存在时 `xm-up.sh` **给每个容器各复制一份**挂进去（两份运行期
缓存互不踩），不存在就是空缓存起步。

### 耗时

镜像已存在时 **1m10s–3m40s**（实测区间：两容器起来 + **4 次** mock 驱动的 pi 运行——
`a1`、`a2`、`launch-a`、`launch-b`；`make xm-model` 另跑 1 次，约 1–2 分钟）。
首次 `xm-build` 再加 1–2 分钟。区间取自体量相同的一台 x86_64 Linux 机器，Docker **29.9.0**
（热缓存、镜像已存在的仓库状态另有一次 48s 的实测；慢的一端是 docker 冷启动 + 4 次 pi 冷启动）。

### 只看这几行判断通过

```
XM_ASSERT a1 PASS role-policy            # scout+host 被拒，文案含 allowRoles/'centurion'/'scout'
XM_ASSERT a2 PASS machine-list           # 未知机器被拒，文案含 hc machine ls + 真实的 `lists: remote` 片段
XM_ASSERT b  PASS launch                 # 零配置（只有 enabled:true）启动成功
XM_ASSERT c  PASS remote-artifact        # 远端真出现 .pi-worktrees/<child> + pi-subagent/remote/… 分支 + 本轮 nonce 文件
XM_ASSERT d0 PASS known-gap: …           # 零配置下 collect 连 fetch 都没有（见下）
XM_ASSERT c2 PASS remote-artifact        # hosts 条目配置下再验一次产物
XM_ASSERT d  PASS transcript-readback    # runs/<id>/remote/<child>.jsonl 有内容且含远端最后一条 assistant 文本
XM_ASSERT d1 PASS known-gap: …           # fetch 有了，但 collect 仍被工作树归属守卫拒（见下）
XM_ALL_PASS run=… child=…
```

任何 `FAIL` 后面紧跟 `evidence: {…}`（一行 JSON：实测路径、字节数、原始文本）。
`XM_CONTRAST` 专门打印「父机预创建的空占位文件 vs 真 mirror」的字节对照 —— 断言绝不用占位文件。

### 已知缺口（`d0` / `d1` 就是把它俩钉住的断言）

两个缺口在**不同阶段**，别混：

**`d0` —— 零配置：launch 能跑，collect 连 fetch 都没有。**
`subagents.crossMachine` 只用 `{"enabled": true}` 时 launch 成功，但 collect 的第一步
read-back 走同步 `resolveHostTarget`（`src/runs/remote-artifact.ts:199`），它要求
`subagents.crossMachine.hosts.<name>` 条目存在（`src/runs/remote.ts:976-982`）。这个失败还会
被**吞掉**：调用方今天真正看到的是工作树归属守卫
（`collect failed: … worktree '…' belongs to host 'remote': local filesystem and git
operations on it are refused`），父机写不出 `runs/<id>/remote/<child>.jsonl`。
`d0` 同时要求「collect 失败 + mirror 0 字节 + 命中签名之一 + 那条 ownership guard 文案」——
只修 resolver 不修守卫，`d0` 不会假翻绿。

**`d1` —— 给了 hosts 条目：fetch 有了，collect 仍被拒。**
Run B 的配置 `hosts.remote = { "cwd": "/root/work" }` 让 read-back 真正跑通，mirror 由 pre-wait
的 `refreshRemoteSession`（`src/runs/orchestrator.ts:3036`）写出来、内容是真的；但
`finishCollect` 随后在 `assertLocalWorktree(child)`（`src/runs/orchestrator.ts:3515`）把远端
工作树判成「本机不许碰」，于是 collect 的工具结果仍是失败。`d1` 断言「collect 报 ownership
guard **且** mirror 非空」，并打 `XM_GAP` 原文。

**分工**：`d` 证的是任务要求的「转录回传」（产物是真的，行数/最后一条 assistant 文本/mtime/
不用占位文件）；`d0`、`d1` 证的是产品还欠的两截。两个 gap 断言都是**断言现状**：任一缺口被
修好，对应断言会变红，提醒把自测台翻成正向。

### `make xm-model`（§5.4，6.2.2 的「目标机回退」）

6.2.2 起 `567417a feat(cross-machine): fall back to a model on the target instead of
refusing` 把「远端没有该模型」从硬拒绝改成了**回退 + 一条 warning**。这个 target 现在断言的是
回退本身，四条：

```
XM_ASSERT m1 PASS remote-model-absent   # 远端模型表没有 parent 请求的模型
XM_ASSERT m2 PASS fallback-warning      # 派发成功，工具结果同时含：请求的模型不可见 / 用了哪个替代 / pin 的位置
XM_ASSERT m3 PASS fallback-is-real      # 远端 child 的转录里 provider/model 就是回退后的那个 + 远端新增 worktree
XM_ASSERT m4 PASS no-local-fallback     # 没有无 host 的 child：回退发生在目标机，不是偷偷本地跑
XM_ALL_PASS run=… child=…
```

**确定性怎么来的**（这三件事缺一件，回退就不可重复）：

1. 远端的 `models.json` **没有** `xm` provider。pi 对「已知 provider + 未注册 model id」只答
   `Warning: Model "flash" not found for provider "xm". Using custom model id.`，产品的探针
   （`src/runs/remote.ts:871-878`）把这句话读作「不是拒绝」，只有**未知 provider** 才判
   `model-missing`；
2. 远端模型表**只有一行**，且这一行由 mock 提供（`xmock/other` → mock 端口 8766）。
   `planRemoteModelFallback` 的规则是「同 provider 优先，否则第一行」（`src/runs/remote.ts:975-977`），
   所以行数必须是一，才能保证回退落到 mock 而不是真模型；
3. 远端的 `models-store.json` 在 `model-missing` 场景里被**清空**：宿主缓存里的
   `any-endpoint/workbuddy/*` 会排在表的最前面，实测第一版就是回退到了
   `any-endpoint/workbuddy/deepseek-v4.1-flash`（真模型、不可重复）。

实测（6.2.2）两处细节，写在这里免得下次再猜：

- **warning 原文**（产品生成，`src/runs/remote.ts:997-1004`）：
  `host 'remote': model 'xm/flash' is not visible there; using 'xmock/other' from that
  machine's listing (pin it with subagents.crossMachine.hosts.remote.model)`
- **`run.json` 的 child 记录里 `model` 仍是请求值 `xm/flash`**，不是回退值。回退后的
  provider/model 只能从远端 child 的转录（assistant 消息的 `provider`/`model`）或它的 argv 里读，
  所以 m3 认的是转录，`run.json` 只作「当初请求的是什么」的对照。

### 限制（真的限制，不是 TODO）

1. **`hc` 二进制由宿主提供**：npm 上 `herdr` 是 0.0.0 占位，herdr-core 不从 registry 装。
   没有它的机器只能 `SKIPPED`（exit 1）。CI 不跑 `make xm`（与 `test:live` 同级）。
2. **ssh 是 hc 的传输层**：远端容器跑 `sshd`，`hc machine add --install` 会把 hc 拷进去。
   容器重建后必须重跑 `make xm-up`（`make xm` 自带）。
3. **`make xm` 会在 `/tmp/xm-models.*` 生成每容器一份的 `models.json` / `models-store.json`**
   （不是两个容器共用宿主文件：`models-store.json` 是运行期缓存，共用会互相踩）。宿主
   `models.json` 里的 `apiKey` 在写出时被删掉，绝不复制到 `/tmp`；唯一保留的是 mock provider
   的字面量 `"mock"`（pi 会**隐藏**完全没有 apiKey 的 provider，实测 `No models available`，
   所以它不是凭据而是开关）。`make xm-down` 会删掉这些临时目录。
4. **`make xm-real` 非门禁**：真模型经常忽略 `host=remote`（实测 deepseek 一次都没传、hy4std 一半概率），
   失败只打印 `XM_REAL_FAIL`，不影响 `make xm`。

### 与 pi-async 的差异

pi-async 的镜像只在本地构建，不发布 ghcr；pi-legion 的 `tui-sandbox` 由
`.github/workflows/docker-tui-sandbox.yml` 在 master 上自动发布到
`ghcr.io/zzjcool/pi-legion/tui-sandbox:latest`。本地改了 Dockerfile 后
`make build` 会覆盖同名 tag（不会 push）。
