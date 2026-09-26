# knowledge-server

knowledge-server 是基于 ActionDock 规范构建的云主机一体化知识服务容器分发，基于原生单端口多视图模式统一收敛至 443 端口。

框架面向外部查询用户通过动作级白名单提供只读检索与受控追加视图，面向维护智能体提供具备完整读写与维护能力的受控视图，仅通过鉴权令牌自动隔离权限。通过容器化交付，knowledge-server 将工程代码检索、结构化排障知识沉淀与自动化维护规程完整封装，为大模型应用与研发智能体提供高质量的知识基座。

---

## 核心特性

- **单端口虚拟视图隔离**：统一在 443 端口提供原生 HTTPS 服务，通过请求携带的 Bearer 令牌自动匹配虚拟视图。面向外部用户严格收敛于动作级白名单，仅开放只读检索与受控追加动作，杜绝非授权写入；面向内部维护智能体开放完整工作区读写与维护能力，实现原生端口级的安全隔离。
- **代码即知识单一事实源**：坚决贯彻 Git 代码仓库作为知识的单一事实源。通过双分支治理模型，将主干代码分支与知识文档分支解耦，实现知识伴随工程演进自动化提炼与受控变更，全流程版本受控。
- **无状态纯动作维护闭环**：维护全流程深度契合 ActionDock 纯动作规范，彻底告别宿主机脚本与嵌套命令。分支同步、变更扫描、受控编辑、断链校验、变更发布与检查点推进均抽象为标准动作调用。
- **调度与执行极致解耦**：本地流水线调度器与云端维护智能体深度解耦。调度驱动层仅负责轻量化远端扫描与检查点水位轮询探测，无需驻留大模型长会话上下文；执行智能体每次唤起仅聚焦单仓维护，实现高效稳健的批量自闭环。

---

## 架构一览

```text
外部查询用户 / 排障智能体                     内部维护智能体 / 派发调度器
            │                                             │
            ▼ (HTTPS 443 / 查询令牌)                       ▼ (HTTPS 443 / 维护令牌)
┌────────────────────────────────────────────────────────────────────────┐
│                        云主机: knowledge-server                         │
│                                                                        │
│   ActionDock 单端口多视图引擎 (统一监听 443 端口)                       │
│   ├─ 查询视图 (sk)：动作白名单 (search.rg, files.read, files.list, collect)│
│   └─ 维护视图 (skm)：全量能力 (workspace, knowledge, maintenance)       │
└───────────────────┬─────────────────────────────────────┬──────────────┘
                    │                                     │
                    ▼                                     ▼
             /srv/workspace                        /srv/knowledge-inbox
            (宿主机代码仓工作区)                    (宿主机候选知识待审池)
```

系统基于 ActionDock 虚拟视图特性，在单端口上实现了细粒度的动作权限收敛与双向安全隔离。关于系统设计哲学、权限隔离实现机制与闭环演进理念，请参阅架构设计文档 [docs/design.md](docs/design.md)。

---

## 极简快速上手

### 配置环境变量与专属令牌

克隆仓库后，基于环境配置模板创建环境变量文件：

```bash
cp .env.example .env
```

执行以下命令生成两个互不相同的高强度随机令牌：

```bash
openssl rand -hex 32
openssl rand -hex 32
```

编辑 `.env` 文件，分别填入生成的专属鉴权令牌与宿主机持久化目录：

```dotenv
ACTIONDOCK_TOKEN=<生成的首个高强度随机令牌>
ACTIONDOCK_AGENT_TOKEN=<生成的第二个高强度随机令牌>
PORT=443
KNOWLEDGE_DATA_DIR=/data/knowledge
SSH_DIR=/root/.ssh
```

### 启动容器服务

执行容器构建与后台启动命令：

```bash
docker compose up -d --build
```

容器启动后将自动监听 443 端口以单端口多视图模式运行。若未挂载自定义证书，服务将基于内置机制自动生成自签名 TLS 证书保障通信安全。

### 客户端配置与基础验证

在客户端安装 ActionDock 命令行工具后，添加服务端连接配置：

```bash
# 添加面向查询用户的检索配置 (统一端口 443)
ad profile add sk -s https://<cloud-host-ip>:443 -t <ACTIONDOCK_TOKEN> -k -d "知识库查询服务"

# 添加面向维护智能体的受控维护配置 (统一端口 443)
ad profile add skm -s https://<cloud-host-ip>:443 -t <ACTIONDOCK_AGENT_TOKEN> -k -d "知识库维护服务"
```

通过查询配置验证代码检索与受控候选知识投递功能：

```bash
# 验证代码全文检索
ad run workspace/search.rg --profile sk -- pattern=createPayment

# 验证受控候选知识文档投递
ad run knowledge/knowledge.collect --profile sk --input-file candidate.json
```

---

## 结构化文档导航

为了满足不同角色的使用与扩展需求，请参阅以下针对性技术文档：

- **架构设计与演进理念**：深入理解系统设计哲学、单端口虚拟视图安全模型与闭环演进机制，请参阅 [docs/design.md](docs/design.md)。
- **部署与运维指南**：宿主机目录持久化规范、证书替换、容器运维实操与健康检查，请参阅 [docs/deployment.md](docs/deployment.md)。
- **维护规程与动作参考**：维护智能体标准五步作业规程与全量维护动作参数参考，请参阅 [docs/maintenance.md](docs/maintenance.md)。
- **多仓流水线调度器手册**：大规模多代码仓巡检调度、断点续传机制与看板配置，请参阅 [docs/pipeline-runner.md](docs/pipeline-runner.md)。
- **智能体编排技能规范**：配套维护智能体与总控编排智能体的技能规范与提示词模板，请参阅 [skills/knowledge-maintenance-orchestrator/SKILL.md](skills/knowledge-maintenance-orchestrator/SKILL.md)。

---

## 开源许可证

本项目采用 MIT 许可证。
