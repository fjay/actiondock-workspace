import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  createTestRuntime,
  createTestPlatform,
  MockProcessExecutor,
} from "@actiondock/testing";
import gitDiffAction from "../actions/git-diff.ts";

function createRuntime(tmpDir: string) {
  const platform = createTestPlatform({
    process: new MockProcessExecutor({ fallbackToReal: true }),
  });
  return createTestRuntime({
    config: { WORKSPACE_ROOT: tmpDir },
    platform,
  });
}

describe("workspace/git.diff", () => {
  it("returns clean diff for repository without changes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-diff-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello\n");
      execSync("git add file.txt && git commit -m 'Initial'", { cwd: tmpDir });

      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(gitDiffAction, {});

      assert.equal(res.isGitRepo, true);
      assert.equal(res.clean, true);
      assert.equal(res.diff, "");
      assert.equal(res.truncated, false);
      assert.equal(res.filesChanged, 0);
      assert.equal(res.insertions, 0);
      assert.equal(res.deletions, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("inspects unstaged changes with structured statistics", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-diff-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      fs.writeFileSync(path.join(tmpDir, "app.ts"), "const a = 1;\n");
      execSync("git add app.ts && git commit -m 'Initial'", { cwd: tmpDir });

      // Unstaged modifications: replace line 1 and add line 2
      fs.writeFileSync(path.join(tmpDir, "app.ts"), "const a = 2;\nconst b = 3;\n");

      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(gitDiffAction, {});

      assert.equal(res.isGitRepo, true);
      assert.equal(res.clean, false);
      assert.equal(res.truncated, false);
      assert.equal(res.filesChanged, 1);
      assert.equal(res.insertions, 2);
      assert.equal(res.deletions, 1);
      assert.match(res.diff, /-const a = 1;/);
      assert.match(res.diff, /\+const a = 2;/);
      assert.match(res.diff, /\+const b = 3;/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("inspects staged changes when staged is true", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-diff-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      fs.writeFileSync(path.join(tmpDir, "app.ts"), "const a = 1;\n");
      execSync("git add app.ts && git commit -m 'Initial'", { cwd: tmpDir });

      fs.writeFileSync(path.join(tmpDir, "app.ts"), "const a = 99;\n");
      execSync("git add app.ts", { cwd: tmpDir });

      const runtime = createRuntime(tmpDir);

      // Unstaged diff should be empty
      const unstagedRes = await runtime.run(gitDiffAction, { staged: false });
      assert.equal(unstagedRes.clean, true);

      // Staged diff should show changes
      const stagedRes = await runtime.run(gitDiffAction, { staged: true });
      assert.equal(stagedRes.clean, false);
      assert.equal(stagedRes.filesChanged, 1);
      assert.equal(stagedRes.insertions, 1);
      assert.equal(stagedRes.deletions, 1);
      assert.match(stagedRes.diff, /\+const a = 99;/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns diff summary when statOnly is true", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-diff-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      fs.writeFileSync(path.join(tmpDir, "file1.txt"), "line1\n");
      fs.writeFileSync(path.join(tmpDir, "file2.txt"), "line2\n");
      execSync("git add . && git commit -m 'Initial'", { cwd: tmpDir });

      fs.writeFileSync(path.join(tmpDir, "file1.txt"), "line1 modified\nnew line\n");
      fs.writeFileSync(path.join(tmpDir, "file2.txt"), "line2 modified\n");

      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(gitDiffAction, { statOnly: true });

      assert.equal(res.isGitRepo, true);
      assert.equal(res.clean, false);
      assert.equal(res.filesChanged, 2);
      assert.match(res.diff, /file1\.txt/);
      assert.match(res.diff, /file2\.txt/);
      // Diff stat contains pipe symbol
      assert.match(res.diff, /\|/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("scopes diff to specified path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-diff-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a\n");
      fs.writeFileSync(path.join(tmpDir, "b.txt"), "b\n");
      execSync("git add . && git commit -m 'Initial'", { cwd: tmpDir });

      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a modified\n");
      fs.writeFileSync(path.join(tmpDir, "b.txt"), "b modified\n");

      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(gitDiffAction, { path: "a.txt" });

      assert.equal(res.filesChanged, 1);
      assert.match(res.diff, /a\.txt/);
      assert.doesNotMatch(res.diff, /b\.txt/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("truncates output when exceeding maxLines budget", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-diff-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      fs.writeFileSync(path.join(tmpDir, "large.txt"), "init\n");
      execSync("git add large.txt && git commit -m 'Initial'", { cwd: tmpDir });

      const newLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      fs.writeFileSync(path.join(tmpDir, "large.txt"), newLines + "\n");

      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(gitDiffAction, { maxLines: 5 });

      assert.equal(res.truncated, true);
      assert.equal(res.diff.split("\n").length, 5);
      // Total files changed and lines changed accurately reflect true total
      assert.equal(res.filesChanged, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("truncates output when exceeding maxBytes budget", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-diff-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      fs.writeFileSync(path.join(tmpDir, "large.txt"), "init\n");
      execSync("git add large.txt && git commit -m 'Initial'", { cwd: tmpDir });

      fs.writeFileSync(path.join(tmpDir, "large.txt"), "x".repeat(500) + "\n");

      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(gitDiffAction, { maxBytes: 60 });

      assert.equal(res.truncated, true);
      assert.ok(Buffer.byteLength(res.diff, "utf8") <= 60);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters sensitive files from diff and stats", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-diff-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      fs.writeFileSync(path.join(tmpDir, "app.ts"), "code\n");
      fs.writeFileSync(path.join(tmpDir, ".env"), "KEY=initial\n");
      execSync("git add . && git commit -m 'Initial'", { cwd: tmpDir });

      fs.writeFileSync(path.join(tmpDir, "app.ts"), "code updated\n");
      fs.writeFileSync(path.join(tmpDir, ".env"), "KEY=supersecret\n");

      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(gitDiffAction, {});

      assert.equal(res.isGitRepo, true);
      assert.equal(res.filesChanged, 1);
      assert.match(res.diff, /app\.ts/);
      assert.doesNotMatch(res.diff, /supersecret/);
      assert.doesNotMatch(res.diff, /\.env/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns isGitRepo false for non-git directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-not-git-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");

      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(gitDiffAction, {});

      assert.equal(res.isGitRepo, false);
      assert.equal(res.clean, true);
      assert.equal(res.diff, "");
      assert.equal(res.truncated, false);
      assert.equal(res.filesChanged, 0);
      assert.equal(res.insertions, 0);
      assert.equal(res.deletions, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal or sensitive path access", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-diff-"));
    try {
      const runtime = createRuntime(tmpDir);

      await assert.rejects(
        () => runtime.run(gitDiffAction, { path: "../outside" }),
        (err: any) => err.code === "PATH_OUTSIDE_WORKSPACE"
      );

      await assert.rejects(
        () => runtime.run(gitDiffAction, { path: ".env" }),
        (err: any) => err.code === "SENSITIVE_PATH_DENIED"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
