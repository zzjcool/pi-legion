# 跨机器配置 v1.1：hc 提供机器清单，发现填充路径

> 分支 `feat/host-auto-cwd`，基线 `master` = 6f3fdf0（6.1.1）。
> 契约增补：`docs/contracts/cross-machine-spawn-v1.md` 的 **Addendum v1.1**（A1–A5）。
> 测试：`test/unit/cross-machine-discovery.test.ts`、`test/integration/fake-core-host-discovery.test.ts`。

## 1. 问题（用户原话就是需求）

> 「这里的意思是只能一个工作目录？我觉得这个设计的不是很合理啊，实际我们可能不同项目有不同的路径，然后 pi 这东西，为什么不可以直接使用 hc 的能力」

v1 的设计把三件事绑在了一起：

1. **一台机器只能一个项目**：`hosts.<h>.cwd` 是唯一的工作目录，没有 per-call 覆盖。
2. **父机要替远端手写路径**：`node` / `piCli` / `piLegionRoot` / `piExtensions` 都得在父机配置里写死，写错一个就启动失败。
3. **hc 的机器清单与 settings 互不相识**：真机实测（6.1.1，派发到 hw-nj）失败原因就是 hc core 的 machines 注册表为空 → `machine_unknown`；用户被迫「先在 hc 注册，再在 settings 里重复描述同一台机器」。

v1.1 的答案：**准入交给 hc，配置交给发现，cwd 交给调用**。

## 2. 新配置形态（旧 / 新对照）

### 旧（6.1.1，必须全写）

```jsonc
{
  "subagents": {
    "crossMachine": {
      "enabled": true,
      "hosts": {
        "hw-nj": {
          "cwd": "/root/code/pi-legion",
          "node": "/root/.nvm/versions/node/v24.13.1/bin/node",
          "piCli": "/root/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
          "piLegionRoot": "/root/.pi/agent/npm/node_modules/pi-legion",
          "piExtensions": ["/root/.pi/agent/npm/node_modules/pi-any-endpoint/extensions/index.ts"]
        }
      }
    }
  }
}
```

### 新：最小可用配置（推荐）

```jsonc
{ "subagents": { "crossMachine": { "enabled": true } } }
```

就这一行。`hw-nj` 在 `hc machine ls` 里就已经意味着「这台机器可以用」；
`cwd` 每次调用给：

```ts
subagent({ host: "hw-nj", cwd: "/root/code/pi-legion", agent: "worker", task: "…" })
```

一台机器多个项目 = 多次调用给不同的 `cwd`：

```ts
subagent({ host: "hw-nj", cwd: "/root/code/project-a", … })
subagent({ host: "hw-nj", cwd: "/root/code/project-b", … })
```

### 新：可选覆盖（只写你要改的字段）

```jsonc
{
  "subagents": {
    "crossMachine": {
      "enabled": true,                    // 可选：false = 全关
      "discover": true,                   // 可选：false = 关掉探测（默认 true）
      "discoveryTtlSeconds": 900,         // 可选：发现结果缓存 TTL
      "refresh": false,                   // 可选：true = 下次启动强制重新探测
      "hosts": {
        "hw-nj": {
          "cwd": "/root/code/pi-legion",   // 默认 cwd（可被调用覆盖）
          "pathMap": { "/Users/me/extensions": "/root/extensions" }
        }
      }
    }
  }
}
```

字段语义（每一条都可以省略）：

| 字段 | 省略时 |
|---|---|
| `cwd` | 由每次调用 `subagent({host, cwd})` / `hostCwd` 提供；两者都没有 ⇒ **拒绝**（不猜 HOME） |
| `node` | 探测：`node -e process.execPath` 得到的**真实二进制**（不是 mise/asdf shim） |
| `piCli` | 探测：`command -v pi` 背后的 **JS 入口**（`…/dist/bundle/cli.js`），并用 `<node> <entry> --version` 验证 |
| `piLegionRoot` | 探测：包名 `pi-legion` 的安装目录（校验 `index.ts` + `package.json`）；探测不到时退回 6.1.1 的默认值（同路径），preflight 会点名 |
| `piExtensions` | 探测：远端已安装、声明了 `pi.extensions` 且看起来是 **provider** 的扩展（`--no-extensions` 会关掉它们，S5.6 的 `No models available` 就是这个）。显式写 `[]` 表示「不要加」 |
| `pathMap` / `worktreeRoot` | 6.1.1 的规则不变 |

**显式配置永远优先**：写了就用你写的（包括故意写 shim 路径）；发现只填空。

## 3. 探测：一条命令、五类事实

`remoteDiscoveryScript()`（`src/runs/remote.ts`）是一段 POSIX `sh`，通过**一次**
`machine.exec`（`on: <host>`，超时 20s）执行，输出 `KEY<TAB>VALUE`（重复键用
`all()` 读，`EXT` 每装一个扩展一行）。它问的五件事：

| 事实 | 命令 | 解析规则 |
|---|---|---|
| 真实 node | `command -v node`；`node -e 'process.stdout.write(process.execPath)'`；`node -v` | **以 `process.execPath` 为准**。若与 `command -v node` 不同，把后者记作 `NODE_SHIM`（诊断用），交付给启动的永远是前者 |
| pi 的 JS 入口 | `command -v pi`；`realpath`；`readlink -f` / node `realpathSync`；`cat <agent>/install/current-version`；`install/releases/*/node_modules/.bin/pi`；`…/@earendil-works/pi-coding-agent/dist/bundle/cli.js`；launcher 文件里出现的绝对 `.js` 路径 | 候选逐个过滤：必须是 `.js/.mjs/.cjs`、存在、并且 **`<node> <candidate> --version` 退出 0**。第一个通过的就是 `PI_ENTRY`；否则 `PI_ENTRY_MISSING` |
| legion 根 | `$PI_DIR/../npm/node_modules/pi-legion`、`$HOME/.pi/agent/npm/node_modules/pi-legion`、`npm root -g` | 必须存在 `index.ts`，且 `package.json` 的 `name` 是 `pi-legion`（不靠目录名） |
| 已装扩展 | `$HOME/.pi/agent/npm/node_modules/*`、`$PI_DIR/../npm/node_modules/*` | 读 `package.json`；有 `pi.extensions` 才算；`keywords` 含 `provider` 或入口里出现 `registerProvider` → `provider=1` |
| 探测完整性 | `emit PROBE_OK 1`（最后一行） | 没有这一行 = 远端 shell 没跑完，**不能**当成「什么都没装」 |

### shim 处理（6.1.0 事故的正解）

- **node shim**：mise/asdf 的 `node` 是 shell 脚本。把 `command -v node` 直接交给
  `terminal.run` 的 `argv[0]`，等于让 shim 当解释器——6.1.0 的 `SyntaxError` 就是这一类。
  探测让 **node 自己回答**（`process.execPath`），只交付真实二进制。
- **pi launcher**：`/root/.pi/agent/bin/pi` 是 `case "$0"` shell 包装。child argv 是
  `[node, piCli, …]`，所以 `piCli` 必须是 JS。探测把 launcher 解析到
  `install/releases/<current-version>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`
  （优先 `install/current-version` 指定的版本），并**实际执行** `<node> <entry> --version` 作为证明。
- 这台机器的真实布局上已经验证（本仓库 CI 环境，`pi` 1.5.2 + `pi-legion` 6.1.1）：

```
MACHINE	host
NODE_CMD	/root/.nvm/versions/node/v24.13.1/bin/node
NODE_BIN	/root/.nvm/versions/node/v24.13.1/bin/node
NODE_VERSION	v24.13.1
PI_CMD	/root/.pi/agent/bin/pi
PI_ENTRY	/root/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
PI_VERSION	1.5.2
LEGION_ROOT	/root/.pi/agent/npm/node_modules/pi-legion
LEGION_VERSION	6.1.1
EXT	pi-any-endpoint	/root/.pi/agent/npm/node_modules/pi-any-endpoint/extensions/index.ts	1
EXT	pi-async	/root/.pi/agent/npm/node_modules/pi-async/extensions/index.ts	0
EXT	pi-sysmon	/root/.pi/agent/npm/node_modules/pi-sysmon/src/index.ts	0
PROBE_OK	1
```

### 3.1 扩展按包名重锚（v1.2，实测场景）

真机失败（Mac 父机 → hw-nj）：

```
[pi-legion] host hw-nj: 5 extension(s) not loadable there (no pathMap entry maps them):
  pi-sysmon/src/index.ts, pi-autoresearch/extensions/pi-autoresearch/index.ts,
  pi-any-endpoint/extensions/index.ts, pi-sop/src/index.ts, pi-async/extensions/index.ts
```

五条都是**父机绝对路径**。v1.2 起：

1. 探测额外输出 `PKG<TAB><name><TAB><dir>`（远端每个已安装包）和
   `PKGENTRY<TAB><name><TAB><relative><TAB><abs>`（它声明的 `pi.extensions` 入口）。
2. `mapRemoteArgPath()` 在多出 `packages` 时，先找 argv 路径所属的 npm 包
   （向上找最近的 `package.json`，取 `name`），再把「包内相对路径」拼到**远端同名包目录**上。
3. 三种结果：
   - 同名包 + 同一相对入口 ⇒ 自动映射（用户那 5 条全部命中，不需要 pathMap）；
   - 远端没有这个包 ⇒ **启动前拒绝**（`INVALID_PARAMS`），文案含包名、父机路径、
     `Install '<pkg>' on '<host>'` / `pathMap` / `PI_LEGION_CHILD_INHERIT_EXTENSIONS=0` 三种修法；
   - 远端有包但入口不同（版本/布局差异）⇒ **启动前拒绝**，并列出它实际声明的入口
     （`declared: ./dist/index.js -> /…/dist/index.js`）。
4. 不再"丢扩展 + stderr 提示"：那种降级会让 child 缺 provider 后启动、打印 no models、
   然后挂死（用户说的"半死"）。
5. 只有 `needsPackageIndex(argv)` 为真（argv 里存在既不在 checkout、也不在 pathMap、
   也不在镜像目录的绝对路径）时才去取包列表；全显式旧配置的 argv 只含本包入口（走
   `piLegionRoot` 的 pathMap），**零额外往返**。

对应测试：`cross-machine-discovery.test.ts` 的 `v1.2 extensions:*`（同包 / 缺包 / 入口不同 /
何时取包列表）与 `fake-core-host-discovery.test.ts` 的两条集成用例（用 fake core 真实探测出的
包列表把父机路径映射到 `<remote>/home/.pi/agent/npm/node_modules/pi-any-endpoint/extensions/index.ts`；
缺包时启动前拒绝且没有 `terminal.run`）。

## 4. 准入与配置分家

`resolveHostTargetAsync()` 的顺序（每一步只报自己那类失败）：

1. **准入**：`hc` 的机器清单（`machine.list`）是「这台机器能不能去」的唯一来源。
   - 新启动：`admission: "always"` —— 名字必须是这个 core 认识的机器；
   - resume / 读回已有远端 child：`admission: "never"` —— **不**查注册表。
     机器注册是 **按 `HC_SESSION`** 的（runbook 自己写了这条），跨 session 的
     resume 不能被注册表误杀；四步 resume gate 会直接问那台机器，报错更准。
   - 默认 `when-unconfigured`：settings 没写这个 host 时才用注册表（此时它同时
     提供「配置」）。
2. **cwd**：per-call `cwd`/`hostCwd` → host 默认 `cwd` → 拒绝（点名两个写法）。
3. **发现**：只填空，且只在 `discover` 开启时；完整显式条目 **零探测**。
4. **解析**：纯函数 `resolveHostTarget()`，所有调用方（launch / resume / verify / 读回）
   共享同一份 target。

`hc` 里没有这台机器时的错误（不是 `machine_unknown`，也不是让你去翻 settings）：

```
host 'hw-nj' is not a machine this hc core knows (`hc machine ls` here lists: vps, host-workspace).
Register it first:
  hc machine add --name hw-nj ssh://user@that-machine
(or use one of the names above). Legion will not run the child on this machine instead.
```

注册表为空时：`` `hc machine ls` here lists no machines `` —— 同样是这句 + `hc machine add`。

## 5. 缓存与自愈

- **内存**（模块级）+ **磁盘**（`$XDG_CACHE_HOME/pi-legion/host-discovery/<host>.json`，
  0600）双层，TTL = `crossMachine.discoveryTtlSeconds`，默认 **900s**。
- `crossMachine.refresh: true`（或 `doctor` 的 refresh 开关）**跳过两层**缓存；
  `clearHostDiscoveryCache(host?)` 同时清内存/磁盘。
- **失败不缓存**：探测答「这台机器没有 node」会让本次解析失败，同时清掉该 host 的
  缓存 —— 装完 node 下一次启动立刻重新探测。
- **失败可自愈**：preflight 因**发现来的** `node`/`piCli`/`piLegionRoot` 被拒
  （exit 12/13/14/16）时，`HostTarget.rediscover()` 重新探测 **一次** 并重试
  preflight——远端升级 `pi`（bundle 换到新的 `install/releases/<v>/`）不需要重启父进程。
  完全显式的 target 没有 `rediscover`，不会背着操作者重新探测。
- 并发：`tasks[]` 的多个 step 共享同一个 in-flight promise，只付一次探测。

## 6. 错误文案（真实断言过的）

探测跑了但缺字段（含实际探测结果 + 手写示例）：

```
host 'fakebox': host discovery could not find node / piCli on that machine.
What the probe found:
node: not found on PATH
pi: not found on PATH
legion: /root/.pi/agent/npm/node_modules/pi-legion
Write the missing field by hand and retry:
  "subagents": { "crossMachine": { "hosts": { "fakebox": { "cwd": "/srv/app",
      "node": "/abs/path/on/fakebox/bin/node", "piCli": "/abs/path/on/fakebox/…/dist/bundle/cli.js" } } } }
```

探测根本跑不起来（传输层）：

```
host 'vps': host discovery could not run (transport: connection reset); the machine may be
unreachable. Nothing was guessed: set subagents.crossMachine.hosts.vps by hand
("node" / "piCli" / "piLegionRoot") if the machine is meant to be offline
```

per-call cwd 不存在（preflight，terminal 之前）：

```
host 'fakebox': cwd '/remote/no-such-project' does not exist on fakebox
(remote paths are absolute on that machine; local paths are not translated)
```

（`hc exec --on fakebox -- ls -ld /remote/no-such-project` 是 runbook 里的排查方式；
preflight 的 exit 11 / `bad_cwd` 映射在 `remotePreflight` / `unreachable()`。）

既没默认也没 per-call：

```
host 'vps' has no cwd: set a default in subagents.crossMachine.hosts.vps.cwd,
or pass one per call with subagent({ host: "vps", cwd: "/abs/path/on/vps" })
```

## 7. 向后兼容证明

- `resolveHostTarget()`（同步、纯函数）的签名与行为未变；`enabled !== true` 的拒绝文案
  逐字节不变（`test/unit/cross-machine-target.test.ts` 全绿，未改一行）。
- 旧配置 `cwd + node + piCli + piLegionRoot` ⇒ **零探测**，解析结果与 6.1.1 的
  `HostTarget` deep-equal，且没有 `discovered` / `discovery` / `rediscover` 字段
  （`cross-machine-discovery.test.ts` 的 "BYTE-IDENTICAL" 用例；integration 里同一
  场景断言 `machine.exec` 次数为 0）。
- 只写 `cwd` 的旧配置：`cwd` 语义、`worktreeRoot`/`mirrorRoot` 推导、preflight 全部不变；
  `node`/`piCli` 由探测填成**真实绝对路径**（功能等价，且正是要修的 bug）。缺 cwd 的错误
  在不显式提供时仍是 6.1.1 的原句（per-call 提示只在 v1.1 解析路径上出现）。
- resume 不查注册表（`admission: "never"`）：跨 `HC_SESSION` 的 resume 仍走原来的四步
  gate（`legion-session-continuity.test.ts` 的 B2/S4 全绿）。
- `remote-artifact` / `remote-verify` 仍用同步解析（它们只需要 `host`+`cwd`，
  且读回不应因注册表/view 而失败）。

## 8. 测试证据

```
npm run typecheck           → green
npm test                    → 见最后一节（unit 全绿）
npm run test:integration    → 154/154 green
```

新增用例：

`test/unit/cross-machine-discovery.test.ts`（21 个）
- 真跑 `sh -c` 的探测：mise shim → 真实 node；`case "$0"` launcher → bundle `cli.js`；
  legion 按 package name 找到；provider 扩展被识别（`pi-async`/`sysmon` 不误判）；
- 无 node/pi 的机器：`NODE_MISSING` + `PROBE_OK`，错误文案含实际探测结果；
- `EXT` 重复行不会被 Map 吞掉；
- 准入：未知机器（列出已知机器 + `hc machine add`）、空注册表、老 core 无 `machine.list`、
  `admission: always/never`、`enabled:false`；
- 失败文案：缺字段（含 JSON 示例）、传输失败、超时；
- 解析：显式全写 = 6.1.1 逐字段相同；`{}` 被填充；显式 `piExtensions: []` 优先；
  `discover:false` 不探测；per-call cwd 覆盖 / 非绝对拒绝 / 两者皆无拒绝；
- 缓存：一次探测服务多次、`refresh` 重探、TTL 过期重探、失败不缓存、磁盘缓存跨进程。

`test/integration/fake-core-host-discovery.test.ts`（8 个，真 `HcCliClient` + fake hc core）
- `{}` host + per-call cwd：解析 → preflight → 启动探测 → `terminal.run`，argv[0]
  是**真实 node**（假远端 root 内的那份），argv[1] 是 bundle，provider 扩展在 argv 里；
- **settings 完全没有 `hosts` 段**、hc 注册表有机器：可直接启动；
- hc 注册表为空：拒绝并点名 `hc machine add`，且**零** `machine.exec` / `terminal.run`；
- 已注册但探测失败（无 node/pi）：文案含 `node: not found on PATH` + 手写示例；
- 6.1.1 全写配置：`machine.exec` 次数 = 0，`discovered` 字段不存在，仍能启动；
- per-call cwd 覆盖（`terminal.run.cwd` 是第二个项目）与不存在目录的拒绝；
- 缓存里的旧 `piCli` 失效 → preflight 触发一次 rediscover → 新入口生效。

### 8.1 扩展解析（v1.2）

```
npm test 里的 v1.2 用例：
✔ v1.2 extensions: a parent package path is re-rooted by PACKAGE NAME when the target has the same package
✔ v1.2 extensions: the package is ABSENT there — refuse before launch, naming package, path and the fix
✔ v1.2 extensions: the package IS there but the entry differs — refuse, listing what it declares
✔ v1.2 extensions: the probe index is only fetched when an argv path NEEDS it
✔ v1.2: a parent extension path is re-rooted by PACKAGE NAME from the target's real package list
✔ v1.2: an extension the target does not have is refused before any terminal, naming package and fixes
```

## 9. live e2e

`docs/runbooks/cross-machine-live-e2e.md` 需要真 `hc` + 真远端机器；**本环境没有 `hc`
可执行文件（`command -v hc` 为空）**，因此 live 用例未运行。手工验证步骤：

```bash
export HC_SESSION=test-host-auto-cwd-$$
hc machine add --temp --name host-workspace host-workspace   # 必须 test-* session
hc machine ls | grep host-workspace

# 最小配置：settings 里只留 enabled，host 由 hc 提供
# { "subagents": { "crossMachine": { "enabled": true } } }
subagent({ host: "host-workspace", cwd: "/root/code/pi-legion", agent: "worker", task: "…" })

# 第二个项目（同一台机器）
subagent({ host: "host-workspace", cwd: "/root/code/other-project", agent: "scout", task: "…" })
```

跑 `npm run test:live` 时同样要求 `HC_SESSION=test-*` 且已 `hc machine add --temp`。

## 10. 改动文件

| 文件 | 改动 |
|---|---|
| `src/runs/remote.ts` | 探测脚本/解析/合并、`resolveHostTargetAsync`、缓存、准入、per-call cwd、自愈入口、包名重锚（`resolvePackagePathOnHost` / `mapRemoteArgv` / `needsPackageIndex`） |
| `src/shared/types.ts` | `CrossMachineHostConfig.discover`、`CrossMachineSettings.discover/refresh/discoveryTtlSeconds`、文案语义 |
| `src/agents/settings.ts` | 解析上述新键；`optionalPositiveSeconds` 校验 TTL |
| `src/hc/client.ts` | allowlist 增加 `machine.list`（读注册表；写侧仍禁止） |
| `src/supervisor/terminal-supervisor.ts` | preflight 失败时对**发现来的**字段重新探测一次并重试；argv 映射改用 `mapRemoteArgv`（不再丢扩展），按需加载远端包列表 |
| `index.ts` | `hostCwd` 参数（`subagent`/`tasks[]`/`vexillatio`）、per-call `cwd` 的远端语义、launch/resume 使用异步解析 |
| `test/helpers/fake-hc-core.mjs` | `machine.list`（含 `empty`/`unsupported` 模式）、`FAKE_HC_REMOTE_PATH/HOME` 沙箱 |
| `test/unit/cross-machine-discovery.test.ts` | 新增 |
| `test/integration/fake-core-host-discovery.test.ts` | 新增 |
| `docs/contracts/cross-machine-spawn-v1.md` | Addendum v1.1（A1–A5） |
| `docs/runbooks/cross-machine-live-e2e.md` | v1.1 最小配置说明 |
| `CHANGELOG.md` | 6.2.0 条目 |

## 11. 版本建议

纯新增能力 + 现有配置行为不变 ⇒ **minor**：`6.1.1 → 6.2.0`（不发版，只给建议）。
