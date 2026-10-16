# TUI 缺陷狩猎手册（QA playbook）

> **给谁看**：任何要在本仓库做「视觉/交互验证」的 agent 或人。读完即可执行。
>
> **为什么有这份文档**：`CONTRIBUTING.md` 只覆盖 `typecheck` / `test` / `test:docker`，而本仓库有冻结的 TUI 契约（`docs/tui-viewer-contract.md`），其验收项（T1 渲染对齐主上下文、T5 follow-end、T12 流式去重）本质是**渲染与交互**断言，无法用普通单测覆盖。本手册补上这一段：如何在容器里跑真实 TUI、如何截图取证、如何造确定性复现、如何把发现变成 issue。多 agent 整轮狩猎的编排见 `docs/qa-hunting-round.md`。

---

## 0. 核心原则：三层证据链

**每个缺陷必须有这三层，缺一层就别报。**

| 层 | 目的 | 手段 |
| --- | --- | --- |
| ① 纯函数最小复现 | 精确定位，无需环境 | `node --experimental-strip-types` 直调被测函数 |
| ② 无头端到端 | 证明真实调用路径可达 | 直驱组件 / registry / orchestrator（不起 TUI） |
| ③ TUI 截图/帧 | 证明用户可见 | tmux 捕获 ANSI → 渲染 PNG 给我看 |

**只做 ③ 会误报**（把测试环境噪声当产品缺陷）。**只做 ① 会漏报**（函数本身正确但调用方错）。

**无视觉能力时**：如果你的模型看不了图，以明文帧/码点断言为准（见 §3 铁律 1），PNG 只作为附给有视觉能力的会话/人的辅助证据。不要因为"看不了图"就跳过第 ③ 层——明文帧同样能证明用户可见性。

---

## 1. 基建：容器 + 可脚本化 LLM

### 1.1 为什么必须容器化

- TUI 渲染依赖终端宽度/高度，本地终端不可控；容器里可精确设 `tmux -x <cols> -y <rows>`。
- 本仓库改 TUI 行为会动 `ctx.ui.custom()`；容器快照可重建。

### 1.2 用仓库自带的 mock LLM（已存在，别自造）

`test/mock-llm/` 已是**可脚本化的 OpenAI 兼容端点**（`npm run mock-llm`，默认 `:8765`，scenario 可选，见 `test/mock-llm/README.md` 的 `MOCK_LLM_SCENARIO=spawn-scout`）。

- 模型名固定为 `--provider mock --model flash --thinking off`（`writeMockPiHome` 已把 provider 配好，dummy key 恒为 `mock`）。
- 驱动指令用 `MOCK_SAY: <text>` 等 inline directives（README「Inline directives」一节）。

### 1.3 端口纪律（血泪）

**永远用随机端口**，不要硬编码 `8765`：旧进程残留会静默串台，产物看起来干净但跑的是错的 scenario。

```bash
PORT=$(python3 -c 'import socket,random
for _ in range(300):
    p=random.randint(20000,29999); s=socket.socket()
    try: s.bind(("127.0.0.1",p)); s.close(); print(p); break
    except OSError: s.close()')
# 起 mock 后必须等就绪再启动 pi
for _ in $(seq 1 40); do curl -sf -m2 "http://127.0.0.1:$PORT/v1/models" >/dev/null && break; sleep 0.5; done
```

**禁止 `pkill -f mock-llm`**（会匹配到自己的 shell 把自己杀掉）。用：

```bash
ps -eo pid,cmd | grep "[m]ock-llm" | awk '{print $1}' | xargs -r kill -9
```

### 1.4 tmux 捕获（本仓库尚缺的一环）

`test/docker/` 已有容器基建；需要补一个 tmux 捕获步骤拿到真像素。建议新增 `test/docker/verify-tui-visual.sh`（**当前尚未落库，见 §11 状态表**）：

```bash
# 在容器内
tmux new-session -d -s qa -x 120 -y 40
tmux send-keys -t qa "HOME=$PIHOME TERM=xterm-256color pi --provider mock --model flash --thinking off" C-m
sleep 12
tmux capture-pane -p -t qa -e > /tmp/frame.ansi
python3 /opt/tui/ansi2png.py /tmp/frame.ansi /tmp/frame.png --cols 120
```

渲染注意：然后交给宿主渲染成 PNG（镜像内置 `test/tui/ansi2png.py`，PIL 逐单元格）：

- **不要用 ImageMagick 的 Pango**——它吞掉嵌套 `foreground` 颜色，会让颜色类取证失真。
- **渲染器必须支持 CJK 字体回退**，否则中文渲染成方框，**会掩盖 CJK 宽度/溢出缺陷本身**。

---

## 2. 执行循环

```bash
# 1) 起隔离 home + 随机端口 mock（见 §10 快速开始）
# 2) tmux 起 pi，按场景送键
# 3) 每步 capture-pane，需要时渲染 PNG 核对渲染与交互
```

**等待要基于"渲染稳定"而不是拍脑袋 sleep**。推荐 capture-until-stable：连续两次捕获（间隔 ≥1s）diff 为空才算渲染完成，再送下一键。

```bash
# capture-until-stable：稳定才返回，最多等 30s
stable() {
  local prev="" cur=""
  for _ in $(seq 1 30); do
    sleep 1
    cur=$(tmux capture-pane -p -t qa -e)
    [ "$cur" = "$prev" ] && { printf '%s' "$cur"; return 0; }
    prev="$cur"
  done
  printf '%s' "$cur"; return 1   # 超时：视为异常，记录后处理
}
```

连续送键不给渲染周期 = 误判为缺陷（曾把连按两次 Esc 判成"面板没关"，其实是时序太快；放慢后正确：Esc 从详情→列表→关闭）。

tmux 特有的坑：

- `send-keys Escape` 与后续按键之间同样要等稳定，tmux 不做合并。
- `tmux -x 120 -y 40` 是**初始**尺寸；若程序随后收到 resize 事件（如进入备用屏幕），以程序日志/探测输出里的实际宽高为准，别假设仍是 120×40。

---

## 3. 铁律（踩过的坑，别再犯）

1. **先读明文再读图**。低分辨率下 `▶`(U+25B6) 会被误读成 `◀`，差点误报。下结论前先 `sed 's/\x1b\[[0-9;]*m//g'` 看明文或查码点。
2. **区分环境噪声 vs 产品缺陷**。截图里的 `â`/`Ã` 是 xterm 没开 UTF-8（用 `-u8` + `LANG=C.utf8`）；root 绕过权限位（`chmod 500` 仍可写）。都不是产品问题。
3. **工具执行要查请求日志/产物，不能只看回复**。模型完全可能回复"I started the task"却没调用工具。判据：`mock` 请求数 + 产物文件存在。
4. **报之前先查重**。先 `gh issue list --search <关键词>` 确认没报过，再在当前 main 上复跑最小复现确认缺陷仍在（§9 列的类别尤甚，可能已修）。

---

## 4. 判定标准（报不报）

| 报 issue | 只记录 |
| --- | --- |
| 可复现的功能/数据/安全缺陷 | 理论风险（无法复现） |
| 契约明文与实现不符 | 契约未规定的设计取舍 |
| API 语义误导 | 低价值打磨 |
| 跨面口径不一致（同一数据多解释） | 环境限制导致的观察 |

**必须能复现才报。** 不可复现的一律降级为"记录为风险"。

怀疑回归类缺陷时，加一步**负向对照**：在已知 good commit（`git log` 找缺陷引入前的版本）上跑同样步骤。以前没有 → 新回归（更紧急）；以前也有 → 一直如此的设计，回到 §4 表格判定。

---

## 5. 高 ROI 角度（按序）

1. **跨面口径一致**：同一数据在多处（tree / viewer / status）是否同口径。
2. **契约 vs 实现逐条对照**：把冻结契约（如 `tui-viewer-contract.md` 的 T1–T13）grep 出来逐条验证。
3. **单位混淆**：字节/码点/显示宽度。
4. **配置边界**：每个 env 变量试 `""`/`0`/`-1`/`NaN`/`Infinity`/浮点。
5. **UI 状态模型**：滚动/过滤/选中是否有统一模型。

---

## 6. 写 issue 的结构（接 CONTRIBUTING 的 "Issues first"）

CONTRIBUTING 要求 issue 含 repro / 期望 / 实际 / 环境（Node / OS / pi-legion 版本）。渲染类 issue 再加一段：

```markdown
## Summary
一句话说清症状 + 影响。
## Severity
critical / major / minor + 一句理由（维护者据此分诊，49 个 issue 没有分级无法排优先级）。
## Where
精确到 `file:line` + 关键代码。
## Reproduction
**实测输出**（不是"应该看到什么"）。贴 `tmux capture-pane / strings / ps` 的真实结果。
最小复现脚本路径（见 §7 产物落库，随 issue 提交或附 PR）。
## Through the TUI
渲染/交互问题附帧内容（明文或 PNG）。
## Impact
为什么值得修（用户/模型/数据视角）。
## Environment
pi-legion 版本、Node、终端尺寸、容器/宿主、mock scenario。
```

---

## 7. 产物落库（不要只写 /tmp）

容器一销毁，`/tmp` 里的帧/PNG/脚本全丢——issue 里的证据链就断了。每个发现固定一个产物目录：

```text
test/tui/artifacts/<YYYYMMDD>-<issue-slug>/
  ├─ frame.ansi      # 关键帧（capture-pane -e 原始输出）
  ├─ repro.mjs       # ① 层最小复现脚本，node repro.mjs 直接跑
  ├─ frame.png       # 可选，渲染后的取证图
  └─ notes.md        # 复现步骤、码点分析、结论
```

- issue 的 Reproduction 一节引用上述相对路径；修复 PR 把 `repro.mjs` 转成正式回归测试（先失败再修，见 §8）。
- 如果产物含敏感路径/密钥，写之前先检查（CONTRIBUTING：never commit real keys）。

---

## 8. 与 CONTRIBUTING 的衔接

- 本手册产出的 issue 走同一流程：issue → 一个 PR 一个 concern → draft → Ready for review（`ci` 绿）。
- 修复时按 CONTRIBUTING 的回归测试要求：**先失败测试，再生产代码**。本手册的三层证据天然提供了测试用例（`repro.mjs` → 测试）。
- 涉及 `src/tui/` 的改动，务必跑 `npm run test:integration`（`FakeSupervisor`），因为本手册发现的多数缺陷是「调用方错」而非「组件错」——单测覆盖不到。

---

## 9. 已验证的生效案例（pi-async，49 issues）

本方法论在 `zzjcool/pi-async` 上跑通，产出 49 个 issue。代表性几类：

- **渲染层**：`rail` 未剥离裸 C0（`\x07`/`\x08`/`\x0c`）——控制字符破坏布局（可复现最小用例 + TUI 帧）。
- **宽度单位**：截断按**码点**而非显示宽度 → CJK/emoji 溢出挤掉 `elapsed` 字段。
- **状态语义**：`sync + abort` 返回 `mode:"sync"` + `status:"running"` 自相矛盾（作者的测试已断言 `status:"running"` 是设计意图，`mode` 才是缺陷——**先读测试再报**）。
- **安全**：正则缺 `m` flag → 契约建议的锚定 `^READY$` **永不匹配**；且 **JS 无内联 `?m`**（我最初的 workaround 错了，已更正）
- **架构根因**：4 组概念 9 份副本（`stripAnsi`×2、duration×2、env×3、width×2），由并行开发计划解释，直接产生 4 组缺陷。合并为共享助手可关闭整类。

**关键教训**：建议（修复方案/workaround）**必须先跑一遍**再写进 issue。我曾把 `(?m)` 当 workaround 写进去，而 JS 正则不支持内联 flag——差点误导维护者。

---

## 10. 快速开始（复制即用）

```bash
# ── 0. 随机端口起 mock ──────────────────────────────
PORT=$(python3 -c 'import socket,random
for _ in range(300):
    p=random.randint(20000,29999); s=socket.socket()
    try: s.bind(("127.0.0.1",p)); s.close(); print(p); break
    except OSError: s.close()')
MOCK_LLM_SCENARIO=spawn-scout npm run mock-llm -- --port "$PORT" &
for _ in $(seq 1 40); do curl -sf -m2 "http://127.0.0.1:$PORT/v1/models" >/dev/null && break; sleep 0.5; done

# ── 1. 生成隔离 pi home（打印路径，后续要用）──────────
PIHOME=$(node --experimental-strip-types -e '
import { writeMockPiHome } from "./test/mock-llm/index.ts";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os";
const dir = mkdtempSync(`${tmpdir()}/qa-`);
writeMockPiHome({ dir, baseUrl: `http://127.0.0.1:${process.env.PORT}/v1` });
console.log(dir);
')
echo "PIHOME=$PIHOME"

# ── 2. tmux 起 pi ────────────────────────────────────
tmux new-session -d -s qa -x 120 -y 40
tmux send-keys -t qa "HOME=$PIHOME TERM=xterm-256color PI_CODING_AGENT_DIR=$PIHOME pi --provider mock --model flash --thinking off" C-m
# 等启动稳定（连续两帧相同，见 §2 stable()）
sleep 12; tmux capture-pane -p -t qa -e > /tmp/boot.ansi

# ── 3. 交互 + 捕获 ───────────────────────────────────
tmux send-keys -t qa "MOCK_SAY: hello" C-m
sleep 2
tmux capture-pane -p -t qa -e > /tmp/frame.ansi
# 渲染 PNG（ansi2png.py 尚未落库，见 §11 状态表）
# python3 test/tui/ansi2png.py /tmp/frame.ansi /tmp/frame.png --cols 120

# ── 4. 清理 ─────────────────────────────────────────
tmux kill-session -t qa
ps -eo pid,cmd | grep "[m]ock-llm" | awk '{print $1}' | xargs -r kill -9
```

---

## 11. 维护

### 基建状态表（改一处，同步此处）

| 资产 | 位置 | 状态 |
| --- | --- | --- |
| 脚本化 mock LLM | `test/mock-llm/` | ✅ 已有 |
| 隔离 pi home | `writeMockPiHome({ dir, baseUrl })` | ✅ 已有 |
| 沙箱镜像 | `ghcr.io/zzjcool/pi-legion/tui-sandbox`（Dockerfile: `test/docker/Dockerfile.tui-sandbox`，CI 自动发布） | ✅ 已有 |
| tmux 捕获 harness | `test/docker/verify-tui-visual.sh`（`npm run test:tui-visual` 一键跑） | ✅ 已有 |
| ANSI→PNG 渲染器 | `test/tui/ansi2png.py`（镜像内置 `/opt/tui/`） | ✅ 已有 |
| 容器基建 | `test/docker/` | ✅ 已有 |
| 冻结契约 | `docs/tui-viewer-contract.md` | ✅ 已有 |

镜像发布：push 到 master 且上述文件变更时 CI 自动构建推送（`.github/workflows/docker-tui-sandbox.yml`）；本地修改 Dockerfile 后想立即验证可直接 `npm run test:tui-visual`（本地 build，无需 push）。要手动 push 需要 `write:packages` scope 的 token（`gh auth token` 默认没有）：`echo <TOKEN> | docker login ghcr.io -u zzjcool --password-stdin && docker push ghcr.io/zzjcool/pi-legion/tui-sandbox:latest`。

证据产物（`test/tui/artifacts/`）已 gitignore，不进仓库；issue 里引用时贴关键帧明文/PNG 内容而非路径。

### 其他维护项

- 新增 tmux 捕获脚本后，把它纳入 `npm run test:docker`（或单独 `test:tui-visual`，**不进必需 `ci`**，因为依赖容器与像素）——已落 `test:tui-visual`，同样不进 `ci`。
- 每次发现新的"陷阱"（环境噪声/判定边界）补进 §3/§4。
- 渲染器与 harness 保持单一实现，**不要 sed 派生副本**（派生副本会与主版本漂移）。

---

## 12. 停止条件（防止无限狩猎）

开放式狩猎没有自然终点，agent 必须主动收尾：

- **角度穷尽即停**：§5 五个角度各跑完一轮后收尾，不要在同一角度反复深挖。
- **零发现止损**：连续 2 个角度零新发现（查重后），提前结束本轮。
- **时间预算**：单轮狩猎建议 ≤60 分钟容器时间；超时把已完成的部分按 §7 落库，未跑完的角度写进 notes.md 留给下一轮。
- **发现量上限**：单轮报 ≤10 个 issue（pi-async 一轮 49 个已属极限，多数维护者一次消化不了）；超出部分落库为 notes.md 里的 candidate 列表，下轮先查重再升级为 issue。
