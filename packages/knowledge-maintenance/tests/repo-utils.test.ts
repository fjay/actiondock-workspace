import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseDiffStat,
  parseGitLog,
  resolveRepoPath,
} from "../src/repo-utils.ts";

describe("repo-utils", () => {
  describe("parseDiffStat", () => {
    it("parses normal diff stat with additions and deletions", () => {
      const output = [
        " src/campaign/budget.ts | 30 ++++++++++++++++++++++++++----",
        " src/auth/handler.ts    | 10 +++++-----",
        " 2 files changed, 35 insertions(+), 5 deletions(-)",
      ].join("\n");

      const res = parseDiffStat(output);
      assert.equal(res.filesChanged, 2);
      assert.equal(res.insertions, 35);
      assert.equal(res.deletions, 5);
      assert.equal(res.files.length, 2);
      assert.equal(res.files[0]?.file, "src/campaign/budget.ts");
      assert.equal(res.files[1]?.file, "src/auth/handler.ts");
    });

    it("parses diff stat with only insertions", () => {
      const output = [
        " docs/intro.md | 20 ++++++++++++++++++++",
        " 1 file changed, 20 insertions(+)",
      ].join("\n");

      const res = parseDiffStat(output);
      assert.equal(res.filesChanged, 1);
      assert.equal(res.insertions, 20);
      assert.equal(res.deletions, 0);
    });

    it("parses empty or empty lines gracefully", () => {
      const res = parseDiffStat("");
      assert.equal(res.filesChanged, 0);
      assert.equal(res.insertions, 0);
      assert.equal(res.deletions, 0);
      assert.deepEqual(res.files, []);
    });
  });

  describe("parseGitLog", () => {
    it("parses formatted tab-delimited git log", () => {
      const output = [
        "1111222233334444555566667777888899990000\t1111222\tAlice <alice@test.com>\t2026-09-24T08:00:00Z\tfeat: new feature",
        "2222333344445555666677778888999900001111\t2222333\tBob <bob@test.com>\t2026-09-24T07:00:00Z\tfix: bug fix",
      ].join("\n");

      const res = parseGitLog(output);
      assert.equal(res.length, 2);
      assert.equal(res[0]?.hash, "1111222233334444555566667777888899990000");
      assert.equal(res[0]?.shortHash, "1111222");
      assert.equal(res[0]?.author, "Alice <alice@test.com>");
      assert.equal(res[0]?.date, "2026-09-24T08:00:00Z");
      assert.equal(res[0]?.message, "feat: new feature");
    });

    it("returns empty array on empty input", () => {
      assert.deepEqual(parseGitLog(""), []);
      assert.deepEqual(parseGitLog("   \n\n"), []);
    });
  });

  describe("resolveRepoPath", () => {
    it("resolves existing directory path", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "util-path-"));
      try {
        const resolved = resolveRepoPath(tmpDir);
        assert.equal(resolved, path.resolve(tmpDir));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("throws on non-existent path", () => {
      assert.throws(
        () => resolveRepoPath("/non/existent/path/here"),
        (err: any) => err.code === "PATH_NOT_FOUND"
      );
    });

    it("throws when path is a file instead of directory", () => {
      const tmpFile = path.join(os.tmpdir(), `temp-file-${Date.now()}.txt`);
      fs.writeFileSync(tmpFile, "content");
      try {
        assert.throws(
          () => resolveRepoPath(tmpFile),
          (err: any) => err.code === "NOT_A_DIRECTORY"
        );
      } finally {
        fs.rmSync(tmpFile, { force: true });
      }
    });
  });
});
