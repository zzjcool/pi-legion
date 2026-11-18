# 跨机真机自测台 —— 拓扑镜像（契约 docs/contracts/xm-harness-v1.md §2）
#
#   docker build -t pi-legion-xm:latest -f test/docker/Dockerfile.xm .
#
# 宿主沙箱镜像已含 node24 / pi 1.5.x / git / tmux，这里只补**传输层**：
# hc（herdr-core）跨机的唯一传输就是 ssh（契约 §7.3），所以 openssh-server
# 必须躺在镜像里，openssh-client 供 parent 侧发起连接。

FROM ghcr.io/zzjcool/pi-legion/tui-sandbox:latest

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server openssh-client \
    && rm -rf /var/lib/apt/lists/*

# key-only ssh：只承认公钥认证。
# 刻意不设置任何登录口令，也不写任何「root 能否登录」类的开关 —— root 本来就没有
# 口令，配合只允许 publickey 这一条，口令路径自然不通。
# （注意：这一行以下不要出现那类开关的键名；工具链会把它脱敏成占位符并真写进文件。）
RUN printf '\n# xm-harness: key-only ssh (docs/contracts/xm-harness-v1.md §2)\nAuthenticationMethods publickey\n' \
      >> /etc/ssh/sshd_config

# 容器里没有 systemd 帮忙生成主机密钥，必须自己造，否则 sshd 起不来。
# /run/sshd 是 sshd 的 privilege separation 目录，缺了它 sshd -D 会直接退出。
RUN mkdir -p /run/sshd /root/.ssh \
    && chmod 700 /root/.ssh \
    && ssh-keygen -A

# 固定 git 身份：两端容器内 commit / push 都不该撞上 "Please tell me who you are"。
RUN git config --global user.email "xm@example.invalid" \
    && git config --global user.name "xm-harness"

EXPOSE 22

# hc 二进制（herdr-core）**不烧进镜像**：licence 与版本必须跟随宿主，
# 由 test/docker/xm-up.sh 在容器起来之后从宿主 docker cp 进 parent（契约 §7.2）。
# 没有 hc 的机器上 `make xm` 只能 SKIPPED + exit 1，这是本自测台的硬限制。
