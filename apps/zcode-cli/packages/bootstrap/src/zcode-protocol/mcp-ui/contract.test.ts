// mcp-ui 契约示例（移植自官方 v3.15.1，vitest → node:test）。
// 可独立运行：
//   npx tsx --test apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/contract.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { McpUiServerScopeError } from "./contract.js";
import { createExampleSessionAccess } from "./contract.example.js";

test("示例 session 视图按 serverName 判定归属", async () => {
  const access = createExampleSessionAccess();
  assert.equal(await access.hasMcpServer("plugin:example-plugin:widget"), true);
  assert.equal(await access.hasMcpServer("plugin:other:srv"), false);
});

test("越权错误映射为 -32602", () => {
  const error = new McpUiServerScopeError("plugin:other:srv");
  assert.equal(error.code, -32602);
  assert.ok(error.message.includes("is not available in this session"));
});
