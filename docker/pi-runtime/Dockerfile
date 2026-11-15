# pi-runtime：piwork SandboxRpcBackend 的沙箱运行时镜像
# （docs/opensandbox-integration-spec.md §6 Phase 2 / v2.0 Step 6）。
#
# 构建上下文为本目录（无仓库文件依赖）：
#   docker build -f docker/pi-runtime/Dockerfile -t pi-runtime:dev docker/pi-runtime
#
# 完整安装 pi 包——单拷 dist/bundle 不是合法分发（bundle 运行时仍从周边
# node_modules 解析 jiti 等依赖，实测扩展装载即失败，见 spec §7）。非 root
# 运行；workspace 挂载点 /workspace 预建（bind 由 provider 注入，空/ephemeral
# source 时 provider 挂匿名卷）。依赖均为纯 JS/WASM（无 .node addon），alpine
# (musl) 可用；quickjs-wasi/photon 走 Node 内建 WASI。
#
# 宿主侧装配对应（lib/runtime/run/index.ts）：
#   PIWORK_SANDBOX_IMAGE=pi-runtime:dev
#   PIWORK_SANDBOX_CLI_PATH=/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js

# 版本与仓库 package.json 的 @earendil-works/pi-coding-agent 精确一致；升级时同步（AGENTS.md Pi-first）
ARG PI_CLI_VERSION=1.5.2
FROM node:22-alpine

# ARG 在 FROM 前声明的只在 FROM 行生效，stage 内需重新声明才能被 --build-arg 覆盖
ARG PI_CLI_VERSION=1.5.2

# npm 源可覆盖（默认官方源；受限网络构建：
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com）
ARG NPM_REGISTRY=https://registry.npmjs.org

RUN addgroup -S pi && adduser -S -G pi -h /home/pi pi

# engines: node >=22.19（构建期断言，防基础镜像漂移）
RUN node -e "const [M,m]=process.versions.node.split('.').map(Number); if (M!==22||m<19) process.exit(1)"

RUN npm install --omit=dev --registry="${NPM_REGISTRY}" --prefix /opt/pi "@earendil-works/pi-coding-agent@${PI_CLI_VERSION}" \
  && rm -rf /root/.npm

# bash 供 pi 内建 bash 工具与 provider 的 dd/cat 契约；git 供 hosted-git-info 类解析按需再加
RUN apk add --no-cache bash

# Python 工具链 + 预装 Office/PDF 生成库（文档类执行任务的运行时面）。
# musl 下 lxml/Pillow 走 apk 预编译包，避免运行时 pip 触发源码编译；其余为
# 纯 wheel（python-pptx/python-docx/openpyxl/reportlab/pypdf）。
# 构建期断言可导入，镜像缺能力时在 build 阶段即失败而不是等模型在沙箱里撞错。
RUN apk add --no-cache python3 py3-pip py3-lxml py3-pillow \
  && pip install --no-cache-dir --break-system-packages \
    python-pptx python-docx openpyxl reportlab pypdf \
  && python3 -c "import lxml, PIL, pptx, xlsxwriter, docx, openpyxl, reportlab, pypdf; print('python office/pdf toolchain ok')"

# 中文字体（Noto CJK）：中文 PDF/Word 产出的硬前提，缺失时输出全是豆腐块。
RUN apk add --no-cache font-noto-cjk \
  && test -f /usr/share/fonts/noto/NotoSansCJK-Regular.ttc

# typst：现代排版 PDF 生成器，官方静态 musl 二进制（无运行时依赖）。
# 锁定版本保证可复现；升级时更新 TYPST_VERSION。
ARG TYPST_VERSION=0.15.1
RUN apk add --no-cache xz \
  && wget -q -O /tmp/typst.tar.xz \
    "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
  && tar -xJf /tmp/typst.tar.xz -C /tmp \
  && mv "/tmp/typst-x86_64-unknown-linux-musl/typst" /usr/local/bin/typst \
  && chmod +x /usr/local/bin/typst \
  && rm -rf /tmp/typst.tar.xz "/tmp/typst-x86_64-unknown-linux-musl" \
  && typst --version

RUN mkdir -p /workspace \
  && chown -R pi:pi /opt/pi /workspace /home/pi

USER pi
WORKDIR /workspace

# 沙箱内 pi cli 绝对路径（宿主 PIWORK_SANDBOX_CLI_PATH 必须与此一致）
ENV PIWORK_SANDBOX_CLI_PATH=/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
