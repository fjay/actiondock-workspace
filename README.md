# knowledge-server

ActionDock 2.x 云主机一体化知识服务容器（All-in-One Knowledge Server Distribution）。

本工程负责在云主机上以 Docker 容器化运行知识中枢，对外提供**原生 HTTPS（端口 443）**服务，并支持 Maintainer Agent 定时通过 SSH 反向触发自动化维护。

---

## 架构与分工

```text
               本地开发者 / 排障 Agent / Valet
                             │
                             ▼  (HTTPS 443 / --profile sk)
 ┌───────────────────────────────────────────────────────────────┐
 │               Cloud Host: knowledge-server         │
 │                                                               │
 │   ┌────────────────────────────────────────────────────────┐  │
 │   │  ad serve -p 443 -H 0.0.0.0 --https                   │  │
 │   │           -P workspace,knowledge -t <TOKEN>            │  │
 │   └──────────────────────────┬─────────────────────────────┘  │
 │                              │                                │
 │       ┌──────────────────────┴──────────────────────┐         │
 │       ▼                                             ▼         │
 │  [Read Plane]                               [Feedback Plane]  │
 │  actiondock-workspace                       actiondock-inbox  │
 │  (search.rg, files.read, files.list)        (collect, list)   │
 │                                                               │
 │  ───────────────────────────────────────────────────────────  │
 │  [Privileged Maintenance Plane] (禁止 HTTP 暴露，仅限 SSH)    │
 │  actiondock-knowledge-maintenance (sync, list, complete)      │
 └──────────────────────┬──────────────────────────────▲─────────┘
         │                      │                      ▲
         ▼                      ▼                      │ (SSH 反向触发)
  /srv/workspace        /srv/knowledge-inbox     Maintainer Agent
 (宿主机代码仓卷)       (宿主机候选文档卷)        (框架定时任务)
```

---

## 工程目录结构 (Monorepo 模式)

```text
knowledge-server/
├── Dockerfile                  # 基于 node:25-bookworm-slim 的一体化容器镜像
├── docker-compose.yml          # Docker Compose 编排文件
├── entrypoint.sh               # 容器自举入口脚本，负责路由链接与原生 HTTPS 启动
├── package.json                # Monorepo 根清单，声明 npm workspaces
├── .env.example                # 环境变量配置模板
├── host/
│   └── knowledge-maintenance   # 宿主机 Wrapper 脚本，供 Agent 定时通过 SSH 调用
├── config/
│   └── repos.json.example      # 批量待维护代码仓与系统知识仓清单示例
└── packages/                   # 聚合的三大核心 ActionDock 工具包
    ├── knowledge-workspace/    # [只读平面] 工作区代码检索与文件读取
    ├── knowledge-inbox/        # [追加平面] 候选知识投递与待审池归档
    └── knowledge-maintenance/  # [维护平面] 远端同步、差异扫描与 Checkpoint 推进
```

---

## 前置准备

1. **宿主机环境**：
   - 操作系统：Linux（CentOS / Ubuntu / Debian）
   - 已安装：Docker（≥ 20.10）与 Docker Compose（≥ v2.0）
2. **源码就绪（Monorepo 模式）**：
   - 本项目已聚合三大核心包（位于 `packages/` 目录下）：
     - `packages/knowledge-workspace`（工程工作区全文检索与文件读取）
     - `packages/knowledge-inbox`（候选知识投递与待审池归档）
     - `packages/knowledge-maintenance`（代码同步、变更扫描与 Checkpoint 推进）
   - **完全自包含，无需预先发布到 npm 源**，Docker 构建时自动本地装配与链接。
3. **SSH 密钥准备**：
   - 宿主机已配置可免密访问内部代码仓（如 GitLab / GitHub 等）的 SSH 密钥（通常为 `~/.ssh/id_rsa`）。

---

## 快速部署流程

### 1. 克隆工程并配置环境变量
在云主机上克隆本工程，进入目录：
```bash
cp .env.example .env
```
根据云主机实际情况编辑 `.env`：
```dotenv
# 必须设置：强随机鉴权令牌 (客户端连接时使用)
ACTIONDOCK_TOKEN=your-random-secure-token-here

# 外部暴露端口 (原生 HTTPS 监听，默认 443)
PORT=443


# 宿主机持久化根目录 (所有子目录 workspace/、inbox/、config/、certs/、logs/ 均基于此目录自动创建与衍生，不给自定义)
KNOWLEDGE_DATA_DIR=/data/knowledge

# 宿主机 SSH 密钥挂载目录 (用于向内部 Git 仓库免密拉取与推送)
SSH_DIR=/root/.ssh
```

### 2. 配置待维护仓库清单 (`repos.json`)
在宿主机 `$KNOWLEDGE_DATA_DIR/config/`（如 `/data/knowledge/config/`）下创建 `repos.json`：
```json
[
  {
    "path": "/srv/workspace/order-service",
    "repoType": "code",
    "sourceBranch": "release",
    "knowledgeBranch": "docs"
  },
  {
    "path": "/srv/workspace/cron-service",
    "repoType": "code",
    "sourceBranch": "release",
    "knowledgeBranch": "docs"
  },
  {
    "path": "/srv/workspace/system-knowledge",
    "repoType": "system_knowledge",
    "sourceBranch": "master"
  }
]
```

### 3. 构建并启动容器
```bash
# 构建镜像并后台拉起容器
docker compose up -d --build

# 查看容器运行日志
docker compose logs -f
```

容器启动后，`ad serve` 将自动在 `443` 端口上监听原生 HTTPS 请求。
> **证书说明**：若未挂载正式证书，ActionDock 会自动生成合法的自签名 TLS 证书运行。

---

## 客户端连接验证

在本地客户端或排障 Agent 机器上，执行：

### 1. 添加远端 Profile
```bash
ad profile add sk -s https://<cloud-host-ip> -t <ACTIONDOCK_TOKEN> -k -d "云端知识库服务"
```
*(注：`-k` 用于信任自签名证书)*

### 2. 验证检索（Read Plane）
```bash
ad run workspace/search.rg --profile sk -- pattern=createPayment
ad run workspace/files.read --profile sk -- path=system-knowledge/index.md
```

### 3. 验证候选知识投递（Append Plane）
```bash
ad run knowledge/knowledge.collect --profile sk --input-file candidate.json
```

---

## Maintainer Agent 定时触发规程 (SSH 驱动)

Maintainer Agent 框架自带定时任务功能，按预设周期定时唤起，通过 **SSH 连入云主机宿主机** 驱动维护。

推荐直接通过 Docker 命令调用容器内的维护工具链（**宿主机零前置配置，免去在宿主机上拷贝脚本与权限配置**）：

```bash
# 步骤 1：执行全量代码同步与冲突自愈 (若遇文档冲突，返回退出码 2 并生成 /tmp/sync-report.json)
docker exec -i knowledge-server run-maintenance.sh sync

# 步骤 2：对目标仓库执行单仓变更扫描 (使用容器内仓库路径，如 /srv/workspace/order-service)
docker exec -i knowledge-server ad run maintenance/maintenance.list --json -- path=<repoPath>

# 步骤 2.5 (可选)：若修改或初始化了知识文档，统一提交推送
docker exec -i knowledge-server ad run maintenance/maintenance.publish --json -- path=<repoPath> message="docs: update knowledge documentation"

# 步骤 3：对目标仓库推进 Checkpoint 水位 (complete)
docker exec -i knowledge-server ad run maintenance/maintenance.complete --json -- path=<repoPath> commit=<TO_COMMIT> actionTaken=<docs_updated|no_change_needed> summary="..."
```

---

### Maintainer Agent 生产提示词模板（可直接配置进定时任务）

在 Maintainer Agent 定时任务中，配置如下系统提示词：

```markdown
请激活并严格遵循 【project-knowledge-maintainer】 技能，针对指定的单一仓库执行一轮知识维护闭环。
*(提示：若当前环境中该维护技能不存在，请确保 skills 目录下已配置 project-knowledge-maintainer)*

【目标仓库】
- 目标标识：{{TARGET_REPO}} (例如: order-service)
- 容器内默认路径：`<repoPath>` = `/srv/workspace/{{TARGET_REPO}}`
  *(注：若需确认具体分支或非标准路径，可执行 `docker exec -i knowledge-server cat /etc/actiondock/repos.json` 查阅)*

【标准化执行流程】

### 步骤 1：全量分支同步与冲突感知
批量分支同步速度极快，首先在云主机上执行全量同步：
docker exec -i knowledge-server run-maintenance.sh sync

根据命令退出码精准判定分支同步结果：
- **退出码 0 (success)**：
  全量仓库的分支同步与非文档代码冲突自愈（--theirs 策略）全部成功完成，直接进入步骤 2。
- **退出码 2 (conflict，检测到知识文档冲突)**：
  存在 Markdown 知识文档冲突。直接读取容器内纯净的结构化报告文件：
  docker exec -i knowledge-server cat /tmp/sync-report.json

  检查 `conflicts` 列表中是否包含目标仓库 `<repoPath>`：
  1. **若包含目标仓库**：
     针对 `conflictFiles` 中的每个冲突文档进行语义消解：
     a. 查看带冲突标记的文档内容：
        docker exec -i knowledge-server cat "<repoPath>/<conflictFile>"
     b. 理解两端事实（<<<<<<< HEAD 本地知识 vs >>>>>>> origin/release 生产变更），消除冲突标记，合成为最准确完备的 Markdown 知识文档；
     c. 安全写回容器对应文件：
        cat << 'EOF' | docker exec -i knowledge-server tee "<repoPath>/<conflictFile>" > /dev/null
        <消解后的文档内容>
        EOF
     d. 统一通过维护工具提交并推送（自动切换 docs 分支、暂存并提交推送）：
        docker exec -i knowledge-server ad run maintenance/maintenance.publish --json -- path="<repoPath>" message="docs(merge): resolve knowledge conflict"
     e. 目标仓库冲突消除完毕，继续进入步骤 2。
  2. **若不包含目标仓库**：
     文档冲突发生在其它的仓库中，当前目标仓库已成功同步，直接进入步骤 2。
- **退出码 1 (error)**：
  执行异常，直接报告错误并退出。

### 步骤 2：对目标仓库执行单仓变更扫描与场景判定
执行变更扫描（一次仅针对目标仓库 `<repoPath>`）：
docker exec -i knowledge-server ad run maintenance/maintenance.list --json -- path="<repoPath>"

根据返回的 JSON 信封决议：
- **场景 A（无代码变更 `data.hasChanges=false`）**：
  文档已与代码对齐，跳过步骤 3，直接输出完成报告退出。
- **场景 B（冷启动建库 `data.initialInventoryRequired=true` 或无 docs/ 目录）**：
  进入技能【模式四：存量全盘建库与初始化】。严格按 layout.md 与 coverage.md 规范从源码深度盘点，生成六大分类文档与 index.md/overview.md 后，统一提交推送：
  docker exec -i knowledge-server ad run maintenance/maintenance.publish --json -- path="<repoPath>" message="docs: initialize project knowledge base"
- **场景 C（增量核验 `data.initialInventoryRequired=false 且 hasChanges=true`）**：
  进入技能【模式三：自动化代码变更核验】。根据返回的代码 Diff 按失效四问核对。若文档失效需修改，就地编辑后统一提交推送：
  docker exec -i knowledge-server ad run maintenance/maintenance.publish --json -- path="<repoPath>" message="docs: update knowledge documentation"

### 步骤 3：推进 Checkpoint 水位（铁律：必须执行）
核验完成后，必须将水位推进到步骤 2 返回的 `data.to` commit：
- 若更新了知识文档（或全盘建库）：
  docker exec -i knowledge-server ad run maintenance/maintenance.complete --json -- path="<repoPath>" commit="<TO_COMMIT>" actionTaken="docs_updated" summary="<更新说明>"
- 若四问全否无需修改文档：
  docker exec -i knowledge-server ad run maintenance/maintenance.complete --json -- path="<repoPath>" commit="<TO_COMMIT>" actionTaken="no_change_needed" summary="<内部优化/重构，知识未失效>"

### 步骤 4：输出结算报告
输出 Markdown 报告，列出：目标仓库名与路径 `<repoPath>`、分支同步状态、冲突自愈/消解记录、进入的模式（冷启动建库/增量核验/无变更）、四问核验概况、最终 Checkpoint Commit。
```

---

## 常用运维命令

```bash
# 查看容器状态
docker compose ps

# 查看实时服务日志
docker compose logs -f

# 进入容器内交互式调试
docker compose exec knowledge-server bash

# 手工在容器内执行一次单仓维护
docker compose exec -i knowledge-server run-maintenance.sh --repo-path /srv/workspace/order-service --repo-type code

# 容器重启
docker compose restart
```

---

## 许可证

MIT
