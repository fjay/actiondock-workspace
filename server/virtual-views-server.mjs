import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";

// 1. 读取环境配置
const PORT = parseInt(process.env.PORT || "443", 10);
const SK_TOKEN = process.env.ACTIONDOCK_TOKEN || "";
const AGENT_TOKEN = process.env.ACTIONDOCK_AGENT_TOKEN || "";
const INTERNAL_PORT = 5177;
const INTERNAL_HOST = "127.0.0.1";
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || "/srv/workspace";
const KNOWLEDGE_INBOX_ROOT = process.env.KNOWLEDGE_INBOX_ROOT || "/srv/knowledge-inbox";

// 启动强约束安全防御检查
if (!SK_TOKEN || SK_TOKEN.length < 32) {
  throw new Error("ACTIONDOCK_TOKEN is required and must be at least 32 characters long");
}
if (!AGENT_TOKEN || AGENT_TOKEN.length < 32) {
  throw new Error("ACTIONDOCK_AGENT_TOKEN is required and must be at least 32 characters long");
}
if (SK_TOKEN === AGENT_TOKEN) {
  throw new Error("ACTIONDOCK_TOKEN and ACTIONDOCK_AGENT_TOKEN must not be identical");
}

// 检查是否使用了已知公开的示例占位符 Token
const INSECURE_TOKEN_PATTERNS = [
  "4f8c9b",
  "e7a1d2",
  "9f83b2a7",
  "8a12d4e7",
  "your-random-secure",
];

function isKnownInsecureToken(token) {
  return INSECURE_TOKEN_PATTERNS.some((pattern) => token.includes(pattern));
}

if (isKnownInsecureToken(SK_TOKEN) || isKnownInsecureToken(AGENT_TOKEN)) {
  throw new Error(
    "Detected insecure default/example placeholder token. Please generate high-strength random tokens using: openssl rand -hex 32"
  );
}

// 白名单动作与受控包定义 (统一使用完全合格名称 Fully Qualified Action Name)
const SK_ALLOWLIST = new Set([
  "workspace/files.read",
  "workspace/files.list",
  "workspace/search.rg",
  "knowledge/knowledge.collect",
]);

const SK_SHORT_ACTION_MAP = {
  "files.read": "workspace/files.read",
  "files.list": "workspace/files.list",
  "search.rg": "workspace/search.rg",
  "knowledge.collect": "knowledge/knowledge.collect",
};

const SKM_PACKAGE_ALLOWLIST = new Set(["workspace", "knowledge", "maintenance"]);

const ACTION_PACKAGE_MAP = {
  // workspace
  "search.rg": "workspace",
  "files.read": "workspace",
  "files.list": "workspace",
  "files.write": "workspace",
  "files.edit": "workspace",
  "files.delete": "workspace",
  "files.move": "workspace",
  "git.status": "workspace",
  "git.diff": "workspace",
  "links.verify": "workspace",
  // knowledge
  "knowledge.collect": "knowledge",
  "knowledge.list": "knowledge",
  "knowledge.archive": "knowledge",
  // maintenance
  "maintenance.sync": "maintenance",
  "maintenance.list": "maintenance",
  "maintenance.publish": "maintenance",
  "maintenance.complete": "maintenance",
};

// 2. 启动底层 ActionDock 守护进程 (清除 Token 环境变量，由网关统一进行虚拟视图鉴权，彻底移除 --management)
const backendEnv = { ...process.env };
delete backendEnv.ACTIONDOCK_TOKEN;
delete backendEnv.ACTIONDOCK_AGENT_TOKEN;

console.log("[INFO] Starting internal ActionDock backend service on port " + INTERNAL_PORT + "...");
const backend = spawn(
  "ad",
  ["serve", "-p", String(INTERNAL_PORT), "-H", INTERNAL_HOST, "--allow-insecure-no-auth"],
  {
    stdio: "inherit",
    env: backendEnv,
  }
);

backend.on("exit", (code, signal) => {
  console.log(`[INFO] Internal backend exited with code ${code}, signal ${signal}`);
  process.exit(code ?? 1);
});

// 等待后端就绪
async function waitForBackend(maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(
          `http://${INTERNAL_HOST}:${INTERNAL_PORT}/api/v2/health`,
          { timeout: 1000 },
          (res) => {
            if (res.statusCode === 200) {
              resolve(true);
            } else {
              reject(new Error(`Status ${res.statusCode}`));
            }
          }
        );
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Timeout"));
        });
      });
      console.log("[INFO] Internal ActionDock backend service is healthy and ready.");
      return;
    } catch (err) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("ActionDock internal backend failed to start within timeout");
}

await waitForBackend();

// 3. TLS 证书加载或自签名生成
let cert;
let key;
const certPath = process.env.ACTIONDOCK_TLS_CERT || "/etc/actiondock/certs/cert.pem";
const keyPath = process.env.ACTIONDOCK_TLS_KEY || "/etc/actiondock/certs/key.pem";

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  cert = fs.readFileSync(certPath);
  key = fs.readFileSync(keyPath);
  console.log(`[INFO] Using TLS certificates from ${certPath} and ${keyPath}`);
} else {
  console.log("[INFO] Generating self-signed TLS certificate via openssl...");
  const tempDir = "/tmp/actiondock-tls";
  fs.mkdirSync(tempDir, { recursive: true });
  const genKey = path.join(tempDir, "key.pem");
  const genCert = path.join(tempDir, "cert.pem");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${genKey}" -out "${genCert}" -days 365 -subj "/CN=127.0.0.1"`,
    { stdio: "ignore" }
  );
  cert = fs.readFileSync(genCert);
  key = fs.readFileSync(genKey);
  console.log("[INFO] Self-signed TLS certificate generated successfully.");
}

// 4. 请求解析辅助函数
function parseActionTarget(pathname) {
  const normalized = pathname.replace(/^\/api\/v2/, "").replace(/\/+$/, "");
  // 1. /packages/:pkg/actions/:action/(run|start)
  const pkgRunMatch = normalized.match(/^\/packages\/([^/]+)\/actions\/([^/]+)\/(run|start)$/);
  if (pkgRunMatch) {
    const pkg = decodeURIComponent(pkgRunMatch[1]);
    const act = decodeURIComponent(pkgRunMatch[2]);
    return {
      packageId: pkg,
      actionId: act,
      fullAction: `${pkg}/${act}`,
      operation: pkgRunMatch[3],
      hasPackage: true,
    };
  }
  // 2. /packages/:pkg/actions/:action
  const pkgMatch = normalized.match(/^\/packages\/([^/]+)\/actions\/([^/]+)$/);
  if (pkgMatch) {
    const pkg = decodeURIComponent(pkgMatch[1]);
    const act = decodeURIComponent(pkgMatch[2]);
    return {
      packageId: pkg,
      actionId: act,
      fullAction: `${pkg}/${act}`,
      operation: "describe",
      hasPackage: true,
    };
  }
  // 3. /actions/:id/(run|start)
  const actRunMatch = normalized.match(/^\/actions\/(.+?)\/(run|start)$/);
  if (actRunMatch) {
    const rawAction = decodeURIComponent(actRunMatch[1]).trim();
    if (!rawAction) return null;
    const op = actRunMatch[2];
    if (rawAction.includes("/")) {
      const slashIdx = rawAction.indexOf("/");
      const pkg = rawAction.slice(0, slashIdx);
      const act = rawAction.slice(slashIdx + 1);
      return {
        packageId: pkg,
        actionId: act,
        fullAction: rawAction,
        operation: op,
        hasPackage: true,
      };
    }
    const resolvedPkg = ACTION_PACKAGE_MAP[rawAction];
    return {
      packageId: resolvedPkg,
      actionId: rawAction,
      fullAction: resolvedPkg ? `${resolvedPkg}/${rawAction}` : rawAction,
      operation: op,
      hasPackage: false,
    };
  }
  // 4. /actions/:id
  const actMatch = normalized.match(/^\/actions\/(.+)$/);
  if (actMatch) {
    const rawAction = decodeURIComponent(actMatch[1]).trim();
    if (!rawAction) return null;
    if (rawAction.includes("/")) {
      const slashIdx = rawAction.indexOf("/");
      const pkg = rawAction.slice(0, slashIdx);
      const act = rawAction.slice(slashIdx + 1);
      return {
        packageId: pkg,
        actionId: act,
        fullAction: rawAction,
        operation: "describe",
        hasPackage: true,
      };
    }
    const resolvedPkg = ACTION_PACKAGE_MAP[rawAction];
    return {
      packageId: resolvedPkg,
      actionId: rawAction,
      fullAction: resolvedPkg ? `${resolvedPkg}/${rawAction}` : rawAction,
      operation: "describe",
      hasPackage: false,
    };
  }
  return null;
}

function verifyToken(req) {
  let token = "";
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  }
  if (!token) {
    try {
      const parsedUrl = new URL(req.url, "http://localhost");
      const qToken = parsedUrl.searchParams.get("token");
      if (qToken) {
        token = qToken.trim();
      }
    } catch {}
  }
  if (!token) return null;
  if (SK_TOKEN && token === SK_TOKEN) {
    return "sk";
  }
  if (AGENT_TOKEN && token === AGENT_TOKEN) {
    return "skm";
  }
  return null;
}

// 5. 反向代理转发
function proxyRequest(req, res, targetPath = req.url) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.authorization;

  const proxyReq = http.request(
    {
      hostname: INTERNAL_HOST,
      port: INTERNAL_PORT,
      path: targetPath,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    console.error("[Proxy Error]", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "BAD_GATEWAY", message: err.message } }));
    }
  });

  req.pipe(proxyReq);
}

// 6. 创建 HTTPS 服务 (严格的白名单反向代理与默认拒绝策略)
const server = https.createServer({ key, cert }, async (req, res) => {
  // CORS 支持
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, X-Request-Id");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, "https://localhost");
  const pathname = parsedUrl.pathname;

  // 放行健康检查：GET /api/v2/health 与 GET /health
  if ((pathname === "/api/v2/health" || pathname === "/health") && req.method === "GET") {
    proxyRequest(req, res);
    return;
  }

  // 鉴权校验
  const view = verifyToken(req);
  if (!view) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid or missing Bearer token",
        },
      })
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // sk 视图：白名单严格收敛 (只读检索与受控追加)
  // ---------------------------------------------------------------------------
  if (view === "sk") {
    // 放行动作列表：GET /api/v2/actions 与 GET /actions (严格过滤白名单 4 项动作)
    if ((pathname === "/api/v2/actions" || pathname === "/actions") && req.method === "GET") {
      try {
        const queryRes = await fetch(`http://${INTERNAL_HOST}:${INTERNAL_PORT}/api/v2/actions`);
        const actions = await queryRes.json();
        const filtered = Array.isArray(actions)
          ? actions.filter((a) => {
              const fullId =
                a.id && a.id.includes("/")
                  ? a.id
                  : a.packageId && (a.actionId || a.id)
                  ? `${a.packageId}/${a.actionId || a.id}`
                  : (a.id && SK_SHORT_ACTION_MAP[a.id]) || "";
              return SK_ALLOWLIST.has(fullId);
            })
          : [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(filtered));
        return;
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { code: "SERVER_ERROR", message: err.message } }));
        return;
      }
    }

    // 放行授权动作描述与执行：仅允许白名单 4 项动作的 GET describe 与 POST run/start
    const actionTarget = parseActionTarget(pathname);
    if (actionTarget) {
      let candidateFullAction = "";
      if (actionTarget.hasPackage) {
        // 当请求携带 package（如 /packages/:pkg/actions/:act 或 /actions/:pkg/:act）时，必须仅根据 fullAction 校验，绝不单独匹配 actionId
        candidateFullAction = actionTarget.fullAction;
      } else {
        // 当请求为短路径 /actions/:act 时，将其映射为官方全名
        candidateFullAction = SK_SHORT_ACTION_MAP[actionTarget.actionId] || "";
      }

      const allowed = candidateFullAction !== "" && SK_ALLOWLIST.has(candidateFullAction);

      if (allowed) {
        if (actionTarget.operation === "describe" && req.method === "GET") {
          proxyRequest(req, res);
          return;
        }
        if ((actionTarget.operation === "run" || actionTarget.operation === "start") && req.method === "POST") {
          proxyRequest(req, res);
          return;
        }
      }

      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: {
            code: "ACTION_FORBIDDEN",
            message: `Action '${actionTarget.fullAction || actionTarget.actionId}' is not allowed in sk view`,
          },
        })
      );
      return;
    }

    // 其余所有请求全部直接响应 403 阻断，绝对不调用 proxyRequest 默认转发
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Access denied by gateway security policy",
        },
      })
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // skm 视图：受控维护视图 (workspace, knowledge, maintenance)
  // ---------------------------------------------------------------------------
  if (view === "skm") {
    // 放行动作列表：GET /api/v2/actions 与 GET /actions (过滤保留三个受控包动作)
    if ((pathname === "/api/v2/actions" || pathname === "/actions") && req.method === "GET") {
      try {
        const queryRes = await fetch(`http://${INTERNAL_HOST}:${INTERNAL_PORT}/api/v2/actions`);
        const actions = await queryRes.json();
        const filtered = Array.isArray(actions)
          ? actions.filter(
              (a) =>
                (a.packageId && SKM_PACKAGE_ALLOWLIST.has(a.packageId)) ||
                (a.id && ACTION_PACKAGE_MAP[a.id])
            )
          : [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(filtered));
        return;
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { code: "SERVER_ERROR", message: err.message } }));
        return;
      }
    }

    // 放行授权动作描述与执行：仅允许受控包内的动作 GET describe 与 POST run/start
    const actionTarget = parseActionTarget(pathname);
    if (actionTarget) {
      const allowed =
        actionTarget.packageId && SKM_PACKAGE_ALLOWLIST.has(actionTarget.packageId);

      if (allowed) {
        if (actionTarget.operation === "describe" && req.method === "GET") {
          proxyRequest(req, res);
          return;
        }
        if ((actionTarget.operation === "run" || actionTarget.operation === "start") && req.method === "POST") {
          proxyRequest(req, res);
          return;
        }
      }

      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: {
            code: "PACKAGE_FORBIDDEN",
            message: `Package '${actionTarget.packageId || "unknown"}' is not allowed in skm view`,
          },
        })
      );
      return;
    }

    // 其余所有请求全部直接响应 403 阻断，绝对不调用 proxyRequest 默认转发
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Access denied by gateway security policy",
        },
      })
    );
    return;
  }

  // 兜底 403 阻断
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "Forbidden" } }));
});

// 7. 启动服务监听
server.listen(PORT, "0.0.0.0", () => {
  console.log("============================================================");
  console.log("Starting ActionDock Knowledge Server (Single-Port Virtual Views Mode)");
  console.log(`Port:           ${PORT} (HTTPS, Virtual Views)`);
  console.log("sk view:        Enabled (Read & append-only: search.rg, files.read, files.list, knowledge.collect)");
  console.log("skm view:       Enabled (Package allowlist: workspace, knowledge, maintenance)");
  console.log(`Workspace Root: ${WORKSPACE_ROOT}`);
  console.log(`Inbox Root:     ${KNOWLEDGE_INBOX_ROOT}`);
  console.log("============================================================");
  console.log("Server is ready to accept remote requests.");
});

// 8. 优雅停机信号处理
function shutdown() {
  console.log("[INFO] Received termination signal, gracefully shutting down...");
  server.close(() => {
    console.log("[INFO] HTTPS Gateway closed.");
  });
  backend.kill("SIGTERM");
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
