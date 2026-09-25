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
  FakeProcessDriver,
} from "@actiondock/testing";
import gitStatusAction from "../actions/git-status.ts";

function createRuntime(tmpDir: string) {
  const platform = createTestPlatform({
    process: new MockProcessExecutor({ fallbackToReal: true }),
  });
  return createTestRuntime({
    config: { WORKSPACE_ROOT: tmpDir },
    platform,
  });
}

describe("workspace/git.status", () => {
  it("returns clean status for a clean Git repository", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-status-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Hello");
      execSync("git add README.md && git commit -m 'Initial commit'", {
        cwd: tmpDir,
      });

      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(gitStatusAction, {});

      assert.equal(res.isGitRepo, true);
      assert.ok(res.branch === "main" || res.branch === "master");
      assert.equal(res.clean, true);
      assert.deepEqual(res.staged, []);
      assert.deepEqual(res.unstaged, []);
      assert.deepEqual(res.untracked, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("correctly categorizes staged, unstaged, and untracked changes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-status-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      fs.writeFileSync(path.join(tmpDir, "tracked.txt"), "v1");
      execSync("git add tracked.txt && git commit -m 'Initial'", { cwd: tmpDir });

      // Unstaged change
      fs.writeFileSync(path.join(tmpDir, "tracked.txt"), "v2");

      // Staged change
      fs.writeFileSync(path.join(tmpDir, "staged.txt"), "staged content");
      execSync("git add staged.txt", { cwd: tmpDir });

      // Untracked change
      fs.writeFileSync(path.join(tmpDir, "untracked.txt"), "new file");

      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(gitStatusAction, {});

      assert.equal(res.isGitRepo, true);
      assert.equal(res.clean, false);
      assert.deepEqual(res.staged, ["staged.txt"]);
      assert.deepEqual(res.unstaged, ["tracked.txt"]);
      assert.deepEqual(res.untracked, ["untracked.txt"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters sensitive files from status lists", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-status-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Readme");
      execSync("git add README.md && git commit -m 'Initial'", { cwd: tmpDir });

      // Create sensitive files (untracked)
      fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=1");
      fs.writeFileSync(path.join(tmpDir, ".env.production"), "SECRET=2");
      fs.writeFileSync(path.join(tmpDir, "server.key"), "PRIVATE KEY");
      fs.writeFileSync(path.join(tmpDir, "id_rsa"), "SSH KEY");

      // Create a normal untracked file
      fs.writeFileSync(path.join(tmpDir, "normal.txt"), "normal");

      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(gitStatusAction, {});

      assert.equal(res.isGitRepo, true);
      assert.deepEqual(res.untracked, ["normal.txt"]);
      assert.equal(res.staged.includes(".env"), false);
      assert.equal(res.unstaged.includes(".env"), false);
      assert.equal(res.untracked.includes(".env"), false);
      assert.equal(res.untracked.includes("server.key"), false);
      assert.equal(res.untracked.includes("id_rsa"), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns isGitRepo false for non-git directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-not-git-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");

      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(gitStatusAction, {});

      assert.equal(res.isGitRepo, false);
      assert.equal(res.branch, "");
      assert.equal(res.clean, true);
      assert.deepEqual(res.staged, []);
      assert.deepEqual(res.unstaged, []);
      assert.deepEqual(res.untracked, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("scopes status to specified subdirectory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-status-sub-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      const subDir = path.join(tmpDir, "pkg");
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(tmpDir, "root.txt"), "root");
      fs.writeFileSync(path.join(subDir, "sub.txt"), "sub");
      execSync("git add . && git commit -m 'Initial'", { cwd: tmpDir });

      // Modify both
      fs.writeFileSync(path.join(tmpDir, "root.txt"), "root modified");
      fs.writeFileSync(path.join(subDir, "sub.txt"), "sub modified");

      const runtime = createRuntime(tmpDir);
      const res = await runtime.run(gitStatusAction, {
        path: "pkg",
      });

      assert.equal(res.isGitRepo, true);
      assert.equal(res.unstaged.includes("pkg/sub.txt"), true);
      assert.equal(res.unstaged.includes("root.txt"), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("validates target path boundaries and types", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-git-status-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "file.txt"), "file");

      const runtime = createRuntime(tmpDir);

      await assert.rejects(
        () => runtime.run(gitStatusAction, { path: "nonexistent" }),
        (err: any) => err.code === "FILE_NOT_FOUND"
      );

      await assert.rejects(
        () => runtime.run(gitStatusAction, { path: "file.txt" }),
        (err: any) => err.code === "NOT_A_DIRECTORY"
      );

      await assert.rejects(
        () => runtime.run(gitStatusAction, { path: "../outside" }),
        (err: any) => err.code === "PATH_OUTSIDE_WORKSPACE"
      );

      await assert.rejects(
        () => runtime.run(gitStatusAction, { path: ".git" }),
        (err: any) => err.code === "SENSITIVE_PATH_DENIED"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles mock porcelain status parser scenarios (detached HEAD, renames)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mock-"));
    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --show-toplevel") {
          handle.emitOutput("stdout", `${tmpDir}\n`);
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain=v1 -b") {
          const porcelain = [
            "## HEAD (no branch)",
            "R  old-name.ts -> new-name.ts",
            " M modified.ts",
            "?? untracked.ts",
            "!! ignored.log",
            "?? .env",
          ].join("\n");
          handle.emitOutput("stdout", porcelain + "\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const platform = createTestPlatform({ processDriver: fakeDriver });
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
        platform,
      });

      const res = await runtime.run(gitStatusAction, {});

      assert.equal(res.isGitRepo, true);
      assert.equal(res.branch, "HEAD");
      assert.equal(res.clean, false);
      assert.deepEqual(res.staged, ["new-name.ts"]);
      assert.deepEqual(res.unstaged, ["modified.ts"]);
      assert.deepEqual(res.untracked, ["untracked.ts"]);
      assert.equal(res.untracked.includes(".env"), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
