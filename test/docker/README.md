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

## 与 pi-async 的差异

pi-async 的镜像只在本地构建，不发布 ghcr；pi-legion 的 `tui-sandbox` 由
`.github/workflows/docker-tui-sandbox.yml` 在 master 上自动发布到
`ghcr.io/zzjcool/pi-legion/tui-sandbox:latest`。本地改了 Dockerfile 后
`make build` 会覆盖同名 tag（不会 push）。
