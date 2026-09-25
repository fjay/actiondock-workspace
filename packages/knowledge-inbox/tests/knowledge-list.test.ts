import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime } from "@actiondock/testing";
import listAction from "../actions/knowledge-list.ts";

describe("knowledge.list", () => {
  it("returns empty items array when inbox directories do not exist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-list-empty-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const result = await runtime.run(listAction, {});
      assert.deepEqual(result.items, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("lists pending candidates and extracts rich frontmatter metadata sorted by date descending", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-list-pending-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });

      // File 1: Earlier date
      const file1 = path.join(pendingDir, "20260920-100000-111111-doc-one.md");
      fs.writeFileSync(
        file1,
        `---
title: Older Document
domain: network
tags:
  - tcp
created_at: '2026-09-20T10:00:00.000Z'
id: 20260920-111111
status: pending
---

# Older Document
Details here.`
      );

      // File 2: Later date
      const file2 = path.join(pendingDir, "20260924-120000-222222-doc-two.md");
      fs.writeFileSync(
        file2,
        `---
title: Newer Document
domain: database
tags:
  - postgres
created_at: '2026-09-24T12:00:00.000Z'
id: 20260924-222222
status: pending
---

# Newer Document
Details here.`
      );

      const result = await runtime.run(listAction, { status: "pending" });

      assert.equal(result.items.length, 2);
      // Sorted descending: file2 first, then file1
      assert.equal(result.items[0].id, "20260924-222222");
      assert.equal(result.items[0].title, "Newer Document");
      assert.equal(result.items[0].domain, "database");
      assert.deepEqual(result.items[0].tags, ["postgres"]);
      assert.equal(result.items[0].status, "pending");
      assert.equal(result.items[0].year, "2026");

      assert.equal(result.items[1].id, "20260920-111111");
      assert.equal(result.items[1].title, "Older Document");
      assert.equal(result.items[1].domain, "network");
      assert.deepEqual(result.items[1].tags, ["tcp"]);
      assert.equal(result.items[1].status, "pending");
      assert.equal(result.items[1].year, "2026");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("lists processed documents from nested year and resolution subdirectories with year filtering", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-list-proc-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const dir2026 = path.join(tmpDir, "processed", "2026", "accepted");
      const dir2025 = path.join(tmpDir, "processed", "2025", "rejected");
      fs.mkdirSync(dir2026, { recursive: true });
      fs.mkdirSync(dir2025, { recursive: true });

      const fileAccepted = path.join(dir2026, "20260924-110000-aaa111-accepted-doc.md");
      fs.writeFileSync(
        fileAccepted,
        `---
title: Accepted Doc
id: 20260924-aaa111
status: processed
resolution: accepted
created_at: '2026-09-24T11:00:00.000Z'
archived_at: '2026-09-24T11:30:00.000Z'
archive_note: Approved for production runbook
---

Content`
      );

      const fileRejected = path.join(dir2025, "20250924-100000-bbb222-rejected-doc.md");
      fs.writeFileSync(
        fileRejected,
        `---
title: Rejected Doc
id: 20250924-bbb222
status: processed
resolution: rejected
created_at: '2025-09-24T10:00:00.000Z'
archived_at: '2025-09-24T10:15:00.000Z'
archive_note: Not reproducible
---

Content`
      );

      // 1. Scan without year filter (full scan across all years)
      const resultAllYears = await runtime.run(listAction, { status: "processed" });

      assert.equal(resultAllYears.items.length, 2);
      assert.equal(resultAllYears.items[0].id, "20260924-aaa111");
      assert.equal(resultAllYears.items[0].resolution, "accepted");
      assert.equal(resultAllYears.items[0].archiveNote, "Approved for production runbook");
      assert.equal(resultAllYears.items[0].status, "processed");
      assert.equal(resultAllYears.items[0].year, "2026");

      assert.equal(resultAllYears.items[1].id, "20250924-bbb222");
      assert.equal(resultAllYears.items[1].resolution, "rejected");
      assert.equal(resultAllYears.items[1].status, "processed");
      assert.equal(resultAllYears.items[1].year, "2025");

      // 2. Query filtered by year="2026"
      const result2026 = await runtime.run(listAction, { status: "processed", year: "2026" });
      assert.equal(result2026.items.length, 1);
      assert.equal(result2026.items[0].id, "20260924-aaa111");
      assert.equal(result2026.items[0].year, "2026");

      // 3. Query filtered by year="2025"
      const result2025 = await runtime.run(listAction, { status: "processed", year: "2025" });
      assert.equal(result2025.items.length, 1);
      assert.equal(result2025.items[0].id, "20250924-bbb222");
      assert.equal(result2025.items[0].year, "2025");

      // 4. Query with non-existent year
      const resultNone = await runtime.run(listAction, { status: "processed", year: "2020" });
      assert.equal(resultNone.items.length, 0);

      // 5. Query with invalid year format
      await assert.rejects(
        () => runtime.run(listAction, { year: "invalid-year" }),
        (err: any) => err.code === "INVALID_YEAR"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("lists all documents across pending and processed when status is 'all', and supports year filtering", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-list-all-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      const processedDir = path.join(tmpDir, "processed", "2026", "duplicate");
      const processedOldDir = path.join(tmpDir, "processed", "2024", "accepted");
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(processedDir, { recursive: true });
      fs.mkdirSync(processedOldDir, { recursive: true });

      fs.writeFileSync(
        path.join(pendingDir, "20260924-110000-p11111-pending-doc.md"),
        `---
id: 20260924-p11111
status: pending
created_at: '2026-09-24T11:00:00.000Z'
---
# Pending Doc`
      );

      fs.writeFileSync(
        path.join(processedDir, "20260924-120000-d22222-dup-doc.md"),
        `---
id: 20260924-d22222
status: processed
resolution: duplicate
created_at: '2026-09-24T12:00:00.000Z'
---
# Duplicate Doc`
      );

      fs.writeFileSync(
        path.join(processedOldDir, "20240101-090000-old111-old-doc.md"),
        `---
id: 20240101-old111
status: processed
resolution: accepted
created_at: '2024-01-01T09:00:00.000Z'
---
# Old Doc`
      );

      // All documents across all years
      const resultAll = await runtime.run(listAction, { status: "all" });
      assert.equal(resultAll.items.length, 3);
      assert.equal(resultAll.items[0].id, "20260924-d22222");
      assert.equal(resultAll.items[0].status, "processed");
      assert.equal(resultAll.items[0].year, "2026");
      assert.equal(resultAll.items[1].id, "20260924-p11111");
      assert.equal(resultAll.items[1].status, "pending");
      assert.equal(resultAll.items[1].year, "2026");
      assert.equal(resultAll.items[2].id, "20240101-old111");
      assert.equal(resultAll.items[2].year, "2024");

      // Filtered to year 2026 only
      const result2026 = await runtime.run(listAction, { status: "all", year: "2026" });
      assert.equal(result2026.items.length, 2);
      assert.equal(result2026.items[0].id, "20260924-d22222");
      assert.equal(result2026.items[1].id, "20260924-p11111");

      // Filtered to year 2024 only
      const result2024 = await runtime.run(listAction, { status: "all", year: "2024" });
      assert.equal(result2024.items.length, 1);
      assert.equal(result2024.items[0].id, "20240101-old111");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maintains backward compatibility with legacy non-year processed directories", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-list-legacy-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const legacyDir = path.join(tmpDir, "processed", "duplicate");
      fs.mkdirSync(legacyDir, { recursive: true });

      fs.writeFileSync(
        path.join(legacyDir, "20260924-120000-d22222-dup-doc.md"),
        `---
id: 20260924-d22222
status: processed
created_at: '2026-09-24T12:00:00.000Z'
---
# Duplicate Doc`
      );

      const result = await runtime.run(listAction, { status: "processed" });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].id, "20260924-d22222");
      assert.equal(result.items[0].resolution, "duplicate");
      assert.equal(result.items[0].year, "2026");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("gracefully parses markdown files without frontmatter or with raw headings", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-list-raw-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });

      fs.writeFileSync(
        path.join(pendingDir, "20260924-150000-c33333-raw-note.md"),
        "# Raw Heading Without YAML\n\nSome body text."
      );

      const result = await runtime.run(listAction, { status: "pending" });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].id, "20260924-c33333");
      assert.equal(result.items[0].title, "Raw Heading Without YAML");
      assert.equal(result.items[0].status, "pending");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
