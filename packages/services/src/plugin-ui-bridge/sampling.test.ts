// 页面 sampling 的服务边界（移植自官方 v3.15.1，vitest → node:test）。
// 可独立运行：
//   npx tsx --test packages/services/src/plugin-ui-bridge/sampling.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPluginUiSamplingService } from "./pluginUiSamplingService.js";
import { exampleSample } from "./contract.example.js";
import { IPluginUiSamplingService } from "./samplingContract.js";
const scope = {
  workspacePath: "/repo",
  sessionId: "task",
  pluginId: "math",
  serverName: "math",
  instance: { runtimeId: "agent", generation: 1, token: "credential", appIdentity: "a".repeat(64) },
};

test("forwards the complete bound identity without transforming the result", async () => {
  const result = {
    role: "assistant" as const,
    model: "test",
    content: { type: "text" as const, text: "answer" },
    stopReason: "endTurn",
  };
  const sampleCalls: unknown[] = [];
  const cancelCalls: unknown[] = [];
  const service = createPluginUiSamplingService({
    sample: async (input) => {
      sampleCalls.push(input);
      return result;
    },
    cancelSampling: async (input) => {
      cancelCalls.push(input);
      return { cancelled: true };
    },
  });
  assert.equal(await exampleSample(service, scope), result);
  // 服务在转发时补上请求体（exampleSample 的 sampling 参数）；这里只校验身份三元组完整不变。
  const forwarded = sampleCalls[0] as Record<string, unknown>;
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(forwarded).filter(([key]) => key !== "request")),
    { ...scope, operationId: "sample-1" },
  );
  assert.ok(forwarded.request);
  await service.cancelSampling({ ...scope, operationId: "sample-1" });
  assert.deepStrictEqual(cancelCalls, [{ ...scope, operationId: "sample-1" }]);
  assert.equal(sampleCalls.length, 1);
  assert.equal(IPluginUiSamplingService.channelName, "plugin-ui-sampling");
});

test("fails closed when this runtime has no sampling implementation", async () => {
  const service = createPluginUiSamplingService();
  await assert.rejects(exampleSample(service, scope), (error: { code?: string }) => {
    assert.equal(error.code, "unavailable");
    return true;
  });
  assert.deepStrictEqual(await service.cancelSampling({ ...scope, operationId: "sample-1" }), {
    cancelled: false,
  });
});
