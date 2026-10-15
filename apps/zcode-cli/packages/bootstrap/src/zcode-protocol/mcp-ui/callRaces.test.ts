// 页面 ↔ MCP 调用的取消竞态（移植自官方 v3.15.1，vitest → node:test）。
// 可独立运行：
//   npx tsx --test apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/callRaces.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpAppProvidedToolDefinition, McpAppProvidedToolExecutor } from "@zcode/core";
import type { McpAppsAppToolCallRequest } from "@zcode/shared/mcp-apps";
import { McpUiAppToolRegistry } from "./appTools.js";
import { createExampleSessionAccess } from "./contract.example.js";
import { abortMcpUiToolCallsForSession, createMcpUiHandlers } from "./handlers.js";
const scope = {
  sessionId: "race",
  pluginId: "p",
  serverName: "plugin:example-plugin:widget",
  instance: { runtimeId: "agent", generation: 1, token: "token", appIdentity: "a".repeat(64) },
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const rejections = new Set<Promise<unknown>>();
const track = <T>(promise: Promise<T>): Promise<T> => {
  // 竞态断言必须等待完成，否则未捕获拒绝会把 node:test 判为失败。
  const guarded = promise.then(
    (value) => {
      rejections.delete(guarded);
      return value;
    },
    (error: unknown) => {
      rejections.delete(guarded);
      throw error;
    },
  );
  rejections.add(guarded);
  return guarded;
};

test("page to MCP cancellation", async (t) => {
  t.after(() => abortMcpUiToolCallsForSession(scope.sessionId));

  await t.test("cancels before admission without executing", async () => {
    const handlers = createMcpUiHandlers();
    const access = createExampleSessionAccess();
    let calls = 0;
    access.callTool = async () => {
      calls += 1;
      return { content: [] };
    };
    await handlers.cancelToolCall(access, { ...scope, callId: "early" });
    await assert.rejects(
      handlers.callTool(access, { ...scope, callId: "early", toolName: "test" }),
      /Duplicate/,
    );
    assert.equal(calls, 0);
  });

  await t.test("cancels while visibility/admission is pending, rejecting the late result", async () => {
    const gate = deferred<readonly ("app" | "model")[]>();
    const entered = deferred<void>();
    const access = createExampleSessionAccess();
    access.getToolVisibility = () => {
      entered.resolve();
      return gate.promise;
    };
    let calls = 0;
    access.callTool = async () => {
      calls += 1;
      return { content: [] };
    };
    const handlers = createMcpUiHandlers();
    const pending = track(handlers.callTool(access, { ...scope, callId: "pending", toolName: "test" }));
    await entered.promise;
    await handlers.cancelToolCall(access, { ...scope, callId: "pending" });
    gate.resolve(["app"]);
    await assert.rejects(pending);
    assert.equal(calls, 0);
  });

  await t.test("propagates cancellation to execution and refuses a late success or duplicate execution", async () => {
    const result = deferred<{ content: [] }>();
    const entered = deferred<void>();
    let signal: AbortSignal | undefined;
    const access = createExampleSessionAccess();
    access.getToolVisibility = async () => ["app"];
    access.callTool = async (_server, _tool, _args, options) => {
      signal = options?.signal;
      entered.resolve();
      return result.promise;
    };
    const handlers = createMcpUiHandlers();
    const params = { ...scope, callId: "running", toolName: "test" };
    const pending = track(handlers.callTool(access, params));
    await entered.promise;
    await handlers.cancelToolCall(access, params);
    assert.equal(signal?.aborted, true);
    result.resolve({ content: [] });
    await assert.rejects(pending);
    await assert.rejects(handlers.callTool(access, params), /Duplicate/);
  });
});

test("model to page cancellation", async (t) => {
  t.after(() => abortMcpUiToolCallsForSession(scope.sessionId));
  for (const claimed of [false, true])
    await t.test(`has one terminal outcome when cancelled ${claimed ? "after" : "before"} claim`, async () => {
      let execute!: McpAppProvidedToolExecutor;
      let definitions: readonly McpAppProvidedToolDefinition[] = [];
      const messages: McpAppsAppToolCallRequest[] = [];
      const registry = new McpUiAppToolRegistry({
        applyTools: (_session, tools, run) => {
          definitions = tools;
          execute = run;
          return tools.map((tool) => tool.modelName);
        },
        publishCall: (_session, _target, call) => {
          messages.push(call);
        },
        createCallId: () => "model-call",
      });
      const params = { ...scope, scopeId: scope.instance.token, generation: 1 };
      registry.register({
        ...params,
        tools: [{ name: "increment", inputSchema: { type: "object" } }],
      });
      const cancel = new AbortController();
      const pending = track(
        execute(
          { definition: definitions[0]!, arguments: {}, toolCallId: "model" },
          { signal: cancel.signal },
        ),
      );
      if (claimed) assert.equal(registry.claim({ ...params, callId: "model-call" }), true);
      cancel.abort();
      await assert.rejects(pending, /cancelled/);
      assert.equal(
        messages.filter((message) => message.cancelled).length,
        1,
      );
      assert.equal(
        registry.resolve({ ...params, callId: "model-call", result: { content: [] } }),
        false,
      );
      assert.equal(registry.claim({ ...params, callId: "model-call" }), false);
      registry.clearSession(scope.sessionId);
    });
});
