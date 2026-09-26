# 知识中枢维护规程与动作参考手册

---

## 维护平面定位与权限体系

### 维护平面定位与架构

知识中枢是基于 ActionDock 规范构建的一体化知识服务容器，采用原生单端口多视图架构统一收敛至 HTTPS 443 端口运行。面向知识中枢的访问区分为外部查询平面与内部维护平面：

- 查询平面通过查询令牌自动路由至查询虚拟视图，采用动作级白名单严格收敛，仅暴露只读检索与候选知识投递能力，杜绝任何写入与版本控制操作。
- 维护平面面向受信任的维护智能体与调度系统，通过维护专属特权令牌自动路由至特权维护视图（配置标识 `skm`），赋予完整的工作区代码与文档检索、文件受控读写、局部精准编辑、断链核验、版本差异审查、双分支代码同步、文档推送发布以及检查点水位推进能力。

```text
       本地开发者 / 排障智能体 / 外部客户端               维护智能体 / 派发子智能体 / 流水线驱动器
                      │                                              │
                      ▼  (HTTPS 443 / 查询令牌)                       ▼  (HTTPS 443 / 维护令牌)
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │                               Cloud Host: knowledge-server                               │
  │                                                                                          │
  │   ┌──────────────────────────────────────────────────────────────────────────────────┐   │
  │   │  ad serve -p 443 --https --views "<VIEWS_JSON>"                                  │   │
  │   │  (单端口多视图：通过请求中的 Bearer Token 自动路由对应虚拟视图)                     │   │
  │   └─────────────────────────────┬──────────────────────────────┬─────────────────────┘   │
  │                                 │                              │                         │
  │                                 ▼                              ▼                         │
  │                 ┌──────────────────────────────┐ ┌──────────────────────────────┐        │
  │                 │ sk 虚拟视图 (只读检索与追加)  │ │ skm 虚拟视图 (特权维护平面)  │        │
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

### 权限隔离体系与环境配置

维护智能体对云端知识中枢的操作一律通过特权配置标识 `skm` 发起。客户端接入配置与鉴权机制如下：

- 客户端配置添加：在本地维护环境或自动化调度容器中，通过 ActionDock 命令行添加维护配置标识：
  ```bash
  ad profile add skm -s https://<cloud-host-ip>:443 -t <ACTIONDOCK_AGENT_TOKEN> -k -d "知识中枢特权维护服务"
  ```
  其中 `-k` 参数用于在自签名证书环境下信任传输层连接。
- 令牌自动路由：客户端发起的每个请求均携带 `Authorization: Bearer <ACTIONDOCK_AGENT_TOKEN>` 请求头，云端服务前置网关自动鉴权并映射至 `skm` 特权视图，开放 `workspace`、`knowledge` 与 `maintenance` 全部包空间。
- 权限隔离边界：查询用户持有的普通令牌无法调用维护动作，维护动作亦不向外部公网暴露未受控接口，实现动作级别的物理与逻辑双重隔离。

### 核心维护原则与操作红线

维护智能体执行维护规程时必须恪守以下原则：

- 单一事实源原则：Git 代码仓库作为正式知识资产的唯一事实源，所有正式文档均在各代码仓知识分支或系统知识仓主分支中演进。
- 工作区边界收敛：所有文件操作必须严格收敛在工作区根目录 `/srv/workspace` 内，严禁利用相对路径越界逃逸。
- 检查点推进铁律：代码变更触发知识有效性核验，无论本次维护是否修改文档，流程结束时均必须推进检查点水位，确立已核验基线。
- 安全回退红线：分支同步或合并遇阻时必须安全中止并保留现场，严禁执行硬重置或强制推送到远端仓库。
- 知识单元解耦：待审池候选文档属于贡献单元，严禁机械地直接转化为正式知识文件，必须经过去重、交叉验证与结构化提炼后合入正式文档。

---

## 远端自省与动作发现

ActionDock 提供完整的自省与发现能力。维护智能体在连接远端受控服务后，可通过命令行工具动态探测挂载的工具包、动作定义、参数模式以及示例，无需依赖静态硬编码。

### 远端工具包与服务概览探测

查看远端服务中已挂载的全部工具包、可用动作数量及标准规程概览：

```bash
ad info --profile skm
```

若需进一步探查特定工具包的内部细节与详细规程，可指定包名称：

```bash
ad info workspace --profile skm
ad info maintenance --profile skm
ad info knowledge --profile skm
```

执行后将输出该工具包的版本、描述、环境变量配置依赖、包含的动作列表以及配套的操作手册。

### 可用动作清单列举

列出当前特权视图下所有可调用的动作标识与其功能摘要：

```bash
ad list --profile skm
```

输出结果清晰呈现每个动作的完整路径命名空间，例如 `maintenance/maintenance.sync`、`workspace/files.edit` 等。维护智能体可据此确认当前视图具备的完整操作能力集。

### 动作模式定义与传参规范探测

通过动作描述命令，智能体可自省获取指定动作的底层模式定义：

```bash
ad describe maintenance/maintenance.sync --profile skm
ad describe maintenance/maintenance.list --profile skm
ad describe workspace/files.edit --profile skm
ad describe workspace/links.verify --profile skm
```

自省输出包含以下核心要素：

- 动作功能说明：动作的具体用途、运行上下文与副作用。
- 输入模式定义：完整的 JSON 模式结构，包含各字段名称、数据类型、是否必填、枚举限制与默认值。
- 输出模式定义：动作执行成功后的返回载荷结构，包含状态码、实体对象与结构化统计信息。
- 典型传参示例：官方预置的输入与输出数据样例，为智能体组装入参提供基准依据。

---

## 核心维护动作全集速查

### 代码同步动作

**动作标识**：`maintenance/maintenance.sync`

**所属工具包**：`maintenance`

**核心职责**：将本地工作区的代码仓或系统知识仓与远端仓库保持同步。针对双分支业务代码仓，自动将源码迭代分支合入知识文档分支；针对单分支系统知识仓，执行快进同步。在遇到脏工作区或合并冲突时安全中止，杜绝丢失未提交代码或污染分支历史。

**输入参数规范**：

- `path`（字符串，可选）：目标仓库在工作区内的绝对路径。若省略该参数，则自动读取仓库清单配置文件，执行全量多仓批量同步。
- `url`（字符串，可选）：远端 Git 仓库克隆地址。当本地工作区目录不存在时，基于该地址执行自动按需克隆。
- `config`（字符串，可选）：仓库清单配置文件路径，默认为 `/etc/actiondock/repos.json`。
- `repoType`（字符串枚举，可选）：仓库架构类型，取值为 `code`（双分支业务代码仓）或 `system_knowledge`（单分支系统知识仓）。未指定时根据清单配置自动识别。
- `sourceBranch`（字符串，可选）：源码迭代来源分支，业务代码仓默认为 `release`，系统知识仓默认为 `master`。
- `knowledgeBranch`（字符串，可选）：知识文档分支，仅对双分支业务代码仓生效，默认为 `docs`。
- `filterBlobNone`（布尔值，可选）：是否启用免文件体部分获取机制，大幅减少网络传输与磁盘占用，默认为 `true`。远端不支持时自动优雅降级为全量同步。
- `cloneTimeoutMs`（整数，可选）：执行克隆操作时的超时毫秒数，默认采用系统全局配置。

**输出字段解析**：

- `status`（字符串枚举）：同步执行结果状态，取值为 `success`（同步成功并推送）、`dirty_worktree`（工作区存在未提交变动而中止）、`conflict`（合并遇到冲突并已安全回滚）、`error`（严重执行异常）。
- `batch`（布尔值）：是否为批量多仓同步模式。
- `path`（字符串）：单仓模式下解析后的仓库绝对路径。
- `currentCommit`（字符串）：同步完成后目标分支的最新提交哈希。
- `uncommittedFiles`（字符串数组）：当状态为 `dirty_worktree` 时，列出导致中断的未提交文件列表。
- `conflictFiles`（字符串数组）：当状态为 `conflict` 时，列出产生合并冲突的文件清单。
- `summary`（对象）：批量模式下的统计信息，包含 `total`（总处理仓数）、`syncedCount`（成功同步数）、`conflictCount`（冲突数）、`errorCount`（异常数）。
- `results`（对象数组）：批量模式下每个仓库的独立同步结果详情。
- `message`（字符串）：人机可读的执行结果摘要。

**调用示例**：

- 批量全量同步已配置仓库：
  ```bash
  ad run maintenance/maintenance.sync --profile skm
  ```
- 单仓定向同步：
  ```bash
  ad run maintenance/maintenance.sync --profile skm -- path="/srv/workspace/order-service" repoType="code" sourceBranch="release" knowledgeBranch="docs"
  ```
- 单仓自动克隆并同步：
  ```bash
  ad run maintenance/maintenance.sync --profile skm -- path="/srv/workspace/order-service" url="git@github.com:example/order-service.git" repoType="code"
  ```

---

### 变更扫描动作

**动作标识**：`maintenance/maintenance.list`

**所属工具包**：`maintenance`

**核心职责**：对比目标代码分支的最新提交与检查点持久化库中记录的上轮已核验提交，提取未审查的代码提交列表、差异文件清单与修改行数统计，为维护智能体提供精确的核验范围。

**输入参数规范**：

- `path`（字符串，可选）：目标仓库的绝对路径。若省略则执行批量多仓变更扫描。
- `config`（字符串，可选）：仓库清单配置文件路径，默认为 `/etc/actiondock/repos.json`。
- `branch`（字符串，可选）：待检查的目标分支名称，业务代码仓默认为 `release`，系统知识仓默认为 `master`。

**输出字段解析**：

- `hasChanges`（布尔值）：自上次检查点以来是否存在尚未审查的代码变更。
- `batch`（布尔值）：是否为多仓批量扫描模式。
- `path`（字符串）：仓库根路径。
- `repo`（字符串）：仓库标识名称。
- `branch`（字符串）：核验的目标分支名称。
- `from`（字符串或空值）：检查点数据库中记录的前置提交哈希；若仓库此前从未核验过，则返回空值。
- `to`（字符串）：当前扫描到达的目标最新提交哈希。
- `commitCount`（整数）：本次扫描覆盖的代码提交总数。
- `initialInventoryRequired`（布尔值）：若为 `true`，代表该仓库无历史检查点记录，必须执行首次全盘建库与全量盘点流程。
- `commits`（对象数组）：待审代码提交清单，包含每条提交的 `hash`、`shortHash`、`message`、`author` 与 `date`。
- `changedFilesSummary`（对象）：文件修改汇总信息，包含 `filesChanged`（改动文件数）、`insertions`（新增行数）、`deletions`（删除行数）以及 `files`（逐个文件的改动统计）。
- `summary`（对象）：批量扫描汇总，包含 `total`、`changedCount`、`initialCount`、`upToDateCount`、`errorCount`。
- `results`（对象数组）：批量模式下每个仓库的扫描结论数组。
- `message`（字符串）：执行结果文字说明。

**调用示例**：

- 批量扫描所有仓库变更状态：
  ```bash
  ad run maintenance/maintenance.list --profile skm
  ```
- 单仓定向扫描：
  ```bash
  ad run maintenance/maintenance.list --profile skm -- path="/srv/workspace/order-service"
  ```

---

### 工作区读写与局部受控编辑

维护智能体在知识中枢工作区内进行文档维护时，严禁使用未经沙箱管控的裸终端命令，必须全部统一调用工作区受控动作集。

#### 文本分段直读动作

**动作标识**：`workspace/files.read`

**核心职责**：分段读取工作区内的文档或源码文本，支持指定起始行与最大行数，具备严格的输出体积上限保护。

**输入参数规范**：

- `path`（字符串，必填）：相对于工作区根目录的文件路径。
- `startLine`（数字，可选）：起始行号，从 1 开始计数，默认为 1。
- `maxLines`（数字，可选）：最大读取行数，默认为 2000。

**输出字段解析**：

- `path`（字符串）：解析后的文件路径。
- `startLine`（数字）：实际读取的起始行号。
- `endLine`（数字）：实际读取的结束行号。
- `content`（字符串）：文件内容正文。
- `hasMore`（布尔值）：文件是否仍有后续未读行。
- `truncated`（布尔值）：内容是否因单行过长或体积超限被截断。

**调用示例**：

```bash
ad run workspace/files.read --profile skm -- path="order-service/docs/knowledge/flow/flow-payment.md" startLine:=1 maxLines:=500
```

#### 文本安全写入动作

**动作标识**：`workspace/files.write`

**核心职责**：向工作区指定文件安全写入文本内容，支持自动按需创建缺失的各级父目录，提供防覆盖保护选项。

**输入参数规范**：

- `path`（字符串，必填）：相对于工作区根目录的目标文件路径。
- `content`（字符串，必填）：待写入的文本正文。
- `createDirs`（布尔值，可选）：若父目录不存在是否自动递归创建，默认为 `true`。
- `overwrite`（布尔值，可选）：目标文件已存在时是否允许覆盖写入，默认为 `true`。

**输出字段解析**：

- `path`（字符串）：规格化后的相对路径。
- `bytesWritten`（数字）：实际写入的字节总数。
- `created`（布尔值）：本次写入是否创建了新文件。

**调用示例**：

```bash
ad run workspace/files.write --profile skm -- path="order-service/docs/knowledge/rule/rule-refund.md" content="# 退款时效与校验规则\n\n- 退款时效窗口为支付成功后 30 个自然日内。\n"
```

#### 局部精准受控编辑动作

**动作标识**：`workspace/files.edit`

**核心职责**：对现有文档进行局部字符串精准替换，支持设置行号范围约束与多重匹配防冲突保护，杜绝全文覆盖造成的意外丢失。

**输入参数规范**：

- `path`（字符串，必填）：相对于工作区根目录的目标文件路径。
- `targetContent`（字符串，必填）：待查找并替换的原始文本内容，必须严格匹配源文件中的字符序列与缩进。
- `replacementContent`（字符串，必填）：替换后的目标新内容。
- `allowMultiple`（布尔值，可选）：是否允许替换多处匹配项，默认为 `false`。若为 `false` 且文件中存在多处匹配，动作将直接报错中止。
- `startLine`（数字，可选）：限定查找替换的起始行号。
- `endLine`（数字，可选）：限定查找替换的结束行号。

**输出字段解析**：

- `path`（字符串）：文件相对路径。
- `replacementsCount`（数字）：实际完成替换的匹配项数量。
- `bytesWritten`（数字）：编辑完成后文件的总字节数。

**调用示例**：

```bash
ad run workspace/files.edit --profile skm -- path="order-service/docs/knowledge/flow/flow-payment.md" targetContent="超时判定阈值为 15 分钟" replacementContent="超时判定阈值为 30 分钟" allowMultiple:=false
```

#### 工作区辅助管理动作

- 目录层级受控浏览：`workspace/files.list`
  - 参数：`path`（目录路径，默认为根目录）、`depth`（遍历层级深度，默认 1）、`hidden`（是否包含隐藏文件，默认 `false`）。
  - 用途：快速探索知识库目录布局与源码骨架。
  - 示例：`ad run workspace/files.list --profile skm -- path="order-service/docs/knowledge" depth:=2`
- 文件或目录安全删除：`workspace/files.delete`
  - 参数：`path`（路径）、`recursive`（递归删除目录，默认 `false`）、`ignoreIfNotExists`（不存在时静默忽略，默认 `false`）。
  - 边界：受到受控边界防误删保护，严禁删除工作区根目录。
- 版本感知移动与重命名：`workspace/files.move`
  - 参数：`from`（源路径）、`to`（目标路径）、`overwrite`（覆盖已有文件，默认 `false`）。
  - 特性：自动感知 Git 跟踪状态，已跟踪文件自动采用底层版本重命名，完整保留变更演化历史。
- 全文代码与文档检索：`workspace/search.rg`
  - 参数：`pattern`（正则或字面量表达式）、`paths`（限定搜索目录数组）、`fixedStrings`（字面量模式）、`maxResults`（最大返回匹配数，上限 200）。
  - 特性：基于 ripgrep 引擎极速检索，自动忽略构建产物与无用目录。

---

### 文档断链与引用校验

**动作标识**：`workspace/links.verify`

**所属工具包**：`workspace`

**核心职责**：对指定工作区目录或文档内的相对路径链接、图片静态资产引用以及 Markdown 标题锚点进行全量图谱校验。

**核心交付门禁**：在维护流程中，任何文档的新建（`files.write`）或修改（`files.edit`）完成后，必须立即调用本动作进行死链扫描。只有当断链数为零（`brokenCount === 0`）时，才允许进入后续发布与提交流程。

**输入参数规范**：

- `path`（字符串，可选）：待扫描的目录或单个 Markdown 文件相对路径，默认为 `.`（全工作区扫描）。
- `checkAnchors`（布尔值，可选）：是否校验文档内部的标题锚点引用有效性，默认为 `true`。
- `ignoreDirs`（字符串数组，可选）：额外排除的目录名称列表，例如 `["archive", "vendor"]`。

**输出字段解析**：

- `scannedFiles`（整数）：本次扫描覆盖的 Markdown 文档总数。
- `totalLinks`（整数）：本次校验发现的本地相对链接总数。
- `brokenCount`（整数）：扫描发现的断链总数。
- `brokenLinks`（对象数组）：断链详情列表，数组中每个对象包含：
  - `file`（字符串）：存在断链的 Markdown 文件路径。
  - `line`（整数）：断链所在的行号（从 1 开始）。
  - `link`（字符串）：文档正文中书写的原始链接内容。
  - `target`（字符串）：解析出的相对目标路径或锚点标识。
  - `reason`（字符串枚举）：失效原因代码，取值为 `TARGET_NOT_FOUND`（引用的目标文件或相对路径不存在）或 `ANCHOR_NOT_FOUND`（目标文档中不存在对应的标题锚点）。

**就地自愈修复规程**：

- 若返回 `brokenCount > 0`，严禁直接提交或放行。
- 遍历 `brokenLinks` 数组，针对 `TARGET_NOT_FOUND`，分析是引用的相对路径层级错误，抑或是引用的目标文档尚未落盘。路径错误时调用 `workspace/files.edit` 纠偏相对层级；目标文档缺失时调用 `workspace/files.write` 补齐对应文档。
- 针对 `ANCHOR_NOT_FOUND`，调用 `workspace/files.edit` 将链接锚点修正为目标文档中实际存在的标准化标题锚点。
- 修复完毕后重新执行 `workspace/links.verify`，反复迭代直至 `brokenCount === 0`。

**调用示例**：

```bash
ad run workspace/links.verify --profile skm -- path="order-service/docs/knowledge" checkAnchors:=true
```

---

### 工作区变更审查

维护智能体在执行发布前，必须对本地工作区的修改状态与差异范围进行双重核查，确保修改完全收敛于知识文档目录，严禁意外误触业务代码或项目工程配置文件。

#### 工作区状态审查动作

**动作标识**：`workspace/git.status`

**核心职责**：审查指定仓库工作区与暂存区的即时状态，返回未暂存、已暂存及未跟踪的文件列表，并过滤潜在的敏感信息。

**输入参数规范**：

- `path`（字符串，可选）：仓库相对于工作区根目录的路径，默认为工作区根目录。

**输出字段解析**：

- `isGitRepo`（布尔值）：目标目录是否为合法的 Git 仓库。
- `branch`（字符串）：当前检出的分支名称。
- `clean`（布尔值）：工作区是否完全干净无任何未提交改动。
- `staged`（字符串数组）：已暂存的文件路径列表。
- `unstaged`（字符串数组）：已修改但尚未暂存的文件路径列表。
- `untracked`（字符串数组）：未被版本跟踪的新建文件列表。

**调用示例**：

```bash
ad run workspace/git.status --profile skm -- path="order-service"
```

#### 工作区受控差异核验动作

**动作标识**：`workspace/git.diff`

**核心职责**：核验工作区改动的具体补丁文本与统计摘要，受到最大行数与字节预算的双重保护。

**输入参数规范**：

- `path`（字符串，可选）：指定核验差异的子文件或目录路径，省略时核验全仓。
- `staged`（布尔值，可选）：是否核验已暂存的修改，默认为 `false`（核验未暂存变动）。
- `statOnly`（布尔值，可选）：是否仅输出差异统计摘要而不返回完整补丁正文，默认为 `false`。
- `maxLines`（数字，可选）：最大返回差异行数，默认为 1000。
- `maxBytes`（数字，可选）：最大字节预算上限，默认为 262144（256KB）。

**输出字段解析**：

- `isGitRepo`（布尔值）：是否为 Git 仓库。
- `clean`（布尔值）：所选审查范围内是否存在差异。
- `diff`（字符串）：具体的差异对比文本，受行数与字节预算裁剪保护。
- `truncated`（布尔值）：差异文本是否因超出预算被截断。
- `filesChanged`（数字）：改动涉及的文件数量。
- `insertions`（数字）：新增行数。
- `deletions`（数字）：删除行数。

**调用示例**：

- 快速审查变动统计：
  ```bash
  ad run workspace/git.diff --profile skm -- path="order-service" -- statOnly:=true
  ```
- 审查具体补丁细节：
  ```bash
  ad run workspace/git.diff --profile skm -- path="order-service" -- maxLines:=500
  ```

---

### 文档提交推送与检查点推进

#### 文档改动提交与推送动作

**动作标识**：`maintenance/maintenance.publish`

**所属工具包**：`maintenance`

**核心职责**：将本地工作区中已完成核验与断链自愈的知识文档修改统一步骤化暂存、提交，并推送到远端知识分支或系统知识仓主分支。

**输入参数规范**：

- `path`（字符串，必填）：仓库在工作区内的绝对路径。
- `repoType`（字符串枚举，可选）：仓库架构类型（`code` 或 `system_knowledge`），默认自动识别。
- `branch`（字符串，可选）：推送的目标分支名称。业务代码仓默认为 `docs`，系统知识仓默认为 `master`。
- `message`（字符串，可选）：提交日志信息，遵循约定式提交规范，默认为 `docs: update knowledge documentation`。
- `files`（字符串数组，可选）：指定需暂存并提交的特定文件或目录列表，省略时默认暂存并提交当前分支下的全部改动。
- `push`（布尔值，可选）：创建本地提交后是否推送到远端仓库，默认为 `true`。

**输出字段解析**：

- `status`（字符串枚举）：发布结果，取值为 `success`（成功完成提交与推送）、`no_changes`（工作区干净无改动需要提交）、`error`（提交或推送过程出错）。
- `path`（字符串）：仓库解析后的绝对路径。
- `repo`（字符串）：仓库标识名称。
- `branch`（字符串）：执行提交与推送的分支名称。
- `committed`（布尔值）：是否成功生成了本地 Git 提交。
- `pushed`（布尔值）：是否已将修改成功推送至远端。
- `commit`（字符串）：新生成的 Git 提交哈希。
- `files`（字符串数组）：本次提交包含的文件相对路径清单。
- `message`（字符串）：人机可读的发布结果总结。

**调用示例**：

```bash
ad run maintenance/maintenance.publish --profile skm -- path="/srv/workspace/order-service" message="docs(payment): update refund flow and error codes"
```

#### 检查点水位推进动作

**动作标识**：`maintenance/maintenance.complete`

**所属工具包**：`maintenance`

**核心职责**：在完成代码变更核验后，将检查点持久化数据库中的已核验提交水位推进至本次核验的目标提交，确保状态被可靠记录。

**检查点推进铁律**：检查点的核心语义是“从上一个检查点到当前提交之间的代码变动，已经经过知识体系的完整核验”。因此，无论本次维护最终是否产生了文档修改，核验流程结束后均必须显式调用 `maintenance.complete` 动作。若未推进检查点，下轮自动化巡检将重复扫描已经审查过的历史提交，造成流程死循环。

**输入参数规范**：

- `path`（字符串，必填）：仓库在工作区内的绝对路径。
- `commit`（字符串，必填）：本次核验完成的目标提交哈希（7 至 40 位十六进制字符），通常取自 `maintenance.list` 返回的 `to` 字段。
- `actionTaken`（字符串枚举，可选）：本次维护周期采取的处理决议，默认为 `no_change_needed`。可选枚举值：
  - `docs_updated`：代码变动导致知识失效，已完成知识文档的新建或更新。
  - `no_change_needed`：已深入审查代码提交，经判定属于内部实现重构或优化，对外行为与契约未发生漂移，无需变动文档。
  - `skipped`：跳过本次审查或由于特殊策略免检。
- `summary`（字符串，可选）：针对本次核验决策的简明备忘说明，供审计与后续维护回溯。

**输出字段解析**：

- `repo`（字符串）：仓库标识名称。
- `path`（字符串）：仓库路径。
- `previousCommit`（字符串或空值）：更新前的前置检查点提交哈希；若为首次核验则为 `null`。
- `currentCommit`（字符串）：本次成功推进并持久化记录的最新 40 位完整提交哈希。
- `actionTaken`（字符串枚举）：记录的处理决议。
- `summary`（字符串）：记录的核验说明文本。
- `updatedAt`（字符串）：检查点持久化落盘的 ISO 8601 标准时间戳。

**调用示例**：

- 文档更新后的推进：
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- path="/srv/workspace/order-service" commit="d4e5f607182930415263748596a7b8c9d0e1f2a3" actionTaken="docs_updated" summary="根据支付流重构更新了 flow-payment 与 interface 契约文档"
  ```
- 无需变动文档时的推进：
  ```bash
  ad run maintenance/maintenance.complete --profile skm -- path="/srv/workspace/order-service" commit="d4e5f607182930415263748596a7b8c9d0e1f2a3" actionTaken="no_change_needed" summary="核验 3 个提交，均为内部缓存逻辑优化，业务流程与错误码未发生漂移"
  ```

---

## 候选知识归档动作

候选知识待审池是知识中枢在反馈追加平面的核心机制。外部排障人员或排障智能体通过 `knowledge.collect` 投递的时效性排障结论、故障现场日志与排障线索，均暂存于待审池（位于 `/srv/knowledge-inbox/pending/`）。维护智能体在消费待审池时，负责对候选文档进行检索、甄别、合入正式知识库，并执行分类归档。

### 候选文档检索动作

**动作标识**：`knowledge/knowledge.list`

**所属工具包**：`knowledge`

**核心职责**：检索待审池或历史已归档的候选知识文档，支持按生命周期状态、归档年份与关联仓库进行精确过滤，按生成时间倒序排列。

**输入参数规范**：

- `status`（字符串枚举，可选）：候选文档生命周期状态过滤，默认为 `pending`。可选值：
  - `pending`：检索等待审核与消费的新增候选文档。
  - `processed`：检索已完成归档处理的历史文档。
  - `all`：检索全部状态的候选文档。
- `year`（字符串，可选）：4 位日历年份字符串（例如 `2026`），用于过滤特定年份归档的历史候选。
- `repo`（字符串，可选）：关联代码仓库名称过滤，基于候选文档的元数据进行匹配。

**输出字段解析**：

- `items`（对象数组）：符合条件的候选知识文档列表，数组中每个对象包含：
  - `id`（字符串）：候选文档的全局唯一标识。
  - `filename`（字符串）：文档在磁盘上的物理文件名。
  - `path`（字符串）：文档在容器内的绝对路径。
  - `status`（字符串枚举）：当前状态（`pending` 或 `processed`）。
  - `year`（字符串）：文档所属年份。
  - `title`（字符串）：文档标题。
  - `domain`（字符串）：所属业务领域。
  - `tags`（字符串数组）：关联的分类标签列表。
  - `repos`（字符串数组）：关联的代码仓库标识列表。
  - `createdAt`（字符串）：创建时间戳。
  - `archivedAt`（字符串，可选）：归档时间戳（仅在已处理文档中返回）。
  - `resolution`（字符串枚举，可选）：归档决议。
  - `archiveNote`（字符串，可选）：归档说明。

**调用示例**：

- 列出待处理的所有候选文档：
  ```bash
  ad run knowledge/knowledge.list --profile skm -- status="pending"
  ```
- 检索关联特定仓库的待处理文档：
  ```bash
  ad run knowledge/knowledge.list --profile skm -- status="pending" repo="order-service"
  ```

---

### 候选文档归档动作

**动作标识**：`knowledge/knowledge.archive`

**所属工具包**：`knowledge`

**核心职责**：将待审池中的候选文档物理移动至已处理归档目录中（结构为 `/srv/knowledge-inbox/processed/<year>/<resolution>/`），并自动在文档头部元数据中注入归档决议、归档时间戳与决策备忘。

**输入参数规范**：

- `id`（字符串，必填）：待归档的候选文档唯一标识或其完整文件名。
- `resolution`（字符串枚举，可选）：对该候选文档的归档处置决议，默认为 `accepted`。可选值：
  - `accepted`：候选内容有效，已成功合入正式知识库文档。
  - `duplicate`：候选内容与既有知识或历史排障结论重复，予以归档去重。
  - `rejected`：候选内容结论失真或已被废止，拒绝采纳。
  - `insufficient_evidence`：现场证据不充分或缺少复现日志，暂不采纳。
- `note`（字符串，可选）：针对归档决议的具体说明文本（例如标明合入的目标正式文档路径或去重依据）。

**输出字段解析**：

- `id`（字符串）：已归档的文档唯一标识。
- `fromPath`（字符串）：原在待审池中的文件绝对路径。
- `toPath`（字符串）：归档移动后的最终文件绝对路径。
- `resolution`（字符串枚举）：生效的处置决议。
- `status`（字符串）：归档后的生命周期状态，固定为 `archived`。
- `year`（字符串）：落位的归档年份分类。

**调用示例**：

- 采纳并合入正式文档后的归档：
  ```bash
  ad run knowledge/knowledge.archive --profile skm -- id="20260924-a1b2c3" resolution="accepted" note="排障结论已结构化合入 order-service 的 runbook-database-timeout.md"
  ```
- 重复内容的归档处理：
  ```bash
  ad run knowledge/knowledge.archive --profile skm -- id="20260924-d4e5f6" resolution="duplicate" note="与历史资产 20260901-b8c7e2 描述的 Redis 内存碎片问题完全一致"
  ```

---

## Maintainer Agent 编排调度与技能对接

维护智能体负责自主驱动单仓全生命周期的自动化闭环。通过挂载配套编排技能，智能体可高效承接上层调度驱动，落实标准化作业规范。

### 技能挂载与激活方式

系统在 `skills/knowledge-maintenance-orchestrator/SKILL.md` 中预置了完整的单仓自闭环编排规范。在智能体运行环境、定时任务或流水线调度配置中，通过标准化指令激活技能：

```text
请激活 skills/knowledge-maintenance-orchestrator/SKILL.md 技能，针对指定的单一代码仓库执行一轮完整的知识维护闭环。
```

激活后，智能体将遵循该技能定义的单仓自闭环执行规程，自动调用特权视图动作，实现确定性交付。

### 标准化单仓自闭环执行全流程

智能体对目标仓库执行维护时，必须严格执行以下闭环阶段：

- 阶段一：分支同步与冲突安全消解
  - 智能体调用 `maintenance/maintenance.sync`（传入目标仓库路径 `path`）执行分支同步。
  - 若返回状态为 `success`，代表同步顺利完成，自动进入下一阶段。
  - 若返回状态为 `conflict`，代表知识文档在合并时产生冲突。智能体调用 `workspace/files.read` 读取带有冲突标记的文档，结合两端事实消除冲突标记并合成完备文档，随后调用 `workspace/files.write` 安全写回，调用 `maintenance/maintenance.publish` 提交冲突消解成果，恢复工作区整洁后继续推进流程。
  - 若返回状态为 `dirty_worktree` 或 `error`，智能体记录中断原因并中止当前仓的维护。
- 阶段二：变更扫描与场景判定分流
  - 智能体调用 `maintenance/maintenance.list`（传入目标仓库路径 `path`）进行变更扫描。
  - 分流场景甲（无代码变更场景）：若 `hasChanges === false` 且无需冷启动，说明当前知识文档已与最新生产代码完全对齐。智能体跳过后续编辑与发布环节，直接进入阶段五，调用 `maintenance.complete` 推进检查点水位。
  - 分流场景乙（冷启动建库场景）：若 `initialInventoryRequired === true` 或仓库缺少知识文档骨架，判定为首次接入。智能体需基于六大单数类别目录（`flow`、`module`、`rule`、`interface`、`data`、`runbook`）深入源码全量构建实质文档，并在知识根目录生成导航入口 `index.md` 与总览文档 `overview.md`。
  - 分流场景丙（增量核验场景）：若存在新增提交（`hasChanges === true`），智能体提取变更提交列表与差异文件切片，启动源码核验。
- 阶段三：源码核验与文档编写
  - 智能体对变更文件逐一应用更新门槛与失效四问（核验业务流程、对外契约、关键定位是否发生漂移，是否引入新入口与新规则）。
  - 若四问全否，说明仅涉及内部优化或重构，知识文档无需变动，直接进入阶段五。
  - 若存在知识失效，使用 `workspace/search.rg` 检索受影响模块，使用 `workspace/files.read` 阅读上下文，使用 `workspace/files.write` 新建文档或使用 `workspace/files.edit` 进行局部受控编辑。
  - 知识文档必须统一落位在 `/srv/workspace/<repoPath>/docs/knowledge/<category>/` 目录下，并以 `<category>-<topic>.md` 规则严格命名。
- 阶段四：断链自检自愈门禁
  - 文档编辑完成后，智能体调用 `workspace/links.verify` 对目标仓库执行全量断链扫描。
  - 门禁判定：若发现断链（`brokenCount > 0`），严禁执行发布，必须利用 `workspace/files.edit` 立即就地自愈修复相对死链与失效锚点，直至断链数清零（`brokenCount === 0`）。
  - 边界复核：调用 `workspace/git.status` 与 `workspace/git.diff` 审查变更边界，确保所有修改纯粹收敛于文档目录，业务源码保持零改动。
- 阶段五：统一发布推送与推进检查点水位
  - 存在实质文档变动时，智能体调用 `maintenance/maintenance.publish` 统一提交并推送到远端知识分支。
  - 推进检查点（绝对交付标志）：无论本次是否产生文档修改，智能体在流程终点必须调用 `maintenance/maintenance.complete`，传入本次扫描的目标提交哈希 `to`，根据实际情况指定 `actionTaken` 为 `docs_updated` 或 `no_change_needed`，并附带简要备忘说明。该动作的成功执行是本次维护任务完成的唯一事实依据。

### 本地流水线调度驱动协同

针对大规模代码仓库（如数十至上百个服务）场景，为避免维护智能体在单次长会话中发生上下文膨胀或网络长连接中断，系统推荐配合使用本地流水线调度驱动器（`bin/pipeline-runner.mjs`）：

- 职责解耦：本地调度驱动器运行在本地宿主环境中，负责宏观多仓清单轮询、断点续传管理、并发控制与进度看板展示；维护智能体聚焦于微观单仓，每次唤醒只负责一个仓库的端到端维护闭环。
- 异步感知与闭环推进：调度驱动器向智能体派发单仓维护指令后，通过非阻塞方式异步观察云端状态库。当且仅当智能体成功执行 `maintenance.complete` 动作且检查点提交水位更新后，驱动器判定该仓维护成功，自动切入下一个目标仓库。

### 交付报告规范

单仓维护流程结束后，维护智能体输出结构化交付结算摘要，用于审计留痕与状态归档：

```markdown
# 单仓知识维护交付报告

- 目标仓库：<仓库名称>
- 工作区路径：<repoPath>
- 维护场景：<冷启动建库 / 增量核验 / 无代码变更>
- 前置检查点：<fromCommit>
- 目标提交：<toCommit>
- 分支同步状态：<成功 / 冲突已自愈消解>
- 文档变更清单：
  - <新建或修改的文档相对路径及变更摘要>
- 断链自检门禁：
  - 扫描文档数：<数字>
  - 检查链接数：<数字>
  - 残留断链数：0（门禁通过）
- 检查点推进决议：
  - 记录提交：<toCommit>
  - 处置决议：<docs_updated / no_change_needed>
  - 推进状态：成功
```
