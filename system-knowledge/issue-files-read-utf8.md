# [Bug] files.read 误报 UNSUPPORTED_TEXT_ENCODING：UTF-8 校验的 8KB 采样边界会截断多字节字符

## 环境

- ActionDock CLI：2.5.1（npm 全局安装）
- 远端 workspace：profile `sk`（adserve workspace action），源码位于 `<workspace>/actions/files-read.ts`
- 运行环境：Linux / Node v25.x
- 触发文件：`system-knowledge/ddl/data-ddl-fi_cert.md`（47351 字节，中文密集的 Markdown 文档）

## 复现步骤

```bash
ad run files.read --profile sk -i '{"path":"system-knowledge/ddl/data-ddl-fi_cert.md"}'
```

返回：

```json
{
  "ok": false,
  "error": {
    "code": "UNSUPPORTED_TEXT_ENCODING",
    "message": "Non-UTF-8 text encoding is not supported"
  }
}
```

## 期望行为

正常返回文件前 200 行内容（该文件是合法 UTF-8 文本）。

## 实际行为

被判定为非 UTF-8 编码，拒绝读取并抛出 `UNSUPPORTED_TEXT_ENCODING`。

## 文件本身合法性验证

```bash
file data-ddl-fi_cert.md
# → data-ddl-fi_cert.md: UTF-8 Unicode text, with very long lines

iconv -f UTF-8 -t UTF-8 data-ddl-fi_cert.md > /dev/null && echo VALID
# → VALID

python3 -c "open('data-ddl-fi_cert.md','rb').read().decode('utf-8')"
# → 无异常（全量解码通过，无 BOM）
```

文件本身完全合法，错误由 `files.read` 的采样校验逻辑产生。

## 根因

`actions/files-read.ts` 的 `validateUtf8File()` 只读取文件**前 8192 字节**并使用 `new TextDecoder("utf-8", { fatal: true })` 进行同步完整解码判定。当第 8192 字节恰好落在多字节字符（如 3 字节汉字或 4 字节 emoji）的中间时，采样切片尾部会残缺未决字节，导致 `TextDecoder` 抛出解码异常，进而误判为非 UTF-8 文件：

```ts
function validateUtf8File(filePath: string, sizeBytes: number): void {
  if (sizeBytes === 0) return;

  const sampleSize = Math.min(sizeBytes, 8192);   // ← 固定 8192 采样边界
  const buffer = Buffer.alloc(sampleSize);
  const fd = fs.openSync(filePath, "r");
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, sampleSize, 0);
    const slice = buffer.subarray(0, bytesRead);
    // ...
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      decoder.decode(slice);                      // ← fatal 同步解码，尾部截断序列直接抛错！
    } catch {
      throw new WorkspaceError(
        "Non-UTF-8 text encoding is not supported",
        "UNSUPPORTED_TEXT_ENCODING",
        415
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}
```

## 字节级证据

该文件偏移 8186–8201 的原始字节：

```
00001fea: 31 e6 ad a3 e5 b8 b8 20 32 e7 bb b4 e6 8a a4 20  1...常 2...投
00001ffa: 33 e5 bc 82 e5 b8 b8 20 34 e5 ba 9f e5 bc 83 27  3异常 4级...'
```

拆解（对应中文「3 异常 4 级」）：

| 偏移 | 字节 | 字符 |
|---|---|---|
| 8187–8189 | `e5 bc 82` | 异 |
| 8190–8192 | `e5 b8 b8` | 常 |

采样范围是 `[0, 8192)`（最后一个被读入的字节是偏移 **8191**），因此「常」字只取到 `e5 b8`，**缺少第三个字节 `b8`**，`TextDecoder({ fatal: true })` 抛错 → 误报为非 UTF-8。

本地 Python 等价复现（同一文件）：

```python
>>> d = open('data-ddl-fi_cert.md','rb').read()
>>> len(d)
47351
>>> d[8186:8200].hex(' ')
'33 e5 bc 82 e5 b8 b8 20 34 e5 ba 9f e5 bc'
>>> d[:8192].decode('utf-8')
UnicodeDecodeError: 'utf-8' codec can't decode bytes in position 8190-8191: unexpected end of data
```

## 影响面

任何被 `files.read` 读取的文件，只要**第 8192 字节恰好落在多字节字符内部**（3 字节汉字、4 字节 emoji 等）就会误报。对中文注释/文档密集的仓库（DDL 快照、README、中文注释的源码）命中概率很高，且与文件内容是否合法无关；文件内容稍作改动（例如在前面增删几个字符改变偏移）就可能从「报错」变成「正常」，排查时极易被误导为编码问题。

## 建议修复（方案 A 增强版，一行改动）

利用 WHATWG 标准 `TextDecoder` 的 `stream` 模式：
- 当采样未读完整个文件（`bytesRead < sizeBytes`）时，开启 `{ stream: true }`，此时**未被后续字节补全的尾部残缺序列会被缓冲而不抛错**；而切片中间或尾部的非法字节依然会立刻抛错。
- 当小文件全量读完（`bytesRead === sizeBytes`）时，保持 `{ stream: false }`，对全文严格校验。

```ts
// actions/files-read.ts
function validateUtf8File(filePath: string, sizeBytes: number): void {
  if (sizeBytes === 0) {
    return;
  }
  const sampleSize = Math.min(sizeBytes, 8192);
  const buffer = Buffer.alloc(sampleSize);
  const fd = fs.openSync(filePath, "r");
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, sampleSize, 0);
    const slice = buffer.subarray(0, bytesRead);

    // Binary check: contains 0x00 null byte
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === 0) {
        throw new WorkspaceError(
          "Binary file is not supported",
          "UNSUPPORTED_BINARY_FILE",
          415
        );
      }
    }

    // UTF-8 validation
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      // 仅当采样未读完整个文件时允许尾部残缺序列缓冲，小文件全量读取依然严格校验
      decoder.decode(slice, { stream: bytesRead < sizeBytes });
    } catch {
      throw new WorkspaceError(
        "Non-UTF-8 text encoding is not supported",
        "UNSUPPORTED_TEXT_ENCODING",
        415
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}
```

## 补充单元测试建议（`tests/files-read.test.ts`）

```ts
it("reads file where UTF-8 multi-byte character crosses the 8KB sampling boundary", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-read-boundary-"));
  try {
    const file = path.join(tmpDir, "boundary.txt");
    // 8190 字节 ASCII + 3 字节中文（跨越 8192 采样边界，第 8192 字节为 '中' 的第 2 字节）
    const content = "a".repeat(8190) + "中文\n";
    fs.writeFileSync(file, content, "utf-8");

    const runtime = createTestRuntime({
      config: { WORKSPACE_ROOT: tmpDir },
    });

    const res = await runtime.run(filesReadAction, {
      path: "boundary.txt",
    });
    assert.equal(res.path, "boundary.txt");
    assert.ok(res.content.startsWith("a".repeat(100)));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

## 备注

- 同目录其他 DDL 快照（`data-ddl-vip_bfms_act.md`、`data-ddl-bf_member_register.md` 等）读取正常，仅 `data-ddl-fi_cert.md` 命中，进一步佐证是边界位置问题而非文件编码问题。
- 建议同时修正错误文案：当采样截断导致判定失败时，当前提示会误导用户去修文件编码。
