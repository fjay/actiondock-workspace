import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime, createTestPlatform, FakeProcessDriver } from "@actiondock/testing";
import { encodeStateKey } from "@actiondock/sdk";
import listAction from "../actions/maintenance-list.ts";

describe("maintenance.list", () => {
  it("implements Strategy B: initial run without checkpoint requests full inventory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-init-"));
    try {
      const fakeDriver = new FakeProcessDriver();

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "branch -a --format=%(refname:short)") {
          handle.emitOutput("stdout", "release\nmain\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse release^{commit}") {
          handle.emitOutput("stdout", "e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "git@github.com:myorg/order-service.git\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-list --count e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3") {
          handle.emitOutput("stdout", "128\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      const res = await runtime.run(listAction, { path: tmpDir });

      assert.equal(res.hasChanges, true);
      assert.equal(res.from, null);
      assert.equal(res.to, "e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3");
      assert.equal(res.repo, "order-service");
      assert.equal(res.branch, "release");
      assert.equal(res.commitCount, 128);
      assert.equal(res.initialInventoryRequired, true);
      assert.deepEqual(res.commits, []);
      assert.ok(res.message.includes("full inventory required"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports no changes when checkpoint commit equals HEAD", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-noupdate-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const headCommit = "1111222233334444555566667777888899990000";

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse release^{commit}") {
          handle.emitOutput("stdout", `${headCommit}\n`);
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "https://github.com/myorg/demo-repo\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      // Pre-seed checkpoint in state
      await runtime.state.set(encodeStateKey("checkpoints", "demo-repo"), {
        commit: headCommit,
        updatedAt: "2026-09-24T00:00:00Z",
      });

      const res = await runtime.run(listAction, { path: tmpDir, branch: "release" });

      assert.equal(res.hasChanges, false);
      assert.equal(res.from, headCommit);
      assert.equal(res.to, headCommit);
      assert.equal(res.commitCount, 0);
      assert.deepEqual(res.commits, []);
      assert.equal(res.initialInventoryRequired, false);
      assert.ok(res.message.includes("up to date"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("extracts commits and diff stats when changes are detected", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-changes-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      const fromCommit = "aaaa111122223333444455556666777788889999";
      const toCommit = "bbbb111122223333444455556666777788889999";

      fakeDriver.onSpawn = (handle: any, spec: any) => {
        const cmd = spec.args.join(" ");
        if (cmd === "rev-parse --is-inside-work-tree") {
          handle.emitOutput("stdout", "true\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "rev-parse release^{commit}") {
          handle.emitOutput("stdout", `${toCommit}\n`);
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd === "config --get remote.origin.url") {
          handle.emitOutput("stdout", "git@github.com:myorg/demo-repo.git\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.includes("log --pretty=format:%H%x09%h%x09%an <%ae>%x09%aI%x09%s")) {
          const logLines = [
            `${toCommit}\tbbbb111\tAlice <alice@test.com>\t2026-09-24T08:00:00Z\tfeat: update budget validation logic`,
            `cccc111122223333444455556666777788889999\tcccc111\tBob <bob@test.com>\t2026-09-24T07:30:00Z\tfix: handle null payment response`,
          ].join("\n");
          handle.emitOutput("stdout", logLines + "\n");
          handle.emitExit({ code: 0, signal: null });
        } else if (cmd.includes("diff --stat")) {
          const diffOutput = [
            " src/campaign/budget.ts | 30 ++++++++++++++++++++++++++----",
            " src/payment/handler.ts |  8 ++++----",
            " 2 files changed, 30 insertions(+), 8 deletions(-)",
          ].join("\n");
          handle.emitOutput("stdout", diffOutput + "\n");
          handle.emitExit({ code: 0, signal: null });
        } else {
          handle.emitExit({ code: 0, signal: null });
        }
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      // Pre-seed checkpoint in state
      await runtime.state.set(encodeStateKey("checkpoints", "demo-repo"), {
        commit: fromCommit,
        updatedAt: "2026-09-24T00:00:00Z",
      });

      const res = await runtime.run(listAction, { path: tmpDir, branch: "release" });

      assert.equal(res.hasChanges, true);
      assert.equal(res.from, fromCommit);
      assert.equal(res.to, toCommit);
      assert.equal(res.commitCount, 2);
      assert.equal(res.commits?.length, 2);
      assert.equal(res.commits[0]?.shortHash, "bbbb111");
      assert.equal(res.commits[0]?.message, "feat: update budget validation logic");

      assert.equal(res.changedFilesSummary?.filesChanged, 2);
      assert.equal(res.changedFilesSummary?.insertions, 30);
      assert.equal(res.changedFilesSummary?.deletions, 8);
      assert.equal(res.changedFilesSummary?.files?.length, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws INVALID_REPO error when target path is not a git repository", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-notgit-"));
    try {
      const fakeDriver = new FakeProcessDriver();
      fakeDriver.onSpawn = (handle: any) => {
        handle.emitOutput("stderr", "fatal: not a git repository\n");
        handle.emitExit({ code: 128, signal: null });
        handle.emitOutputClosed("natural");
      };

      const runtime = createTestRuntime({
        platform: createTestPlatform({ processDriver: fakeDriver }),
      });

      await assert.rejects(
        () => runtime.run(listAction, { path: tmpDir }),
        (err: any) => err.code === "INVALID_REPO"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
