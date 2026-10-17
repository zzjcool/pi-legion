# pi-legion 容器化测试 —— 一键入口（模式对齐 pi-async/test/docker）
#
#   cd test/docker && make help
#
# 两条路，各司其职：
#   pi-legion-real  真模型（挂宿主 auth + models-store，--network=host）
#   mock TUI 回归   确定性回归，容器内 mock LLM，不碰宿主模型
#
# 路径从 Makefile 位置反推仓库根，不硬编码 /root/... ：
#   ROOT = <repo>/        SRC = <repo>（插件源码，挂成 /plugin）

SHELL := /bin/bash
ROOT  := $(shell cd "$(dir $(lastword $(MAKEFILE_LIST)))/../.." && pwd)
DOCK  := $(ROOT)/test/docker

# 真模型容器
NAME  ?= pi-legion-real
IMAGE ?= ghcr.io/zzjcool/pi-legion/tui-sandbox:latest
MODEL ?= workbuddy/hy4-preview-ioa

# mock TUI 回归
COLS ?= 120
ROWS ?= 40
SCENARIO ?= echo

.PHONY: help build rebuild run it print shell status clean down smoke tui-visual

help: ## 显示帮助
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n",$$1,$$2}'

build: ## 构建沙箱镜像（>300s，tee 到 /tmp/pi-legion-build.log）
	@echo "构建中 → /tmp/pi-legion-build.log"
	@docker build -t "$(IMAGE)" -f "$(DOCK)/Dockerfile.tui-sandbox" "$(ROOT)" 2>&1 \
	  | tee /tmp/pi-legion-build.log | tail -3

rebuild: clean ## 重建镜像 + 换掉容器（改 Dockerfile / 升 pi 版本后跑这个）
	@$(MAKE) build
	@echo "==> 镜像已重建；旧容器已删，make run 会用新镜像重新 start"

up: ## 只起真模型容器，不进 pi
	@bash "$(DOCK)/run-tui-real.sh" --print "Reply with the single word OK" >/dev/null
	@echo "容器 $(NAME) 已起"

run: ## 起容器并直接进入 pi（默认 hy4-preview-ioa）—— 日常用这个
	@bash "$(DOCK)/run-tui-real.sh"

it: run ## run 的别名

print: ## 非交互问一句（PROMPT="..."），验证模型可达
	@bash "$(DOCK)/run-tui-real.sh" --print "$(PROMPT)"

shell: ## 只进容器 bash（不自动跑 pi）
	@bash "$(DOCK)/run-tui-real.sh" --shell

smoke: ## 三层冒烟：模型可达 → 插件加载 → legion 工具注册
	@bash "$(DOCK)/smoke-real.sh" "$(MODEL)" "$(NAME)"

tui-visual: ## mock 模型确定性 TUI 回归（SCENARIO/COLS/ROWS 可调）
	@docker image inspect "$(IMAGE)" >/dev/null 2>&1 || $(MAKE) build
	@env TUI_COLS="$(COLS)" TUI_ROWS="$(ROWS)" MOCK_LLM_SCENARIO="$(SCENARIO)" \
	  docker run --rm --env TUI_COLS --env TUI_ROWS --env MOCK_LLM_SCENARIO \
	  -v "$(ROOT)":/plugin -w /plugin "$(IMAGE)" \
	  bash test/docker/verify-tui-visual.sh

status: ## 容器与镜像状态（含子 agent 扩展注入是否就位）
	@docker ps -a --filter name=$(NAME) \
	  --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
	@docker images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}' \
	  | grep -E 'tui-sandbox' || echo "（镜像 $(IMAGE) 未构建）"
	@echo "--- 子 agent provider 注入 ---"
	@docker exec $(NAME) printenv PI_LEGION_CHILD_EXTENSIONS 2>/dev/null \
	  || echo "  PI_LEGION_CHILD_EXTENSIONS 未设置（容器未运行或镜像缺 any-endpoint → 子 agent 会报 Unknown provider）"

down: clean
clean: ## 删真模型容器（镜像保留）
	@docker rm -f $(NAME) >/dev/null 2>&1 && echo "已删 $(NAME)" || echo "$(NAME) 不存在"
