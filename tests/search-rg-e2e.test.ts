import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

describe("workspace/search.rg end-to-end integration via ad CLI with real ripgrep", () => {
  it("executes real ripgrep process and returns actual matches on filesystem fixture", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-e2e-"));
    try {
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, "service.ts"), "export const payment = 1;\n");
      fs.writeFileSync(path.join(srcDir, "util.ts"), "export const PAYMENT_FEE = 2;\n");
      fs.writeFileSync(path.join(tmpDir, ".env"), "PAYMENT_KEY=secret\n");

      const stdout = execFileSync(
        "ad",
        [
          "run",
          "search.rg",
          "-c",
          `WORKSPACE_ROOT=${tmpDir}`,
          "--input",
          JSON.stringify({
            pattern: "payment|PAYMENT",
            "ignore-case": true,
          }),
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
        }
      );

      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.data.truncated, false);
      const matchedPaths = parsed.data.matches.map((m: any) => m.path).sort();
      assert.deepEqual(matchedPaths, ["src/service.ts", "src/util.ts"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects fixed-strings with real ripgrep", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-e2e-"));
    try {
      const file = path.join(tmpDir, "sample.ts");
      fs.writeFileSync(file, "const a = fn('hello.*');\nconst b = fn('hello');\n");

      const projectRoot = path.resolve(import.meta.dirname, "..");
      const stdout = execFileSync(
        "ad",
        [
          "run",
          "search.rg",
          "-c",
          `WORKSPACE_ROOT=${tmpDir}`,
          "--input",
          JSON.stringify({
            pattern: "hello.*",
            "fixed-strings": true,
          }),
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
        }
      );

      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.data.matches.length, 1);
      assert.equal(parsed.data.matches[0].line, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
