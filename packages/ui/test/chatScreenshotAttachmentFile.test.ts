// 选区截图 → composer 附件的转换回归：截图必须落成带真实 PNG 头的 image/png File，
// 走与粘贴/上传相同的 addAttachmentFiles 链路（spec：specs/composer-screen-capture.md）。
// 纯数据模块，可用 tsx --test --tsconfig packages/ui/tsconfig.json 独立运行。
import assert from "node:assert/strict";
import test from "node:test";

import { createScreenshotAttachmentFile } from "../src/lib/chatAttachments.js";

// 1x1 PNG。
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("截图结果转 image/png File，保留文件名与内容类型", async () => {
  const file = createScreenshotAttachmentFile({
    ok: true,
    dataBase64: PNG_1X1_BASE64,
    filename: "zcode-screenshot-2026-09-28T00-00-00-000Z.png",
    contentType: "image/png",
    size: 70,
    width: 1,
    height: 1,
  });
  assert.equal(file.name, "zcode-screenshot-2026-09-28T00-00-00-000Z.png");
  assert.equal(file.type, "image/png");
  const bytes = Buffer.from(await file.arrayBuffer());
  // PNG 魔数：89 50 4E 47（\x89PNG），证明 base64 被原样还原为二进制。
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(bytes.byteLength, file.size);
});

test("非 image 的 contentType 回落为 image/png，File.type 不为空", async () => {
  const file = createScreenshotAttachmentFile({
    ok: true,
    dataBase64: PNG_1X1_BASE64,
    filename: "zcode-screenshot.png",
    contentType: "application/octet-stream",
    size: 70,
    width: 1,
    height: 1,
  });
  assert.equal(file.type, "image/png");
});
