import path from "node:path";
import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { WorkspacePathPolicy } from "../src/path-policy.ts";
import { WorkspaceError, WorkspaceErrorCode } from "../src/errors.ts";
import { isSensitivePath } from "../src/file-policy.ts";
import { GitClient } from "../src/git-client.ts";
import {
  DEFAULT_DIFF_MAX_LINES,
  MAX_DIFF_LINES,
  DEFAULT_DIFF_MAX_BYTES,
  MAX_DIFF_BYTES,
} from "../src/limits.ts";

export type Input = ActionInput<"git.diff">;
export type Output = ActionOutput<"git.diff">;

export default defineAction<Input, Output>(async (input, ctx) => {
  const workspaceRoot = ctx.config.get<string>("WORKSPACE_ROOT", process.cwd());
  const pathPolicy = new WorkspacePathPolicy(workspaceRoot);

  const staged = input.staged === true;
  const statOnly = input.statOnly === true;

  const maxLines =
    input.maxLines !== undefined
      ? Math.min(Math.max(1, Math.floor(input.maxLines)), MAX_DIFF_LINES)
      : DEFAULT_DIFF_MAX_LINES;

  const maxBytes =
    input.maxBytes !== undefined
      ? Math.min(Math.max(1, Math.floor(input.maxBytes)), MAX_DIFF_BYTES)
      : DEFAULT_DIFF_MAX_BYTES;

  let checkDir = pathPolicy.root;
  let targetRelPosix: string | undefined;

  if (input.path && input.path.trim()) {
    const resolved = pathPolicy.resolveAndValidate(input.path, {
      allowNonExistent: true,
    });
    targetRelPosix = resolved.relativePath;
    checkDir = resolved.stat?.isDirectory()
      ? resolved.absolutePath
      : path.dirname(resolved.absolutePath);
  }

  const gitClient = new GitClient(ctx, checkDir);
  const isGitRepo = await gitClient.isInsideWorkTree(checkDir);

  if (!isGitRepo) {
    return {
      isGitRepo: false,
      clean: true,
      diff: "",
      truncated: false,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    };
  }

  const repoRoot = await gitClient.getRepoRoot(checkDir);

  let gitPathArg: string | undefined;
  if (targetRelPosix) {
    const targetAbs = path.resolve(pathPolicy.root, targetRelPosix);
    const gitRel = path.relative(repoRoot, targetAbs).split(path.sep).join("/");
    gitPathArg = gitRel;
  }

  // 1. Get statistics via git diff --numstat
  const numstatArgs = ["diff", "--numstat"];
  if (staged) {
    numstatArgs.push("--staged");
  }
  if (gitPathArg) {
    numstatArgs.push("--", gitPathArg);
  }

  const numstatRes = await gitClient.run(numstatArgs, { cwd: repoRoot });
  if (numstatRes.code !== 0) {
    throw new WorkspaceError(
      `git diff --numstat failed: ${numstatRes.stderr.trim() || numstatRes.stdout.trim()}`,
      WorkspaceErrorCode.GIT_ERROR,
      500
    );
  }

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  const numstatLines = numstatRes.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of numstatLines) {
    const parts = line.split("\t");
    if (parts.length >= 3) {
      const insStr = parts[0];
      const delStr = parts[1];
      const fileRel = parts.slice(2).join("\t");

      const fileAbs = path.resolve(repoRoot, fileRel);
      const relPosix = pathPolicy.toRelativePath(fileAbs);
      if (isSensitivePath(relPosix)) {
        continue;
      }

      filesChanged++;
      if (insStr !== "-") {
        insertions += parseInt(insStr, 10) || 0;
      }
      if (delStr !== "-") {
        deletions += parseInt(delStr, 10) || 0;
      }
    }
  }

  // 2. Get diff text
  const diffArgs = ["diff"];
  if (staged) {
    diffArgs.push("--staged");
  }
  if (statOnly) {
    diffArgs.push("--stat");
  }
  if (gitPathArg) {
    diffArgs.push("--", gitPathArg);
  }

  const diffRes = await gitClient.run(diffArgs, { cwd: repoRoot });
  if (diffRes.code !== 0) {
    throw new WorkspaceError(
      `git diff failed: ${diffRes.stderr.trim() || diffRes.stdout.trim()}`,
      WorkspaceErrorCode.GIT_ERROR,
      500
    );
  }

  let rawDiff = diffRes.stdout;

  // Filter sensitive files from diff output
  if (!statOnly) {
    const chunks = rawDiff.split(/(?=^diff --git )/m);
    const filteredChunks: string[] = [];
    for (const chunk of chunks) {
      if (!chunk.startsWith("diff --git ")) {
        filteredChunks.push(chunk);
        continue;
      }
      const firstLine = chunk.split("\n")[0] || "";
      const match = firstLine.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (match) {
        const pathA = match[1];
        const pathB = match[2];
        const relA = pathPolicy.toRelativePath(path.resolve(repoRoot, pathA));
        const relB = pathPolicy.toRelativePath(path.resolve(repoRoot, pathB));
        if (isSensitivePath(relA) || isSensitivePath(relB)) {
          continue;
        }
      }
      filteredChunks.push(chunk);
    }
    rawDiff = filteredChunks.join("");
  } else {
    const lines = rawDiff.split("\n");
    const filteredLines = lines.filter((l) => {
      const trimmed = l.trim();
      if (!trimmed) return true;
      const parts = trimmed.split("|");
      if (parts.length >= 2) {
        const fileRel = parts[0].trim();
        const rel = pathPolicy.toRelativePath(path.resolve(repoRoot, fileRel));
        if (isSensitivePath(rel)) return false;
      }
      return true;
    });
    rawDiff = filteredLines.join("\n");
  }

  // Budget checks: lines and bytes
  let diffText = rawDiff;
  let truncated = false;

  const lines = diffText.split("\n");
  if (lines.length > maxLines) {
    diffText = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }

  const buf = Buffer.from(diffText, "utf8");
  if (buf.byteLength > maxBytes) {
    diffText = buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
    truncated = true;
  }

  const clean =
    filesChanged === 0 &&
    insertions === 0 &&
    deletions === 0 &&
    diffText.trim().length === 0;

  return {
    isGitRepo: true,
    clean,
    diff: diffText,
    truncated,
    filesChanged,
    insertions,
    deletions,
  };
});
