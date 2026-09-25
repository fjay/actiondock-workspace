# knowledge-server
# 云主机 Dockerfile - 知识库自动维护与反馈闭环服务端
# ==============================================================================
FROM node:25-bookworm-slim

LABEL maintainer="ActionDock Knowledge Team"
LABEL description="ActionDock 2.x Knowledge Server (Read, Append, Privileged Maintenance Planes)"

# 安装必要的系统底层工具：git (带 partial clone 支持), ripgrep (search.rg 引擎), ssh, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ripgrep \
    openssh-client \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 配置 Git 全局安全目录与维护者基础身份，防止挂载卷在多用户/容器内外引发 dubious ownership 拦截
RUN git config --global --add safe.directory '*' && \
    git config --global user.name "Knowledge Maintainer" && \
    git config --global user.email "maintainer@actiondock.local"

# 全局安装最新版 ActionDock CLI
RUN npm config set strict-ssl false && \
    npm install -g @actiondock/cli && \
    npm cache clean --force

# 创建 Monorepo 应用目录并拷贝 package.json 与 packages
WORKDIR /app

COPY package*.json ./
COPY packages ./packages

# 安装工作空间生产依赖
RUN npm install --omit=dev --strict-ssl=false && npm cache clean --force

# 链接本地 packages 至 ActionDock 全局路由
RUN ad link /app/packages/knowledge-workspace && \
    ad link /app/packages/knowledge-inbox && \
    ad link /app/packages/knowledge-maintenance

# 软链接维护驱动脚本到全局 PATH，方便从外部或 SSH 直接执行
RUN ln -s /app/packages/knowledge-maintenance/scripts/run-maintenance.sh /usr/local/bin/run-maintenance.sh && \
    chmod +x /usr/local/bin/run-maintenance.sh

# 创建标准挂载目录与日志目录
RUN mkdir -p /srv/workspace /srv/knowledge-inbox /etc/actiondock /var/log/actiondock

# 默认运行环境变量
ENV NODE_ENV=production \
    PORT=443 \
    WORKSPACE_ROOT=/srv/workspace \
    KNOWLEDGE_INBOX_ROOT=/srv/knowledge-inbox \
    GIT_BLOBLESS_FETCH=true

# 暴露原生 HTTPS 端口
EXPOSE 443

# 拷贝容器启动入口
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /srv

ENTRYPOINT ["/entrypoint.sh"]
