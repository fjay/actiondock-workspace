import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { GitClient } from "../src/git.ts";
import { resolveRepoPath, detectRepoType } from "../src/repo-utils.ts";

export type Input = ActionInput<"maintenance.sync">;
export type Output = ActionOutput<"maintenance.sync">;

export default defineAction<Input, Output>(async (input, ctx) => {
  ctx.log.info("Starting maintenance.sync", { path: input.path });

  let resolvedPath: string;
  try {
    resolvedPath = resolveRepoPath(input.path);
  } catch (err: any) {
    ctx.log.error("Failed to resolve repository path", { error: err.message });
    return {
      status: "error",
      path: input.path,
      repoType: input.repoType ?? "code",
      message: err.message,
    };
  }

  const timeoutMs = ctx.config.get<number>("GIT_TIMEOUT_MS", 30000);
  const maxOutputBytes = ctx.config.get<number>("GIT_MAX_OUTPUT_BYTES", 4 * 1024 * 1024);
  const git = new GitClient(ctx, resolvedPath, timeoutMs, maxOutputBytes);

  // 1. Validate git repository
  const isWorkTree = await git.isInsideWorkTree();
  if (!isWorkTree) {
    ctx.log.error("Target path is not a valid git repository", { path: resolvedPath });
    return {
      status: "error",
      path: resolvedPath,
      repoType: input.repoType ?? "code",
      message: `Path is not a valid git repository: ${resolvedPath}`,
    };
  }

  // 2. Check clean worktree
  const dirtyFiles = await git.getPorcelainStatus();
  if (dirtyFiles.length > 0) {
    ctx.log.warn("Working tree has uncommitted modifications; aborting sync", {
      dirtyCount: dirtyFiles.length,
      files: dirtyFiles,
    });
    return {
      status: "dirty_worktree",
      path: resolvedPath,
      repoType: input.repoType ?? "code",
      uncommittedFiles: dirtyFiles,
      message: "Working tree is dirty; synchronization aborted to prevent uncommitted changes from being lost",
    };
  }

  // 3. Resolve repository type and branch configurations
  const repoType = input.repoType ?? (await detectRepoType(git, input.knowledgeBranch));
  const sourceBranch = input.sourceBranch ?? (repoType === "code" ? "release" : "master");
  const knowledgeBranch = repoType === "code" ? (input.knowledgeBranch ?? "docs") : undefined;

  ctx.log.info(`Syncing repository (${repoType})`, {
    resolvedPath,
    repoType,
    sourceBranch,
    ...(knowledgeBranch ? { knowledgeBranch } : {}),
  });

  // 4. Fetch origin (Blobless Partial Fetch with automatic fallback)
  const defaultBlobless = ctx.config.get<boolean>("GIT_BLOBLESS_FETCH", true);
  const useBlobless = input.filterBlobNone ?? defaultBlobless;
  ctx.log.info(`Fetching from remote origin (blobless: ${useBlobless})...`);
  const fetchResult = await git.fetchOrigin({ filterBlobNone: useBlobless });
  if (fetchResult.code !== 0) {
    const errorMsg = fetchResult.stderr.trim() || fetchResult.stdout.trim() || "git fetch origin failed";
    ctx.log.error("git fetch origin failed", { error: errorMsg });
    return {
      status: "error",
      path: resolvedPath,
      repoType,
      sourceBranch,
      ...(knowledgeBranch ? { knowledgeBranch } : {}),
      message: `Failed to fetch from remote origin: ${errorMsg}`,
    };
  }

  // 5A. Single branch / system knowledge repository
  if (repoType === "system_knowledge") {
    ctx.log.info(`Switching to ${sourceBranch} for system_knowledge sync...`);
    const localBranchExists = await git.refExists(`refs/heads/${sourceBranch}`);
    if (localBranchExists) {
      const checkoutRes = await git.run(["checkout", sourceBranch]);
      if (checkoutRes.code !== 0) {
        return {
          status: "error",
          path: resolvedPath,
          repoType,
          sourceBranch,
          message: `Failed to checkout ${sourceBranch}: ${checkoutRes.stderr.trim()}`,
        };
      }
    } else {
      const checkoutRes = await git.run(["checkout", "-B", sourceBranch, `origin/${sourceBranch}`]);
      if (checkoutRes.code !== 0) {
        return {
          status: "error",
          path: resolvedPath,
          repoType,
          sourceBranch,
          message: `Failed to checkout ${sourceBranch} from origin/${sourceBranch}: ${checkoutRes.stderr.trim()}`,
        };
      }
    }

    ctx.log.info(`Fast-forward merging origin/${sourceBranch}...`);
    const mergeRes = await git.run(["merge", "--ff-only", `origin/${sourceBranch}`]);
    if (mergeRes.code !== 0) {
      const err = mergeRes.stderr.trim() || mergeRes.stdout.trim();
      ctx.log.error("Fast-forward merge failed", { error: err });
      return {
        status: "error",
        path: resolvedPath,
        repoType,
        sourceBranch,
        message: `Fast-forward merge failed for origin/${sourceBranch}: ${err}`,
      };
    }

    const currentCommit = await git.getHeadCommit();
    ctx.log.info(`Successfully synced ${sourceBranch} to ${currentCommit}`);

    return {
      status: "success",
      path: resolvedPath,
      repoType,
      sourceBranch,
      currentCommit,
      message: `Successfully synchronized system knowledge branch '${sourceBranch}' via fast-forward merge`,
    };
  }

  // 5B. Dual-branch code repository (release -> docs)
  const docsBranch = knowledgeBranch!;
  const remoteDocsExists = await git.refExists(`origin/${docsBranch}`);

  if (!remoteDocsExists) {
    ctx.log.info(`Remote branch origin/${docsBranch} does not exist. Initializing from origin/${sourceBranch}...`);
    const localDocsExists = await git.refExists(`refs/heads/${docsBranch}`);
    if (localDocsExists) {
      await git.run(["checkout", docsBranch]);
    } else {
      const checkoutRes = await git.run(["checkout", "-b", docsBranch, `origin/${sourceBranch}`]);
      if (checkoutRes.code !== 0) {
        return {
          status: "error",
          path: resolvedPath,
          repoType,
          sourceBranch,
          knowledgeBranch: docsBranch,
          message: `Failed to create local ${docsBranch} branch: ${checkoutRes.stderr.trim()}`,
        };
      }
    }

    ctx.log.info(`Pushing newly created ${docsBranch} to origin...`);
    const pushRes = await git.run(["push", "origin", docsBranch]);
    if (pushRes.code !== 0) {
      return {
        status: "error",
        path: resolvedPath,
        repoType,
        sourceBranch,
        knowledgeBranch: docsBranch,
        message: `Failed to push initialized ${docsBranch} to origin: ${pushRes.stderr.trim()}`,
      };
    }

    const currentCommit = await git.getHeadCommit();
    return {
      status: "success",
      path: resolvedPath,
      repoType,
      sourceBranch,
      knowledgeBranch: docsBranch,
      currentCommit,
      initializedBranch: true,
      message: `Initialized knowledge branch '${docsBranch}' from 'origin/${sourceBranch}' and pushed to remote origin`,
    };
  }

  // Remote docs branch exists: switch and fast-forward local docs if needed
  ctx.log.info(`Switching to knowledge branch ${docsBranch}...`);
  const localDocsExists = await git.refExists(`refs/heads/${docsBranch}`);
  if (localDocsExists) {
    const checkoutRes = await git.run(["checkout", docsBranch]);
    if (checkoutRes.code !== 0) {
      return {
        status: "error",
        path: resolvedPath,
        repoType,
        sourceBranch,
        knowledgeBranch: docsBranch,
        message: `Failed to checkout ${docsBranch}: ${checkoutRes.stderr.trim()}`,
      };
    }
    // Bring local docs up to date with origin/docs
    await git.run(["merge", "--ff-only", `origin/${docsBranch}`]);
  } else {
    const checkoutRes = await git.run(["checkout", "-b", docsBranch, `origin/${docsBranch}`]);
    if (checkoutRes.code !== 0) {
      return {
        status: "error",
        path: resolvedPath,
        repoType,
        sourceBranch,
        knowledgeBranch: docsBranch,
        message: `Failed to checkout ${docsBranch} tracking origin/${docsBranch}: ${checkoutRes.stderr.trim()}`,
      };
    }
  }

  // Merge origin/<sourceBranch> into knowledgeBranch
  ctx.log.info(`Merging origin/${sourceBranch} into ${docsBranch}...`);
  const mergeRes = await git.run(["merge", "--no-edit", `origin/${sourceBranch}`]);

  if (mergeRes.code !== 0) {
    ctx.log.warn(`Merge conflict detected while merging origin/${sourceBranch} into ${docsBranch}`);

    // Read conflict files before aborting merge
    const statusRes = await git.run(["status", "--porcelain"]);
    const conflictFiles = statusRes.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(UU|AA|UD|DU|DD|AU|UA)/.test(line))
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

    ctx.log.info("Safely aborting merge via git merge --abort...");
    await git.run(["merge", "--abort"]);

    return {
      status: "conflict",
      path: resolvedPath,
      repoType,
      sourceBranch,
      knowledgeBranch: docsBranch,
      conflictFiles: conflictFiles.length > 0 ? conflictFiles : ["(conflicting files undetected)"],
      message: `Merge conflict detected while merging origin/${sourceBranch} into ${docsBranch}; merge was safely aborted`,
    };
  }

  // Push merged knowledge branch to remote origin
  ctx.log.info(`Pushing updated ${docsBranch} to origin...`);
  const pushRes = await git.run(["push", "origin", docsBranch]);
  if (pushRes.code !== 0) {
    return {
      status: "error",
      path: resolvedPath,
      repoType,
      sourceBranch,
      knowledgeBranch: docsBranch,
      message: `Merged origin/${sourceBranch} but failed to push ${docsBranch} to origin: ${pushRes.stderr.trim()}`,
    };
  }

  const currentCommit = await git.getHeadCommit();
  ctx.log.info(`Successfully merged origin/${sourceBranch} into ${docsBranch} at ${currentCommit}`);

  return {
    status: "success",
    path: resolvedPath,
    repoType,
    sourceBranch,
    knowledgeBranch: docsBranch,
    currentCommit,
    initializedBranch: false,
    message: `Successfully synchronized '${sourceBranch}' into '${docsBranch}' and pushed to remote origin`,
  };
});
