import { defineAction, encodeStateKey } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { GitClient } from "../src/git.ts";
import {
  resolveRepoPath,
  getRepoIdentifier,
  parseGitLog,
  parseDiffStat,
} from "../src/repo-utils.ts";
import { MaintenanceError } from "../src/errors.ts";

export type Input = ActionInput<"maintenance.list">;
export type Output = ActionOutput<"maintenance.list">;

export default defineAction<Input, Output>(async (input, ctx) => {
  ctx.log.info("Starting maintenance.list", { path: input.path, branch: input.branch });

  const resolvedPath = resolveRepoPath(input.path);
  const timeoutMs = ctx.config.get<number>("GIT_TIMEOUT_MS", 30000);
  const maxOutputBytes = ctx.config.get<number>("GIT_MAX_OUTPUT_BYTES", 4 * 1024 * 1024);
  const git = new GitClient(ctx, resolvedPath, timeoutMs, maxOutputBytes);

  const isWorkTree = await git.isInsideWorkTree();
  if (!isWorkTree) {
    throw new MaintenanceError(
      `Path is not a valid git repository: ${resolvedPath}`,
      "INVALID_REPO",
      400
    );
  }

  // 1. Determine target branch
  let targetBranch = input.branch;
  if (!targetBranch) {
    const branches = await git.listBranchNames();
    if (branches.some((b) => b === "release" || b === "origin/release")) {
      targetBranch = "release";
    } else {
      targetBranch = "master";
    }
  }

  // 2. Resolve target branch HEAD commit
  const toCommit = await git.getHeadCommit(targetBranch);
  const repoName = await getRepoIdentifier(git, resolvedPath);

  // 3. Read checkpoint from ctx.state
  const stateKey = encodeStateKey("checkpoints", repoName);
  let savedState = await ctx.state.get<any>(stateKey);

  // Fallback to unnamespaced key if needed
  if (!savedState) {
    savedState = await ctx.state.get<any>(repoName);
  }

  let fromCommit: string | null = null;
  if (typeof savedState === "string") {
    fromCommit = savedState;
  } else if (savedState && typeof savedState.commit === "string") {
    fromCommit = savedState.commit;
  }

  ctx.log.info("Inspecting repository maintenance status", {
    repo: repoName,
    branch: targetBranch,
    from: fromCommit,
    to: toCommit,
  });

  // Strategy B: No prior checkpoint found -> full initial inventory required
  if (!fromCommit) {
    ctx.log.info(`No prior checkpoint found for repository ${repoName}; initial inventory needed`);
    const countRes = await git.run(["rev-list", "--count", toCommit]);
    const totalCommits = parseInt(countRes.stdout.trim() || "0", 10);

    return {
      hasChanges: true,
      path: resolvedPath,
      repo: repoName,
      branch: targetBranch,
      from: null,
      to: toCommit,
      commitCount: totalCommits,
      initialInventoryRequired: true,
      commits: [],
      message: `Initial maintenance check: no checkpoint found in state, full inventory required (${totalCommits} total commits in branch)`,
    };
  }

  // Checkpoint matches current HEAD -> no pending changes
  if (fromCommit === toCommit) {
    ctx.log.info(`Repository ${repoName} is already up to date at checkpoint ${fromCommit}`);
    return {
      hasChanges: false,
      path: resolvedPath,
      repo: repoName,
      branch: targetBranch,
      from: fromCommit,
      to: toCommit,
      commitCount: 0,
      initialInventoryRequired: false,
      commits: [],
      changedFilesSummary: {
        summaryText: "0 files changed",
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        files: [],
      },
      message: "Repository is up to date with last checked commit",
    };
  }

  // Checkpoint differs from HEAD -> compute diff and commits
  ctx.log.info(`Fetching commits and file diff between ${fromCommit} and ${toCommit}...`);

  const logRes = await git.run([
    "log",
    "--pretty=format:%H%x09%h%x09%an <%ae>%x09%aI%x09%s",
    `${fromCommit}..${toCommit}`,
  ]);
  const commits = parseGitLog(logRes.stdout);

  const diffRes = await git.run(["diff", "--stat", `${fromCommit}..${toCommit}`]);
  const changedFilesSummary = parseDiffStat(diffRes.stdout);

  const commitCount = commits.length > 0 ? commits.length : 1;

  ctx.log.info(`Found ${commitCount} new commit(s) in ${repoName}`);

  return {
    hasChanges: true,
    path: resolvedPath,
    repo: repoName,
    branch: targetBranch,
    from: fromCommit,
    to: toCommit,
    commitCount,
    initialInventoryRequired: false,
    commits,
    changedFilesSummary,
    message: `Found ${commitCount} new commit(s) since last checkpoint`,
  };
});
