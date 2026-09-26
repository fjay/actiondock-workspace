#!/usr/bin/env bash
# ==============================================================================
# entrypoint.sh - knowledge-server 容器启动脚本
# ==============================================================================
set -e

# 1. 检查并修正 SSH 挂载目录权限 (保证 Git 免密操作可用)
if [ -d "/root/.ssh" ] && [ -w "/root/.ssh" ]; then
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

# 4. 强约束安全校验：ACTIONDOCK_TOKEN 与 ACTIONDOCK_AGENT_TOKEN 必须存在且长度 >= 32 且互不相同
if [ -z "${ACTIONDOCK_TOKEN}" ] || [ "${#ACTIONDOCK_TOKEN}" -lt 32 ]; then
    echo "[SECURITY ERROR] ACTIONDOCK_TOKEN must be set and contain at least 32 characters." >&2
    exit 1
fi

if [ -z "${ACTIONDOCK_AGENT_TOKEN}" ] || [ "${#ACTIONDOCK_AGENT_TOKEN}" -lt 32 ]; then
    echo "[SECURITY ERROR] ACTIONDOCK_AGENT_TOKEN must be set and contain at least 32 characters." >&2
    exit 1
fi

if [ "${ACTIONDOCK_TOKEN}" = "${ACTIONDOCK_AGENT_TOKEN}" ]; then
    echo "[SECURITY ERROR] ACTIONDOCK_TOKEN and ACTIONDOCK_AGENT_TOKEN must not be identical." >&2
    exit 1
fi

# 检查是否使用了已知公开的示例占位符 Token
for token in "${ACTIONDOCK_TOKEN}" "${ACTIONDOCK_AGENT_TOKEN}"; do
    case "${token}" in
        *4f8c9b*|*e7a1d2*|*9f83b2a7*|*8a12d4e7*|*your-random-secure*)
            echo "[SECURITY ERROR] Detected insecure default/example placeholder token. Please generate high-strength random tokens using: openssl rand -hex 32" >&2
            exit 1
            ;;
    esac
done

# 5. 启动常驻单端口虚拟视图 HTTP 服务 (原生单端口多视图 Virtual Views 模式)
exec node /app/server/virtual-views-server.mjs

