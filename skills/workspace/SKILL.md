---
name: workspace
description: Read-only engineering workspace search and file access
---

# Workspace (workspace)

Read-only engineering workspace search and file access

## ActionDock 运行时

本技能为 **ActionDock 源码型技能包**。智能体可直接通过宿主环境中已安装的 ActionDock 命令行工具 `ad` 执行其中的 Action。

### 注册与链接

在初次调用或初始化时，将包含本 `SKILL.md` 的目录解析为 `<skill_root>` 并完成注册：

```bash
ad link "<skill_root>"
```

> `ad link` 天然具备幂等性，同一 Package 多次执行会直接更新路径，可安全重复调用。若初次运行提示依赖缺失，可在 `<skill_root>` 目录下执行 `npm install --omit=dev` 安装生产依赖。

### 动作参数契约按需调阅

在调用未知参数的 Action 前，可在终端执行命令按需查阅该 Action 的输入输出模式与详细说明：

```bash
ad describe workspace/search.rg
```

### 执行 Action

为避免多技能之间的 Action ID 命名冲突，建议统一使用带有 Package 前缀的完全限定 ID。

推荐最佳实践：使用文件传递参数，杜绝终端引号转义问题：

```bash
# 写入参数到临时文件并通过 --input-file 传递
cat << 'EOF' > /tmp/input.json
{
  "param": "value"
}
EOF
ad run workspace/search.rg --input-file /tmp/input.json
```

亦可通过内联参数进行简易命令调用：

```bash
ad run workspace/search.rg --input '{"param": "value"}'
```

> **免注册本地执行**：
> 若工作目录已位于本技能根目录，亦可直接免 link 执行：
> ```bash
> cd <skill_root>
> ad run <action-id> --input-file /tmp/input.json
> ```

### 结构化响应解析

所有 Action 执行结果均在 `stdout` 输出标准格式的 JSON 信封：

```json
// 执行成功响应 (ok 为 true)
{
  "ok": true,
  "runId": "01J...",
  "data": { ... }
}

// 执行失败响应 (ok 为 false)
{
  "ok": false,
  "runId": "01J...",
  "error": {
    "code": "ACTION_EXECUTION_FAILED",
    "message": "错误详细描述信息"
  }
}
```

- `stdout`：标准 JSON 信封结果。当 `ok` 为 `true` 时，从 `data` 提取业务返回值推进后续步骤；当 `ok` 为 `false` 时，从 `error` 提取错误码与信息以判定自愈策略或上报。
- `stderr`：执行日志与诊断跟踪信息。

## 业务操作规程

> [!IMPORTANT]
> **规程优先准则**：当处理复合业务任务时，智能体必须优先检查是否存在匹配场景的 Playbook。若存在规程，必须优先查阅并严格遵循规程界定的步骤时序与校验逻辑推进，严禁无序拼凑调用底层 Action。

Playbook SOPs 为复杂业务任务提供逐步指导规程。详细规程请查阅对应文档：

- **inspect-workspace** (`./playbooks/inspect-workspace.md`): Standard operating procedure for exploring files and searching codebase in the engineering workspace

---

## Action 目录

- `workspace/search.rg` (或 `search.rg`) - Search text in the engineering workspace using ripgrep semantics. Most input fields map directly to ripgrep long options. Paths are relative to the workspace root.
  - 输入参数:
    - `pattern` (`string`, 必填): ripgrep search pattern (regular expression by default, or literal if fixed-strings is true)
    - `paths` (`array`): Paths to search, relative to workspace root. Defaults to workspace root if omitted.
    - `fixed-strings` (`boolean`): Treat pattern as literal string instead of regular expression (-F)
    - `ignore-case` (`boolean`): Case insensitive search (-i)
    - `smart-case` (`boolean`): Smart case search: case-insensitive unless pattern contains uppercase (-S)
    - `word-regexp` (`boolean`): Only match whole words (-w)
    - `line-regexp` (`boolean`): Only match whole lines (-x)
    - `glob` (`array`): Glob patterns to include or exclude (e.g. ['*.ts', '!generated/**']) (-g)
    - `type` (`array`): Only search files matching file type definition (e.g. ['ts', 'py']) (--type)
    - `type-not` (`array`): Do not search files matching file type definition (--type-not)
    - `hidden` (`boolean`): Search hidden files and directories (--hidden)
    - `no-ignore` (`boolean`): Do not respect .gitignore or other ignore files (--no-ignore)
    - `follow` (`boolean`): Follow symbolic links (--follow)
    - `context` (`number`): Show NUM lines before and after each match (-C)
    - `before-context` (`number`): Show NUM lines before each match (-B)
    - `after-context` (`number`): Show NUM lines after each match (-A)
    - `multiline` (`boolean`): Enable matching across multiple lines (-U)
    - `multiline-dotall` (`boolean`): Make '.' in regex match newlines (--multiline-dotall)
    - `max-count` (`number`): Limit number of matching lines per file (-m)
    - `max-columns` (`number`): Don't print lines longer than this limit in bytes (--max-columns)
    - `max-columns-preview` (`boolean`): Print preview for lines exceeding max-columns (--max-columns-preview)
  - 输出字段:
    - `matches` (`array`)
    - `truncated` (`boolean`)

- `workspace/files.read` (或 `files.read`) - Read UTF-8 text from a file in the engineering workspace. Supports reading from a specific line with bounded output. Paths are relative to the workspace root.
  - 输入参数:
    - `path` (`string`, 必填): Path to the file relative to the workspace root
    - `startLine` (`number`): 1-based starting line number. Defaults to 1. (默认值: `1`)
    - `maxLines` (`number`): Maximum number of lines to read. Defaults to 200. (默认值: `200`)
  - 输出字段:
    - `path` (`string`)
    - `startLine` (`number`)
    - `endLine` (`number`)
    - `content` (`string`)
    - `hasMore` (`boolean`)
    - `truncated` (`boolean`)

- `workspace/files.list` (或 `files.list`) - List files and directories in the engineering workspace. Paths are relative to the workspace root.
  - 输入参数:
    - `path` (`string`): Directory path relative to workspace root. Defaults to workspace root.
    - `depth` (`number`): Maximum directory traversal depth. Defaults to 1. (默认值: `1`)
    - `hidden` (`boolean`): Whether to include hidden files. Defaults to false. (默认值: `false`)
  - 输出字段:
    - `items` (`array`)
    - `truncated` (`boolean`)

---

## 运行时配置与持久化状态

如需检查或配置该 Package 的运行时参数与持久化数据：

```bash
# 查看与设置配置项
ad config list --package workspace
ad config set KEY VALUE --package workspace

# 查看与检索状态数据
ad state list --package workspace
ad state get KEY --package workspace
```

---

## 故障排查与环境安装指引（按需查阅）

> [!NOTE]
> **按需排查原则**：默认宿主环境中已预置 `ad` 命令行工具与 Node.js 运行环境。正常执行流程直接调用上述 Action 即可，**严禁在任务启动前盲目进行前置环境检查或体检**；仅在终端明确报错提示命令不存在（如 `ad: command not found`）或提示依赖缺失时，方可按本节指引安装初始化。

### 命令行工具与环境依赖未就绪时的安装指引

若宿主环境未安装 `ad` 命令行工具或依赖缺失，请依次按如下步骤完成安装：

- **环境要求**：Node.js 版本大于等于 24.12.0（执行 `node -v` 确认）。
- **全局安装 ActionDock 命令行工具**：
  ```bash
  npm install -g @actiondock/cli
  ```
- **安装技能源码依赖**：
  若在技能目录内调用时提示模块缺失，在 `<skill_root>` 目录下安装生产依赖：
  ```bash
  cd "<skill_root>" && npm install --omit=dev
  ```
- **验证工具就绪**：
  ```bash
  ad --version
  ```
- **环境诊断与体检**：
  安装完成后若仍遇到异常，执行体检命令排查：
  ```bash
  ad doctor
  ```
- **完成安装后重新链接本技能**：
  ```bash
  ad link "<skill_root>"
  ```
