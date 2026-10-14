// ============================================================
// Provider model catalog
// ============================================================
// 按供应商已配置的协议拉取模型目录。URL / 请求头构造与正式 Model 执行链
// （model-execution.ts 的 toAiSdkProviderConfig / normalizeAnthropicBaseURL）保持同源，
// 避免「能聊天但拉不到目录」的两套协议理解。

import type { HttpClientPort } from "@zcode/contracts";
import { isHttpClientPortError } from "@zcode/contracts";
import { isApiKeyAccess, type ApiKeyAccessConfigObject } from "@zcode/provider";
import type {
  ProviderModelCatalogEntry,
  ProviderModelCatalogResult,
} from "@zcode/shared";

/** 模型目录请求的超时预算；目录响应体很小，不需要生成调用的长超时。 */
const CATALOG_TIMEOUT_MS = 20_000;
const CATALOG_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ANTHROPIC_VERSION_HEADER = "anthropic-version";
const ANTHROPIC_VERSION_VALUE = "2023-06-01";
const AUTHORIZATION_HEADER = "Authorization";
const API_KEY_HEADER = "x-api-key";

/**
 * 只声明构造请求必需读取的字段，不要求调用方持有已解析的完整 Registry 配置——
 * RegistryProviderConfig 是「完整已解析」类型（access.apiKey 必填），
 * 测试与部分装配点只有结构性配置。
 * access 用可辨识联合，isApiKeyAccess 才能窄化出 apiKey。
 */
export interface ProviderModelCatalogConfig {
  readonly access:
    | {
        readonly type: ApiKeyAccessConfigObject["type"];
        readonly apiKey?: string | null;
      }
    | { readonly type: string; readonly apiKey?: string | null };
  readonly api?: {
    readonly type?: string | null;
    readonly baseUrl?: string | null;
    readonly headers?: Readonly<Record<string, string>> | null;
  } | null;
}

export interface FetchProviderModelCatalogInput {
  readonly providerId: string;
  readonly config: ProviderModelCatalogConfig;
  readonly httpClient: HttpClientPort;
  readonly signal?: AbortSignal;
}

/**
 * 拉取供应商模型目录。失败以结构化结果返回，不向调用方抛出——
 * 与 ModelConnectivityResult 一致，调用方（协议层 / 设置页）按 code 分流文案。
 */
export async function fetchProviderModelCatalog(
  input: FetchProviderModelCatalogInput,
): Promise<ProviderModelCatalogResult> {
  const api = input.config.api;
  const baseUrl = api?.baseUrl?.trim();
  if (!baseUrl) {
    return unavailable("该供应商尚未配置接口地址");
  }
  if (!isApiKeyAccess(input.config.access) || !input.config.access.apiKey?.trim()) {
    return unavailable("该供应商尚未配置 API Key");
  }

  const request = buildCatalogRequest(input.config, baseUrl);
  if (request === undefined) {
    return {
      ok: false,
      error: { code: "unsupported-protocol", message: "该供应商的接口协议不支持拉取模型列表" },
    };
  }
  let response;
  try {
    response = await input.httpClient.request(
      {
        url: request.url,
        method: "GET",
        headers: request.headers,
        timeoutMs: CATALOG_TIMEOUT_MS,
        maxResponseBytes: CATALOG_MAX_RESPONSE_BYTES,
        // 不跟随重定向：HttpClientPort 仅在无代理/无自定义 CA 时真正 follow，
        // 否则走 node:http 完全不跟随——同一供应商在有无代理下行为会不一致。
        // 且 fetch 规范只剥离跨域的 Authorization，不剥离自定义的 x-api-key，
        // 跟随重定向存在把 key 诱导到其他主机的风险。3xx 一律按 network 失败。
        redirect: "manual",
      },
      { signal: input.signal },
    );
  } catch (error) {
    return transportFailure(error);
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      error: { code: "auth-failed", message: `接口鉴权失败（HTTP ${response.status}）` },
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      error: {
        code: "network",
        message: `接口返回 HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
      },
    };
  }

  const models = parseCatalogBody(response.body);
  if (models === undefined) {
    return {
      ok: false,
      error: { code: "invalid-response", message: "接口返回的模型列表无法解析" },
    };
  }
  if (models.length === 0) {
    // 空目录不能当成「全部删除」落盘：保留本地列表，让用户确认是接口问题还是真的下架。
    return { ok: false, error: { code: "empty-catalog", message: "接口未返回任何模型" } };
  }
  return { ok: true, models };
}

/** Anthropic 的 AI SDK provider 会在 baseURL 后追加 /messages，网关根地址必须在边界补齐 /v1。 */
export function normalizeAnthropicBaseURL(baseURL: string | undefined): string | undefined {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (pathname.toLowerCase().endsWith("/v1")) {
      url.pathname = pathname;
      return url.href;
    }

    url.pathname = `${pathname}/v1`;
    return url.href;
  } catch {
    const withoutTrailingSlash = trimmed.replace(/\/+$/u, "");
    return withoutTrailingSlash.toLowerCase().endsWith("/v1")
      ? withoutTrailingSlash
      : `${withoutTrailingSlash}/v1`;
  }
}

function buildCatalogRequest(
  config: ProviderModelCatalogConfig,
  baseUrl: string,
): { url: string; headers: Record<string, string> } | undefined {
  // isApiKeyAccess 同时接受 api-key 与 zhipu-coding-plan-api-key，与正式执行链同判。
  const apiKey = isApiKeyAccess(config.access) ? config.access.apiKey?.trim() : undefined;
  const configuredHeaders = { ...config.api?.headers };
  const headers: Record<string, string> = {};
  switch (config.api?.type) {
    case "anthropic-messages":
      headers[ANTHROPIC_VERSION_HEADER] = ANTHROPIC_VERSION_VALUE;
      if (apiKey) {
        headers[API_KEY_HEADER] = apiKey;
        // Anthropic 兼容网关会同时读取 x-api-key 和 Bearer Authorization；显式配置的保持优先。
        if (!hasHeader(configuredHeaders, AUTHORIZATION_HEADER)) {
          headers[AUTHORIZATION_HEADER] = `Bearer ${apiKey}`;
        }
      }
      return {
        url: joinModelsPath(normalizeAnthropicBaseURL(baseUrl) ?? baseUrl),
        headers: { ...headers, ...configuredHeaders },
      };
    case "openai-chat-completions":
    case "openai-responses":
      if (apiKey && !hasHeader(configuredHeaders, AUTHORIZATION_HEADER)) {
        headers[AUTHORIZATION_HEADER] = `Bearer ${apiKey}`;
      }
      return {
        url: joinModelsPath(baseUrl),
        headers: { ...headers, ...configuredHeaders },
      };
    default:
      // 未知协议不进猜测分支：正式执行链同样只支持这三种。
      return undefined;
  }
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) {
    return false;
  }
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
}

function joinModelsPath(baseUrl: string): string {
  // 必须按 URL 语义拼：字符串拼接会把 /models 吞进 query（baseUrl 带 ?token= 时），
  // 而正式执行链把 baseUrl 交给 AI SDK 按 URL 语义处理，两边要一致。
  try {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/models`;
    return url.toString();
  } catch {
    // 非绝对 URL（用户只填了 host 或相对路径）时退回字符串拼接，交给 HTTP 层报 invalid_url。
    return `${baseUrl.replace(/\/+$/u, "")}/models`;
  }
}

function parseCatalogBody(body: Uint8Array): ProviderModelCatalogEntry[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
  // 兼容三种常见形状：{ data: [...] }、{ models: [...] } 与顶层数组。
  // 顶层数组先判：isRecord 会排除数组，放在后面会把合法响应误判成无法解析。
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.data)
      ? parsed.data
      : isRecord(parsed) && Array.isArray(parsed.models)
        ? parsed.models
        : undefined;
  if (list === undefined) {
    return undefined;
  }
  const entries: ProviderModelCatalogEntry[] = [];
  for (const item of list) {
    const id = readModelId(item);
    if (id === undefined) {
      continue;
    }
    entries.push({ id });
  }
  return entries;
}

function readModelId(item: unknown): string | undefined {
  if (typeof item === "string") {
    const trimmed = item.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!isRecord(item)) {
    return undefined;
  }
  for (const key of ["id", "name"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(message: string): ProviderModelCatalogResult {
  return { ok: false, error: { code: "provider-unavailable", message } };
}

function transportFailure(error: unknown): ProviderModelCatalogResult {
  if (isHttpClientPortError(error)) {
    if (error.code === "timeout") {
      return { ok: false, error: { code: "timeout", message: "拉取模型列表超时" } };
    }
    if (error.code === "too_large") {
      return {
        ok: false,
        error: { code: "invalid-response", message: "接口返回的模型列表过大" },
      };
    }
    if (error.code === "egress_blocked") {
      return { ok: false, error: { code: "network", message: "接口地址被出网策略拦截" } };
    }
    return { ok: false, error: { code: "network", message: error.message } };
  }
  return {
    ok: false,
    error: { code: "network", message: error instanceof Error ? error.message : String(error) },
  };
}
