// mcp-apps 协议契约与 toolMeta 归一化（移植自官方 v3.15.1 mcp-apps/contract.test.ts，
// vitest → node:test）。可独立运行：
//   npx tsx --test packages/shared/src/mcp-apps/contract.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_RESOURCE_MIME_TYPE,
  MCP_APPS_UI_RESOURCE_SCHEME,
  MCP_APPS_LEGACY_RESOURCE_URI_META_KEY,
  buildMcpAppsClientCapabilities,
  isMcpAppsUiReadResourceMimeAllowed,
} from "./contract.js";
import { normalizeMcpAppCspRelaxations, normalizeMcpToolUiMeta } from "./toolMeta.js";
import {
  exampleClientCapabilities,
  exampleResourceMetaWithRelaxations,
  exampleSandboxHandle,
  exampleToolUiDescriptor,
} from "./contract.example.js";

describe("mcp-apps-protocol contract", () => {
  for (const [label, mimeType] of [
    ["PDF 文档", " Application/PDF ; version=1.7 "],
    ["办公文档", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["电子表格", "application/vnd.ms-excel"],
    ["开放演示文档", "application/vnd.oasis.opendocument.presentation"],
    ["矢量图片", "image/svg+xml; charset=utf-8"],
    ["相机图片", "image/heic"],
    ["动画图片", "image/gif"],
    ["音频", "audio/mpeg"],
    ["WAV 别名", "audio/x-wav"],
    ["视频", "video/mp4"],
    ["归档", "application/zip"],
    ["GZIP 别名", "application/x-gzip"],
    ["字体", "font/woff2"],
    ["结构化数据", "application/yaml"],
    ["JSON 模型", "model/gltf+json"],
    ["已有文本前缀", "text/csv; charset=utf-8"],
    ["已有二进制", "application/octet-stream"],
    ["已有模型", "model/gltf-binary"],
  ] as const) {
    it(`页面资源接纳${label}（${mimeType}）`, () => {
      assert.equal(isMcpAppsUiReadResourceMimeAllowed(mimeType), true);
    });
  }

  for (const mimeType of [
    "application/x-msdownload",
    "application/x-executable",
    "application/vnd.example.unknown",
    "image/x-example-unknown",
    "application/pdf-malware",
    "application/pdf,application/x-msdownload",
    "",
    " ; charset=utf-8",
  ]) {
    it(`资源扩容仍拒绝未知或不合法 MIME：${JSON.stringify(mimeType)}`, () => {
      assert.equal(isMcpAppsUiReadResourceMimeAllowed(mimeType), false);
    });
  }

  it("扩展标识与 UI 资源 mimeType 与官方 SDK 常量一致", () => {
    assert.equal(MCP_APPS_EXTENSION_ID, "io.modelcontextprotocol/ui");
    assert.equal(MCP_APPS_RESOURCE_MIME_TYPE, "text/html;profile=mcp-app");
    assert.equal(MCP_APPS_LEGACY_RESOURCE_URI_META_KEY, "ui/resourceUri");
    assert.deepStrictEqual(buildMcpAppsClientCapabilities(), exampleClientCapabilities);
  });

  it("resourceUri 同时接受标准键、弃用扁平键与 openai/outputTemplate", () => {
    assert.equal(
      normalizeMcpToolUiMeta({ ui: { resourceUri: "ui://a/b" } })?.resourceUri,
      "ui://a/b",
    );
    assert.equal(normalizeMcpToolUiMeta({ "ui/resourceUri": "ui://a/c" })?.resourceUri, "ui://a/c");
    assert.equal(
      normalizeMcpToolUiMeta({ "openai/outputTemplate": "ui://a/d" })?.resourceUri,
      "ui://a/d",
    );
    assert.equal(normalizeMcpToolUiMeta({ ui: { resourceUri: "https://a/b" } }), null);
  });

  it("zcode/csp 只认已知布尔键", () => {
    assert.deepStrictEqual(normalizeMcpAppCspRelaxations(exampleResourceMetaWithRelaxations), {
      unsafeEval: true,
    });
    assert.equal(
      normalizeMcpAppCspRelaxations({ "zcode/csp": { unsafeEval: false, other: true } }),
      null,
    );
  });

  it("示例描述与句柄满足契约形状", () => {
    assert.equal(exampleToolUiDescriptor.resourceUri.startsWith(MCP_APPS_UI_RESOURCE_SCHEME), true);
    assert.equal(
      exampleSandboxHandle.shellUrl,
      `zcode-sandbox://shell-${exampleSandboxHandle.sandboxId}/`,
    );
    assert.equal(exampleSandboxHandle.partition.startsWith("persist:plugin-sandbox-"), true);
  });
});
