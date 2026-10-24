#!/usr/bin/env bash
# 真模型三层冒烟：L1 模型可达 → L2 插件加载 → L3 legion 工具注册。
# 模式对齐 pi-async/test/docker/tools/smoke.sh。
#
#   smoke-real.sh [model] [container]
#
# L2 不能省：模型通了不代表本仓库插件被加载（/plugin 未登记为 package 时
# 镜像自带的包照样能跑，插件却静默缺席）。
set -uo pipefail

NAME="${2:-pi-legion-real}"
MODEL="${1:-workbuddy/hy4-preview-ioa}"

run() { timeout 200 docker exec "$NAME" pi --model "$MODEL" --print "$1" 2>&1; }

echo "### L1 model reachable"
L1=$(run "Reply with the single word PONG and nothing else.")
echo "$L1"
if echo "$L1" | grep -qi pong; then echo "L1 OK"; else echo "L1 FAIL"; exit 1; fi

echo
echo "### L2 plugin loaded"
L2=$(docker exec "$NAME" pi list 2>&1)
echo "$L2"
if echo "$L2" | grep -q "/plugin"; then echo "L2 OK"; else echo "L2 FAIL: /plugin not installed"; exit 1; fi

echo
echo "### L3 legion tool registered"
L3=$(run "Do you have a tool named subagent? Answer one word YES or NO.")
echo "$L3"
if echo "$L3" | grep -qi yes; then echo "L3 OK"; else echo "L3 FAIL: subagent missing"; exit 1; fi

echo
echo "### L4 worktree:true roles can run (git + a HEAD to branch from)"
# #272: `worktree: true` (centurion) needs git AND a commit. An empty repo passes
# `rev-parse --is-inside-work-tree` but fails `worktree add ... HEAD`, which then
# reads as a pi-legion bug instead of a missing sandbox prerequisite.
L4=$(docker exec "$NAME" bash -lc 'cd /root/work && git rev-parse --short HEAD 2>&1')
echo "HEAD: $L4"
if [ -z "$L4" ] || echo "$L4" | grep -qi "fatal\|not a git"; then
  echo "L4 FAIL: /root/work cannot host a worktree (git or HEAD missing)"
  exit 1
fi
echo "L4 OK"

echo
echo "ALL LAYERS PASSED"
