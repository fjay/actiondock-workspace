import fs from "node:fs";
import path from "node:path";
import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { WorkspacePathPolicy } from "../src/path-policy.ts";
import { WorkspaceError, WorkspaceErrorCode } from "../src/errors.ts";
import { GitClient } from "../src/git-client.ts";

export type Input = ActionInput<"files.move">;
export type Output = ActionOutput<"files.move">;

export default defineAction<Input, Output>(async (input, ctx) => {
  const workspaceRoot = ctx.config.get<string>("WORKSPACE_ROOT", process.cwd());
  const pathPolicy = new WorkspacePathPolicy(workspaceRoot);

  if (!input.from || typeof input.from !== "string" || !input.from.trim()) {
    throw new WorkspaceError(
      "Source path must not be empty",
      WorkspaceErrorCode.INVALID_ARGUMENT,
      400
    );
  }

  if (!input.to || typeof input.to !== "string" || !input.to.trim()) {
    throw new WorkspaceError(
      "Destination path must not be empty",
      WorkspaceErrorCode.INVALID_ARGUMENT,
      400
    );
  }

  const overwrite = input.overwrite === true;

  const resolvedFrom = pathPolicy.resolveAndValidate(input.from);
  if (
    !resolvedFrom.relativePath ||
    resolvedFrom.absolutePath === pathPolicy.root ||
    resolvedFrom.realPath === pathPolicy.realRoot
  ) {
    throw new WorkspaceError(
      "Cannot move workspace root directory",
      WorkspaceErrorCode.INVALID_ARGUMENT,
      400
    );
  }

  const resolvedTo = pathPolicy.resolveAndValidate(input.to, {
    allowNonExistent: true,
  });
  if (
    !resolvedTo.relativePath ||
    resolvedTo.absolutePath === pathPolicy.root ||
    resolvedTo.realPath === pathPolicy.realRoot
  ) {
    throw new WorkspaceError(
      "Cannot move to workspace root directory",
      WorkspaceErrorCode.INVALID_ARGUMENT,
      400
    );
  }

  if (resolvedFrom.absolutePath === resolvedTo.absolutePath) {
    return {
      from: resolvedFrom.relativePath,
      to: resolvedTo.relativePath,
      gitTracked: false,
    };
  }

  if (resolvedFrom.stat?.isDirectory()) {
    if (resolvedTo.absolutePath.startsWith(resolvedFrom.absolutePath + path.sep)) {
      throw new WorkspaceError(
        "Cannot move a directory into itself or its child directory",
        WorkspaceErrorCode.INVALID_ARGUMENT,
        400
      );
    }
  }

  const toExists = fs.existsSync(resolvedTo.absolutePath);
  if (toExists && !overwrite) {
    throw new WorkspaceError(
      `Destination path already exists and overwrite is false: ${resolvedTo.relativePath}`,
      WorkspaceErrorCode.FILE_ALREADY_EXISTS,
      409
    );
  }

  const parentDir = path.dirname(resolvedTo.absolutePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  if (ctx.signal?.aborted) {
    throw new Error("Move operation aborted by caller");
  }

  const gitClient = new GitClient(ctx, pathPolicy.root);
  const isGitRepo = await gitClient.isInsideWorkTree();
  let gitTracked = false;

  if (isGitRepo) {
    const isTracked = await gitClient.isTracked(resolvedFrom.relativePath);
    if (isTracked) {
      const mvArgs = ["mv"];
      if (overwrite) {
        mvArgs.push("-f");
      }
      mvArgs.push(resolvedFrom.relativePath, resolvedTo.relativePath);
      const mvRes = await gitClient.run(mvArgs);
      if (mvRes.code === 0) {
        gitTracked = true;
      }
    }
  }

  if (!gitTracked) {
    if (toExists && overwrite) {
      fs.rmSync(resolvedTo.absolutePath, { recursive: true, force: true });
    }
    fs.renameSync(resolvedFrom.absolutePath, resolvedTo.absolutePath);
  }

  return {
    from: resolvedFrom.relativePath,
    to: resolvedTo.relativePath,
    gitTracked,
  };
});
