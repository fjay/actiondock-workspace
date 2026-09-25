#!/usr/bin/env bash
# ==============================================================================
# run-maintenance.sh
# 知识库自动维护与反馈闭环 - 云主机后台编排驱动脚本
#
# 定位：由 Cron / systemd 定时调度，调用 actiondock-knowledge-maintenance 执行
# 流程：maintenance.sync -> maintenance.list -> (maintainer agent) -> maintenance.complete
# ==============================================================================

set -euo pipefail

# 解析脚本真实物理路径 (支持软链接)
SOURCE="${BASH_SOURCE[0]}"
while [ -h "${SOURCE}" ]; do
  DIR="$(cd -P "$(dirname "${SOURCE}")" && pwd)"
  SOURCE="$(readlink "${SOURCE}")"
  [[ ${SOURCE} != /* ]] && SOURCE="${DIR}/${SOURCE}"
done
SCRIPT_DIR="$(cd -P "$(dirname "${SOURCE}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 日志输出函数
log_info() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO] $*"
}

log_warn() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [WARN] $*" >&2
}

log_error() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [ERROR] $*" >&2
}

show_help() {
  cat << EOF
使用方法:
  $0 [command] [options]

子命令:
  sync                        仅执行分支同步与代码冲突自愈 (推荐 Agent 步骤 1 使用)
  full                        执行完整编排 (sync -> list -> agent -> complete, 默认模式)

配置选项:
  --repo-path <path>          待维护仓库绝对路径
  --repo-type <type>          仓库架构类型: code | system_knowledge (默认自动判定)
  --source-branch <branch>    源分支 (code仓默认: release, 系统仓默认: master)
  --knowledge-branch <branch> 知识分支 (code仓默认: docs)
  --sync-only                 等同于 sync 子命令
  --auto-complete             若无知识变更需更新时自动推进 checkpoint (默认开启)
  --config <file>             JSON 格式的批量仓库配置文件路径
  --report-file <file>        结构化维护报告输出路径 (默认: /tmp/sync-report.json)
  --dry-run                   仅扫描不提交状态变更
  -h, --help                  显示帮助信息

环境变量:
  WORKSPACE_ROOT              默认工作区根目录 (如 /srv/workspace)
  MAINTAINER_AGENT_CMD        可选的 Maintainer Agent 触发脚本或命令
EOF
}

# 默认参数
ACTION_MODE="full"
if [[ $# -gt 0 ]]; then
  case "$1" in
    sync)
      ACTION_MODE="sync"
      shift
      ;;
    full)
      ACTION_MODE="full"
      shift
      ;;
  esac
fi

TARGET_REPO_PATH=""
REPO_TYPE=""
SOURCE_BRANCH=""
KNOWLEDGE_BRANCH=""
AUTO_COMPLETE=true
CONFIG_FILE=""
REPORT_FILE="/tmp/sync-report.json"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sync-only)
      ACTION_MODE="sync"
      shift
      ;;
    --repo-path)
      TARGET_REPO_PATH="$2"
      shift 2
      ;;
    --repo-type)
      REPO_TYPE="$2"
      shift 2
      ;;
    --source-branch)
      SOURCE_BRANCH="$2"
      shift 2
      ;;
    --knowledge-branch)
      KNOWLEDGE_BRANCH="$2"
      shift 2
      ;;
    --auto-complete)
      AUTO_COMPLETE=true
      shift
      ;;
    --no-auto-complete)
      AUTO_COMPLETE=false
      shift
      ;;
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    --report-file)
      REPORT_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      log_error "未知参数: $1"
      show_help
      exit 1
      ;;
  esac
done

# 若未显式指定 config，默认自动采用 /etc/actiondock/repos.json (支持无参全量同步)
if [ -z "${CONFIG_FILE}" ] && [ -f "/etc/actiondock/repos.json" ]; then
  CONFIG_FILE="/etc/actiondock/repos.json"
fi

# 校验 ad 命令
if ! command -v ad &>/dev/null; then
  log_error "'ad' CLI 工具未找到，请确保已安装并在 PATH 中可用"
  exit 1
fi

# 初始化维护执行报告文件 (持久化至指定文件，供 Agent 干净读取)
REPORT_FILE="${REPORT_FILE:-/tmp/sync-report.json}"
mkdir -p "$(dirname "${REPORT_FILE}")" 2>/dev/null || true
echo '{"synced":[],"conflicts":[],"errors":[]}' > "${REPORT_FILE}"

# 保证 Git 提交基础身份
ensure_git_config() {
  if ! git config --global user.name >/dev/null 2>&1; then
    git config --global user.name "Knowledge Maintainer" >/dev/null 2>&1 || true
  fi
  if ! git config --global user.email >/dev/null 2>&1; then
    git config --global user.email "maintainer@actiondock.local" >/dev/null 2>&1 || true
  fi
}

record_synced() {
  local p="$1"
  node -e "
    const fs = require('fs');
    try {
      const r = JSON.parse(fs.readFileSync('${REPORT_FILE}', 'utf8'));
      if (!r.synced.includes(process.argv[1])) r.synced.push(process.argv[1]);
      fs.writeFileSync('${REPORT_FILE}', JSON.stringify(r));
    } catch (e) {}
  " "${p}"
}

record_conflict() {
  local p="$1"
  local s_b="$2"
  local k_b="$3"
  shift 3
  node -e "
    const fs = require('fs');
    try {
      const r = JSON.parse(fs.readFileSync('${REPORT_FILE}', 'utf8'));
      const files = process.argv.slice(4);
      r.conflicts.push({
        path: process.argv[1],
        sourceBranch: process.argv[2],
        knowledgeBranch: process.argv[3],
        conflictFiles: files
      });
      fs.writeFileSync('${REPORT_FILE}', JSON.stringify(r));
    } catch (e) {}
  " "${p}" "${s_b}" "${k_b}" "$@"
}

record_error() {
  local p="$1"
  local msg="$2"
  node -e "
    const fs = require('fs');
    try {
      const r = JSON.parse(fs.readFileSync('${REPORT_FILE}', 'utf8'));
      r.errors.push({
        path: process.argv[1],
        error: process.argv[2]
      });
      fs.writeFileSync('${REPORT_FILE}', JSON.stringify(r));
    } catch (e) {}
  " "${p}" "${msg}"
}

# 执行单仓维护流程
process_repository() {
  local repo_path="$1"
  local r_type="$2"
  local s_branch="$3"
  local k_branch="$4"

  log_info "============================================================"
  log_info "开始处理仓库: ${repo_path}"
  log_info "============================================================"

  if [ ! -d "${repo_path}" ]; then
    log_error "仓库目录不存在: ${repo_path}"
    record_error "${repo_path}" "Repository directory does not exist: ${repo_path}"
    return 1
  fi

  ensure_git_config

  # 1. 构建 maintenance.sync 输入
  local sync_input="{\"path\": \"${repo_path}\""
  if [ -n "${r_type}" ]; then
    sync_input="${sync_input}, \"repoType\": \"${r_type}\""
  fi
  if [ -n "${s_branch}" ]; then
    sync_input="${sync_input}, \"sourceBranch\": \"${s_branch}\""
  fi
  if [ -n "${k_branch}" ]; then
    sync_input="${sync_input}, \"knowledgeBranch\": \"${k_branch}\""
  fi
  sync_input="${sync_input}}"

  log_info "步骤 1: 执行 maintenance.sync..."
  local sync_output
  sync_output=$(ad run maintenance/maintenance.sync -i "${sync_input}" --json 2>/dev/null || true)

  if [ -z "${sync_output}" ]; then
    log_error "maintenance.sync 执行失败或未返回输出"
    record_error "${repo_path}" "maintenance.sync returned empty output or failed to execute"
    return 1
  fi

  local sync_status
  sync_status=$(echo "${sync_output}" | node -e "const d=JSON.parse(require('fs').readFileSync(0, 'utf8')); console.log(d.data?.status || d.result?.status || d.status || 'unknown');" 2>/dev/null || echo "unknown")

  case "${sync_status}" in
    success)
      log_info "maintenance.sync 成功完成"
      record_synced "${repo_path}"
      if [ "${ACTION_MODE}" = "sync" ]; then
        log_info "分支同步任务圆满完成 (sync-only)"
        return 0
      fi
      ;;
    dirty_worktree)
      log_warn "工作区存在未提交修改，为保证安全已中止同步: ${repo_path}"
      record_error "${repo_path}" "Working tree is dirty; synchronization aborted"
      return 1
      ;;
    conflict)
      log_info "检测到合并冲突，尝试启动【代码冲突自动自愈】流程..."
      local k_b="${k_branch:-docs}"
      local s_b="${s_branch:-release}"
      
      # 尝试执行 merge 提取未决文件
      (
        cd "${repo_path}"
        git checkout "${k_b}" >/dev/null 2>&1 || true
        git merge "origin/${s_b}" >/dev/null 2>&1 || true
      )

      # 扫描冲突文件
      local raw_conflict_files
      raw_conflict_files=$(cd "${repo_path}" && git diff --name-only --diff-filter=U 2>/dev/null || true)

      local has_doc_conflict=false
      local doc_conflicts=()
      for f in ${raw_conflict_files}; do
        if [[ "${f}" =~ ^docs/knowledge/.*\.md$ ]]; then
          log_warn "发现知识文档冲突文件 (需 Agent 语义合并): ${f}"
          has_doc_conflict=true
          doc_conflicts+=("${f}")
        else
          log_info "自动按生产代码(--theirs)消解业务代码/配置冲突: ${f}"
          (cd "${repo_path}" && git checkout --theirs -- "${f}" >/dev/null 2>&1 && git add -- "${f}" >/dev/null 2>&1 || true)
        fi
      done

      if [ "${has_doc_conflict}" = false ]; then
        (
          cd "${repo_path}"
          git commit -m "chore(merge): auto-resolve code conflicts using origin/${s_b}" >/dev/null 2>&1 || true
          git push origin "${k_b}" >/dev/null 2>&1 || true
        )
        log_info "所有冲突均为代码/配置文件，已全部自动自愈并提交推送完毕！"
        record_synced "${repo_path}"
        if [ "${ACTION_MODE}" = "sync" ]; then
          return 0
        fi
      else
        log_warn "仓库 [${repo_path}] 尚有知识文档冲突未解决，保留冲突标记，等待 Maintainer Agent 介入合意消解: ${doc_conflicts[*]}"
        record_conflict "${repo_path}" "${s_b}" "${k_b}" "${doc_conflicts[@]}"
        return 2
      fi
      ;;
    *)
      log_error "maintenance.sync 遇到错误: ${sync_output}"
      record_error "${repo_path}" "maintenance.sync status: ${sync_status}"
      return 1
      ;;
  esac

  # 2. 执行 maintenance.list 检查变更
  log_info "步骤 2: 执行 maintenance.list..."
  local list_input="{\"path\": \"${repo_path}\""
  if [ -n "${s_branch}" ]; then
    list_input="${list_input}, \"branch\": \"${s_branch}\""
  fi
  list_input="${list_input}}"

  local list_output
  list_output=$(ad run maintenance/maintenance.list -i "${list_input}" --json 2>/dev/null || true)

  if [ -z "${list_output}" ]; then
    log_error "maintenance.list 执行失败或未返回输出"
    return 1
  fi

  local has_changes to_commit commit_count is_initial
  has_changes=$(echo "${list_output}" | node -e "const d=JSON.parse(require('fs').readFileSync(0, 'utf8')); const r=d.data||d.result||d; console.log(Boolean(r.hasChanges));")
  to_commit=$(echo "${list_output}" | node -e "const d=JSON.parse(require('fs').readFileSync(0, 'utf8')); const r=d.data||d.result||d; console.log(r.to || '');")
  commit_count=$(echo "${list_output}" | node -e "const d=JSON.parse(require('fs').readFileSync(0, 'utf8')); const r=d.data||d.result||d; console.log(r.commitCount || 0);")
  is_initial=$(echo "${list_output}" | node -e "const d=JSON.parse(require('fs').readFileSync(0, 'utf8')); const r=d.data||d.result||d; console.log(Boolean(r.initialInventoryRequired));")

  if [ "${has_changes}" != "true" ]; then
    log_info "仓库知识库已与最新提交对齐，无新增变更，跳过后续流程"
    return 0
  fi

  log_info "检测到代码变更: 目标 Commit=${to_commit}, 差异提交数=${commit_count}, 首次全盘盘点=${is_initial}"

  # 3. 触发 Maintainer Agent (若配置)
  if [ -n "${MAINTAINER_AGENT_CMD:-}" ]; then
    log_info "步骤 3: 调度 Maintainer Agent (${MAINTAINER_AGENT_CMD})..."
    ${MAINTAINER_AGENT_CMD} "${repo_path}" "${to_commit}" "${list_output}" || {
      log_warn "Maintainer Agent 处理完成或返回非零状态"
    }
  else
    log_info "步骤 3: 未配置 MAINTAINER_AGENT_CMD，待 Maintainer 统一消费"
  fi

  # 3.5. 检查并自动提交推送知识文档修改 (maintenance.publish)
  local docs_modified=false
  local dirty_status
  dirty_status=$(cd "${repo_path}" && git status --porcelain 2>/dev/null || true)
  if [ -n "${dirty_status}" ]; then
    log_info "检测到知识文档修改，执行 maintenance.publish 提交并推送..."
    local publish_input="{\"path\": \"${repo_path}\", \"message\": \"docs: automated knowledge maintenance update\"}"
    if [ -n "${k_branch}" ]; then
      publish_input="{\"path\": \"${repo_path}\", \"branch\": \"${k_branch}\", \"message\": \"docs: automated knowledge maintenance update\"}"
    elif [ "${r_type}" = "system_knowledge" ]; then
      publish_input="{\"path\": \"${repo_path}\", \"repoType\": \"system_knowledge\", \"branch\": \"${s_branch:-master}\", \"message\": \"docs(system): automated knowledge maintenance update\"}"
    fi
    local publish_output
    publish_output=$(ad run maintenance/maintenance.publish -i "${publish_input}" --json 2>/dev/null || true)
    log_info "maintenance.publish 执行完毕: ${publish_output}"
    docs_modified=true
  fi

  # 4. 推进 maintenance.complete checkpoint
  if [ "${AUTO_COMPLETE}" = true ] && [ "${DRY_RUN}" = false ]; then
    log_info "步骤 4: 推进 maintenance.complete checkpoint 至 ${to_commit}..."
    local action_taken="no_change_needed"
    if [ "${docs_modified}" = "true" ] || [ "${is_initial}" = "true" ]; then
      action_taken="docs_updated"
    fi

    local complete_input="{\"path\": \"${repo_path}\", \"commit\": \"${to_commit}\", \"actionTaken\": \"${action_taken}\", \"summary\": \"Automated maintenance cycle completed\"}"
    local complete_output
    complete_output=$(ad run maintenance/maintenance.complete -i "${complete_input}" --json 2>/dev/null || true)
    log_info "Checkpoint 更新完毕: ${complete_output}"
  fi

  log_info "仓库 ${repo_path} 维护流程圆满完成"
}

# 运行逻辑
cd "${PKG_DIR}"

if [ -n "${TARGET_REPO_PATH}" ]; then
  process_repository "${TARGET_REPO_PATH}" "${REPO_TYPE}" "${SOURCE_BRANCH}" "${KNOWLEDGE_BRANCH}" || true
elif [ -n "${CONFIG_FILE}" ] && [ -f "${CONFIG_FILE}" ]; then
  log_info "读取批量仓库配置: ${CONFIG_FILE}"
  repo_count=$(node -e "const repos=JSON.parse(require('fs').readFileSync('${CONFIG_FILE}','utf8')); console.log(Array.isArray(repos)?repos.length:0);" 2>/dev/null || echo 0)
  for (( i=0; i<repo_count; i++ )); do
    item=$(node -e "const repos=JSON.parse(require('fs').readFileSync('${CONFIG_FILE}','utf8')); console.log(JSON.stringify(repos[$i]));")
    p=$(echo "${item}" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.path || '');")
    t=$(echo "${item}" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.repoType || '');")
    s=$(echo "${item}" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.sourceBranch || '');")
    k=$(echo "${item}" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.knowledgeBranch || '');")
    if [ -n "${p}" ]; then
      process_repository "${p}" "${t}" "${s}" "${k}" || true
    fi
  done
else
  # 检查 WORKSPACE_ROOT
  if [ -n "${WORKSPACE_ROOT:-}" ] && [ -d "${WORKSPACE_ROOT}" ]; then
    log_info "未指定单独仓库，扫描 WORKSPACE_ROOT (${WORKSPACE_ROOT})..."
    for d in "${WORKSPACE_ROOT}"/*; do
      if [ -d "${d}/.git" ]; then
        process_repository "${d}" "" "" "" || true
      fi
    done
  else
    log_error "请通过 --repo-path 指定目标仓库，或通过 --config 指定配置文件，或设置 WORKSPACE_ROOT 环境变量"
    show_help
    exit 1
  fi
fi

# 检查跨仓联动：若系统知识库 (system-knowledge) 存在未提交修改，自动执行 maintenance.publish 提交并推送
check_and_publish_system_knowledge() {
  local sys_repo="${SYSTEM_KNOWLEDGE_PATH:-}"
  if [ -z "${sys_repo}" ] && [ -n "${WORKSPACE_ROOT:-}" ] && [ -d "${WORKSPACE_ROOT}/system-knowledge/.git" ]; then
    sys_repo="${WORKSPACE_ROOT}/system-knowledge"
  fi

  if [ -n "${sys_repo}" ] && [ -d "${sys_repo}/.git" ]; then
    local sys_dirty
    sys_dirty=$(cd "${sys_repo}" && git status --porcelain 2>/dev/null || true)
    if [ -n "${sys_dirty}" ]; then
      log_info "检测到系统知识库 (${sys_repo}) 存在未提交修改，执行 maintenance.publish 自动提交推送..."
      local sys_publish_input="{\"path\": \"${sys_repo}\", \"repoType\": \"system_knowledge\", \"message\": \"docs(system): automated sync from service changes\"}"
      local sys_publish_output
      sys_publish_output=$(ad run maintenance/maintenance.publish -i "${sys_publish_input}" --json 2>/dev/null || true)
      log_info "系统知识库 maintenance.publish 执行完毕: ${sys_publish_output}"
    fi
  fi
}

check_and_publish_system_knowledge

# 生成并打印维护执行汇总报告
final_report=$(node -e "
  const fs = require('fs');
  try {
    const r = JSON.parse(fs.readFileSync('${REPORT_FILE}', 'utf8'));
    const conflictCount = r.conflicts.length;
    const errorCount = r.errors.length;
    const syncedCount = r.synced.length;
    
    let status = 'success';
    if (conflictCount > 0) {
      status = 'conflict';
    } else if (errorCount > 0) {
      status = 'error';
    }
    
    console.log(JSON.stringify({
      status,
      summary: {
        total: syncedCount + conflictCount + errorCount,
        syncedCount,
        conflictCount,
        errorCount
      },
      synced: r.synced,
      conflicts: r.conflicts,
      errors: r.errors
    }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message }));
  }
")

# 将最终格式化报告写回目标文件 (供 Agent 随时查看)
echo "${final_report}" > "${REPORT_FILE}"

echo ""
echo "============================================================"
echo "              KNOWLEDGE MAINTENANCE REPORT"
echo "============================================================"
echo "${final_report}"
echo "============================================================"
log_info "结构化维护报告已保存至容器内路径: ${REPORT_FILE}"
echo ""

conflict_count=$(echo "${final_report}" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.summary?.conflictCount || 0);" 2>/dev/null || echo 0)
error_count=$(echo "${final_report}" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.summary?.errorCount || 0);" 2>/dev/null || echo 0)

if [ "${conflict_count}" -gt 0 ]; then
  log_warn "检测到存在知识文档冲突 (共 ${conflict_count} 个仓库)，退出码: 2"
  exit 2
elif [ "${error_count}" -gt 0 ]; then
  log_error "执行过程中遇到错误 (共 ${error_count} 处)，退出码: 1"
  exit 1
else
  log_info "所有知识库维护调度执行圆满完成，退出码: 0"
  exit 0
fi
