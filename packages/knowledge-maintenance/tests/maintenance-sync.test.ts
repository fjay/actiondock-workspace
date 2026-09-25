import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime, createTestPlatform, FakeProcessDriver } from "@actiondock/testing";
import syncAction from "../actions/maintenance-sync.ts";

describe("maintenance.sync", () => {
  it("synchronizes dual-branch code repository successfully when remote docs branch exists", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-code-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --ff-only origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --no-edit origin/release") {
          handle.emitOutput("stdout", "Merge made by the 'ort' strategy.\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "push origin docs") {
          handle.emitOutput("stdout", "To origin\n   abc..def  docs -> docs\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "9999888877776666555544443333222211110000\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
        repoType: "code",
        sourceBranch: "release",
        knowledgeBranch: "docs",
      });

      assert.equal(res.status, "success");
      assert.equal(res.repoType, "code");
      assert.equal(res.sourceBranch, "release");
      assert.equal(res.knowledgeBranch, "docs");
      assert.equal(res.currentCommit, "9999888877776666555544443333222211110000");
      assert.equal(res.initializedBranch, false);

      assert.ok(executedCommands.some((c) => c.startsWith("fetch")));
      assert.ok(executedCommands.includes("checkout docs"));
      assert.ok(executedCommands.includes("merge --no-edit origin/release"));
      assert.ok(executedCommands.includes("push origin docs"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects dirty working tree and returns dirty_worktree without fetching or merging", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-dirty-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", " M src/index.ts\n?? uncommitted.txt\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
        repoType: "code",
      });

      assert.equal(res.status, "dirty_worktree");
      assert.deepEqual(res.uncommittedFiles, ["M src/index.ts", "?? uncommitted.txt"]);
      assert.ok(res.message.includes("Working tree is dirty"));
      assert.ok(!executedCommands.includes("fetch origin"), "Should not fetch when worktree is dirty");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("safely aborts merge and returns conflict status on merge conflict", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-conflict-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          // If porcelain status is checked during merge, report unmerged conflict
          if (executedCommands.includes("merge --no-edit origin/release")) {
            handle.emitOutput("stdout", "UU docs/knowledge/flow.md\nUU docs/api.md\n");
          } else {
            handle.emitOutput("stdout", "");
          }
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --ff-only origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --no-edit origin/release") {
          handle.emitOutput("stderr", "CONFLICT (content): Merge conflict in docs/knowledge/flow.md\nAutomatic merge failed\n");
          handle.emitExit({ code: 1, signal: null });
        } else if (cmd === "merge --abort") {
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
        repoType: "code",
      });

      assert.equal(res.status, "conflict");
      assert.deepEqual(res.conflictFiles, ["docs/knowledge/flow.md", "docs/api.md"]);
      assert.ok(res.message.includes("safely aborted"));

      // Verify strict contract: git merge --abort MUST have been called, and NEVER git push
      assert.ok(executedCommands.includes("merge --abort"), "Must execute git merge --abort");
      assert.ok(!executedCommands.some((c) => c.startsWith("push")), "Must not push on conflict");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("initializes docs branch when remote origin/docs does not exist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-init-branch-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify origin/docs") {
          // Remote docs does NOT exist
          handle.emitExit({ code: 1, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/docs") {
          // Local docs does not exist yet
          handle.emitExit({ code: 1, signal: null });
        } else if (cmd === "checkout -b docs origin/release") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "push origin docs") {
          handle.emitOutput("stdout", "Total 0 (delta 0), reused 0 (delta 0)\nTo origin\n * [new branch] docs -> docs\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "aabbccddeeff00112233445566778899aabbccdd\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
        repoType: "code",
      });

      assert.equal(res.status, "success");
      assert.equal(res.initializedBranch, true);
      assert.equal(res.currentCommit, "aabbccddeeff00112233445566778899aabbccdd");
      assert.ok(executedCommands.includes("checkout -b docs origin/release"));
      assert.ok(executedCommands.includes("push origin docs"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("synchronizes system_knowledge single-branch repository via ff-only merge", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-sys-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin" || cmd === "fetch origin") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/master") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout master") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --ff-only origin/master") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "3333444455556666777788889999000011112222\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
        repoType: "system_knowledge",
        sourceBranch: "master",
      });

      assert.equal(res.status, "success");
      assert.equal(res.repoType, "system_knowledge");
      assert.equal(res.sourceBranch, "master");
      assert.equal(res.currentCommit, "3333444455556666777788889999000011112222");
      assert.ok(executedCommands.includes("merge --ff-only origin/master"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns error status if path is not a git repository", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-notgit-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stderr", "fatal: not a git repository\n");
          handle.emitExit({ code: 128, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
      });

      assert.equal(res.status, "error");
      assert.ok(res.message.includes("not a valid git repository"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to standard fetch when remote origin does not support --filter=blob:none", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-fallback-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const executedCommands: string[] = [];

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        executedCommands.push(cmd);

        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "status --porcelain") {
          handle.emitOutput("stdout", "");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "fetch --filter=blob:none origin") {
          // Server rejects filter option
          handle.emitOutput("stderr", "fatal: Server does not support --filter\n");
          handle.emitExit({ code: 128, signal: null });
        } else if (cmd === "fetch origin") {
          // Fallback succeeds
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse --verify refs/heads/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "checkout docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --ff-only origin/docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "merge --no-edit origin/release") {
          handle.emitOutput("stdout", "Merge made by the 'ort' strategy.\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "push origin docs") {
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse HEAD") {
          handle.emitOutput("stdout", "1111222233334444555566667777888899990000\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(syncAction, {
        path: tmpDir,
        repoType: "code",
      });

      assert.equal(res.status, "success");
      assert.ok(executedCommands.includes("fetch --filter=blob:none origin"));
      assert.ok(executedCommands.includes("fetch origin"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
