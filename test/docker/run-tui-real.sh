#!/usr/bin/env bash
# 真模型沙箱：容器（已装 pi） + 本仓库插件源码 + 宿主网关的真模型。
#
# 做法对齐 pi-async/test/docker（那里已跑通，别自创）：
#   · --network=host   —— 接入点是宿主进程，bridge 下 localhost:<port> 不可达；
#                        用 host 网络后 auth.json 的 baseUrl 一个字都不用改。
#   · auth.json / models-store.json 挂到容器内相同绝对路径（不复制、不改写）
#   · 镜像里 pi install npm:pi-any-endpoint，provider 由它注册
#
#   bash test/docker/run-tui-real.sh                    # 起容器并进 pi TUI
#   bash test/docker/run-tui-real.sh --print "你好"      # 非交互，验证模型可达
#   bash test/docker/run-tui-real.sh --shell            # 只进容器 bash
#
# 可调环境变量：
#   TUI_REAL_IMAGE  镜像（默认 ghcr.io/zzjcool/pi-legion/tui-sandbox:latest）
#   TUI_REAL_NAME   容器名（默认 pi-legion-real）
#   PI_MODEL        模型 id（默认 workbuddy/hy4-preview-ioa）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${TUI_REAL_IMAGE:-ghcr.io/zzjcool/pi-legion/tui-sandbox:latest}"
NAME="${TUI_REAL_NAME:-pi-legion-real}"
MODEL="${PI_MODEL:-workbuddy/hy4-preview-ioa}"
HOST_AGENT="${HOST_PI_AGENT:-$HOME/.pi/agent}"

for f in auth.json models-store.json; do
  [ -f "$HOST_AGENT/$f" ] || { echo "FAIL: $HOST_AGENT/$f 不存在（宿主需先 /login）。"; exit 1; }
done

# 插件按 cwd 落盘（cwd/.pi-subagents/），源码是 ro 挂载，所以工作目录必须是
# 容器内的可写目录，不能 cd 进挂载的仓库（pi-async README 同款坑）。
start() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --network=host \
    -v "$ROOT:/plugin:ro" \
    -v "$HOST_AGENT/auth.json:$HOST_AGENT/auth.json:ro" \
    -v "$HOST_AGENT/models-store.json:$HOST_AGENT/models-store.json" \
    -e TERM=xterm-256color \
    "$IMAGE" sleep infinity >/dev/null
  echo "==> pi version:  $(docker exec "$NAME" pi --version)"
  echo "==> models:"
  docker exec "$NAME" pi --list-models 2>&1 | sed 's/^/    /' | head -10
  docker exec "$NAME" pi --list-models 2>&1 | grep -q "$MODEL" \
    || echo "WARN: model '$MODEL' not in catalog — check models-store.json mount" >&2
}

MODE="${1:-}"
case "$MODE" in
  --shell)
    [ -n "$(docker ps --filter name=^/"$NAME"$ --filter status=running --quiet)" ] || start
    exec docker exec -it "$NAME" bash
    ;;
  --print)
    shift
    PROMPT="$*"
    [ -n "$(docker ps --filter name=^/"$NAME"$ --filter status=running --quiet)" ] || start
    exec docker exec "$NAME" pi --model "$MODEL" --print "$PROMPT"
    ;;
  *)
    if [ -n "$(docker ps --filter name=^/"$NAME"$ --filter status=running --quiet)" ]; then
      echo "reusing running container '$NAME'"
    else
      start
    fi
    exec docker exec -it "$NAME" pi --model "$MODEL"
    ;;
esac
