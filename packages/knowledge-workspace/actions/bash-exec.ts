import fs from "node:fs";
import path from "node:path";
import { defineAction, decodeText } from "@actiondock/sdk";
import type { ActionInput, ActionOutput } from "../.actiondock/generated/actions.d.ts";
import { WorkspaceError, WorkspaceErrorCode } from "../src/errors.ts";

export type Input = ActionInput<"bash.exec">;
export type Output = ActionOutput<"bash.exec">;

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB

function resolveBashExecutable(): string {
  if (fs.existsSync("/bin/bash")) {
    return "/bin/bash";
  }
  if (fs.existsSync("/usr/bin/bash")) {
    return "/usr/bin/bash";
  }
  return "bash";
}

export default defineAction<Input, Output>(async (input, ctx) => {
  const command = input.command?.trim();
  if (!command) {
    throw new WorkspaceError(
      "Command must not be empty",
      WorkspaceErrorCode.INVALID_ARGUMENT,
      400
    );
  }

  const configuredRoot = ctx.config.get<string>("WORKSPACE_ROOT", process.cwd());
  const workspaceRoot = fs.existsSync(configuredRoot) ? configuredRoot : process.cwd();
  const cwd = input.cwd ? path.resolve(workspaceRoot, input.cwd) : workspaceRoot;

  if (!fs.existsSync(cwd)) {
    throw new WorkspaceError(
      `Working directory does not exist: ${cwd}`,
      WorkspaceErrorCode.DIRECTORY_NOT_FOUND,
      404
    );
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await ctx.process.run(
    {
      spec: {
        executable: resolveBashExecutable(),
        args: ["-c", command],
        cwd,
        env: {
          inherit: "allowlisted",
          set: {
            PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
            GIT_TERMINAL_PROMPT: "0",
            GIT_MERGE_AUTOEDIT: "no",
          },
        },
        io: { mode: "pipe" },
      },
      timeoutMs,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    },
    { signal: ctx.signal }
  );

  const content = decodeText(res.chunks);

  return {
    exitCode: res.exit.code,
    content,
    truncated: res.truncated,
  };
});
