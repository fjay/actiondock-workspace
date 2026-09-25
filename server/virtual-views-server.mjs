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

// 白名单动作定义
const SK_ALLOWLIST = new Set([
  "search.rg",
  "files.read",
  "files.list",
  "knowledge.collect",
  "workspace/search.rg",
  "workspace/files.read",
  "workspace/files.list",
  "knowledge/knowledge.collect",
]);

const SKM_PACKAGE_ALLOWLIST = new Set(["workspace", "knowledge", "maintenance"]);

// 2. 启动底层 ActionDock 守护进程 (清除 Token 环境变量，由网关统一进行虚拟视图鉴权)
const backendEnv = { ...process.env };
delete backendEnv.ACTIONDOCK_TOKEN;
delete backendEnv.ACTIONDOCK_AGENT_TOKEN;

console.log("[INFO] Starting internal ActionDock backend service on port " + INTERNAL_PORT + "...");
const backend = spawn(
  "ad",
  ["serve", "-p", String(INTERNAL_PORT), "-H", INTERNAL_HOST, "--allow-insecure-no-auth", "--management"],
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
  const normalized = pathname.replace(/^\/api\/v2/, "");
  // 匹配 /packages/:pkg/actions/:action/...
  const pkgMatch = normalized.match(/^\/packages\/([^/]+)\/actions\/([^/]+)(?:\/(?:run|start))?$/);
  if (pkgMatch) {
    return {
      packageId: decodeURIComponent(pkgMatch[1]),
      actionId: decodeURIComponent(pkgMatch[2]),
      fullAction: `${decodeURIComponent(pkgMatch[1])}/${decodeURIComponent(pkgMatch[2])}`,
    };
  }
  // 匹配 /actions/:action/...
  const actMatch = normalized.match(/^\/actions\/([^/]+)(?:\/(?:run|start))?$/);
  if (actMatch) {
    const rawAction = decodeURIComponent(actMatch[1]);
    if (rawAction.includes("/")) {
      const parts = rawAction.split("/");
      return {
        packageId: parts[0],
        actionId: parts.slice(1).join("/"),
        fullAction: rawAction,
      };
    }
    return {
      actionId: rawAction,
      fullAction: rawAction,
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

// 6. 创建 HTTPS 服务
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

  // 健康检查直接放行
  if (pathname === "/api/v2/health" || pathname === "/health") {
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
  // sk 视图：白名单严格收敛
  // ---------------------------------------------------------------------------
  if (view === "sk") {
    // 1. 动作列表请求
    if ((pathname === "/api/v2/actions" || pathname === "/actions") && req.method === "GET") {
      try {
        const queryRes = await fetch(`http://${INTERNAL_HOST}:${INTERNAL_PORT}/api/v2/actions`);
        const actions = await queryRes.json();
        // 严格过滤出白名单的 4 项动作
        const filtered = Array.isArray(actions)
          ? actions.filter(
              (a) =>
                SK_ALLOWLIST.has(a.id) ||
                (a.actionId && SK_ALLOWLIST.has(a.actionId)) ||
                (a.packageId && SK_ALLOWLIST.has(`${a.packageId}/${a.id}`))
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

    // 2. 检查特定动作请求或调用
    const actionTarget = parseActionTarget(pathname);
    if (actionTarget) {
      const allowed =
        SK_ALLOWLIST.has(actionTarget.actionId) ||
        (actionTarget.fullAction && SK_ALLOWLIST.has(actionTarget.fullAction));

      if (!allowed) {
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
      // 允许的白名单动作，代理执行
      proxyRequest(req, res);
      return;
    }

    // 3. sk 视图禁止写操作或非白名单路径
    if (req.method !== "GET" && !pathname.includes("/runs")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: {
            code: "FORBIDDEN",
            message: "Write operations are forbidden in sk view",
          },
        })
      );
      return;
    }

    proxyRequest(req, res);
    return;
  }

  // ---------------------------------------------------------------------------
  // skm 视图：具备完整读写与受控维护能力
  // ---------------------------------------------------------------------------
  if (view === "skm") {
    // 动作列表请求：过滤保留 workspace, knowledge, maintenance
    if ((pathname === "/api/v2/actions" || pathname === "/actions") && req.method === "GET") {
      try {
        const queryRes = await fetch(`http://${INTERNAL_HOST}:${INTERNAL_PORT}/api/v2/actions`);
        const actions = await queryRes.json();
        const filtered = Array.isArray(actions)
          ? actions.filter((a) => !a.packageId || SKM_PACKAGE_ALLOWLIST.has(a.packageId))
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

    // 检查动作权限
    const actionTarget = parseActionTarget(pathname);
    if (actionTarget && actionTarget.packageId) {
      if (!SKM_PACKAGE_ALLOWLIST.has(actionTarget.packageId)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: {
              code: "PACKAGE_FORBIDDEN",
              message: `Package '${actionTarget.packageId}' is not allowed in skm view`,
            },
          })
        );
        return;
      }
    }

    // 全量畅通代理
    proxyRequest(req, res);
    return;
  }

  // 默认兜底
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "Not Found" } }));
});

// 7. 启动服务监听
server.listen(PORT, "0.0.0.0", () => {
  console.log("============================================================");
  console.log("Starting ActionDock Knowledge Server (Single-Port Virtual Views Mode)");
  console.log(`Port:           ${PORT} (HTTPS, Virtual Views)`);
  console.log("sk view:        Enabled (Action allowlist: search.rg, files.read, files.list, knowledge.collect)");
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
