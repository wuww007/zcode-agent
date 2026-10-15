// MCP App sampling 边界（移植自官方 v3.15.1 mcp-apps/sampling.test.ts，vitest → node:test）。
// 可独立运行：
//   npx tsx --test packages/shared/src/mcp-apps/sampling.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpAppsSamplingParamsSchema } from "./sampling.js";

const base = {
  messages: [{ role: "user", content: { type: "text", text: "Explain fractions" } }],
  maxTokens: 200,
};

describe("MCP App sampling boundary", () => {
  it("accepts ordered text/image messages and advisory model hints", () => {
    assert.partialDeepStrictEqual(
      mcpAppsSamplingParamsSchema.parse({
        ...base,
        modelPreferences: { hints: [{ name: "other-model" }] },
      }),
      base,
    );
    assert.equal(
      mcpAppsSamplingParamsSchema.safeParse({
        ...base,
        messages: [
          { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AQ==" }] },
        ],
      }).success,
      true,
    );
  });

  for (const extra of [
    { tools: [] },
    { includeContext: "allServers" },
    { temperature: 0 },
    { stopSequences: [] },
    { providerId: "injected" },
    { maxTokens: 0 },
  ]) {
    it(`rejects unsupported input ${JSON.stringify(extra)}`, () => {
      assert.equal(mcpAppsSamplingParamsSchema.safeParse({ ...base, ...extra }).success, false);
    });
  }

  for (const content of [
    { type: "audio", data: "AQ==", mimeType: "audio/wav" },
    { type: "resource_link", uri: "file:///secret" },
    { type: "image", mimeType: "image/png", data: "invalid!" },
    { type: "image", mimeType: "image/svg+xml", data: "AQ==" },
  ]) {
    it(`rejects unsupported or malformed block ${content.type}`, () => {
      assert.equal(
        mcpAppsSamplingParamsSchema.safeParse({ ...base, messages: [{ role: "user", content }] })
          .success,
        false,
      );
    });
  }

  it("bounds total blocks, UTF-8 text, metadata and decoded image bytes", () => {
    const parse = (messages: unknown[], extra = {}) =>
      mcpAppsSamplingParamsSchema.safeParse({ ...base, messages, ...extra });
    const blocks = Array.from({ length: 65 }, () => ({ type: "text", text: "x" }));
    assert.equal(parse([{ role: "user", content: blocks }]).success, false);
    assert.equal(
      parse([{ role: "user", content: { type: "text", text: "数".repeat(3 * 1024 * 1024) } }])
        .success,
      false,
    );
    assert.equal(
      parse(base.messages, { metadata: { payload: "x".repeat(8 * 1024 * 1024) } }).success,
      false,
    );
    const data = Buffer.alloc(4 * 1024 * 1024).toString("base64");
    assert.equal(
      parse([{ role: "user", content: { type: "image", mimeType: "image/png", data } }]).success,
      true,
    );
    assert.equal(
      parse([
        { role: "user", content: { type: "image", mimeType: "image/png", data: data + "AAAA" } },
      ]).success,
      false,
    );
  });
});
