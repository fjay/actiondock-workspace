import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestRuntime } from "@actiondock/testing";
import filesReadAction from "../actions/files-read.ts";

describe("workspace/files.read", () => {
  it("reads small text file completely", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-read-"));
    try {
      const file = path.join(tmpDir, "hello.txt");
      fs.writeFileSync(file, "line 1\nline 2\nline 3\n");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      const res = await runtime.run(filesReadAction, {
        path: "hello.txt",
      });

      assert.equal(res.path, "hello.txt");
      assert.equal(res.startLine, 1);
      assert.equal(res.endLine, 3);
      assert.equal(res.content, "line 1\nline 2\nline 3");
      assert.equal(res.hasMore, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads with pagination (startLine and maxLines)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-read-"));
    try {
      const file = path.join(tmpDir, "items.txt");
      fs.writeFileSync(file, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      // Page 1: lines 1 to 4
      const p1 = await runtime.run(filesReadAction, {
        path: "items.txt",
        startLine: 1,
        maxLines: 4,
      });
      assert.equal(p1.startLine, 1);
      assert.equal(p1.endLine, 4);
      assert.equal(p1.content, "1\n2\n3\n4");
      assert.equal(p1.hasMore, true);

      // Page 2: lines 5 to 8
      const p2 = await runtime.run(filesReadAction, {
        path: "items.txt",
        startLine: 5,
        maxLines: 4,
      });
      assert.equal(p2.startLine, 5);
      assert.equal(p2.endLine, 8);
      assert.equal(p2.content, "5\n6\n7\n8");
      assert.equal(p2.hasMore, true);

      // Page 3: lines 9 to 12
      const p3 = await runtime.run(filesReadAction, {
        path: "items.txt",
        startLine: 9,
        maxLines: 4,
      });
      assert.equal(p3.startLine, 9);
      assert.equal(p3.endLine, 10);
      assert.equal(p3.content, "9\n10");
      assert.equal(p3.hasMore, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects sensitive files (.env)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-read-"));
    try {
      fs.writeFileSync(path.join(tmpDir, ".env"), "API_KEY=secret");

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () => runtime.run(filesReadAction, { path: ".env" }),
        (err: any) => err.code === "SENSITIVE_PATH_DENIED"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects binary files with UNSUPPORTED_BINARY_FILE", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-read-"));
    try {
      const binFile = path.join(tmpDir, "image.png");
      const binData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a]);
      fs.writeFileSync(binFile, binData);

      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () => runtime.run(filesReadAction, { path: "image.png" }),
        (err: any) => err.code === "UNSUPPORTED_BINARY_FILE"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects path outside workspace root", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-read-"));
    try {
      const runtime = createTestRuntime({
        config: { WORKSPACE_ROOT: tmpDir },
      });

      await assert.rejects(
        () => runtime.run(filesReadAction, { path: "../etc/passwd" }),
        (err: any) => err.code === "PATH_OUTSIDE_WORKSPACE"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
