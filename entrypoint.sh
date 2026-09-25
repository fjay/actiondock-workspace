#!/usr/bin/env bash
# ==============================================================================
# entrypoint.sh - knowledge-server 容器启动脚本
# ==============================================================================
set -e

# 1. 检查并修正 SSH 挂载目录权限 (保证 Git 免密操作可用)
if [ -d "/root/.ssh" ]; then
    chmod 700 /root/.ssh 2>/dev/null || true
    if compgen -G "/root/.ssh/id_*" > /dev/null; then
        chmod 600 /root/.ssh/id_* 2>/dev/null || true
    fi
    # 自动接受新主机的 SSH 凭据指纹
    if [ ! -f "/root/.ssh/config" ]; then
        (echo -e "Host *\n  StrictHostKeyChecking accept-new\n" > /root/.ssh/config 2>/dev/null) || true
        chmod 600 /root/.ssh/config 2>/dev/null || true
    fi
fi

# 2. 配置 ActionDock 运行时全局配置
ad config set -g WORKSPACE_ROOT "${WORKSPACE_ROOT:-/srv/workspace}" >/dev/null 2>&1 || true
ad config set -g KNOWLEDGE_INBOX_ROOT "${KNOWLEDGE_INBOX_ROOT:-/srv/knowledge-inbox}" >/dev/null 2>&1 || true

# 确保 Monorepo packages 已链接到 ActionDock 全局路由 (幂等保障)
if [ -d "/app/packages" ]; then
    ad link /app/packages/knowledge-workspace >/dev/null 2>&1 || true
    ad link /app/packages/knowledge-inbox >/dev/null 2>&1 || true
    ad link /app/packages/knowledge-maintenance >/dev/null 2>&1 || true
fi

# 3. 如果通过 docker run / docker exec 传入了自定义命令，则直接执行该命令
if [ "$#" -gt 0 ] && [ "$1" != "serve" ]; then
    exec "$@"
fi

# 4. 默认启动常驻守护服务：ad serve (原生 HTTPS)
PORT="${PORT:-443}"
echo "============================================================"
echo "Starting ActionDock Knowledge Server on port ${PORT} (HTTPS)"
echo "Workspace Root: ${WORKSPACE_ROOT}"
echo "Inbox Root:     ${KNOWLEDGE_INBOX_ROOT}"
echo "============================================================"

# 构建 ad serve 启动参数
# 安全隔离：对外仅暴露 workspace (只读检索) 与 knowledge (候选投递与待审池)，特权 maintenance 仅限本地/SSH CLI 调用
SERVE_ARGS=("-p" "${PORT}" "-H" "0.0.0.0" "--https" "-P" "workspace,knowledge")

# 若配置了 ACTIONDOCK_TOKEN 则启用认证令牌
if [ -n "${ACTIONDOCK_TOKEN:-}" ]; then
    SERVE_ARGS+=("-t" "${ACTIONDOCK_TOKEN}")
else
    echo "[WARN] ACTIONDOCK_TOKEN not provided, running with --allow-insecure-no-auth"
    SERVE_ARGS+=("--allow-insecure-no-auth")
fi

# 检查是否存在挂载的正式 TLS 证书文件
CERT_FILE="${ACTIONDOCK_TLS_CERT:-/etc/actiondock/certs/cert.pem}"
KEY_FILE="${ACTIONDOCK_TLS_KEY:-/etc/actiondock/certs/key.pem}"

if [ -f "${CERT_FILE}" ] && [ -f "${KEY_FILE}" ]; then
    echo "[INFO] Using custom TLS certificates from ${CERT_FILE} and ${KEY_FILE}"
    SERVE_ARGS+=("--tls-cert" "${CERT_FILE}" "--tls-key" "${KEY_FILE}")
else
    echo "[INFO] No custom certificates provided, ad serve will auto-generate self-signed TLS certificates"
fi

exec ad serve "${SERVE_ARGS[@]}"
