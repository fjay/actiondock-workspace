# knowledge-server

[ActionDock](https://github.com/team4u/actiondock) 云主机一体化知识服务容器。

本工程负责在云主机上以 Docker 容器化运行知识中枢，支持双 HTTP 服务分流架构：面向外部查询用户通过动作级白名单提供原生 HTTPS（端口 443）只读检索服务；面向内部维护智能体提供具备完整读写与维护能力的受控服务（端口 8443），实现细粒度安全隔离与自动化闭环演进。

> **深入理解架构**：系统核心设计哲学、双服务分流架构与闭环演进，请参阅 [知识中枢设计理念与核心架构演进](docs/design.md)。

---

## 架构与分工

```text
       本地开发者 / 排障智能体 / 客户端                   维护智能体 / 派发子智能体
                      │                                              │
                      ▼  (HTTPS 443 / 查询令牌)                       ▼  (HTTPS 8443 / 维护令牌)
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │                               Cloud Host: knowledge-server                               │
  │                                                                                          │
  │   ┌─────────────────────────────────────┐      ┌─────────────────────────────────────┐   │
  │   │  ad serve -p 443 --https            │      │  ad serve -p 8443 --https           │   │
  │   │  -A "workspace/search.rg,           │      │  -P workspace,knowledge,maintenance │   │
  │   │      workspace/files.read,          │      │  -t <AGENT_TOKEN>                   │   │
  │   │      workspace/files.list,          │      └──────────────────┬──────────────────┘   │
  │   │      knowledge/knowledge.collect"   │                         │                      │
  │   │  -t <QUERY_TOKEN>                   │                         │                      │
  │   └──────────────────┬──────────────────┘                         │                      │
  │                      │                                            │                      │
  │       ┌──────────────┴──────────────┐              ┌──────────────┴──────────────┐       │
  │       ▼                             ▼              ▼                             ▼       │
  │  [工作区检索与读取]           [候选知识收集]   [工作区完整编辑与审查]         [候选归档与特权维护]   │
  │  - search.rg                - collect      - search.rg / read / list     - knowledge.list/archive│
  │  - files.read                              - write / edit / delete / move- maintenance.sync/list │
  │  - files.list                              - git.status / git.diff       - maintenance.publish   │
  └───────┬─────────────────────────────┬─────────────────────────────┬──────────────┬───────┘
          │                             │                             │              │
          ▼                             ▼                             ▼              ▼
   /srv/workspace                /srv/knowledge-inbox          /srv/workspace  Git 代码仓库
  (宿主机代码仓卷)              (宿主机候选文档卷)            (受控读写操作)  (自动同步与推送)
```

---

## 工程目录结构 (Monorepo 模式)

```text
knowledge-server/
├── Dockerfile                  # 基于 node:25-bookworm-slim 的一体化容器镜像
├── docker-compose.yml          # Docker Compose 编排文件
├── entrypoint.sh               # 容器自举入口脚本，负责路由链接与双服务启动
├── package.json                # Monorepo 根清单，声明 npm workspaces
├── .env.example                # 环境变量配置模板
├── host/
│   └── knowledge-maintenance   # 宿主机包装脚本，供智能体通过宿主机调度
├── config/
│   └── repos.json.example      # 批量待维护代码仓与系统知识仓清单示例
├── skills/                     # 配套知识维护与总控编排智能体技能
│   ├── project-knowledge-maintainer/      # 知识维护执行规范与参考模板
│   └── knowledge-maintenance-orchestrator/# 知识维护总控编排技能
└── packages/                   # 聚合的三大核心 ActionDock 工具包
    ├── knowledge-workspace/    # [工作区平面] 代码检索、文件读写、局部受控编辑与差异核验
    ├── knowledge-inbox/        # [追加平面] 候选知识投递与待审池归档
    └── knowledge-maintenance/  # [维护平面] 远端同步、差异扫描与 Checkpoint 推进
```

---

## 前置准备

- **宿主机环境**：
  - 操作系统：Linux（CentOS / Ubuntu / Debian）
  - 已安装：Docker（版本大于等于 20.10）与 Docker Compose（版本大于等于 2.0）
- **源码就绪（Monorepo 模式）**：
  - 本项目已聚合三大核心包（位于 `packages/` 目录下）：
    - `packages/knowledge-workspace`（工程工作区代码检索、文件读写、受控编辑与差异核验）
    - `packages/knowledge-inbox`（候选知识投递与待审池归档）
    - `packages/knowledge-maintenance`（代码同步、变更扫描与 Checkpoint 推进）
  - 完全自包含，无需预先发布到 npm 源，Docker 构建时自动本地装配与链接。
- **SSH 密钥准备**：
  - 宿主机已配置可免密访问内部代码仓（如 GitLab / GitHub 等）的 SSH 密钥（通常为 `~/.ssh/id_rsa`）。

---

## 快速部署流程

### 克隆工程并配置环境变量
在云主机上克隆本工程，进入目录：
```bash
cp .env.example .env
```
根据云主机实际情况编辑 `.env`：
```dotenv
# 查询服务鉴权令牌 (面向外部查询用户与排障智能体，动作级白名单只读检索)
ACTIONDOCK_TOKEN=your-random-secure-query-token-here

# 智能体受控维护服务鉴权令牌 (面向内部维护智能体与派发子智能体，具备完整读写与维护权限)
ACTIONDOCK_AGENT_TOKEN=your-random-secure-agent-token-here

# 查询服务外部暴露端口 (原生 HTTPS 监听，默认 443)
PORT=443

# 智能体维护服务外部暴露端口 (原生 HTTPS 监听，默认 8443)
AGENT_PORT=8443

# 宿主机持久化根目录 (所有子目录 workspace/、inbox/、config/、certs/、logs/ 均基于此目录自动创建与衍生，不给自定义)
KNOWLEDGE_DATA_DIR=/data/knowledge

# 宿主机 SSH 密钥挂载目录 (用于向内部 Git 仓库免密拉取与推送)
SSH_DIR=/root/.ssh
```

### 配置待维护仓库清单 (`repos.json`)
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

### 构建并启动容器
```bash
# 构建镜像并后台拉起容器
docker compose up -d --build

# 查看容器运行日志
docker compose logs -f
```

容器启动后，将自动以双服务模式运行：
- **查询服务**：在 `443` 端口上监听原生 HTTPS 请求，通过动作白名单严格收敛。
- **智能体维护服务**：在 `8443` 端口上监听原生 HTTPS 请求，供内部维护智能体调用。
> **证书说明**：若未挂载正式证书，ActionDock 会自动生成合法的自签名 TLS 证书运行。

---

## 客户端连接验证

在本地客户端或排障智能体机器上，执行：

### 添加远端配置
```bash
# 添加面向查询用户的检索配置 (端口 443)
ad profile add sk -s https://<cloud-host-ip>:443 -t <ACTIONDOCK_TOKEN> -k -d "云端知识库查询服务"

# 添加面向维护智能体的受控维护配置 (端口 8443)
ad profile add skm -s https://<cloud-host-ip>:8443 -t <ACTIONDOCK_AGENT_TOKEN> -k -d "云端知识库维护服务"
```
*(注：`-k` 用于信任自签名证书)*

### 验证检索服务
```bash
ad run workspace/search.rg --profile sk -- pattern=createPayment
ad run workspace/files.read --profile sk -- path=system-knowledge/index.md
```

### 验证候选知识投递
```bash
ad run knowledge/knowledge.collect --profile sk --input-file candidate.json
```

---

## Maintainer Agent 自动化维护规程 (Action 驱动)

Maintainer Agent 按预设周期唤起，通过面向维护智能体的受控服务（端口 8443，配置标识 `skm`）驱动维护闭环，全流程统一采用 ActionDock 纯动作规范，彻底摆脱 Docker 嵌套命令与无状态 Shell 脚本。

### 核心动作速查 (面向 `skm` 维护服务)

- **全量代码分支同步**：
  ```bash
  ad run maintenance/maintenance.sync --profile skm
  ```
- **代码变更扫描**（不传 path 时执行全量多仓扫描）：
  ```bash
  # 批量扫描所有配置仓库：
  ad run maintenance/maintenance.list --profile skm

  # 单仓扫描：
  ad run maintenance/maintenance.list --profile skm -- path=<repoPath>
  ```
- **读取知识或冲突文档**：
  ```bash
  ad run workspace/files.read --profile skm -- path=<repoPath>/<filePath>
  ```
- **写入或消解写回知识文档**：
  ```bash
  ad run workspace/files.write --profile skm -- path=<repoPath>/<filePath> content="<content>"
  ```
- **局部受控编辑知识文档**：
  ```bash
  ad run workspace/files.edit --profile skm -- path=<repoPath>/<filePath> targetContent="<oldText>" replacementContent="<newText>"
  ```
- **文档链接与引用有效性校验**：
  ```bash
  ad run workspace/links.verify --profile skm -- path=<repoPath>
  ```
- **工作区变更状态与差异审查**：
  ```bash
  ad run workspace/git.status --profile skm -- path=<repoPath>
  ad run workspace/git.diff --profile skm -- path=<repoPath> -- statOnly:=true
  ```
- **文档改动提交与推送**：
  ```bash
  ad run maintenance/maintenance.publish --profile skm -- path=<repoPath> message="docs: update knowledge documentation"
  ```
- **推进 Checkpoint 水位**：
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- path=<repoPath> commit=<TO_COMMIT> actionTaken=<docs_updated|no_change_needed> summary="..."
  ```

---

### Maintainer Agent 调度与技能配置

云端定时 Maintainer Agent 仅需挂载并激活 [knowledge-maintenance-orchestrator 技能](skills/knowledge-maintenance-orchestrator/SKILL.md)，即可依托特权维护服务（`--profile skm`）自主完成从代码同步、差异扫描、子智能体调度到断链校验、发布推送与检查点推进的完整闭环。

在定时任务或自动化编排平台中，配置极简的生产触发词即可：

```text
请激活 【knowledge-maintenance-orchestrator】 技能，针对指定的单一仓库或全量多仓执行一轮知识维护闭环。
```

完整编排流程、子智能体协作职责与报告规范，请参阅 [知识维护总控编排技能规范](skills/knowledge-maintenance-orchestrator/SKILL.md)。

---

## 常用运维命令

### 容器服务基础运维

```bash
# 查看容器运行状态
docker compose ps

# 查看容器实时日志
docker compose logs -f

# 进入容器交互式调试
docker compose exec knowledge-server bash

# 重启容器服务
docker compose restart
```

### 宿主机包装脚本调用（通过 knowledge-maintenance）

运维人员登录宿主机时，可通过包装脚本便捷调用容器内动作：

```bash
# 全量仓库分支同步
knowledge-maintenance sync

# 单仓定向分支同步
knowledge-maintenance maintenance.sync -- path=/srv/workspace/order-service

# 批量扫描待维护代码变更
knowledge-maintenance list

# 单仓扫描代码变更
knowledge-maintenance maintenance.list -- path=/srv/workspace/order-service

# 单仓文档断链校验
knowledge-maintenance links.verify -- path=/srv/workspace/order-service
```

### 远端受控维护调用（通过 ActionDock 客户端）

维护智能体在受信任网络中，通过 ActionDock 客户端直连维护端口（8443）执行纯动作维护闭环：

```bash
# 远端全量分支同步
ad run maintenance/maintenance.sync --profile skm

# 远端单仓定向分支同步
ad run maintenance/maintenance.sync --profile skm -- path=/srv/workspace/order-service

# 远端批量扫描待维护代码变更
ad run maintenance/maintenance.list --profile skm

# 远端单仓扫描代码变更
ad run maintenance/maintenance.list --profile skm -- path=/srv/workspace/order-service

# 远端文档断链校验
ad run workspace/links.verify --profile skm -- path=/srv/workspace/order-service

# 远端审查工作区差异
ad run workspace/git.diff --profile skm -- path=/srv/workspace/order-service -- statOnly:=true

# 远端提交并推送文档更新
ad run maintenance/maintenance.publish --profile skm -- path=/srv/workspace/order-service message="docs: update knowledge documentation"

# 远端推进检查点水位
ad run maintenance/maintenance.complete --profile skm -- path=/srv/workspace/order-service commit="<TO_COMMIT>" actionTaken="docs_updated" summary="..."
```

---

## 许可证

MIT
