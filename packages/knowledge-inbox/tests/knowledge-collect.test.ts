import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime } from "@actiondock/testing";
import collectAction from "../actions/knowledge-collect.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";

describe("knowledge.collect", () => {
  it("rejects empty or whitespace-only content with 400 error", async () => {
    const runtime = createTestRuntime();

    await assert.rejects(
      () => runtime.run(collectAction, { content: "" }),
      (err: any) => err.code === "CONTENT_REQUIRED"
    );

    await assert.rejects(
      () => runtime.run(collectAction, { content: "   \n\t  " }),
      (err: any) => err.code === "CONTENT_REQUIRED"
    );
  });

  it("successfully collects raw markdown without frontmatter, auto-injecting metadata and inferring heading title", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-raw-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `# MySQL Deadlock Investigation
When running concurrent transactions under REPEATABLE READ, lock escalations can trigger deadlock 1213.
Check SHOW ENGINE INNODB STATUS.`;

      const result = await runtime.run(collectAction, {
        content,
        filename: "mysql-deadlock",
      });

      assert.ok(result.id);
      assert.match(result.id, /^\d{8}-[0-9a-f]{6}$/);
      assert.equal(result.status, "pending");
      assert.match(result.filename, /^\d{8}-\d{6}-[0-9a-f]{6}-mysql-deadlock\.md$/);
      assert.equal(result.path, path.join(tmpDir, "pending", result.filename));

      // Verify file exists on disk
      assert.ok(fs.existsSync(result.path));
      const fileText = fs.readFileSync(result.path, "utf-8");

      // Verify enriched frontmatter
      const parsed = parseFrontmatter(fileText);
      assert.equal(parsed.hasFrontmatter, true);
      assert.equal(parsed.data.id, result.id);
      assert.equal(parsed.data.status, "pending");
      assert.equal(parsed.data.title, "MySQL Deadlock Investigation");
      assert.ok(parsed.data.created_at);
      assert.match(parsed.body, /# MySQL Deadlock Investigation/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves existing frontmatter fields while appending/overriding server metadata", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-fm-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `---
title: Custom Frontmatter Document
domain: storage
tags:
  - ceph
  - s3
customField: preserved
status: old_status
id: fake_old_id
---

## Incident Summary
Object storage latency spiked due to disk scrub operations.`;

      const result = await runtime.run(collectAction, {
        content,
      });

      assert.equal(result.status, "pending");
      assert.match(result.filename, /^\d{8}-\d{6}-[0-9a-f]{6}-Custom-Frontmatter-Document\.md$/);

      const fileText = fs.readFileSync(result.path, "utf-8");
      const parsed = parseFrontmatter(fileText);

      assert.equal(parsed.data.title, "Custom Frontmatter Document");
      assert.equal(parsed.data.domain, "storage");
      assert.deepEqual(parsed.data.tags, ["ceph", "s3"]);
      assert.equal(parsed.data.customField, "preserved");
      assert.equal(parsed.data.status, "pending"); // Overwritten by server
      assert.equal(parsed.data.id, result.id); // Overwritten by server
      assert.ok(parsed.data.created_at);
      assert.match(parsed.body, /## Incident Summary/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sanitizes suggested filenames and strictly prevents directory traversal", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-traversal-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = "Direct troubleshooting content without headers.";
      const result = await runtime.run(collectAction, {
        content,
        filename: "../../../etc/passwd.md",
      });

      assert.ok(result.filename.endsWith("-passwd.md"));
      assert.equal(path.dirname(result.path), path.join(tmpDir, "pending"));
      assert.ok(fs.existsSync(result.path));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to 'candidate' when no filename, heading, or title is provided", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-fallback-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = "No title, no headings, just bare notes.";
      const result = await runtime.run(collectAction, {
        content,
      });

      assert.match(result.filename, /^\d{8}-\d{6}-[0-9a-f]{6}-candidate\.md$/);
      assert.ok(fs.existsSync(result.path));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("successfully collects candidate with single repo, persisting both repos and repo to frontmatter and output", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-single-repo-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `# Order Payment Timeout
When order-service fails to reach payment-service, check RPC timeout settings.`;

      const result = await runtime.run(collectAction, {
        content,
        repo: "order-service",
        filename: "order-payment-timeout",
      });

      assert.equal(result.status, "pending");
      assert.equal(result.repo, "order-service");
      assert.deepEqual(result.repos, ["order-service"]);

      const fileText = fs.readFileSync(result.path, "utf-8");
      const parsed = parseFrontmatter(fileText);

      assert.equal(parsed.data.repo, "order-service");
      assert.deepEqual(parsed.data.repos, ["order-service"]);
      assert.equal(parsed.data.title, "Order Payment Timeout");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("successfully collects candidate with multi-repo array, persisting repos to frontmatter and output", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-multi-repos-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `# Distributed Transaction Compensation
Saga pattern failure between order-service and payment-service.`;

      const result = await runtime.run(collectAction, {
        content,
        repos: ["order-service", "payment-service"],
        filename: "saga-compensation",
      });

      assert.equal(result.status, "pending");
      assert.deepEqual(result.repos, ["order-service", "payment-service"]);
      assert.equal(result.repo, undefined);

      const fileText = fs.readFileSync(result.path, "utf-8");
      const parsed = parseFrontmatter(fileText);

      assert.deepEqual(parsed.data.repos, ["order-service", "payment-service"]);
      assert.equal(parsed.data.repo, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports comma-separated repo string input", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-comma-repo-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = "Cross-service latency troubleshooting notes.";
      const result = await runtime.run(collectAction, {
        content,
        repo: "order-service, payment-service",
      });

      assert.deepEqual(result.repos, ["order-service", "payment-service"]);
      assert.equal(result.repo, undefined);

      const fileText = fs.readFileSync(result.path, "utf-8");
      const parsed = parseFrontmatter(fileText);
      assert.deepEqual(parsed.data.repos, ["order-service", "payment-service"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("extracts and normalizes repos from existing markdown frontmatter when input does not specify repo", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-fm-repos-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `---
title: System Knowledge SOP
repo: system-knowledge
---
# System Knowledge SOP
Standard maintenance procedures.`;

      const result = await runtime.run(collectAction, { content });

      assert.equal(result.repo, "system-knowledge");
      assert.deepEqual(result.repos, ["system-knowledge"]);

      const fileText = fs.readFileSync(result.path, "utf-8");
      const parsed = parseFrontmatter(fileText);
      assert.equal(parsed.data.repo, "system-knowledge");
      assert.deepEqual(parsed.data.repos, ["system-knowledge"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maintains complete backward compatibility when repo/repos are omitted", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-collect-compat-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const content = `# Standalone Note
No repository associated.`;

      const result = await runtime.run(collectAction, { content });

      assert.equal(result.repo, undefined);
      assert.equal(result.repos, undefined);

      const fileText = fs.readFileSync(result.path, "utf-8");
      const parsed = parseFrontmatter(fileText);
      assert.equal(parsed.data.repo, undefined);
      assert.equal(parsed.data.repos, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
