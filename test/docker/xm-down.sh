#!/usr/bin/env bash
# 跨机真机自测台 —— 拓扑清理（契约 docs/contracts/xm-harness-v1.md §3）
#
#   cd test/docker && make xm-down      # 卷默认保留，XM_KEEP=0 连卷一起删
#
# 删两个容器 + 网络；卷（共享 bare origin）默认保留，便于 `make xm-down` 后
# 用同一份 origin 复查。要彻底清干净：`XM_KEEP=0 make xm-down`。
# 全部步骤容忍「本来就不存在」，因此可重复执行。
set -euo pipefail

XM_IMAGE="${XM_IMAGE:-pi-legion-xm:latest}"
XM_NET="${XM_NET:-xm-net}"
XM_VOL="${XM_VOL:-xm-origin}"
XM_PARENT="${XM_PARENT:-xm-parent}"
XM_REMOTE="${XM_REMOTE:-xm-remote}"
XM_KEEP="${XM_KEEP:-1}"

for c in "$XM_PARENT" "$XM_REMOTE"; do
  if docker rm -f "$c" >/dev/null 2>&1; then
    echo "XM_DOWN container-removed $c"
  else
    echo "XM_DOWN container-absent $c"
  fi
done

if docker network rm "$XM_NET" >/dev/null 2>&1; then
  echo "XM_DOWN network-removed $XM_NET"
else
  echo "XM_DOWN network-absent $XM_NET"
fi

if [ "$XM_KEEP" = "0" ]; then
  if docker volume rm "$XM_VOL" >/dev/null 2>&1; then
    echo "XM_DOWN volume-removed $XM_VOL"
  else
    echo "XM_DOWN volume-absent $XM_VOL"
  fi
else
  echo "XM_DOWN volume-kept $XM_VOL（XM_KEEP=0 才删）"
fi

echo "XM_DOWN_OK parent=$XM_PARENT remote=$XM_REMOTE net=$XM_NET vol=$XM_VOL keep=$XM_KEEP"
