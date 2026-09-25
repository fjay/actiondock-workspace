import fs from "node:fs";
import { defineAction } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { WorkspacePathPolicy } from "../src/path-policy.ts";
import { WorkspaceError, WorkspaceErrorCode } from "../src/errors.ts";

export type Input = ActionInput<"files.delete">;
export type Output = ActionOutput<"files.delete">;

export default defineAction<Input, Output>(async (input, ctx) => {
  const workspaceRoot = ctx.config.get<string>("WORKSPACE_ROOT", process.cwd());
  const pathPolicy = new WorkspacePathPolicy(workspaceRoot);

  if (!input.path || typeof input.path !== "string" || !input.path.trim()) {
    throw new WorkspaceError(
      "File or directory path must not be empty",
      WorkspaceErrorCode.INVALID_ARGUMENT,
      400
    );
  }

  const recursive = input.recursive === true;
  const ignoreIfNotExists = input.ignoreIfNotExists === true;

  const resolved = pathPolicy.resolveAndValidate(input.path, {
    allowNonExistent: true,
  });

  if (
    !resolved.relativePath ||
    resolved.absolutePath === pathPolicy.root ||
    resolved.realPath === pathPolicy.realRoot
  ) {
    throw new WorkspaceError(
      "Cannot delete workspace root directory",
      WorkspaceErrorCode.CANNOT_DELETE_ROOT,
      400
    );
  }

  let exists = false;
  let isDirectory = false;
  try {
    const lstat = fs.lstatSync(resolved.absolutePath);
    exists = true;
    isDirectory = lstat.isDirectory();
  } catch {
    exists = false;
  }

  if (!exists) {
    if (ignoreIfNotExists) {
      return {
        path: resolved.relativePath,
        deleted: false,
        isDirectory: false,
      };
    }
    throw new WorkspaceError(
      `File or directory does not exist: ${resolved.relativePath}`,
      WorkspaceErrorCode.FILE_NOT_FOUND,
      404
    );
  }

  if (isDirectory && !recursive) {
    throw new WorkspaceError(
      `Cannot delete directory without recursive option: ${resolved.relativePath}`,
      WorkspaceErrorCode.PATH_IS_DIRECTORY,
      400
    );
  }

  if (ctx.signal?.aborted) {
    throw new Error("Delete operation aborted by caller");
  }

  if (isDirectory) {
    fs.rmSync(resolved.absolutePath, { recursive: true, force: true });
  } else {
    fs.rmSync(resolved.absolutePath, { force: true });
  }

  return {
    path: resolved.relativePath,
    deleted: true,
    isDirectory,
  };
});
