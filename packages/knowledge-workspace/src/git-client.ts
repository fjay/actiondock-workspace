import type { ActionContext } from "@actiondock/sdk";
import { decodeText } from "@actiondock/sdk";
import { WorkspaceError, WorkspaceErrorCode } from "./errors.ts";
import { DEFAULT_GIT_TIMEOUT_MS, DEFAULT_GIT_MAX_OUTPUT_BYTES } from "./limits.ts";

export interface GitExecOptions {
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  env?: Record<string, string> | undefined;
}

export interface GitExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export class GitClient {
  private readonly ctx: ActionContext;
  private readonly defaultCwd: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxOutputBytes: number;

  constructor(
    ctx: ActionContext,
    defaultCwd: string,
    defaultTimeoutMs: number = DEFAULT_GIT_TIMEOUT_MS,
    defaultMaxOutputBytes: number = DEFAULT_GIT_MAX_OUTPUT_BYTES
  ) {
    this.ctx = ctx;
    this.defaultCwd = defaultCwd;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.defaultMaxOutputBytes = defaultMaxOutputBytes;
  }

  async run(args: string[], options?: GitExecOptions): Promise<GitExecResult> {
    const cwd = options?.cwd ?? this.defaultCwd;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const maxOutputBytes = options?.maxOutputBytes ?? this.defaultMaxOutputBytes;

    if (this.ctx.signal.aborted) {
      throw new Error("Git operation aborted by caller");
    }

    this.ctx.log.debug(`Executing: git ${args.join(" ")} in ${cwd}`);

    const res = await this.ctx.process.run(
      {
        spec: {
          executable: "git",
          args,
          cwd,
          env: {
            inherit: "allowlisted",
            set: {
              GIT_TERMINAL_PROMPT: "0",
              GIT_MERGE_AUTOEDIT: "no",
              ...(options?.env ?? {}),
            },
          },
          io: { mode: "pipe" },
        },
        timeoutMs,
        maxOutputBytes,
      },
      { signal: this.ctx.signal }
    );

    const stdout = decodeText(res.chunks.filter((c) => c.stream === "stdout"));
    const stderr = decodeText(res.chunks.filter((c) => c.stream === "stderr"));

    return {
      code: res.exit.code,
      signal: res.exit.signal,
      stdout,
      stderr,
    };
  }

  async isInsideWorkTree(cwd?: string): Promise<boolean> {
    try {
      const res = await this.run(["rev-parse", "--is-inside-work-tree"], { cwd });
      return res.code === 0 && res.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async getRepoRoot(cwd?: string): Promise<string> {
    const res = await this.run(["rev-parse", "--show-toplevel"], { cwd });
    if (res.code !== 0) {
      throw new WorkspaceError(
        `Failed to resolve Git repository root: ${res.stderr.trim() || res.stdout.trim()}`,
        WorkspaceErrorCode.GIT_ERROR,
        500
      );
    }
    return res.stdout.trim();
  }

  async isTracked(relativePath: string, cwd?: string): Promise<boolean> {
    try {
      const res = await this.run(["ls-files", "--error-unmatch", relativePath], { cwd });
      return res.code === 0;
    } catch {
      return false;
    }
  }
}
