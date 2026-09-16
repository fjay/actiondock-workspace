import path from "node:path";
import fs from "node:fs";
import { WorkspaceError } from "./errors.ts";
import { isSensitivePath } from "./file-policy.ts";

export interface ResolveOptions {
  allowNonExistent?: boolean;
}

export interface ResolvedPath {
  absolutePath: string;
  relativePath: string;
  realPath?: string;
  stat?: fs.Stats;
}

export class WorkspacePathPolicy {
  readonly root: string;
  readonly realRoot: string;

  constructor(workspaceRoot?: string) {
    const raw = workspaceRoot && workspaceRoot.trim() ? workspaceRoot.trim() : process.cwd();
    this.root = path.resolve(raw);
    if (!fs.existsSync(this.root)) {
      throw new WorkspaceError(
        `Workspace root directory does not exist: ${this.root}`,
        "WORKSPACE_ROOT_NOT_FOUND",
        404
      );
    }
    this.realRoot = fs.realpathSync(this.root);
  }

  /**
   * Resolves and validates a candidate path against workspace boundary and sensitive file rules.
   */
  resolveAndValidate(candidatePath: string = "", options: ResolveOptions = {}): ResolvedPath {
    const normalized = path.normalize(candidatePath).replace(/^(\.\/|\.\\)+/, "");
    const candidateAbsolute = path.resolve(this.root, normalized);

    // Path boundary check using path.relative (Section 21)
    const relFromRoot = path.relative(this.root, candidateAbsolute);
    const inside =
      relFromRoot === "" ||
      (relFromRoot !== ".." &&
        !relFromRoot.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relFromRoot));

    if (!inside) {
      throw new WorkspaceError(
        `Path resolves outside workspace root: ${candidatePath}`,
        "PATH_OUTSIDE_WORKSPACE",
        403
      );
    }

    const relativePosix = relFromRoot === "" ? "" : relFromRoot.split(path.sep).join("/");

    // Check sensitive file policy
    if (relativePosix && isSensitivePath(relativePosix)) {
      throw new WorkspaceError(
        `Access to sensitive file is denied: ${relativePosix}`,
        "SENSITIVE_PATH_DENIED",
        403
      );
    }

    // Check file existence
    if (!fs.existsSync(candidateAbsolute)) {
      if (options.allowNonExistent) {
        return {
          absolutePath: candidateAbsolute,
          relativePath: relativePosix,
        };
      }
      throw new WorkspaceError(
        `File or directory does not exist: ${candidatePath}`,
        "FILE_NOT_FOUND",
        404
      );
    }

    // Realpath verification for symlink policy (Section 22)
    const realCandidate = fs.realpathSync(candidateAbsolute);
    const relFromRealRoot = path.relative(this.realRoot, realCandidate);
    const realInside =
      relFromRealRoot === "" ||
      (relFromRealRoot !== ".." &&
        !relFromRealRoot.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relFromRealRoot));

    if (!realInside) {
      throw new WorkspaceError(
        `Symlink target resolves outside workspace root: ${candidatePath}`,
        "SYMLINK_OUTSIDE_WORKSPACE",
        403
      );
    }

    const realRelPosix = relFromRealRoot === "" ? "" : relFromRealRoot.split(path.sep).join("/");
    if (realRelPosix && isSensitivePath(realRelPosix)) {
      throw new WorkspaceError(
        `Symlink target resolves to sensitive path: ${realRelPosix}`,
        "SENSITIVE_PATH_DENIED",
        403
      );
    }

    const stat = fs.statSync(candidateAbsolute);

    return {
      absolutePath: candidateAbsolute,
      relativePath: relativePosix,
      realPath: realCandidate,
      stat,
    };
  }

  /**
   * Converts any path back to relative POSIX path from workspace root.
   */
  toRelativePath(anyPath: string): string {
    if (!anyPath) return "";
    const rel = path.isAbsolute(anyPath)
      ? path.relative(this.root, anyPath)
      : path.normalize(anyPath);
    return rel.split(path.sep).join("/");
  }
}
