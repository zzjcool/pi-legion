#!/usr/bin/env bash
# TUI 视觉验证 harness（docs/tui-qa-playbook.md §1.4）。
# 在 tui-sandbox 容器内（或任何有 tmux + node + python3/PIL 的环境）跑：
#   bash test/docker/verify-tui-visual.sh
# 流程：随机端口起 mock LLM → 隔离 pi home → tmux 起 pi（120x40）→
#       等渲染稳定 → 送键 → capture → ANSI→PNG 渲染 → 冒烟断言。
# 产物默认写 test/tui/artifacts/<ts>-smoke/（playbook §7）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ART="${TUI_ARTIFACTS_DIR:-$ROOT/test/tui/artifacts}/$(date +%Y%m%d-%H%M%S)-smoke"
mkdir -p "$ART"
COLS="${TUI_COLS:-120}" ROWS="${TUI_ROWS:-40}"
SCENARIO="${MOCK_LLM_SCENARIO:-echo}"
RENDERER="${ANSI2PNG:-$ROOT/test/tui/ansi2png.py}"

cleanup() {
  tmux kill-server 2>/dev/null || true
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

# ── 1. 随机端口 mock LLM（playbook §1.3 端口纪律）──────────────────────
PORT=$(python3 - <<'EOF'
import socket, random
for _ in range(300):
    p = random.randint(20000, 29999); s = socket.socket()
    try: s.bind(("127.0.0.1", p)); s.close(); print(p); break
    except OSError: s.close()
EOF
)
MOCK_LLM_SCENARIO="$SCENARIO" npm run mock-llm -- --port "$PORT" &
MOCK_PID=$!
for _ in $(seq 1 40); do curl -sf -m2 "http://127.0.0.1:$PORT/v1/models" >/dev/null && break; sleep 0.5; done
curl -sf -m2 "http://127.0.0.1:$PORT/v1/models" >/dev/null || { echo "FAIL: mock not ready"; exit 1; }

# ── 2. 隔离 pi home ────────────────────────────────────────────────────
PIHOME=$(PORT="$PORT" node --experimental-strip-types -e '
import { writeMockPiHome } from "./test/mock-llm/index.ts";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os";
const dir = mkdtempSync(`${tmpdir()}/qa-`);
writeMockPiHome({ dir, baseUrl: `http://127.0.0.1:${process.env.PORT}/v1` });
console.log(dir);
')
echo "PIHOME=$PIHOME"

# ── 3. tmux 起 pi 并等渲染稳定（playbook §2 stable）────────────────────
tmux new-session -d -s qa -x "$COLS" -y "$ROWS"
tmux send-keys -t qa \
  "HOME=$PIHOME PI_CODING_AGENT_DIR=$PIHOME TERM=xterm-256color PI_OFFLINE=1 pi --provider mock --model flash --thinking off" C-m

stable() {  # 连续两次捕获相同 → 稳定
  local prev="" cur=""
  for _ in $(seq 1 30); do
    sleep 1
    cur=$(tmux capture-pane -p -t qa -e)
    [ "$cur" = "$prev" ] && { printf '%s\n' "$cur"; return 0; }
    prev="$cur"
  done
  printf '%s\n' "$cur"; return 1
}

stable > "$ART/boot.ansi" || { echo "FAIL: TUI did not stabilize at boot"; exit 1; }
cp "$ART/boot.ansi" "$ART/frame-1.ansi"

# ── 4. 交互一步 + 捕获 ─────────────────────────────────────────────────
tmux send-keys -t qa "MOCK_SAY: hello from tui-visual-smoke" C-m
stable > "$ART/frame-2.ansi" || echo "WARN: frame-2 unstable (streaming?), captured anyway"

# ── 5. 渲染 PNG（取证）─────────────────────────────────────────────────
python3 "$RENDERER" "$ART/frame-2.ansi" "$ART/frame-2.png" --cols "$COLS"

# ── 6. 冒烟断言（明文优先，playbook 铁律 1）────────────────────────────
fail=0
plain() { sed 's/\x1b\[[0-9;:]*[A-Za-z]//g; s/\x1b\][^\x07]*\x07//g' "$1"; }
grep -q "pi" <(plain "$ART/boot.ansi") || { echo "FAIL: boot frame has no 'pi' UI"; fail=1; }
plain "$ART/frame-2.ansi" | grep -qi "hello from tui-visual-smoke" \
  || { echo "FAIL: MOCK_SAY text not visible in frame-2"; fail=1; }
[ -s "$ART/frame-2.png" ] || { echo "FAIL: rendered PNG missing"; fail=1; }

# ── 7. 记录结论 ────────────────────────────────────────────────────────
cat > "$ART/notes.md" <<EOF
# tui-visual smoke $(date -Iseconds)
- scenario: $SCENARIO  cols: $COLS  rows: $ROWS
- exit: $([ $fail -eq 0 ] && echo PASS || echo FAIL)
EOF

[ $fail -eq 0 ] && echo "PASS: artifacts in $ART" || { echo "FAIL: see $ART"; exit 1; }
