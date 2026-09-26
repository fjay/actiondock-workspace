# knowledge-server

[ActionDock](https://github.com/team4u/actiondock) 云主机一体化知识服务容器。

本工程负责在云主机上以 Docker 容器化运行知识中枢，采用 ActionDock 原生单端口多视图（Virtual Views）架构：统一在单一原生 HTTPS（端口 443）上运行，通过请求中的 Bearer Token 自动匹配与隔离面向外部查询用户的只读检索与受控追加视图（sk）与面向内部维护智能体的全量特权视图（skm），实现细粒度安全隔离与自动化闭环演进。

> **深入理解架构**：系统核心设计哲学、单端口多视图架构与闭环演进，请参阅 [知识中枢设计理念与核心架构演进](docs/design.md)。

---

## 架构与分工

```text
       本地开发者 / 排障智能体 / 客户端                   维护智能体 / 派发子智能体
                      │                                              │
                      ▼  (HTTPS 443 / 查询令牌)                       ▼  (HTTPS 443 / 维护令牌)
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │                               Cloud Host: knowledge-server                               │
  │                                                                                          │
  │   ┌──────────────────────────────────────────────────────────────────────────────────┐   │
  │   │  ad serve -p 443 --https --views "<VIEWS_JSON>"                                  │   │
  │   │  (单端口多视图：通过 Bearer Token 自动路由对应虚拟视图)                             │   │
  │   └─────────────────────────────┬──────────────────────────────┬─────────────────────┘   │
  │                                 │                              │                         │
  │                                 ▼                              ▼                         │
  │                 ┌──────────────────────────────┐ ┌──────────────────────────────┐        │
  │                 │ sk 虚拟视图 (只读检索与追加)  │ │ skm 虚拟视图 (特权受控维护)  │        │
  │                 │ -A search.rg, files.read,    │ │ -P workspace,                │        │
  │                 │    files.list,               │ │    knowledge,                │        │
  │                 │    knowledge.collect         │ │    maintenance               │        │
  │                 └──────────────┬───────────────┘ └──────────────┬───────────────┘        │
  │                                │                                │                        │
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
├── bin/
│   ├── pipeline-runner.mjs     # 开放式本地多仓流水线调度与异步观测驱动器
│   └── pipeline-runner.d.ts    # 流水线调度驱动器类型定义
├── Dockerfile                  # 基于 node:25-bookworm-slim 的一体化容器镜像
├── docker-compose.yml          # Docker Compose 编排文件
├── entrypoint.sh               # 容器自举入口脚本，负责路由链接与单端口多视图服务启动
├── package.json                # Monorepo 根清单，声明 npm workspaces
├── .env.example                # 环境变量配置模板
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
在云主机上克隆本工程，复制环境配置模板：
```bash
cp .env.example .env
```
执行以下命令生成两个互不相同的高强度随机令牌（长度 64 字符）：
```bash
openssl rand -hex 32
openssl rand -hex 32
```
根据云主机实际情况编辑 `.env`，填入生成的专属鉴权令牌：
```dotenv
# ActionDock 虚拟视图鉴权令牌 (必须手动生成高强度密钥，至少 32 字符，两者绝对不可相同)
# 推荐生成命令: openssl rand -hex 32
ACTIONDOCK_TOKEN=<填写首个生成的 64 字符高强度随机令牌>
ACTIONDOCK_AGENT_TOKEN=<填写第二个生成的 64 字符高强度随机令牌>

# 服务外部暴露端口 (原生 HTTPS 单端口多视图模式，默认 443，通过不同 Bearer Token 自动由虚拟视图路由权限)
PORT=443

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

容器启动后，将自动以单端口多视图模式运行：
- **服务监听**：在 `443` 端口上监听原生 HTTPS 请求。
- **权限隔离**：客户端请求携带 `ACTIONDOCK_TOKEN` 时自动路由至 `sk` 视图（动作白名单严格收敛）；携带 `ACTIONDOCK_AGENT_TOKEN` 时自动路由至 `skm` 特权视图（完整维护权限）。
> **证书说明**：若未挂载正式证书，ActionDock 会自动生成合法的自签名 TLS 证书运行。

---

## 客户端连接验证

在本地客户端或排障智能体机器上，执行：

### 添加远端配置
```bash
# 添加面向查询用户的检索配置 (统一端口 443)
ad profile add sk -s https://<cloud-host-ip>:443 -t <ACTIONDOCK_TOKEN> -k -d "云端知识库查询服务"

# 添加面向维护智能体的受控维护配置 (统一端口 443)
ad profile add skm -s https://<cloud-host-ip>:443 -t <ACTIONDOCK_AGENT_TOKEN> -k -d "云端知识库维护服务"
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

Maintainer Agent 按预设周期唤起，通过面向维护智能体的受控维护配置（统一端口 443，配置标识 `skm`）驱动维护闭环，全流程统一采用 ActionDock 纯动作规范，彻底摆脱 Docker 嵌套命令与无状态 Shell 脚本。开发者与智能体面对远端受控环境时，可通过 ActionDock 远端自省与发现工具链完全自主探索和使用远端能力：通过 `ad info` 查看挂载工具包与能力概览，通过 `ad list` 列出所有可用动作，通过 `ad describe` 自省查询任意动作工具的模式定义（获取完整描述、`inputSchema` 与 `outputSchema` 及传参示例）：

```bash
# 查看远端所有挂载的工具包、动作与规程概览
ad info --profile skm

# 列出远端所有可用动作清单及其功能描述
ad list --profile skm

# 查询动作完整描述、模式定义与传参示例
ad describe workspace/files.edit --profile skm
ad describe maintenance/maintenance.sync --profile skm
```

### 核心动作速查 (面向 `skm` 维护服务)

- **远端工具发现与动作模式自省**：
  ```bash
  # 查看远端所有挂载的工具包、动作与规程概览
  ad info --profile skm

  # 列出远端所有可用动作清单及其功能描述
  ad list --profile skm

  # 查看特定工具包内动作详情
  ad info workspace --profile skm

  # 查询动作完整描述、模式定义与传参示例
  ad describe workspace/files.edit --profile skm
  ad describe maintenance/maintenance.sync --profile skm
  ```
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

云端 Maintainer Agent 挂载并激活 [knowledge-maintenance-orchestrator 技能](skills/knowledge-maintenance-orchestrator/SKILL.md)，依托特权维护服务（`--profile skm`）自主完成从单仓代码同步、差异扫描、文档编辑到断链校验、发布推送与检查点推进的完整闭环。

在定时任务或自动化编排平台中，配置极简的生产触发词即可：

```text
请激活 【knowledge-maintenance-orchestrator】 技能，针对指定的单一仓库执行一轮知识维护闭环。
```

完整编排流程、自闭环五步铁律与交付规范，请参阅 [知识维护总控编排技能规范](skills/knowledge-maintenance-orchestrator/SKILL.md)。

---

## 本地多仓流水线调度器（Pipeline Runner）

在大规模多代码仓（例如 90+ 仓库）场景下，为避免主智能体长链路会话上下文膨胀与云端长连接中断风险，本项目提供运行在本地机器上的纯原生驱动脚本 `bin/pipeline-runner.mjs`。将大批量巡检、断点续传与异步观测收敛在本地脚本中，智能体每次唤醒仅聚焦于单仓自闭环，实现调度驱动与执行智能体之间的极致解耦。

### 核心特性

- **纯原生轻量驱动**：基于原生 Node.js 内置模块编写，无需安装任何第三方依赖，零装配成本，开箱即用。
- **开放式命令模版**：通过 `--dispatch-cmd` 传入任意外部派发命令，模版引擎自动插值填充丰富占位符并提供安全引号转义。
- **天然单一事实源断点续传**：以云端检查点与 `maintenance.list` 为唯一事实源。已完成的仓库检查点已推进，`hasChanges` 判定为 `false`；中途退出或再次运行自动跳过已完成仓库，无需本地维护任何冗余的状态账本文件，杜绝双事实源与状态漂移。
- **异步状态侦听与防卡死**：触发外部智能体后，驱动器不阻塞等待长连接，而是以受控间隔定期探测远端目标仓库检查点是否推进至目标提交，同时提供单仓最大等待超时保护。
- **观测看板与报告输出**：终端实时看板动态展示进度条、总仓数、已完成、已跳过、失败数、当前活跃仓、单仓耗时与总耗时，执行完毕输出规范的 Markdown 结算报告。

### 命令模版占位符一览

在 `--dispatch-cmd` 模版中可使用以下占位符，执行时将根据远端扫描结果自动替换：

- **仓库标识**：`{{repo}}`，对应代码仓名称（例如 `order-service`）。
- **工作区路径**：`{{path}}`，远端工作区绝对路径（例如 `/srv/workspace/order-service`）。
- **目标分支**：`{{branch}}`，目标分支名（例如 `release` 或 `master`）。
- **前置检查点**：`{{from}}`，前置检查点提交哈希（冷启动建库时为 `initial`）。
- **目标检查点**：`{{to}}`，目标最新提交哈希。
- **待核验提交数**：`{{commitCount}}`，待核验的新增提交总数。
- **变动文件总数**：`{{changedFilesCount}}`，变动文件总数。
- **变动统计摘要**：`{{diffSummary}}`，文件变动统计摘要文本。
- **提交日志摘要**：`{{commitsSummary}}`，格式化的提交日志摘要文本。
- **指导语模版**：`{{prompt}}`，开箱即用的专业单仓维护指导语模版。

### 命令行选项参数

- `--profile <name>`：ActionDock 远端客户端配置标识，默认值为 `skm`。
- `--dispatch-cmd <template>`：用户自定义派发命令模版，支持上述全量占位符（在 `--dry-run` 预演时可选，实际运行时必填）。
- `--timeout <minutes>`：单仓最大等待检查点推进超时时间（分钟），默认值为 15。
- `--interval <seconds>`：侦听远端检查点轮询探测间隔（秒），默认值为 10。
- `--dry-run`：预演模式，仅扫描远端变更并打印各仓库替换后的派发命令，不实际触发派发与轮询。
- `--only <repos>`：仅处理指定的单个或几个仓库（逗号分隔，例如 `order-service,cron-service`）。
- `--report-file <path>`：最终 Markdown 结算报告输出路径，默认值为 `maintenance-report.md`。
- `-h, --help`：打印完整帮助信息与占位符列表。

### 多形态调用范例

- **Action 派发模式**（通过 ActionDock 异步调用维护智能体）：
  ```bash
  ./bin/pipeline-runner.mjs \
    --profile skm \
    --dispatch-cmd 'ad run my-agent.dispatch --profile skm --async -- repo="{{repo}}" path="{{path}}" prompt="{{prompt}}"'
  ```

- **HTTP 接口派发模式**（通过 Webhook 触发远程智能体）：
  ```bash
  ./bin/pipeline-runner.mjs \
    --profile skm \
    --dispatch-cmd 'curl -s -X POST https://agent.internal/api/dispatch -H "Content-Type: application/json" -d "{\"repo\": \"{{repo}}\", \"to\": \"{{to}}\"}"'
  ```

- **独立 Agent 命令行派发模式**（调用本地智能体命令行工具）：
  ```bash
  ./bin/pipeline-runner.mjs \
    --profile skm \
    --timeout 20 \
    --interval 15 \
    --dispatch-cmd 'lobster run maintainer --repo="{{repo}}" --to="{{to}}" --prompt="{{prompt}}"'
  ```

- **预演模式**（仅扫描远端变更并预览待派发命令）：
  ```bash
  ./bin/pipeline-runner.mjs --dry-run
  ```

- **单仓或指定仓库定向维护**：
  ```bash
  ./bin/pipeline-runner.mjs \
    --only order-service \
    --dispatch-cmd 'ad run my-agent.dispatch --profile skm --async -- repo="{{repo}}" prompt="{{prompt}}"'
  ```

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

### 远端受控维护调用（通过 ActionDock skm 视图）

维护智能体在受信任网络中，通过 ActionDock 客户端直连 443 端口特权维护视图（配置标识 `skm`）执行纯动作维护闭环：

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
