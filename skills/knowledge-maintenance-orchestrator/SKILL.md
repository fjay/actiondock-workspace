---
name: knowledge-maintenance-orchestrator
description: 知识维护总控编排技能，通过 ActionDock 特权维护服务驱动单仓与全多仓的自动化分支同步、代码变更扫描、子智能体调度、断链与状态审查、发布推送及检查点推进闭环。
metadata:
  version: 1.0.0
---

# 知识维护总控编排

作为知识维护总控智能体，通过 ActionDock 纯动作规范依托特权维护服务驱动知识中枢的端到端自动化维护闭环。负责多代码仓与单代码仓的分支自动同步、知识冲突语义消解、代码变更扫描判定、子智能体调度与协作、断链与状态差异审查门禁、统一发布推送以及检查点水位推进。

---

## 核心定位与环境依赖

- **核心定位**：本技能是知识中枢自动化维护的主控编排技能，面向云端维护智能体。主控智能体依托特权维护服务统一编排维护闭环，实现纯动作调用与结构化决策，杜绝宿主机容器嵌套执行与无状态脚本拼接。
- **环境依赖**：执行过程依赖 ActionDock 特权维护服务（服务端口 443，配置标识 `--profile skm`）。所有维护动作（`maintenance/*`）与工作区读写动作（`workspace/*`）统一在此受控环境中执行。
- **远端工具探索与模式自省**：所有工具调用统一基于 ActionDock 纯动作协议（`ad run <action> --profile skm`）。智能体面对远端受控环境时，可通过远端自省与发现工具链完全自主探索和使用远端能力：
  - 通过 `ad info --profile skm` 查看远端所有挂载的工具包、动作与规程概览。
  - 通过 `ad list --profile skm` 列出远端所有可用动作清单及其功能描述。
  - 通过 `ad describe <action> --profile skm`（例如 `ad describe maintenance.sync --profile skm` 或 `ad describe workspace/files.edit --profile skm`）查询具体动作的完整描述、模式定义（`inputSchema` 与 `outputSchema`）以及推荐的扁平传参示例。
  - 通过 `ad info <package> --profile skm`（例如 `ad info workspace --profile skm`）查看具体工具包内的所有动作与剧本。
- **协作技能依赖**：在具体文档编写与局部修补环节，主智能体负责调度子智能体，子智能体挂载并遵循 [project-knowledge-maintainer](../project-knowledge-maintainer/SKILL.md) 深入对应源码执行细粒度核验与文档产出。

---

## 双模式运行准则

根据触发指令与目标仓库配置，智能体自动识别并进入对应运行模式：

- **单仓定向维护模式**：
  - 触发条件：明确指定单一目标仓库标识（例如 `order-service`）。
  - 工作区路径：目标仓库工作区路径 `<repoPath>` 为 `/srv/workspace/<target-repo>`。
  - 执行策略：针对该单一代码仓执行精确的代码分支同步、变更扫描、子智能体调度、门禁自检与检查点水位推进。
- **全仓批量巡检模式**：
  - 触发条件：目标仓库标识留空或指定为 `all`。
  - 工作区路径：工作区根目录 `/srv/workspace` 下的全部配置代码仓。
  - 执行策略：首先执行全量多仓批量同步与批量变更扫描，随后对扫描出存在代码变更或需要冷启动建库的代码仓依次进行场景判定与编排处理；文档未失效的代码仓跳过子智能体调度，直接推进检查点水位。

---

## 标准化执行流程

维护全流程划分为七个关键环节，智能体必须严格遵循时序闭环推进：

### 分支同步与冲突消解

调用维护同步动作拉取远端更新并合入知识分支：

- **批量同步调用**：
  ```bash
  ad run maintenance/maintenance.sync --profile skm
  ```
- **单仓定向同步调用**：
  ```bash
  ad run maintenance/maintenance.sync --profile skm -- path="<repoPath>"
  ```
- **同步返回决议判定**：
  - **执行成功**（`status == "success"`）：代码分支同步与非文档代码自愈成功完成，直接进入变更扫描环节。
  - **存在冲突**（`status == "conflict"`）：检测到知识文档合并冲突，获取返回结果中的 `conflicts` 列表逐一处理：
    - 单仓模式：若包含当前目标仓库 `<repoPath>`，针对其 `conflictFiles` 中的每个冲突文档进行语义消解；若不包含，直接进入变更扫描环节。
    - 批量模式：针对 `conflicts` 列表中各变更仓库的 `conflictFiles` 逐一消解。
    - 冲突消解动作：
      - 调用 `workspace/files.read`（`--profile skm -- path="<repoPath>/<conflictFile>"`）读取带冲突标记的文档内容。
      - 理解本地知识分支（`<<<<<<< HEAD`）与远端生产变更（`>>>>>>> origin/release`）两端事实，消除冲突标记，合成为最准确完备的知识文档。
      - 调用 `workspace/files.write`（`--profile skm -- path="<repoPath>/<conflictFile>" content="<消解后的文档内容>"`）安全写回消解后的文档。
      - 调用 `maintenance/maintenance.publish`（`--profile skm -- path="<repoPath>" message="docs(merge): resolve knowledge conflict"`）提交并推送消解成果。
      - 冲突消解完成后，继续进入变更扫描环节。
  - **执行异常**（`status == "error"`）：记录错误详情并终止后续流程。

### 变更扫描与场景判定

调用维护变更扫描动作比对代码提交差异：

- **单仓扫描调用**：
  ```bash
  ad run maintenance/maintenance.list --profile skm -- path="<repoPath>"
  ```
- **批量扫描调用**：
  ```bash
  ad run maintenance/maintenance.list --profile skm
  ```
- **场景判定与处理分流**：
  - **无代码变更场景**（`hasChanges == false` 且无需初始化建库）：
    - 判定说明：文档已与代码基线完全对齐，无需派发子智能体或更新文档。
    - 后续动作：跳过该仓库后续文档核验，直接进入检查点水位推进环节。
  - **冷启动建库场景**（`initialInventoryRequired == true` 或仓库缺少知识文档骨架）：
    - 判定说明：仓库首次接入知识中枢，或需全面补齐六大类知识资产。
    - 编排动作：主智能体按六大分类目录（`flow`、`module`、`rule`、`interface`、`data`、`runbook`）并行派发子智能体，子智能体深入源码使用 `workspace/files.write` 生成实质文档。
    - 汇总动作：主智能体回收各子智能体产物，生成导航入口 `index.md` 与总览 `overview.md`，随后进入变更门禁与自检环节。
  - **增量核验场景**（`initialInventoryRequired == false` 且 `hasChanges == true`）：
    - 判定说明：代码存在提交增量，需验证既有文档有效性。
    - 编排动作：主智能体根据返回的变更提交与差异文件清单切片，派发核验任务至子智能体。
    - 子智能体执行：子智能体运行更新门槛与失效四问核验。若文档失效，使用 `workspace/files.edit` 提交局部精准补丁；若涉及新增独立流程，使用 `workspace/files.write` 生成新文档。
    - 汇总动作：子智能体完成核验并汇报后，主智能体进入变更门禁与自检环节。

### 子智能体调度与协作

主智能体与子智能体分工明确、紧密协作：

- **主子分工原则**：主智能体负责维护全流程全局编排（分支同步、变更扫描、调度分发、变更门禁校验、统一发布推送与检查点推进），持有特权维护服务；子智能体深入代码一线完成知识提取与文档编写。
- **遵循维护规范**：调度子智能体时，明确要求子智能体挂载并遵循 [project-knowledge-maintainer](../project-knowledge-maintainer/SKILL.md)，关于本仓文档与系统知识仓联动、失效四问判定与格式布局，全部依托该技能既有规约自主决策。
- **标准派发规范**：主智能体调度子智能体时，必须使用标准派发提示词模板作为唯一的规则事实源，显式透传特权受控环境、工作区绝对路径拓扑、跨仓探索授权、工具清单、数据类资产红线准则以及断链自检自愈门禁，杜绝子智能体因上下文缺失而陷入无效摸索。
- **标准子智能体派发提示词模板**：
  主智能体调度子智能体时，必须按下述标准模板组装派发指令：

  ````markdown
  你正在执行知识中枢维护任务，负责目标仓库的知识库核验与文档编写。

  - **遵循技能规范**：挂载并严格遵循 project-knowledge-maintainer。执行更新门槛与失效四问判定；若需更新或新建，遵守统一目录布局与规范命名。
  - **目标仓库绝对路径**：`/srv/workspace/<target-repo>`
  - **跨仓探索与绝对路径授权**：所有代码仓与系统知识仓平铺于 `/srv/workspace`。ActionDock 所有工作区动作均使用绝对路径，严禁使用上级目录（`..`）。已完全授权你直接以绝对路径访问兄弟代码仓（`/srv/workspace/<sibling-repo>`）与系统知识仓（`/srv/workspace/system-knowledge`）。
  - **跨仓 DDL 引用与数据类资产约束（红线准则）**：在涉及 `data` 类知识资产构建与核验时，必须首先探索系统知识仓 `/srv/workspace/system-knowledge`。若已存在对应数据库的映射登记（`db-map.md`）与 DDL 快照（`ddl/data-ddl-{schema}.md`），本仓 `data/data-databases.md` 仅作为轻量引用索引，注明涉及表域与数据源标识；若尚未收录，显式登记为知识缺口。严禁在代码仓库自身文档中复制粘贴表结构、列定义、字段类型或建表脚本。
  - **环境与特权动作工具**：当前依托 ActionDock 特权受控环境（`--profile skm`）。可通过 `ad info --profile skm` 查看所有挂载工具包与能力概览，通过 `ad list --profile skm` 列出所有可用动作，通过 `ad describe <action> --profile skm`（例如 `ad describe workspace/files.edit --profile skm`）自省获取具体动作的模式定义与传参示例。常用特权动作包括：
    - 全文检索：`ad run workspace/search.rg --profile skm -- pattern="<keyword>" paths.0="/srv/workspace/<path>"`
    - 分段直读：`ad run workspace/files.read --profile skm -- path="/srv/workspace/<path>" startLine:=1 maxLines:=2000`
    - 局部编辑：`ad run workspace/files.edit --profile skm -- path="/srv/workspace/<path>" targetContent="<old>" replacementContent="<new>"`
    - 安全写入：`ad run workspace/files.write --profile skm -- path="/srv/workspace/<path>" content="<content>"`
    - 目录浏览：`ad run workspace/files.list --profile skm -- path="/srv/workspace/<dir>" depth:=1`
    - 文档链接有效性校验：`ad run workspace/links.verify --profile skm -- path="/srv/workspace/<repoPath>"`
    - 状态自查与差异比对：`ad run workspace/git.status --profile skm -- path="/srv/workspace/<repoPath>"` 与 `ad run workspace/git.diff --profile skm -- path="/srv/workspace/<repoPath>"`
  - **断链自检与就地修复门禁**：完成任何文档的新建或修改后，严禁直接退出交差。必须主动调用 `ad run workspace/links.verify --profile skm -- path="/srv/workspace/<repoPath>"` 进行死链扫描；若存在断链（`brokenCount > 0`），结合 `brokenLinks` 清单使用 `workspace/files.edit` 立即就地修复至零断链（`brokenCount === 0`）方可汇报。
  - **当前具体核验任务**：
    - <具体说明本次代码变更范围、涉及提交或冷启动建库分类范围>
  - **完成汇报要求**：
    - 任务完成后向主智能体汇报，汇报内容必须包含：
      - 文档判定结论（是否需要更新以及原因说明）
      - 修改或新建的文档清单及简要说明
      - 断链自检与就地修复结果（扫描文件数、校验链接数、断链数须为 0）
      - 工作区状态审查结果
  ````

### 变更门禁与发布前自检

在执行正式发布推送前，主智能体必须严格执行发布前门禁审查：

- **断链校验物理门禁**：
  - 校验命令：
    ```bash
    ad run workspace/links.verify --profile skm -- path="<repoPath>"
    ```
  - 门禁要求：全面核验相对路径死链、图片资产缺失与失效标题锚点。若存在断链，必须先使用 `workspace/files.edit` 修复，确保死链数为零方可放行。
- **工作区状态与差异审查**：
  - 审查命令：
    ```bash
    ad run workspace/git.status --profile skm -- path="<repoPath>"
    ad run workspace/git.diff --profile skm -- path="<repoPath>" -- statOnly:=true
    ```
  - 门禁要求：严格核对所有变更完全收敛在知识文档目录下，严禁误触或修改任何业务源码与配置资产。
- **统一提交与推送**：
  - 确认上述门禁全部合规且存在文档实质变动时，执行统一提交与推送。
  - 单仓知识文档推送：
    ```bash
    ad run maintenance/maintenance.publish --profile skm -- path="<repoPath>" message="docs: update knowledge documentation"
    ```
  - 系统知识仓联动推送：若子智能体遵循 project-knowledge-maintainer 联动修改了系统知识仓，主智能体在收尾时对系统知识仓同样执行闭环推送：
    ```bash
    ad run maintenance/maintenance.publish --profile skm -- path="/srv/workspace/system-knowledge" repoType="system_knowledge" message="docs(system): sync cross-repository knowledge"
    ```

### 推进检查点水位（铁律）

无论本次维护是否产生文档变动，流程结束后必须将水位推进至变更扫描返回的 `to` 提交：

- **更新知识文档或全盘建库**：
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- path="<repoPath>" commit="<TO_COMMIT>" actionTaken="docs_updated" summary="<更新说明>"
  ```
- **经核验确认无需修改文档**：
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- path="<repoPath>" commit="<TO_COMMIT>" actionTaken="no_change_needed" summary="<代码重构或优化，业务逻辑与知识未失效>"
  ```

---

## 结算报告规范

维护流程执行完毕后，主智能体必须汇总输出结构化结算报告，汇报内容规范如下：

```markdown
# 知识维护结算报告

- 维护模式：<单仓定向维护 / 全仓批量巡检>
- 目标仓库列表：<仓库标识与路径清单>
- 分支同步状态：<成功 / 冲突自愈 / 冲突语义消解完成 / 异常>
- 场景判定汇总：
  - <仓库名称>：<冷启动建库 / 增量核验 / 无代码变更>
- 子智能体调度概况：
  - 派发任务数：<数字>
  - 核验结论：<各任务更新说明或无需修改判定>
- 断链校验门禁：
  - 扫描文件数：<数字>
  - 校验链接数：<数字>
  - 断链数：0
- 检查点推进记录：
  - 提交水位：<TO_COMMIT>
  - 处置决议：<docs_updated / no_change_needed>
  - 推进状态：成功
```
