import fs from "node:fs";
import path from "node:path";
import type { ActionContext } from "@actiondock/sdk";
import { decodeText } from "@actiondock/sdk";
import { MaintenanceError } from "./errors.ts";
import { DEFAULT_GIT_TIMEOUT_MS, DEFAULT_GIT_MAX_OUTPUT_BYTES } from "./limits.ts";

export interface GitRunnerOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

export interface GitCloneOptions {
  filterBlobNone?: boolean | undefined;
  branch?: string | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
}

export interface GitExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  raw: string;
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

  async run(args: string[], options?: GitRunnerOptions): Promise<GitExecResult> {
    const cwd = options?.cwd ?? this.defaultCwd;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const maxOutputBytes = options?.maxOutputBytes ?? this.defaultMaxOutputBytes;

    if (this.ctx.signal.aborted) {
      throw new MaintenanceError("Git operation aborted by caller", "OPERATION_ABORTED", 499);
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

    const stdoutChunks = res.chunks.filter((c) => c.stream === "stdout");
    const stderrChunks = res.chunks.filter((c) => c.stream === "stderr");
    const stdout = decodeText(stdoutChunks);
    const stderr = decodeText(stderrChunks);
    const raw = decodeText(res.chunks);

    return {
      code: res.exit.code,
      signal: res.exit.signal,
      stdout,
      stderr,
      raw,
    };
  }

  async isInsideWorkTree(): Promise<boolean> {
    const res = await this.run(["rev-parse", "--is-inside-work-tree"]);
    return res.code === 0 && res.stdout.trim() === "true";
  }

  async getPorcelainStatus(): Promise<string[]> {
    const res = await this.run(["status", "--porcelain"]);
    if (res.code !== 0) {
      throw new MaintenanceError(
        `git status failed: ${res.stderr.trim() || res.stdout.trim()}`,
        "GIT_ERROR",
        500
      );
    }
    return res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async getHeadCommit(branch?: string): Promise<string> {
    const target = branch ? `${branch}^{commit}` : "HEAD";
    const res = await this.run(["rev-parse", target]);
    if (res.code !== 0) {
      throw new MaintenanceError(
        `Failed to resolve commit for '${branch || "HEAD"}': ${res.stderr.trim()}`,
        "COMMIT_NOT_FOUND",
        404
      );
    }
    return res.stdout.trim();
  }

  async verifyCommitExists(commit: string): Promise<string> {
    const check = await this.run(["cat-file", "-e", `${commit}^{commit}`]);
    if (check.code !== 0) {
      throw new MaintenanceError(
        `Commit '${commit}' does not exist in repository`,
        "COMMIT_NOT_FOUND",
        404
      );
    }
    const parse = await this.run(["rev-parse", `${commit}^{commit}`]);
    if (parse.code !== 0) {
      throw new MaintenanceError(
        `Failed to resolve full hash for commit '${commit}'`,
        "COMMIT_NOT_FOUND",
        404
      );
    }
    return parse.stdout.trim();
  }

  async getRemoteUrl(): Promise<string | null> {
    const res = await this.run(["config", "--get", "remote.origin.url"]);
    if (res.code === 0 && res.stdout.trim().length > 0) {
      return res.stdout.trim();
    }
    return null;
  }

  async listBranchNames(): Promise<string[]> {
    const res = await this.run(["branch", "-a", "--format=%(refname:short)"]);
    if (res.code !== 0) {
      return [];
    }
    return res.stdout
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);
  }

  async refExists(ref: string): Promise<boolean> {
    const res = await this.run(["rev-parse", "--verify", ref]);
    return res.code === 0;
  }

  async fetchOrigin(options?: { filterBlobNone?: boolean; branch?: string }): Promise<GitExecResult> {
    const useBlobless = options?.filterBlobNone ?? true;
    if (useBlobless) {
      const args = ["fetch", "--filter=blob:none", "origin"];
      if (options?.branch) {
        args.push(options.branch);
      }
      const bloblessRes = await this.run(args);
      if (bloblessRes.code === 0) {
        return bloblessRes;
      }

      const combined = (bloblessRes.stderr + " " + bloblessRes.stdout).toLowerCase();
      if (
        combined.includes("filter") ||
        combined.includes("unknown option") ||
        combined.includes("not supported") ||
        combined.includes("unsupported")
      ) {
        this.ctx.log.warn("Remote origin does not support --filter=blob:none; falling back to standard fetch", {
          error: bloblessRes.stderr.trim(),
        });
        const fallbackArgs = ["fetch", "origin"];
        if (options?.branch) {
          fallbackArgs.push(options.branch);
        }
        return this.run(fallbackArgs);
      }
      return bloblessRes;
    }

    const standardArgs = ["fetch", "origin"];
    if (options?.branch) {
      standardArgs.push(options.branch);
    }
    return this.run(standardArgs);
  }

  static async clone(
    ctx: ActionContext,
    url: string,
    targetPath: string,
    options?: GitCloneOptions
  ): Promise<GitExecResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;

    if (ctx.signal.aborted) {
      throw new MaintenanceError("Git operation aborted by caller", "OPERATION_ABORTED", 499);
    }

    const runClone = async (args: string[]): Promise<GitExecResult> => {
      if (ctx.signal.aborted) {
        throw new MaintenanceError("Git operation aborted by caller", "OPERATION_ABORTED", 499);
      }

      ctx.log.debug(`Executing: git ${args.join(" ")}`);

      const parentDir = path.dirname(targetPath);
      try {
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
      } catch {
        // Ignore parent directory creation error and let git handle it
      }

      const cwd = fs.existsSync(parentDir) ? parentDir : process.cwd();

      const res = await ctx.process.run(
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
              },
            },
            io: { mode: "pipe" },
          },
          timeoutMs,
          maxOutputBytes,
        },
        { signal: ctx.signal }
      );

      const stdoutChunks = res.chunks.filter((c) => c.stream === "stdout");
      const stderrChunks = res.chunks.filter((c) => c.stream === "stderr");
      const stdout = decodeText(stdoutChunks);
      const stderr = decodeText(stderrChunks);
      const raw = decodeText(res.chunks);

      return {
        code: res.exit.code,
        signal: res.exit.signal,
        stdout,
        stderr,
        raw,
      };
    };

    const useBlobless = options?.filterBlobNone ?? true;
    if (useBlobless) {
      const bloblessArgs = ["clone", "--filter=blob:none"];
      if (options?.branch) {
        bloblessArgs.push("-b", options.branch);
      }
      bloblessArgs.push(url, targetPath);

      const bloblessRes = await runClone(bloblessArgs);
      if (bloblessRes.code === 0) {
        return bloblessRes;
      }

      const combined = (bloblessRes.stderr + " " + bloblessRes.stdout).toLowerCase();
      if (
        combined.includes("filter") ||
        combined.includes("unknown option") ||
        combined.includes("not supported") ||
        combined.includes("unsupported")
      ) {
        ctx.log.warn("Remote origin does not support --filter=blob:none; falling back to standard clone", {
          error: bloblessRes.stderr.trim(),
        });
        if (fs.existsSync(targetPath)) {
          try {
            fs.rmSync(targetPath, { recursive: true, force: true });
          } catch {
            // Ignore error
          }
        }
        const fallbackArgs = ["clone"];
        if (options?.branch) {
          fallbackArgs.push("-b", options.branch);
        }
        fallbackArgs.push(url, targetPath);
        return runClone(fallbackArgs);
      }
      return bloblessRes;
    }

    const standardArgs = ["clone"];
    if (options?.branch) {
      standardArgs.push("-b", options.branch);
    }
    standardArgs.push(url, targetPath);
    return runClone(standardArgs);
  }

  async clone(
    url: string,
    targetPath?: string,
    options?: GitCloneOptions
  ): Promise<GitExecResult> {
    return GitClient.clone(this.ctx, url, targetPath ?? this.defaultCwd, {
      timeoutMs: this.defaultTimeoutMs,
      maxOutputBytes: this.defaultMaxOutputBytes,
      ...options,
    });
  }
}
