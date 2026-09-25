import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestRuntime } from "@actiondock/testing";
import filesDeleteAction from "../actions/files-delete.ts";

describe("workspace/files.delete", () => {
  it("deletes a single file successfully", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-del-"));
    try {
      const filePath = path.join(tmpDir, "test.txt");
      fs.writeFileSync(filePath, "sample content");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(filesDeleteAction, {
        path: "test.txt",
      });

      assert.equal(res.path, "test.txt");
      assert.equal(res.deleted, true);
      assert.equal(res.isDirectory, false);
      assert.equal(fs.existsSync(filePath), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("deletes a directory recursively when recursive is true", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-del-"));
    try {
      const subDir = path.join(tmpDir, "nested", "deep");
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, "file.txt"), "hello");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(filesDeleteAction, {
        path: "nested",
        recursive: true,
      });

      assert.equal(res.path, "nested");
      assert.equal(res.deleted, true);
      assert.equal(res.isDirectory, true);
      assert.equal(fs.existsSync(path.join(tmpDir, "nested")), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects directory deletion when recursive is false", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-del-"));
    try {
      const subDir = path.join(tmpDir, "folder");
      fs.mkdirSync(subDir);

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesDeleteAction, {
            path: "folder",
            recursive: false,
          }),
        (err: any) => err.code === "PATH_IS_DIRECTORY"
      );

      assert.equal(fs.existsSync(subDir), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects non-existent file when ignoreIfNotExists is false (default)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-del-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesDeleteAction, {
            path: "not-found.txt",
          }),
        (err: any) => err.code === "FILE_NOT_FOUND"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns deleted false when non-existent and ignoreIfNotExists is true", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-del-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(filesDeleteAction, {
        path: "not-found.txt",
        ignoreIfNotExists: true,
      });

      assert.equal(res.path, "not-found.txt");
      assert.equal(res.deleted, false);
      assert.equal(res.isDirectory, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects deletion of workspace root", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-del-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesDeleteAction, {
            path: "",
          }),
        (err: any) => err.code === "INVALID_ARGUMENT"
      );

      await assert.rejects(
        () =>
          runtime.run(filesDeleteAction, {
            path: ".",
          }),
        (err: any) => err.code === "CANNOT_DELETE_ROOT"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects sensitive paths like .env and .git", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-del-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesDeleteAction, {
            path: ".env",
          }),
        (err: any) => err.code === "SENSITIVE_PATH_DENIED"
      );

      await assert.rejects(
        () =>
          runtime.run(filesDeleteAction, {
            path: ".git/config",
          }),
        (err: any) => err.code === "SENSITIVE_PATH_DENIED"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal outside workspace root", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-del-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () =>
          runtime.run(filesDeleteAction, {
            path: "../outside.txt",
          }),
        (err: any) => err.code === "PATH_OUTSIDE_WORKSPACE"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles abort signal properly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-del-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "abort.txt"), "data");
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const controller = new AbortController();
      controller.abort();

      const res = await runtime.execute(
        filesDeleteAction,
        { path: "abort.txt" },
        { signal: controller.signal }
      );

      assert.equal(res.ok, false);
      assert.match(res.error?.message || "", /cancelled|aborted/i);
      assert.equal(fs.existsSync(path.join(tmpDir, "abort.txt")), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
