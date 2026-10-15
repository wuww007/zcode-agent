// Host 账号身份绑定（移植自官方 v3.15.1，vitest → node:test）。
// 可独立运行：
//   npx tsx --test packages/services/src/plugin-ui-bridge/instanceAccounts.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPluginUiAccountBindings } from "./instanceAccounts.js";
const instance = { runtimeId: "agent", generation: 1, token: "one", appIdentity: "a".repeat(64) };
const params = {
  workspacePath: "/w",
  sessionId: "s",
  pluginId: "p",
  serverName: "server",
  scopeId: "view",
  resourceUri: "ui://app",
  ownerWebContentsId: 1,
};

test("uses stable account facts and revokes only captured old credentials", async () => {
  let account = "alice";
  const closeCalls: unknown[] = [];
  const openCalls: unknown[] = [];
  const owner = createPluginUiAccountBindings({
    readAccount: async () => ["provider", account],
    open: async (input) => {
      openCalls.push(input);
      return instance;
    },
    close: async (input) => {
      closeCalls.push(input);
    },
  });
  await owner.open(params);
  await owner.open(params);
  assert.deepStrictEqual(openCalls[0], openCalls[1]);
  owner.invalidate();
  account = "bob";
  await owner.open(params);
  assert.notDeepStrictEqual(openCalls[2], openCalls[0]);
  assert.deepStrictEqual(closeCalls, [{ ...params, instance }]);
});

test("closes an open result arriving after account revocation", async () => {
  const gate = Promise.withResolvers<typeof instance>();
  const entered = Promise.withResolvers<void>();
  const closeCalls: unknown[] = [];
  const owner = createPluginUiAccountBindings({
    readAccount: async () => "alice",
    open: () => {
      entered.resolve();
      return gate.promise;
    },
    close: async (input) => {
      closeCalls.push(input);
    },
  });
  const pending = owner.open(params);
  const rejected = assert.rejects(pending, /account changed/);
  await entered.promise;
  owner.invalidate();
  gate.resolve(instance);
  await rejected;
  assert.deepStrictEqual(closeCalls, [{ ...params, instance }]);
});
