# 知识中枢部署与运维指南

---

## 概述

knowledge-server 基于 ActionDock 框架构建，是一体化知识服务容器。系统采用原生单端口多视图架构，在单一 443 端口上对外提供 HTTPS 服务。服务通过请求头中的 Bearer Token 自动进行身份识别与路由分发：

- 面向外部查询用户，系统基于动作级白名单严格收敛，暴露只读检索与受控追加视图（sk 视图），杜绝任何越权写操作。
- 面向内部维护智能体，系统提供具备完整工程读写、局部受控编辑、差异审查与检查点推进能力的受控维护视图（skm 视图）。

本指南详细说明在云主机环境中部署、配置、启动与运维维护该服务的完整规程。

---

## 环境前置准备

在部署服务前，需确保宿主机满足以下基础设施与软件环境依赖：

- **操作系统要求**：
  - 支持主流 Linux 发行版，如 CentOS 7 及以上、Ubuntu 20.04 及以上、Debian 11 及以上。
  - 内核版本支持容器虚拟化技术与安全命名空间隔离。
- **容器与编排工具要求**：
  - 已安装 Docker，版本要求大于等于 20.10。
  - 已安装 Docker Compose，版本要求大于等于 2.0。
  - 宿主机执行用户需具备调用 Docker 守护进程的权限。
- **源码结构自包含特性**：
  - 本工程采用 Monorepo 架构组织，所有核心功能包均聚合收敛在 `packages/` 目录下：
    - `packages/knowledge-workspace`：负责工作区工程代码与知识文档的全文检索、文件分段直读、目录浏览、安全写入、受控局部编辑、文件移动删除、工作区状态审查与断链校验。
    - `packages/knowledge-inbox`：负责收集排障经验与日常运维产生的结构化候选文档并写入待审池，以及后续审核归档。
    - `packages/knowledge-maintenance`：特权维护包，负责双分支代码同步、差异提交扫描、文档发布提交与检查点水位推进。
  - 源码结构具备完全自包含特性，各子包无需预先构建或发布至外部 npm 镜像源，在容器构建阶段由 Dockerfile 自动完成本地依赖装配、生产依赖安装与全局路由软链。
- **密钥凭据准备与权限规范**：
  - 宿主机需配置具备访问内部代码仓库权限的 SSH 密钥对，通常存放于宿主机的 `~/.ssh/` 或 `/root/.ssh/` 目录下。
  - 该密钥对用于向内部 Git 托管平台免密拉取业务分支并向知识文档分支推送更新产物。
  - 容器启动入口脚本包含权限自动防御与修正机制：在容器启动时，会自动将挂载的 SSH 目录权限修正为 700，私钥文件权限修正为 600，并自动在配置文件中写入主机指纹接受策略，防止因主机指纹交互阻断自动化同步流程。

---

## 宿主机持久化目录架构

为保证容器在重建、升级或迁移过程中所有数据与状态资产完整留存，系统通过统一的环境变量收敛宿主机持久化存储路径。

- **根目录收敛原则**：
  - 持久化根目录路径由环境变量 `KNOWLEDGE_DATA_DIR` 定义，未指定时默认使用 `/data/knowledge`。
  - 系统禁止将持久化子目录分散配置在不相关的路径中，所有运行产生的数据资产均在此根目录下派生，确保数据归属集中与备份迁移的高效性。
- **持久化子目录职责与权限矩阵**：
  - **状态库子目录** `state/`：
    - 宿主机路径：`${KNOWLEDGE_DATA_DIR}/state`。
    - 容器内挂载点：`/root/.actiondock`。
    - 职责说明：持久化 ActionDock 框架核心运行时状态库，包含 `global.db` 与 `runtime.db`。核心存储各代码仓库的检查点水位、任务状态与运行指标。检查点记录是维护智能体执行增量核验与断点续传的单一事实源依据，必须严格持久化，避免容器重启导致检查点归零进而引发全量重复建库。
    - 建议权限：目录权限建议为 700，容器内服务具备读写权限。
  - **工作区代码仓子目录** `workspace/`：
    - 宿主机路径：`${KNOWLEDGE_DATA_DIR}/workspace`。
    - 容器内挂载点：`/srv/workspace`。
    - 职责说明：存放所有待维护的业务工程代码仓与系统级知识仓。工作区由外部预先克隆或由维护工具自动同步。维护智能体在容器内部对此目录下的仓库进行分支拉取、差异扫描、文档增删改与提交推送。底层具备严格的路径穿越与软链逃逸安全校验。
    - 建议权限：目录权限建议为 755，容器内服务具备读写权限。
  - **待审池子目录** `inbox/`：
    - 宿主机路径：`${KNOWLEDGE_DATA_DIR}/inbox`。
    - 容器内挂载点：`/srv/knowledge-inbox`。
    - 职责说明：持久化由排障智能体、运维人员或外部调用方投递的结构化候选文档资产。包含存放待处理候选文档的待审池以及处理完毕后的归档池。候选文档作为独立贡献单元与正式知识单元物理隔离，避免未审核信息污染正式知识分支。
    - 建议权限：目录权限建议为 755，容器内服务具备读写权限。
  - **配置子目录** `config/`：
    - 宿主机路径：`${KNOWLEDGE_DATA_DIR}/config`。
    - 容器内挂载点：`/etc/actiondock`。
    - 职责说明：存放仓库清单配置文件 `repos.json`。该文件定义了知识中枢纳管的所有代码仓库路径、仓库类型、源分支与知识分支映射关系。
    - 建议权限：目录权限建议为 755，文件权限建议为 644。
  - **证书子目录** `certs/`：
    - 宿主机路径：`${KNOWLEDGE_DATA_DIR}/certs`。
    - 容器内挂载点：`/etc/actiondock/certs:ro`（只读挂载）。
    - 职责说明：用于放置自定义商业或内部机构签发的正式 TLS 证书文件 `cert.pem` 与私钥文件 `key.pem`。容器启动时优先读取该目录下的证书；若文件不存在，则自动降级生成自签名证书。
    - 建议权限：目录权限建议为 700，私钥文件权限严格限制为 600，公钥证书文件权限为 644。
  - **日志子目录** `logs/`：
    - 宿主机路径：`${KNOWLEDGE_DATA_DIR}/logs`。
    - 容器内挂载点：`/var/log/actiondock`。
    - 职责说明：持久化服务运行产生的系统日志、网关请求审计日志与维护任务执行日志。通过挂载至宿主机，便于结合外部日志采集系统统一收拢与审计。
    - 建议权限：目录权限建议为 755，容器内服务具备写入权限。
  - **远程沙盒裸仓子目录** `remotes/`：
    - 宿主机路径：`${KNOWLEDGE_DATA_DIR}/remotes`。
    - 容器内挂载点：`/data/knowledge/remotes`。
    - 职责说明：用于在离线测试、本地集成验证或沙盒演练场景下存放本地 Git 裸仓。在脱离外部真实 Git 托管平台的环境中，可通过该目录下的裸仓完整模拟多仓克隆、分支拉取、文档推送与检查点推进闭环。
    - 建议权限：目录权限建议为 755。

---

## 环境变量配置指引

系统在工程根目录通过环境配置文件 `.env` 管理所有核心参数。部署时可通过模板文件进行初始化：

```bash
cp .env.example .env
```

- **核心环境变量详细语义**：
  - **配置参数** `ACTIONDOCK_TOKEN`：
    - 作用范围：面向外部查询用户的只读检索与受控追加视图（sk 视图）。
    - 访问控制：持有该令牌的客户端仅被允许调用受控白名单内的动作，包括工作区全文检索（`workspace/search.rg`）、工作区文档读取（`workspace/files.read`）、工作区目录列表（`workspace/files.list`）以及候选文档收集投递（`knowledge/knowledge.collect`）。网关层严密阻断任何文件写操作与维护动作。
  - **配置参数** `ACTIONDOCK_AGENT_TOKEN`：
    - 作用范围：面向内部维护智能体的受控特权维护视图（skm 视图）。
    - 访问控制：持有该特权令牌的客户端拥有三大核心包（`workspace`、`knowledge`、`maintenance`）的全量操作权限，包括文件写入、局部受控替换编辑、文件删除移动、工作区状态审查与差异审查、待审池归档以及双分支代码同步与检查点推进。
  - **配置参数** `PORT`：
    - 作用范围：服务端对外暴露的监听端口。
    - 参数说明：系统基于单端口多视图架构运行，默认值为 `443`。统一使用该单一端口对外提供 HTTPS 服务，通过请求头中携带的令牌动态路由至对应权限视图，无需在防火墙上暴露多个端口。
  - **配置参数** `KNOWLEDGE_DATA_DIR`：
    - 作用范围：宿主机持久化数据根目录。
    - 参数说明：默认值为 `/data/knowledge`。上述持久化目录矩阵（`state/`、`workspace/`、`inbox/`、`config/`、`certs/`、`logs/`、`remotes/`）全部自动基于该路径挂载至容器中。
  - **配置参数** `SSH_DIR`：
    - 作用范围：宿主机 SSH 密钥对挂载目录。
    - 参数说明：默认值为 `/root/.ssh`。以只读形式挂载至容器 `/root/.ssh`，用于保证容器内的 Git 客户端免密访问内部代码托管平台。
- **双令牌生成方法与强制安全要求**：
  - **随机令牌生成命令**：
    必须在终端执行两次高强度加密随机生成命令，分别获取两个相互独立的十六进制随机字符串：
    ```bash
    openssl rand -hex 32
    openssl rand -hex 32
    ```
    该命令每次输出 64 个十六进制字符，分别复制填入 `.env` 中的 `ACTIONDOCK_TOKEN` 与 `ACTIONDOCK_AGENT_TOKEN`。
  - **系统强约束安全性校验**：
    容器自举脚本与虚拟视图网关内置了多道防御校验，只要违反以下任一安全规则，容器启动立即失败并退出：
    - 存在性校验：`ACTIONDOCK_TOKEN` 与 `ACTIONDOCK_AGENT_TOKEN` 均不能为空，必须显式定义。
    - 长度下限校验：两个令牌的字符长度必须均大于或等于 32 字符，拒绝使用弱口令。
    - 互斥性校验：`ACTIONDOCK_TOKEN` 与 `ACTIONDOCK_AGENT_TOKEN` 绝对不可相同。若两项配置一致，系统判定为权限隔离失效并立即阻断退出。
    - 占位符拦截校验：网关内置已知公开占位符签名库。若配置中包含模板占位符特征字符串（如 `4f8c9b`、`e7a1d2`、`9f83b2a7`、`8a12d4e7`、`your-random-secure` 等），将直接判定为不安全配置并拒绝启动。

---

## 待维护代码仓清单配置

知识中枢通过配置文件精确获知纳管的代码仓库列表及其分支维护策略。

- **配置文件规范与位置**：
  - 宿主机文件绝对路径为 `${KNOWLEDGE_DATA_DIR}/config/repos.json`（对应容器内挂载路径为 `/etc/actiondock/repos.json`）。
  - 该配置文件采用标准 JSON 数组格式，每一项代表一个受控维护的代码仓库或系统知识仓库。
- **字段语义与定义规范**：
  - **字段** `path`：
    - 必须为容器内部的绝对路径，格式固定为 `/srv/workspace/<仓库目录名称>`。
    - 路径必须严格收敛在工作区根目录 `/srv/workspace` 内，底层维护工具在调用时执行软链穿透与真实物理路径校验，严禁指向工作区外部目录。
  - **字段** `repoType`：
    - 仓库类型标识，枚举值仅允许为 `code` 或 `system_knowledge`。
    - `code`：表示业务代码仓库。该类仓库业务代码迭代频繁，采用双分支演进规范。
    - `system_knowledge`：表示系统级知识仓库。该类仓库不包含业务代码，用于统一沉淀跨业务的全局架构与规范文档，采用单分支主干规范。
  - **字段** `sourceBranch`：
    - 源码事实源分支名称。
    - 在业务代码仓中通常为生产发布基线分支，如 `release` 或 `master`。知识维护智能体从此分支拉取最新业务代码提交。
    - 在系统级知识仓中为知识沉淀的主干分支，通常为 `master` 或 `main`。
  - **字段** `knowledgeBranch`：
    - 知识文档沉淀分支名称。
    - 该字段仅在 `repoType` 为 `code` 时生效且必填，行业规范通常命名为 `docs`。
    - 当 `repoType` 为 `system_knowledge` 时，该字段不生效，配置时直接省略即可。
- **配置示例**：
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
- **业务代码仓双分支演进规范**：
  - 业务代码仓严格贯彻双分支解耦设计，将生产业务迭代与文档资产演进隔离开来：
    - 事实源分支（`sourceBranch`，如 `release`）：由业务研发团队持续集成交付，作为业务逻辑的唯一代码事实源。维护智能体对此分支仅执行只读拉取，严禁在此分支上提交任何文档。
    - 知识沉淀分支（`knowledgeBranch`，如 `docs`）：由维护智能体专属维护。智能体周期性唤起，将 `sourceBranch` 的增量提交拉取并合并至 `knowledgeBranch`。
    - 双轨合并冲突消解策略：代码合并过程中，若发生非知识文档的源代码冲突，系统默认无条件采用生产分支代码覆盖，确保代码资产自动对齐且流水线不中断；若发生知识文档本身的文字冲突，系统保留冲突标记并由维护智能体进行语义化比对和消解，消解完成后通过标准发布动作提交并推送到远端知识分支。
    - 规范文档结构：在知识分支中，知识文档统一按标准目录组织，包含业务流程、架构模块、规则约束、接口契约、数据定义与运维手册等分类，杜绝在根目录下随意乱放散乱文件。
- **系统级知识仓单分支规范**：
  - 系统级知识仓（`repoType: "system_knowledge"`）主要承载全局性、跨系统架构知识与宏观技术资产。
  - 由于该仓库本身不包含可执行业务代码，无须进行业务代码与文档分支的隔离，采用单分支主干模式（如 `master`）。
  - 维护智能体在执行维护闭环时，直接在主干分支上执行同步、内容审计、链接校验与发布提交。
- **仓库清单自愈与自动发现机制**：
  - 若管理员初次部署时未手动创建 `repos.json` 文件，维护工具包内置了自动发现与配置生成逻辑。
  - 当检测到 `/etc/actiondock/repos.json` 不存在时，系统自动扫描工作区根目录 `/srv/workspace` 下的所有一级子目录。
  - 若子目录包含 `.git` 目录，系统根据目录名称特征进行模式推断：名称包含 `system-knowledge` 或 `knowledge-system` 的目录自动标记为 `system_knowledge` 并配置主分支；其余目录自动标记为 `code` 业务代码仓，默认配置源分支为 `release`，知识分支为 `docs`。
  - 扫描完成后自动生成标准格式的 `repos.json` 文件并持久化落盘，降低多仓库环境的初始化成本。

---

## 容器构建启动与验证

完成环境变量与代码仓清单配置后，即可执行容器构建与服务启动。

- **构建与启动流程**：
  - 在工程根目录下执行构建与后台启动命令：
    ```bash
    docker compose up -d --build
    ```
  - 该命令将驱动 Dockerfile 完成以下自动化阶段：
    - 基于轻量级 Node.js 基础镜像安装底层工具链，包括支持部分克隆特性的 Git、全局高速搜索工具 ripgrep、SSH 客户端以及系统根证书。
    - 配置 Git 全局安全目录与维护者基础身份，防止多用户挂载卷引发权限归属异常拦截。
    - 全局安装 ActionDock 运行时客户端。
    - 拷贝项目源码并安装 Monorepo 生产依赖，将工作区平面、追加平面与特权维护平面三大工具包自动软链至 ActionDock 全局路由。
    - 启动容器入口自举脚本，完成 SSH 密钥目录权限校验修正、运行时工作区参数设定，并前台拉起单端口多视图反向代理服务。
- **传输层加密机制与证书策略**：
  - 系统在 443 端口上强制启用原生 HTTPS 加密传输，杜绝明文传输凭据风险。
  - **加载自定义正式证书**：
    若具备企业域名正式证书，仅需将证书文件与私钥文件分别命名为 `cert.pem` 与 `key.pem`，存放在宿主机 `${KNOWLEDGE_DATA_DIR}/certs/` 目录下。容器挂载该目录后，服务在初始化阶段将自动读取并加载该证书。
  - **自动生成自签名证书**：
    若未挂载自定义证书，服务检测到证书文件缺失时，会自动通过 openssl 在临时目录生成 2048 位 RSA 自签名 TLS 证书。控制台输出对应提示并以自签名证书正常对外提供 HTTPS 服务，保证测试与内部环境下开箱即用且全程加密。
- **服务健康与运行状态验证**：
  - **检查容器状态**：
    执行以下命令确认容器状态为运行中：
    ```bash
    docker compose ps
    ```
  - **查看容器启动日志**：
    ```bash
    docker compose logs -f
    ```
    确认日志中输出服务就绪信息，包含原生 HTTPS 端口监听状态、sk 视图启用状态、skm 视图启用状态以及各工作区根路径挂载信息。
- **客户端连接与单端口多视图隔离验证**：
  在客户端机器上安装 ActionDock 命令行工具，通过添加配置方案验证视图隔离效果：
  - **配置客户端连接配置文件**：
    ```bash
    # 添加面向外部查询用户的检索配置 (统一端口 443，携带 ACTIONDOCK_TOKEN)
    ad profile add sk -s https://<云主机IP>:443 -t <ACTIONDOCK_TOKEN> -k -d "知识库查询服务"

    # 添加面向维护智能体的特权维护配置 (统一端口 443，携带 ACTIONDOCK_AGENT_TOKEN)
    ad profile add skm -s https://<云主机IP>:443 -t <ACTIONDOCK_AGENT_TOKEN> -k -d "知识库维护服务"
    ```
    *(注：命令行参数 `-k` 用于在自签名证书环境下跳过证书链校验)*
  - **验证 sk 视图白名单收敛**：
    执行白名单动作应正常返回结果：
    ```bash
    ad run workspace/search.rg --profile sk -- pattern=test
    ad run workspace/files.list --profile sk -- path=order-service
    ```
    尝试执行写操作或维护动作，网关应坚决返回 403 阻断拒绝错误：
    ```bash
    ad run workspace/files.write --profile sk -- path=order-service/README.md content="hack"
    # 预期响应：HTTP 403 权限拒绝
    ```
  - **验证 skm 视图特权维护能力**：
    使用维护配置方案执行自省与只读扫描，应正常返回所有维护包与动作详情：
    ```bash
    # 查看可用动作列表
    ad list --profile skm

    # 执行全量分支同步扫描
    ad run maintenance/maintenance.list --profile skm
    ```

---

## 常用运维与日常维护命令

在知识中枢日常运维与故障排查过程中，可通过以下标准化命令完成容器基础运维与远端特权动作调度。

- **容器服务基础运维**：
  - **查看容器运行状态**：
    ```bash
    docker compose ps
    ```
  - **查看容器实时输出日志**：
    ```bash
    # 持续追踪全量实时日志
    docker compose logs -f

    # 查看最近 100 行日志并持续追踪
    docker compose logs --tail=100 -f
    ```
  - **进入容器交互式终端调试**：
    ```bash
    docker compose exec knowledge-server bash
    ```
  - **在容器内验证 Git 免密连接连通性**：
    ```bash
    # 测试与代码托管平台的 SSH 连通性
    docker compose exec knowledge-server ssh -T git@github.com
    ```
  - **在容器内检查 ActionDock 工具包软链状态**：
    ```bash
    docker compose exec knowledge-server ad list
    ```
  - **服务重启与平滑重新拉起**：
    ```bash
    # 重启容器服务
    docker compose restart

    # 停止服务
    docker compose stop

    # 重新构建并平滑拉起服务
    docker compose down && docker compose up -d --build
    ```
- **远端受控维护动作执行速查**：
  维护智能体或系统管理员在受信任网络中，通过 ActionDock 客户端直连 443 端口特权维护视图（配置标识 `skm`），以纯动作模式调度各维护动作：
  - **全量多仓代码分支同步**：
    ```bash
    ad run maintenance/maintenance.sync --profile skm
    ```
  - **单仓定向代码分支同步**：
    ```bash
    ad run maintenance/maintenance.sync --profile skm -- path=/srv/workspace/order-service
    ```
  - **批量扫描所有待维护代码变更**：
    ```bash
    ad run maintenance/maintenance.list --profile skm
    ```
  - **单仓定向扫描代码变更与差异区间**：
    ```bash
    ad run maintenance/maintenance.list --profile skm -- path=/srv/workspace/order-service
    ```
  - **远端文档断链与交叉引用校验**：
    ```bash
    ad run workspace/links.verify --profile skm -- path=/srv/workspace/order-service
    ```
  - **远端审查工作区文件变动差异**：
    ```bash
    ad run workspace/git.diff --profile skm -- path=/srv/workspace/order-service -- statOnly:=true
    ```
  - **远端提交并推送文档更新产物**：
    ```bash
    ad run maintenance/maintenance.publish --profile skm -- path=/srv/workspace/order-service message="docs: update service architecture"
    ```
  - **远端推进检查点水位**：
    ```bash
    ad run maintenance/maintenance.complete --profile skm -- path=/srv/workspace/order-service commit="<COMMIT_HASH>" actionTaken="docs_updated" summary="更新接口文档与架构说明"
    ```
