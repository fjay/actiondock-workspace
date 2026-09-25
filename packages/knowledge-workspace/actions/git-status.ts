import path from "node:path";
import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { WorkspacePathPolicy } from "../src/path-policy.ts";
import { WorkspaceError, WorkspaceErrorCode } from "../src/errors.ts";
import { isSensitivePath } from "../src/file-policy.ts";
import { GitClient } from "../src/git-client.ts";

export type Input = ActionInput<"git.status">;
export type Output = ActionOutput<"git.status">;

export default defineAction<Input, Output>(async (input, ctx) => {
  const workspaceRoot = ctx.config.get<string>("WORKSPACE_ROOT", process.cwd());
  const pathPolicy = new WorkspacePathPolicy(workspaceRoot);

  const targetPath = input.path ?? "";
  const resolved = pathPolicy.resolveAndValidate(targetPath);

  if (!resolved.stat || !resolved.stat.isDirectory()) {
    throw new WorkspaceError(
      `Target path is not a directory: ${targetPath}`,
      WorkspaceErrorCode.NOT_A_DIRECTORY,
      400
    );
  }

  const gitClient = new GitClient(ctx, resolved.absolutePath);
  const isGitRepo = await gitClient.isInsideWorkTree(resolved.absolutePath);

  if (!isGitRepo) {
    return {
      isGitRepo: false,
      branch: "",
      clean: true,
      staged: [],
      unstaged: [],
      untracked: [],
    };
  }

  const repoRoot = await gitClient.getRepoRoot(resolved.absolutePath);

  const statusRes = await gitClient.run(["status", "--porcelain=v1", "-b"], {
    cwd: resolved.absolutePath,
  });

  if (statusRes.code !== 0) {
    throw new WorkspaceError(
      `git status failed: ${statusRes.stderr.trim() || statusRes.stdout.trim()}`,
      WorkspaceErrorCode.GIT_ERROR,
      500
    );
  }

  const lines = statusRes.stdout
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);

  let branch = "";
  if (lines.length > 0 && lines[0].startsWith("## ")) {
    const branchPart = lines[0].slice(3).trim();
    if (
      branchPart.startsWith("Initial commit on ") ||
      branchPart.startsWith("No commits yet on ")
    ) {
      branch = branchPart.split(" on ")[1]?.trim() || "";
    } else if (branchPart.startsWith("HEAD (no branch)")) {
      branch = "HEAD";
    } else {
      const dotsIndex = branchPart.indexOf("...");
      if (dotsIndex !== -1) {
        branch = branchPart.slice(0, dotsIndex).trim();
      } else {
        const spaceIndex = branchPart.indexOf(" ");
        if (spaceIndex !== -1) {
          branch = branchPart.slice(0, spaceIndex).trim();
        } else {
          branch = branchPart;
        }
      }
    }
  }

  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  const fileLines = lines.length > 0 && lines[0].startsWith("## ") ? lines.slice(1) : lines;

  for (const line of fileLines) {
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    let rawPath = line.slice(3).trim();

    if (rawPath.includes(" -> ")) {
      const parts = rawPath.split(" -> ");
      rawPath = parts[1] || parts[0];
    }
    if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
      rawPath = rawPath.slice(1, -1);
    }

    const absPath = path.resolve(repoRoot, rawPath);
    const relPosix = pathPolicy.toRelativePath(absPath);

    if (isSensitivePath(relPosix)) {
      continue;
    }

    if (resolved.relativePath) {
      if (
        relPosix !== resolved.relativePath &&
        !relPosix.startsWith(resolved.relativePath + "/")
      ) {
        continue;
      }
    }

    if (x === "?" && y === "?") {
      untracked.push(relPosix);
    } else if (x === "!" && y === "!") {
      continue;
    } else {
      if (x !== " " && x !== "?") {
        staged.push(relPosix);
      }
      if (y !== " " && y !== "?") {
        unstaged.push(relPosix);
      }
    }
  }

  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;

  return {
    isGitRepo: true,
    branch,
    clean,
    staged,
    unstaged,
    untracked,
  };
});
