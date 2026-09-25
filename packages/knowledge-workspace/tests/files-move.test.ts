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
import filesMoveAction from "../actions/files-move.ts";

function createRuntime(tmpDir: string) {
  const platform = createTestPlatform({
    process: new MockProcessExecutor({ fallbackToReal: true }),
  });
  return createTestRuntime({
    config: { WORKSPACE_ROOT: tmpDir },
    platform,
  });
}

describe("workspace/files.move", () => {
  it("moves a non-git file successfully with automatic parent directory creation", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mv-"));
    try {
      const srcFile = path.join(tmpDir, "source.txt");
      fs.writeFileSync(srcFile, "hello move");

      const runtime = createRuntime(tmpDir);

      const res = await runtime.run(filesMoveAction, {
        from: "source.txt",
        to: "nested/target.txt",
      });

      assert.equal(res.from, "source.txt");
      assert.equal(res.to, "nested/target.txt");
      assert.equal(res.gitTracked, false);
      assert.equal(fs.existsSync(srcFile), false);
      assert.equal(
        fs.readFileSync(path.join(tmpDir, "nested", "target.txt"), "utf8"),
        "hello move"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("moves a git-tracked file using git mv when inside a git repository", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mv-git-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      const file = path.join(tmpDir, "tracked.txt");
      fs.writeFileSync(file, "tracked content");
      execSync("git add tracked.txt && git commit -m 'init'", { cwd: tmpDir });

      const runtime = createRuntime(tmpDir);

      const res = await runtime.run(filesMoveAction, {
        from: "tracked.txt",
        to: "sub/moved.txt",
      });

      assert.equal(res.from, "tracked.txt");
      assert.equal(res.to, "sub/moved.txt");
      assert.equal(res.gitTracked, true);
      assert.equal(fs.existsSync(file), false);
      assert.equal(
        fs.readFileSync(path.join(tmpDir, "sub", "moved.txt"), "utf8"),
        "tracked content"
      );

      // Verify git status reflects the rename
      const gitStatus = execSync("git status --porcelain", {
        cwd: tmpDir,
        encoding: "utf8",
      });
      assert.match(gitStatus, /R  tracked\.txt -> sub\/moved\.txt/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("moves an untracked file via fs.renameSync inside a git repository", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mv-untracked-"));
    try {
      execSync(
        "git init && git config user.name test && git config user.email test@test.com",
        { cwd: tmpDir }
      );
      fs.writeFileSync(path.join(tmpDir, "init.txt"), "init");
      execSync("git add init.txt && git commit -m 'init'", { cwd: tmpDir });

      // Create an untracked file
      fs.writeFileSync(path.join(tmpDir, "untracked.txt"), "not tracked");

      const runtime = createRuntime(tmpDir);

      const res = await runtime.run(filesMoveAction, {
        from: "untracked.txt",
        to: "moved-untracked.txt",
      });

      assert.equal(res.from, "untracked.txt");
      assert.equal(res.to, "moved-untracked.txt");
      assert.equal(res.gitTracked, false);
      assert.equal(fs.existsSync(path.join(tmpDir, "untracked.txt")), false);
      assert.equal(
        fs.readFileSync(path.join(tmpDir, "moved-untracked.txt"), "utf8"),
        "not tracked"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects move when destination exists and overwrite is false", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mv-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "content a");
      fs.writeFileSync(path.join(tmpDir, "b.txt"), "content b");

      const runtime = createRuntime(tmpDir);

      await assert.rejects(
        () =>
          runtime.run(filesMoveAction, {
            from: "a.txt",
            to: "b.txt",
            overwrite: false,
          }),
        (err: any) => err.code === "FILE_ALREADY_EXISTS"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("allows overwrite when destination exists and overwrite is true", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mv-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "content new");
      fs.writeFileSync(path.join(tmpDir, "b.txt"), "content old");

      const runtime = createRuntime(tmpDir);

      const res = await runtime.run(filesMoveAction, {
        from: "a.txt",
        to: "b.txt",
        overwrite: true,
      });

      assert.equal(res.from, "a.txt");
      assert.equal(res.to, "b.txt");
      assert.equal(fs.existsSync(path.join(tmpDir, "a.txt")), false);
      assert.equal(
        fs.readFileSync(path.join(tmpDir, "b.txt"), "utf8"),
        "content new"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects when source does not exist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mv-"));
    try {
      const runtime = createRuntime(tmpDir);

      await assert.rejects(
        () =>
          runtime.run(filesMoveAction, {
            from: "nonexistent.txt",
            to: "dest.txt",
          }),
        (err: any) => err.code === "FILE_NOT_FOUND"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects moving workspace root directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mv-"));
    try {
      const runtime = createRuntime(tmpDir);

      await assert.rejects(
        () =>
          runtime.run(filesMoveAction, {
            from: "",
            to: "dest",
          }),
        (err: any) => err.code === "INVALID_ARGUMENT"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects moving a directory into its child directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mv-"));
    try {
      const parentDir = path.join(tmpDir, "parent");
      fs.mkdirSync(parentDir);

      const runtime = createRuntime(tmpDir);

      await assert.rejects(
        () =>
          runtime.run(filesMoveAction, {
            from: "parent",
            to: "parent/child",
          }),
        (err: any) => err.code === "INVALID_ARGUMENT"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects sensitive paths like .env or .git for from and to", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mv-"));
    try {
      fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=1");
      fs.writeFileSync(path.join(tmpDir, "safe.txt"), "safe");

      const runtime = createRuntime(tmpDir);

      await assert.rejects(
        () =>
          runtime.run(filesMoveAction, {
            from: ".env",
            to: "safe2.txt",
          }),
        (err: any) => err.code === "SENSITIVE_PATH_DENIED"
      );

      await assert.rejects(
        () =>
          runtime.run(filesMoveAction, {
            from: "safe.txt",
            to: ".env",
          }),
        (err: any) => err.code === "SENSITIVE_PATH_DENIED"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles abort signal properly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mv-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "abort-from.txt"), "data");

      const runtime = createRuntime(tmpDir);

      const controller = new AbortController();
      controller.abort();

      const res = await runtime.execute(
        filesMoveAction,
        { from: "abort-from.txt", to: "abort-to.txt" },
        { signal: controller.signal }
      );

      assert.equal(res.ok, false);
      assert.match(res.error?.message || "", /cancelled|aborted/i);
      assert.equal(fs.existsSync(path.join(tmpDir, "abort-from.txt")), true);
      assert.equal(fs.existsSync(path.join(tmpDir, "abort-to.txt")), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
