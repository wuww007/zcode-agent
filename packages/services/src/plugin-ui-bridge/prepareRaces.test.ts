// MCP App 沙箱准备的合并与隔离（移植自官方 v3.15.1，vitest → node:test）。
// 可独立运行：
//   npx tsx --test packages/services/src/plugin-ui-bridge/prepareRaces.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import { createPluginUiBridgeService } from "./pluginUiBridgeService.js";
const instance = { runtimeId: "agent", generation: 1, token: "token", appIdentity: "a".repeat(64) };
const params = {
  workspacePath: "/a",
  sessionId: "s",
  pluginId: "p",
  serverName: "m",
  scopeId: "surface:x",
  resourceUri: "ui://x",
  ownerWebContentsId: 1,
};

test("coalesces identical initialization but isolates server, workspace and resource", async () => {
  const openCalls: Array<typeof params & { workspaceIdentity?: string }> = [];
  const readCalls: Array<{ uri: string; instance: typeof instance }> = [];
  const registerCalls: PluginSandboxRegisterInput[] = [];
  const bridge = createPluginUiBridgeService({
    openInstance: async (p: typeof params & { workspaceIdentity?: string }) => {
      openCalls.push(p);
      return {
        ...instance,
        token: JSON.stringify([
          p.serverName,
          p.resourceUri,
          p.workspaceIdentity ?? p.workspacePath,
        ]),
      };
    },
    readMcpResource: async (input: { uri: string; instance: typeof instance }) => {
      readCalls.push(input);
      return { contents: [{ uri: input.uri, mimeType: "text/html", text: "<p>fixture</p>" }] };
    },
    registerSandbox: async (input: PluginSandboxRegisterInput) => {
      registerCalls.push(input);
      return {
        instance: input.instance,
        sandboxId: input.instance.token,
        initId: 1,
        shellUrl: "url",
        partition: "partition",
      };
    },
  });
  const a = bridge.prepareSandbox(params),
    b = bridge.prepareSandbox({ ...params });
  const first = await Promise.all([a, b]);
  assert.deepStrictEqual(first[0], first[1]);
  assert.equal(openCalls.length, 2);
  assert.equal(readCalls.length, 1);
  assert.equal(registerCalls.length, 1);
  const others = await Promise.all([
    bridge.prepareSandbox({ ...params, serverName: "other" }),
    bridge.prepareSandbox({ ...params, resourceUri: "ui://other" }),
    bridge.prepareSandbox({ ...params, workspaceIdentity: "other" }),
  ]);
  assert.equal(openCalls.length, 5);
  assert.equal(readCalls.length, 4);
  assert.equal(registerCalls.length, 4);
  assert.equal(new Set([first[0]!, ...others].map((handle) => handle.sandboxId)).size, 4);
  assert.deepStrictEqual(
    registerCalls.map((input) => input.instance.token),
    readCalls.map((input) => input.instance.token),
  );
});

test("revokes the credential when resource validation fails", async () => {
  const closeCalls: unknown[] = [];
  const bridge = createPluginUiBridgeService({
    openInstance: async () => instance,
    closeInstance: async (input) => {
      closeCalls.push(input);
    },
    readMcpResource: async () => ({ contents: [] }),
    registerSandbox: async () => {
      throw new Error("should not register");
    },
  });
  await assert.rejects(bridge.prepareSandbox(params), /no contents/);
  assert.deepStrictEqual(closeCalls, [{ ...params, instance }]);
});
