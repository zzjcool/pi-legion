#!/usr/bin/env bash
# 跨机真机自测台 —— 拓扑拉起（契约 docs/contracts/xm-harness-v1.md §2 / §3 / §6）
#
#   cd test/docker && make xm-up      # 或直接 bash test/docker/xm-up.sh
#
# 产出**两个容器、两套文件系统、两个进程树、一条真实网络传输**：
#   xm-parent  真 hc（宿主提供）+ pi + /plugin（仓库只读挂载）→ ssh 出去
#   xm-remote  sshd :22 + pi + /plugin + 被 hc 拷进去的 hc agent
# 两端 /srv/git 是同一个 bare origin 卷，各自 /root/work 的 origin 都指向
# /srv/git/app.git（交付预检要求两端 origin 归一化后同名，契约 §2.5）。
#
# 幂等：每次先删同名容器 / 网络 / 卷再重建，可反复执行。
# 命令序列照抄契约 §6（已在本机实测通过），不要自行调换顺序。
#
# 所有环境变量都可覆盖（契约 §3 冻结接口）：
#   XM_IMAGE   pi-legion-xm:latest   XM_NET    xm-net
#   XM_VOL     xm-origin             XM_PARENT xm-parent
#   XM_REMOTE  xm-remote             XM_HOST   remote
#   XM_HOST_CWD /root/work           XM_MODEL  workbuddy/hy4std
#   HC_BIN     $HC_BIN → command -v hc → $HOME/.local/bin/hc
#
# 成功时 stdout 的最后一行固定是（W2 的 assert.mjs 依赖它）：
#   XM_UP_OK parent=<p> remote=<r> host=<h> hostCwd=<cwd>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
AGENT="${AGENT:-$HOME/.pi/agent}"

XM_IMAGE="${XM_IMAGE:-pi-legion-xm:latest}"
XM_NET="${XM_NET:-xm-net}"
XM_VOL="${XM_VOL:-xm-origin}"
XM_PARENT="${XM_PARENT:-xm-parent}"
XM_REMOTE="${XM_REMOTE:-xm-remote}"
XM_HOST="${XM_HOST:-remote}"
XM_HOST_CWD="${XM_HOST_CWD:-/root/work}"
XM_MODEL="${XM_MODEL:-workbuddy/hy4std}"
# Which topology the deterministic driver is about to exercise:
#   launch        — both containers register the mock provider `xm/flash`
#   model-missing — the REMOTE machine does not know that provider at all (§5.4)
XM_MODEL_SCENARIO="${XM_MODEL_SCENARIO:-launch}"
# The two mock LLM ports. These are FROZEN: test/docker/xm/drive.mjs (MOCK_PORTS)
# points the parent container's pi at 8765 and the remote child at 8766.
XM_MOCK_PORT_PARENT=8765
XM_MOCK_PORT_CHILD=8766

# 每一步失败都按契约 §3 的三段式报出来：哪一步、哪条命令、原始输出。
die() {
  printf 'XM_FAIL %s :: %s :: %s\n' "$1" "$2" "$3" >&2
  exit 1
}

step() { printf 'XM_STEP %s\n' "$*"; }

# xm_run <stage> <cmd...>：跑命令，失败即 XM_FAIL（带原始输出），成功时把输出透传。
xm_run() {
  local stage=$1
  shift
  local out
  if ! out=$("$@" 2>&1); then
    die "$stage" "$*" "$out"
  fi
  if [ -n "$out" ]; then printf '%s\n' "$out"; fi
  return 0
}

# xm_cap <stage> <cmd...>：同上，但成功时输出交给调用方 $(...) 捕获。
xm_cap() {
  local stage=$1
  shift
  local out
  if ! out=$("$@" 2>&1); then
    die "$stage" "$*" "$out"
  fi
  printf '%s' "$out"
}

# ---------------------------------------------------------------- 0. 前置检查
step "preflight"

command -v docker >/dev/null 2>&1 \
  || die preflight-docker "command -v docker" "SKIPPED: docker not available"
docker info >/dev/null 2>&1 \
  || die preflight-docker "docker info" "SKIPPED: docker not available"

# 模型凭据来自宿主（契约 §7.4）：缺了容器里 pi 一个模型都没有。
# F8: auth.json 与 models.json **两个都要有**——只有 auth 没有 provider 注册（或反过来）
# 都会让容器里的 pi 静默少模型，那必须在 preflight 变成 SKIPPED + exit 1，不是跑下去再猜。
{ [ -f "$AGENT/auth.json" ] && [ -f "$AGENT/models.json" ]; } \
  || die preflight-credentials "test -f $AGENT/auth.json && test -f $AGENT/models.json" \
         "SKIPPED: no host pi credentials"

# 真 hc：契约 §7.2 的硬限制 —— 容器不联网装 herdr-core，二进制只能由宿主提供。
HC_BIN="${HC_BIN:-}"
if [ -n "$HC_BIN" ] && [ -x "$HC_BIN" ]; then
  :
elif command -v hc >/dev/null 2>&1; then
  HC_BIN="$(command -v hc)"
elif [ -x "${HOME:-/root}/.local/bin/hc" ]; then
  HC_BIN="${HOME:-/root}/.local/bin/hc"
else
  die preflight-hc "HC_BIN | command -v hc | \$HOME/.local/bin/hc" \
    "SKIPPED: no herdr-core (hc) binary"
fi
# 宿主上 hc 常是 herdr-core 的符号链接，docker cp 不会跟链接，先解析成实体文件。
HC_BIN="$(readlink -f "$HC_BIN" 2>/dev/null || printf '%s' "$HC_BIN")"
[ -x "$HC_BIN" ] \
  || die preflight-hc "readlink -f $HC_BIN" "SKIPPED: no herdr-core (hc) binary"
step "hc=$HC_BIN $(xm_cap preflight-hc "$HC_BIN" --version | head -1)"

# --------------------------------------------------------------- 1. 镜像
# 契约 §6 第 1 步；make xm 依赖「镜像不存在就自动 build」。
if docker image inspect "$XM_IMAGE" >/dev/null 2>&1; then
  step "image present $XM_IMAGE"
else
  step "image build $XM_IMAGE（首次构建 ≤6 分钟）"
  xm_run image-build docker build -t "$XM_IMAGE" -f "$HERE/Dockerfile.xm" "$ROOT" | tail -5
fi

# ------------------------------------------- 1.5 每容器各自的 models.json
# v1.1：provider id 与 model id 必须**两端同名**（父机 argv 把 `<provider>/<model>`
# 传给远端），只有 baseUrl 不同。容器的 /root/.pi/agent/models.json 是宿主
# models.json 的只读挂载，没法原地追加 provider，所以这里生成两份合并文件，
# 再分别挂进两个容器。宿主文件里的真实 provider 原样保留（make xm-real 用得上）。
XM_MODELS_DIR="${XM_MODELS_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/xm-models.XXXXXX")}"
step "models dir $XM_MODELS_DIR scenario=$XM_MODEL_SCENARIO"
xm_run models-parent node "$HERE/xm/models-merge.mjs" \
  --base "$AGENT/models.json" \
  --out "$XM_MODELS_DIR/parent/models.json" \
  --base-url "http://parent:$XM_MOCK_PORT_PARENT/v1"
if [ "$XM_MODEL_SCENARIO" = "model-missing" ]; then
  # 远端不认识 xm provider：pi 的启动探针会答 “Unknown provider” + 远端真实模型表，
  # 产品据此报 model-missing（remote.ts:841-867）。
  xm_run models-remote node "$HERE/xm/models-merge.mjs" \
    --base "$AGENT/models.json" \
    --out "$XM_MODELS_DIR/remote/models.json" \
    --no-xm
else
  xm_run models-remote node "$HERE/xm/models-merge.mjs" \
    --base "$AGENT/models.json" \
    --out "$XM_MODELS_DIR/remote/models.json" \
    --base-url "http://parent:$XM_MOCK_PORT_CHILD/v1"
fi

# ------------------------------------------------- 2. 幂等清理 + 网络 + 卷
step "cleanup (idempotent) $XM_PARENT $XM_REMOTE $XM_NET $XM_VOL"
docker rm -f "$XM_PARENT" "$XM_REMOTE" >/dev/null 2>&1 || true
docker network rm "$XM_NET" >/dev/null 2>&1 || true
docker volume rm "$XM_VOL" >/dev/null 2>&1 || true

xm_run net-create docker network create "$XM_NET" >/dev/null
xm_run vol-create docker volume create "$XM_VOL" >/dev/null

# 凭据挂载（models-store.json 必须可写：pi 会把运行期状态写回去）。
# 注意用 if 而不是 `[ -f x ] && ...`：后者在文件缺失时返回 1，set -e 会静默退出。
# 数组展开写成 ${arr[@]+"${arr[@]}"}：空数组在 bash 3.2（macOS 自带）下 set -u 会报 unbound。
CRED_MOUNTS=()
if [ -f "$AGENT/auth.json" ]; then
  CRED_MOUNTS+=(-v "$AGENT/auth.json:$AGENT/auth.json:ro")
fi
# F7: models-store.json 是 pi 的运行期缓存，**不能**两个容器 rw 挂同一个宿主文件
# （两边写同一份缓存 = 互相踩）。每个容器一份副本，各挂各的。
PARENT_MODELS_MOUNT=(-v "$XM_MODELS_DIR/parent/models.json:$AGENT/models.json:ro")
REMOTE_MODELS_MOUNT=(-v "$XM_MODELS_DIR/remote/models.json:$AGENT/models.json:ro")
if [ -f "$AGENT/models-store.json" ]; then
  cp "$AGENT/models-store.json" "$XM_MODELS_DIR/parent/models-store.json"
  cp "$AGENT/models-store.json" "$XM_MODELS_DIR/remote/models-store.json"
  PARENT_MODELS_MOUNT+=(-v "$XM_MODELS_DIR/parent/models-store.json:$AGENT/models-store.json")
  REMOTE_MODELS_MOUNT+=(-v "$XM_MODELS_DIR/remote/models-store.json:$AGENT/models-store.json")
  step "models-store copied per container (parent/remote)"
else
  step "warn: $AGENT/models-store.json 不存在，容器里模型库可能为空"
fi

# ------------------------------------------------------ 3. 两容器（契约 §6）
# --hostname 与容器名都可解析，但不用 --network=host：跨机必须走真网络。
step "run $XM_REMOTE (sshd :22)"
xm_run run-remote docker run -d --name "$XM_REMOTE" --hostname "$XM_HOST" --network "$XM_NET" \
  -v "$ROOT:/plugin:ro" -v "$XM_VOL:/srv/git" \
  ${REMOTE_MODELS_MOUNT[@]+"${REMOTE_MODELS_MOUNT[@]}"} \
  ${CRED_MOUNTS[@]+"${CRED_MOUNTS[@]}"} -e HOME=/root \
  "$XM_IMAGE" /usr/sbin/sshd -D -e >/dev/null

step "run $XM_PARENT"
xm_run run-parent docker run -d --name "$XM_PARENT" --hostname parent --network "$XM_NET" \
  -v "$ROOT:/plugin:ro" -v "$XM_VOL:/srv/git" \
  ${PARENT_MODELS_MOUNT[@]+"${PARENT_MODELS_MOUNT[@]}"} \
  ${CRED_MOUNTS[@]+"${CRED_MOUNTS[@]}"} -e HOME=/root \
  "$XM_IMAGE" sleep infinity >/dev/null

# sshd 就绪：从 parent 侧连 TCP 22，顺带证明容器间 DNS 与端口通。
ready=""
for _ in $(seq 1 60); do
  if docker exec "$XM_PARENT" bash -c "exec 3<>/dev/tcp/$XM_HOST/22" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  die sshd-ready "docker exec $XM_PARENT bash -c 'exec 3<>/dev/tcp/$XM_HOST/22'" \
    "30s 内 sshd 未就绪；docker logs $XM_REMOTE: $(docker logs --tail 20 "$XM_REMOTE" 2>&1)"
fi
step "sshd ready $XM_HOST:22"

# ---------------------------------------- 4. settings：MERGE（绝不能覆盖写）
# 覆盖写会丢 packages → provider 与 /plugin 注册消失 → 容器里 pi --list-models 变空。
# v1.1 追加 defaultProvider/defaultModel（xm/flash），同样走 merge；packages 由
# settings-merge.mjs 的硬不变量守住。
XM_SETTINGS_PATCH='{"subagents":{"crossMachine":{"enabled":true}},"defaultProvider":"xm","defaultModel":"flash"}'
if [ "$XM_MODEL_SCENARIO" = "model-missing" ]; then
  # 远端没有 xm provider，默认模型名就不该指向它。
  XM_SETTINGS_PATCH_REMOTE='{"subagents":{"crossMachine":{"enabled":true}}}'
else
  XM_SETTINGS_PATCH_REMOTE="$XM_SETTINGS_PATCH"
fi
xm_run settings-parent docker exec "$XM_PARENT" \
  node /plugin/test/docker/xm/settings-merge.mjs /root/.pi/agent/settings.json "$XM_SETTINGS_PATCH"
xm_run settings-remote docker exec "$XM_REMOTE" \
  node /plugin/test/docker/xm/settings-merge.mjs /root/.pi/agent/settings.json "$XM_SETTINGS_PATCH_REMOTE"

# ------------------------------------ 5. 共享 bare origin + 两端同名 origin
# 预检（cross-machine-preflight.ts）要求两端 origin 归一化后同名 → 同一个卷 + 同一路径。
xm_run origin-init docker exec "$XM_PARENT" bash -lc \
  'mkdir -p /srv/git && git init -q --bare /srv/git/app.git'
for c in "$XM_PARENT" "$XM_REMOTE"; do
  # 两端同镜像、同 baseline 提交，push 幂等；--force 只防「远端已存在分叉时不幂等」。
  xm_run "origin-$c" docker exec "$c" bash -lc \
    "git -C $XM_HOST_CWD remote remove origin >/dev/null 2>&1 || true
     git -C $XM_HOST_CWD remote add origin /srv/git/app.git
     git -C $XM_HOST_CWD push -q --force origin HEAD:master
     git -C $XM_HOST_CWD remote get-url origin"
done

# ------------------------------------------------------ 6. ssh 密钥（parent → remote）
# bootstrap：authorized_keys 由 up.sh 用 docker exec 灌进 remote，这不是产品路径，
# 产品路径是 `hc machine add --install` 之后 hc 自己维护的那套。
xm_run ssh-keygen docker exec "$XM_PARENT" bash -lc \
  'mkdir -p /root/.ssh && chmod 700 /root/.ssh &&
   [ -f /root/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -f /root/.ssh/id_ed25519'

PUBKEY="$(xm_cap ssh-pub docker exec "$XM_PARENT" cat /root/.ssh/id_ed25519.pub)"
[ -n "$PUBKEY" ] || die ssh-pub "docker exec $XM_PARENT cat /root/.ssh/id_ed25519.pub" "公钥为空"

out="$(printf '%s\n' "$PUBKEY" | docker exec -i "$XM_REMOTE" bash -lc \
  'mkdir -p /root/.ssh && chmod 700 /root/.ssh &&
   cat >> /root/.ssh/authorized_keys &&
   sort -u -o /root/.ssh/authorized_keys /root/.ssh/authorized_keys &&
   chmod 600 /root/.ssh/authorized_keys && wc -l < /root/.ssh/authorized_keys' 2>&1)" \
  || die ssh-authorized-keys "docker exec -i $XM_REMOTE bash -lc '<灌 authorized_keys>'" "$out"
step "authorized_keys lines=$out"

# 非交互 ssh：不读 known_hosts、不问指纹（容器是一次性的）。
out="$(
  docker exec -i "$XM_PARENT" bash -lc 'mkdir -p /root/.ssh && chmod 700 /root/.ssh &&
    cat > /root/.ssh/config && chmod 600 /root/.ssh/config' <<EOF
Host $XM_HOST
  HostName $XM_HOST
  User root
  IdentityFile /root/.ssh/id_ed25519
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
EOF
)" || die ssh-config "docker exec -i $XM_PARENT bash -lc '<写 /root/.ssh/config>'" "$out"
step "ssh config $XM_PARENT:/root/.ssh/config → Host $XM_HOST"

probe="$(xm_cap ssh-probe docker exec "$XM_PARENT" \
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$XM_HOST" 'echo XM_SSH_OK')"
case "$probe" in
  *XM_SSH_OK*) step "ssh $XM_PARENT → $XM_HOST 通" ;;
  *) die ssh-probe "ssh $XM_HOST" "未收到 XM_SSH_OK，原始输出: $probe" ;;
esac

# ---------------------------------------------------- 7. 真 hc（宿主二进制 → parent）
xm_run hc-copy docker cp "$HC_BIN" "$XM_PARENT:/usr/local/bin/hc"
xm_run hc-chmod docker exec "$XM_PARENT" chmod +x /usr/local/bin/hc
xm_run hc-version docker exec "$XM_PARENT" bash -lc 'export PATH=/usr/local/bin:$PATH; hc --version'
xm_run hc-machine-add docker exec "$XM_PARENT" bash -lc \
  "export PATH=/usr/local/bin:\$PATH; hc machine add --name $XM_HOST --install --temp --json $XM_HOST"

# ------------------------------------------------------------ 8. 自检（不是 skip）
# 环境坏就是 FAIL：容器里模型数为 0 说明 provider 没注册上（多半是 settings 被覆盖）。
MODELS_OUT="$(docker exec "$XM_PARENT" bash -lc "cd $XM_HOST_CWD && pi --list-models" 2>&1)" \
  || die selfcheck-models \
       "docker exec $XM_PARENT bash -lc 'cd $XM_HOST_CWD && pi --list-models'" "$MODELS_OUT"
# 首行是表头，其余每行一个模型；grep -c 在 0 个时返回 1，故吞掉退出码只看数字。
# 另：pi 在「一个模型都没有」时退出码也是 0（只打印 No models available），
# 所以必须显式认这句，光看退出码会漏掉真实故障。
case "$MODELS_OUT" in
  *"No models available"*)
    die selfcheck-models "docker exec $XM_PARENT bash -lc 'cd $XM_HOST_CWD && pi --list-models'" \
      "容器里 /root/.pi/agent/settings.json 的 packages 丢了（provider 没注册上，多半是覆盖写不是 merge）；原始输出: $MODELS_OUT" ;;
esac
MODEL_COUNT="$(printf '%s\n' "$MODELS_OUT" | tail -n +2 | grep -c . || true)"
case "$MODEL_COUNT" in
  ''|*[!0-9]*|0)
    die selfcheck-models "docker exec $XM_PARENT bash -lc 'cd $XM_HOST_CWD && pi --list-models'" \
      "容器里可用模型数=$MODEL_COUNT（0 个 = 环境坏，不是 skip；见契约 §5.1）原始输出: $MODELS_OUT" ;;
esac
step "parent models=$MODEL_COUNT (XM_MODEL=$XM_MODEL)"

MACHINES="$(xm_cap selfcheck-machines docker exec "$XM_PARENT" bash -lc \
  'export PATH=/usr/local/bin:$PATH; hc machine ls')"
case "$MACHINES" in
  *"$XM_HOST"*) step "hc machine ls 含 $XM_HOST" ;;
  *) die selfcheck-machines "docker exec $XM_PARENT bash -lc 'hc machine ls'" \
       "hc machine ls 里看不到 $XM_HOST，原始输出: $MACHINES" ;;
esac

printf 'XM_UP_OK parent=%s remote=%s host=%s hostCwd=%s\n' \
  "$XM_PARENT" "$XM_REMOTE" "$XM_HOST" "$XM_HOST_CWD"
