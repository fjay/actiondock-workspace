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

# 4. 默认启动常驻双 HTTP 守护服务 (面向外部用户的查询服务 + 面向维护智能体的受控服务)
PORT="${PORT:-443}"
AGENT_PORT="${AGENT_PORT:-8443}"

echo "============================================================"
echo "Starting ActionDock Knowledge Server (Dual-Service Mode)"
echo "Query Server Port: ${PORT} (HTTPS, Action Whitelist)"
echo "Agent Server Port: ${AGENT_PORT} (HTTPS, Privileged Maintenance)"
echo "Workspace Root:    ${WORKSPACE_ROOT}"
echo "Inbox Root:        ${KNOWLEDGE_INBOX_ROOT}"
echo "============================================================"

# TLS 证书公共参数配置
TLS_ARGS=()
CERT_FILE="${ACTIONDOCK_TLS_CERT:-/etc/actiondock/certs/cert.pem}"
KEY_FILE="${ACTIONDOCK_TLS_KEY:-/etc/actiondock/certs/key.pem}"

if [ -f "${CERT_FILE}" ] && [ -f "${KEY_FILE}" ]; then
    echo "[INFO] Using custom TLS certificates from ${CERT_FILE} and ${KEY_FILE}"
    TLS_ARGS+=("--tls-cert" "${CERT_FILE}" "--tls-key" "${KEY_FILE}")
else
    echo "[INFO] No custom certificates provided, ad serve will auto-generate self-signed TLS certificates"
fi

# 4.1 服务一：面向外部查询用户的检索服务（动作级白名单严格收敛）
QUERY_ARGS=("-p" "${PORT}" "-H" "0.0.0.0" "--https" "${TLS_ARGS[@]}")
DEFAULT_QUERY_ACTIONS="workspace/search.rg,workspace/files.read,workspace/files.list,knowledge/knowledge.collect"
QUERY_ACTIONS="${ACTIONDOCK_QUERY_ACTIONS:-${DEFAULT_QUERY_ACTIONS}}"
QUERY_ARGS+=("-A" "${QUERY_ACTIONS}")

if [ -n "${ACTIONDOCK_TOKEN:-}" ]; then
    QUERY_ARGS+=("-t" "${ACTIONDOCK_TOKEN}")
else
    echo "[WARN] ACTIONDOCK_TOKEN not provided for query server, running with --allow-insecure-no-auth"
    QUERY_ARGS+=("--allow-insecure-no-auth")
fi

# 4.2 服务二：面向内部维护智能体的受控服务（具备完整读写与维护能力）
AGENT_ARGS=("-p" "${AGENT_PORT}" "-H" "0.0.0.0" "--https" "${TLS_ARGS[@]}" "-P" "workspace,knowledge,maintenance")
AGENT_TOKEN="${ACTIONDOCK_AGENT_TOKEN:-${ACTIONDOCK_TOKEN:-}}"

if [ -n "${AGENT_TOKEN}" ]; then
    AGENT_ARGS+=("-t" "${AGENT_TOKEN}")
else
    echo "[WARN] ACTIONDOCK_AGENT_TOKEN not provided, running with --allow-insecure-no-auth"
    AGENT_ARGS+=("--allow-insecure-no-auth")
fi

# 双服务常驻看护与优雅停机处理
QUERY_PID=""
AGENT_PID=""

cleanup() {
    echo "[INFO] Received termination signal, gracefully stopping services..."
    if [ -n "${AGENT_PID}" ] && kill -0 "${AGENT_PID}" 2>/dev/null; then
        kill -TERM "${AGENT_PID}" 2>/dev/null || true
    fi
    if [ -n "${QUERY_PID}" ] && kill -0 "${QUERY_PID}" 2>/dev/null; then
        kill -TERM "${QUERY_PID}" 2>/dev/null || true
    fi
    wait "${AGENT_PID}" 2>/dev/null || true
    wait "${QUERY_PID}" 2>/dev/null || true
    exit 0
}

trap cleanup SIGTERM SIGINT

# 启动智能体受控维护服务 (后台常驻)
ad serve "${AGENT_ARGS[@]}" &
AGENT_PID=$!
echo "[INFO] Agent maintenance server started with PID ${AGENT_PID} on port ${AGENT_PORT}"

# 启动外部查询检索服务 (后台常驻)
ad serve "${QUERY_ARGS[@]}" &
QUERY_PID=$!
echo "[INFO] Query search server started with PID ${QUERY_PID} on port ${PORT}"

# 监听任一服务退出，若任一异常退出则触发清理与容器退出
wait -n "${QUERY_PID}" "${AGENT_PID}" || true
cleanup
