// 供应商模型目录拉取回归：URL / 请求头按 api.type 三分支，响应宽松解析，空目录不落盘。
// 只依赖同目录相对导入与注入的 HttpClientPort，可独立运行：
//   npx tsx --test apps/zcode-cli/packages/adapters/src/model/provider-model-catalog.test.ts
// 注意：仓库没有任何 runner 会自动跑这个文件。

import assert from "node:assert/strict";
import test from "node:test";
import { createHttpClientError } from "@zcode/contracts";
import type { HttpClientPort, HttpClientRequest, HttpClientResponse } from "@zcode/contracts";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  type ProviderApiType,
} from "@zcode/provider";
import {
  fetchProviderModelCatalog,
  type ProviderModelCatalogConfig,
} from "./provider-model-catalog.js";

interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function createHttpClient(
  handler: (request: HttpClientRequest) => HttpClientResponse | Error,
): { port: HttpClientPort; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const port: HttpClientPort = {
    async request(request) {
      requests.push({ url: request.url, headers: request.headers ?? {} });
      const result = handler(request);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
  return { port, requests };
}

function jsonResponse(body: unknown, status = 200): HttpClientResponse {
  return {
    url: "https://provider.example/v1/models",
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: {},
    body: new TextEncoder().encode(JSON.stringify(body)),
    bytes: 0,
    durationMs: 1,
  };
}

function createConfig(
  api: { type: ProviderApiType; baseUrl: string; headers?: Record<string, string> },
  apiKey = "test-only-key",
  accessType: "api-key" | "zhipu-coding-plan-api-key" = "api-key",
): ProviderModelCatalogConfig {
  // Registry 里的 access/api 是配置类实例，不是普通对象；测试必须按真实形态构造。
  return {
    access: new ApiKeyAccessConfig({ type: accessType, apiKey }),
    api: new ProviderApiConfig(api),
  };
}

test("zhipu-coding-plan-api-key 鉴权类型同样可以拉取目录", async () => {
  // zai-api 模板（模板选择器第一项）用的是这个 access.type；
  // isApiKeyAccess 同时接受 api-key 与它，与正式执行链同判。
  const { port, requests } = createHttpClient(() => jsonResponse({ data: [{ id: "GLM-5.3" }] }));
  const result = await fetchProviderModelCatalog({
    providerId: "custom",
    config: createConfig(
      { type: "openai-chat-completions", baseUrl: "https://provider.example/v1" },
      "test-only-key",
      "zhipu-coding-plan-api-key",
    ),
    httpClient: port,
  });
  assert.deepEqual(result, { ok: true, models: [{ id: "GLM-5.3" }] });
  assert.equal(requests[0]?.headers.Authorization, "Bearer test-only-key");
});

test("baseUrl 带 query 参数时 /models 拼到 path 上而不是 query 里", async () => {
  const { port, requests } = createHttpClient(() => jsonResponse({ data: [{ id: "m" }] }));
  await fetchProviderModelCatalog({
    providerId: "custom",
    config: createConfig({
      type: "openai-chat-completions",
      baseUrl: "https://provider.example/v1?token=abc",
    }),
    httpClient: port,
  });
  // 字符串拼接会得到 .../v1?token=abc/models，把路径吞进 query。
  assert.equal(requests[0]?.url, "https://provider.example/v1/models?token=abc");
});

test("baseUrl 带 query 时 anthropic 分支也拼到 path 上", async () => {
  const { port, requests } = createHttpClient(() => jsonResponse({ data: [{ id: "m" }] }));
  await fetchProviderModelCatalog({
    providerId: "custom",
    config: createConfig({
      type: "anthropic-messages",
      baseUrl: "https://gateway.example/anthropic?token=abc",
    }),
    httpClient: port,
  });
  assert.equal(requests[0]?.url, "https://gateway.example/anthropic/v1/models?token=abc");
});

test("openai-chat-completions 拉取 baseUrl 下的 /models 并带 Bearer 鉴权", async () => {
  const { port, requests } = createHttpClient(() =>
    jsonResponse({ data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] }),
  );
  const result = await fetchProviderModelCatalog({
    providerId: "custom",
    config: createConfig({
      type: "openai-chat-completions",
      baseUrl: "https://provider.example/v1/",
    }),
    httpClient: port,
  });
  assert.deepEqual(result, { ok: true, models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] });
  // 尾斜杠不能被拼成双斜杠。
  assert.equal(requests[0]?.url, "https://provider.example/v1/models");
  assert.equal(requests[0]?.headers.Authorization, "Bearer test-only-key");
});

test("openai-responses 与 openai-chat-completions 走同一 /models 约定", async () => {
  const { port, requests } = createHttpClient(() => jsonResponse({ data: [{ id: "o4" }] }));
  const result = await fetchProviderModelCatalog({
    providerId: "custom",
    config: createConfig({ type: "openai-responses", baseUrl: "https://provider.example/v1" }),
    httpClient: port,
  });
  assert.deepEqual(result, { ok: true, models: [{ id: "o4" }] });
  assert.equal(requests[0]?.url, "https://provider.example/v1/models");
});

test("anthropic-messages 补齐 /v1 并带 x-api-key 与 anthropic-version", async () => {
  const { port, requests } = createHttpClient(() =>
    jsonResponse({ data: [{ id: "claude-sonnet-4" }] }),
  );
  const result = await fetchProviderModelCatalog({
    providerId: "custom",
    // 与正式执行链同规：网关根地址也要补 /v1。
    config: createConfig({ type: "anthropic-messages", baseUrl: "https://gateway.example" }),
    httpClient: port,
  });
  assert.deepEqual(result, { ok: true, models: [{ id: "claude-sonnet-4" }] });
  assert.equal(requests[0]?.url, "https://gateway.example/v1/models");
  assert.equal(requests[0]?.headers["x-api-key"], "test-only-key");
  assert.equal(requests[0]?.headers["anthropic-version"], "2023-06-01");
});

test("用户自配 Authorization 不被覆盖，其余自配 header 合并", async () => {
  const { port, requests } = createHttpClient(() => jsonResponse({ data: [{ id: "m" }] }));
  await fetchProviderModelCatalog({
    providerId: "custom",
    config: createConfig({
      type: "openai-chat-completions",
      baseUrl: "https://provider.example/v1",
      headers: { Authorization: "Bearer user-key", "X-Trace": "on" },
    }),
    httpClient: port,
  });
  assert.equal(requests[0]?.headers.Authorization, "Bearer user-key");
  assert.equal(requests[0]?.headers["X-Trace"], "on");
});

test("兼容 { models: [...] } 与顶层数组、字符串项、name 字段", async () => {
  for (const body of [
    { models: [{ id: "a" }] },
    [{ id: "a" }],
    ["a"],
    [{ name: "a" }],
  ]) {
    const { port } = createHttpClient(() => jsonResponse(body));
    const result = await fetchProviderModelCatalog({
      providerId: "custom",
      config: createConfig({
        type: "openai-chat-completions",
        baseUrl: "https://provider.example/v1",
      }),
      httpClient: port,
    });
    assert.deepEqual(result, { ok: true, models: [{ id: "a" }] });
  }
});

test("空目录返回 empty-catalog，不清空本地列表", async () => {
  const { port } = createHttpClient(() => jsonResponse({ data: [] }));
  const result = await fetchProviderModelCatalog({
    providerId: "custom",
    config: createConfig({
      type: "openai-chat-completions",
      baseUrl: "https://provider.example/v1",
    }),
    httpClient: port,
  });
  assert.deepEqual(result, {
    ok: false,
    error: { code: "empty-catalog", message: "接口未返回任何模型" },
  });
});

test("401/403 归一为 auth-failed，其余非 2xx 归一为 network", async () => {
  for (const status of [401, 403]) {
    const { port } = createHttpClient(() => jsonResponse({}, status));
    const result = await fetchProviderModelCatalog({
      providerId: "custom",
      config: createConfig({
        type: "openai-chat-completions",
        baseUrl: "https://provider.example/v1",
      }),
      httpClient: port,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "auth-failed");
  }
  const { port } = createHttpClient(() => jsonResponse({}, 500));
  const result = await fetchProviderModelCatalog({
    providerId: "custom",
    config: createConfig({
      type: "openai-chat-completions",
      baseUrl: "https://provider.example/v1",
    }),
    httpClient: port,
  });
  assert.equal(result.ok === false && result.error.code, "network");
});

test("无法解析的响应体返回 invalid-response", async () => {
  const { port } = createHttpClient(() => ({
    url: "https://provider.example/v1/models",
    status: 200,
    statusText: "OK",
    headers: {},
    body: new TextEncoder().encode("<html>nope</html>"),
    bytes: 0,
    durationMs: 1,
  }));
  const result = await fetchProviderModelCatalog({
    providerId: "custom",
    config: createConfig({
      type: "openai-chat-completions",
      baseUrl: "https://provider.example/v1",
    }),
    httpClient: port,
  });
  assert.equal(result.ok === false && result.error.code, "invalid-response");
});

test("缺 Base URL / API Key 直接失败，不发请求", async () => {
  const noBaseUrl = createHttpClient(() => jsonResponse({ data: [] }));
  const missingBaseUrl = await fetchProviderModelCatalog({
    providerId: "custom",
    config: createConfig({ type: "openai-chat-completions", baseUrl: "" }),
    httpClient: noBaseUrl.port,
  });
  assert.equal(missingBaseUrl.ok === false && missingBaseUrl.error.code, "provider-unavailable");
  assert.deepEqual(noBaseUrl.requests, []);

  const noKey = createHttpClient(() => jsonResponse({ data: [] }));
  const missingKey = await fetchProviderModelCatalog({
    providerId: "custom",
    config: createConfig({ type: "openai-chat-completions", baseUrl: "https://x/v1" }, ""),
    httpClient: noKey.port,
  });
  assert.equal(missingKey.ok === false && missingKey.error.code, "provider-unavailable");
  assert.deepEqual(noKey.requests, []);
});

test("不受支持的协议返回 unsupported-protocol，不发请求", async () => {
  const { port, requests } = createHttpClient(() => jsonResponse({ data: [] }));
  const result = await fetchProviderModelCatalog({
    providerId: "custom",
    config: createConfig({
      // 正式执行链只支持三种；未知协议不能进猜测分支。
      type: "gemini-generate" as unknown as ProviderApiType,
      baseUrl: "https://provider.example/v1",
    }),
    httpClient: port,
  });
  assert.equal(result.ok === false && result.error.code, "unsupported-protocol");
  assert.deepEqual(requests, []);
});

test("HttpClientPort 超时错误归一为 timeout", async () => {
  const { port } = createHttpClient(() =>
    createHttpClientError({ code: "timeout", message: "HTTP request timed out after 20000ms" }),
  );
  const result = await fetchProviderModelCatalog({
    providerId: "custom",
    config: createConfig({
      type: "openai-chat-completions",
      baseUrl: "https://provider.example/v1",
    }),
    httpClient: port,
  });
  assert.equal(result.ok === false && result.error.code, "timeout");
});
