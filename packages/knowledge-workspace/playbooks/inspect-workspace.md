# 工程工作区探索与排查规程

本文档规范智能体在工程工作区内浏览目录、搜索代码与阅读文本文件的标准操作流程（SOP）。

## 工作区配置与范围限定

在执行任何探索与排查操作前，应明确工作区根目录边界：

- **未显式配置时的默认行为（禁止任意访问）**：
  未配置时自动锁定为当前终端工作目录，**绝不代表可以访问全盘任意文件夹**。操作严格受限于当前工程目录内部，任何跨工程、跳出上层目录或系统绝对路径的访问均会被安全拦截。
- **全局配置中心方式**：
  使用 ActionDock 命令行工具配置全局工作区根目录：
  ```bash
  ad config set --global WORKSPACE_ROOT /path/to/target/project
  ```
- **环境变量注入方式**：
  在终端会话或启动服务时注入环境变量：
  ```bash
  export WORKSPACE_ROOT=/path/to/target/project
  # 或临时命令前缀指定（使用扁平参数）：
  WORKSPACE_ROOT=/srv/workspace ad run search.rg -- pattern=foo
  ```
- **沙箱约束说明**：
  配置生效后，所有后续 Action 调用均在该目录内闭环执行，返回的路径统一为相对逻辑路径，越界访问将被强制拦截。

## 标准排查与探索流程

智能体应遵循 **“目录摸底 -> 全文检索 -> 分段精读”** 的标准顺序逐步收敛排查范围，严禁无序盲目遍历。

### 第一步：目录结构探索 (`files.list`)

优先获取工作区顶层目录结构，掌握工程整体骨架与核心模块划分。

- **调用原则**：优先以较浅深度（`depth=1` 或 `2`）扫描，避免深层全量遍历消耗大量上下文。
- **推荐调用示例（扁平参数）**：
  ```bash
  # 扫描工程根目录一级结构：
  ad run files.list -- path=. depth:=1

  # 深入特定源码目录二级结构：
  ad run files.list -- path=src depth:=2

  # 机器模式输出（JSON 信封）：
  ad run files.list --json -- path=src depth:=1
  ```

### 第二步：关键代码检索 (`search.rg`)

定位关键类名、函数定义、错误日志或配置项。利用 ripgrep 原生参数进行精准搜索。

- **调用原则**：
  - 先窄后宽：若已知目标模块，通过 `paths` 数组限定检索子目录；
  - 避免转义：包含特殊符号的代码片段使用 `fixedStrings:=true` 进行字面量精确匹配；
  - 上下文把控：需要观察调用上下文时配置 `context:=2`，必要时通过 `maxResults` 约束返回条数。
- **推荐调用示例（扁平参数）**：
  ```bash
  # 基础正则模式搜索：
  ad run search.rg -- pattern="WorkspacePathPolicy"

  # 限定子目录与忽略大小写搜索：
  ad run search.rg -- pattern="payment" paths.0=src ignoreCase:=true

  # 字面量精确匹配（无需正则转义，附带上下文行）：
  ad run search.rg -- pattern="defineAction<Input, Output>" fixedStrings:=true context:=2 maxResults:=20

  # 机器模式输出（JSON 信封）：
  ad run search.rg --json -- pattern="RG_TIMEOUT_MS" context:=1
  ```

### 第三步：源码分段精读 (`files.read`)

通过第二步检索命中具体文件路径与行号后，按需阅读源文件内容。

- **调用原则**：
  - 严禁一次性全量加载超大文件；
  - 基于检索命中的行号，设定合理的 `startLine` 和 `maxLines`（建议单次 50 ~ 100 行）；
  - 关注返回的 `hasMore` 状态，若内容未完可连续翻页读取。
- **推荐调用示例（扁平参数）**：
  ```bash
  # 精确定位目标行附近代码（从第 1 行起读取 30 行）：
  ad run files.read -- path=src/limits.ts startLine:=1 maxLines:=30

  # 连续分页读取后续内容：
  ad run files.read -- path=src/limits.ts startLine:=31 maxLines:=30

  # 机器模式输出（JSON 信封）：
  ad run files.read --json -- path=package.json startLine:=1 maxLines:=20
  ```

## 安全红线与注意事项

1. **严格限定在沙箱内**：所有传参的 `path` 必须为相对路径，严禁使用 `../` 逃逸出工作区根目录（违者触发 `PATH_OUTSIDE_WORKSPACE`）。
2. **敏感信息全局阻断**：严禁尝试读取 `.env`、`**/*.pem`、`.git/**` 等敏感机密凭据文件（违者触发 `SENSITIVE_PATH_DENIED`）。
3. **传参规范**：主流推荐使用扁平参数（`-- <assignments...>`），字符串使用 `path=val`，数值/布尔/对象使用 `path:=json`，切勿混用 `--input`。
