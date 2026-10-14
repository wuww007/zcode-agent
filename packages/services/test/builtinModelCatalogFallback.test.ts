// 兜底规则回归：config/provider/zcode-builtin.json 的 modelRules[0]（modelMatch ".*"）
// 是每个模型都会命中的兜底层。抬高它的取值会让「没有任何专用规则命中」的模型拿到
// 更激进的参数——包括那些靠兜底取值的在售模板模型。
// 这些模型的真实取值应以专用规则声明；在补齐之前，用显式规则把它们钉回原值，
// 避免一次兜底调整静默改变它们的请求行为。
// 运行：npx tsx --test packages/services/test/builtinModelCatalogFallback.test.ts
// 注意：仓库没有任何 runner 会自动跑这个文件。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ModelConfigRules,
  parseZCodeBuiltinModelConfigRules,
  parseZCodeBuiltinProviderConfigRules,
  type ModelConfig,
} from "@zcode/provider";

const builtinPath = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

function loadRules(): { rules: ModelConfigRules; raw: Record<string, never> } {
  const raw = JSON.parse(readFileSync(builtinPath, "utf8"));
  return { rules: parseZCodeBuiltinModelConfigRules(raw.config.modelConfigRules), raw };
}

/** 兜底层的取值；调整兜底时必须同步更新这里的期望。 */
const FALLBACK = {
  contextWindow: 1000000,
  supportsImage: true,
  maxOutputTokens: 128000,
} as const;

/** 这些在售模板模型没有声明这三个字段的专用规则，靠兜底取值；显式钉住以防兜底调整波及。 */
const PINNED: readonly { templateId: string; modelId: string }[] = [
  { templateId: "opencode-zen-chat", modelId: "big-pickle" },
  { templateId: "opencode-zen-chat", modelId: "hy3-free" },
  { templateId: "opencode-zen-chat", modelId: "ling-3.0-flash-fin-free" },
  { templateId: "opencode-zen-chat", modelId: "muse-spark-1.2-contributor-free" },
  { templateId: "opencode-zen-chat", modelId: "nemotron-3-ultra-free" },
  { templateId: "opencode-zen-chat", modelId: "nemotron-3.5-lightning-free" },
  { templateId: "opencode-zen-messages", modelId: "claude-opus-4-5" },
  { templateId: "opencode-zen-messages", modelId: "claude-opus-4-6" },
  { templateId: "opencode-zen-messages", modelId: "claude-opus-4-7" },
  { templateId: "opencode-zen-messages", modelId: "claude-opus-4-8" },
  { templateId: "opencode-zen-messages", modelId: "claude-sonnet-4-5" },
  { templateId: "opencode-zen-messages", modelId: "claude-sonnet-4-6" },
  { templateId: "opencode-zen-responses", modelId: "gpt-5.1" },
  { templateId: "opencode-zen-responses", modelId: "gpt-5.2" },
  { templateId: "opencode-zen-responses", modelId: "gpt-5.5" },
  { templateId: "opencode-zen-responses", modelId: "gpt-5.5-pro" },
  { templateId: "openrouter", modelId: "anthropic/claude-opus-4.5" },
  { templateId: "openrouter", modelId: "anthropic/claude-opus-4.6" },
  { templateId: "openrouter", modelId: "anthropic/claude-opus-4.7" },
  { templateId: "openrouter", modelId: "anthropic/claude-opus-4.8" },
  { templateId: "openrouter", modelId: "anthropic/claude-sonnet-4.5" },
  { templateId: "openrouter", modelId: "anthropic/claude-sonnet-4.6" },
  { templateId: "openrouter", modelId: "qwen/qwen3-vl-flash" },
];

/** 钉住值 = 调整兜底之前这些模型实际拿到的取值。 */
const PINNED_VALUES = {
  contextWindow: 200000,
  supportsImage: false,
  maxOutputTokens: 32000,
} as const;

function resolve(
  rules: ModelConfigRules,
  input: {
    providerId: string;
    templateId?: string;
    modelId: string;
    apiType?: string;
    baseUrl?: string;
  },
): ModelConfig {
  return ModelConfigRules.composeEffective(rules, ModelConfigRules.empty()).resolve(input);
}

test("兜底规则本身的取值符合预期", () => {
  const { rules } = loadRules();
  const fallback = rules.rules()[0];
  assert.ok(fallback);
  assert.equal(fallback.type, "model");
  assert.equal(fallback.modelMatch, ".*");
  const config = fallback.config.toJSON();
  assert.equal(config.properties?.contextWindow, FALLBACK.contextWindow);
  assert.equal(config.properties?.inputFormat?.supportsImage, FALLBACK.supportsImage);
  assert.equal(config.optionSpecs?.maxOutputTokens?.max, FALLBACK.maxOutputTokens);
  // reasoningLevel 档位不受兜底调整影响。
  assert.deepEqual(config.optionSpecs?.reasoningLevel?.values, ["disabled", "enabled"]);
});

test("被钉住的在售模板模型保持调整前的取值，不随兜底水涨船高", () => {
  const { rules, raw } = loadRules();
  const templateRules = raw.config.modelConfigRules.templateModelRules as {
    templateId: string;
    modelId: string;
  }[];
  for (const pin of PINNED) {
    const template = (
      raw.config.providerConfigRules.templateRules as {
        templateId: string;
        config: { api?: { type?: string; baseUrl?: string } };
      }[]
    ).find((item) => item.templateId === pin.templateId);
    assert.ok(template, `模板不存在: ${pin.templateId}`);
    const rule = templateRules.find(
      (item) => item.templateId === pin.templateId && item.modelId === pin.modelId,
    );
    assert.ok(rule, `缺少钉住规则: ${pin.templateId}/${pin.modelId}`);

    const config = resolve(rules, {
      providerId: `instance:${pin.templateId}`,
      templateId: pin.templateId,
      modelId: pin.modelId,
      apiType: template.config.api?.type,
      baseUrl: template.config.api?.baseUrl,
    }).toJSON();
    assert.equal(
      config.properties?.contextWindow,
      PINNED_VALUES.contextWindow,
      `${pin.templateId}/${pin.modelId} contextWindow 被兜底抬高了`,
    );
    assert.equal(
      config.properties?.inputFormat?.supportsImage,
      PINNED_VALUES.supportsImage,
      `${pin.templateId}/${pin.modelId} supportsImage 被兜底抬高了`,
    );
    assert.equal(
      config.optionSpecs?.maxOutputTokens?.max,
      PINNED_VALUES.maxOutputTokens,
      `${pin.templateId}/${pin.modelId} maxOutputTokens 被兜底抬高了`,
    );
  }
});

test("完全未知的模型才拿到激进兜底值", () => {
  const { rules } = loadRules();
  const config = resolve(rules, {
    providerId: "custom-example",
    modelId: "brand-new-unknown-model",
    apiType: "openai-chat-completions",
    baseUrl: "https://provider.example/v1",
  }).toJSON();
  assert.equal(config.properties?.contextWindow, FALLBACK.contextWindow);
  assert.equal(config.properties?.inputFormat?.supportsImage, FALLBACK.supportsImage);
  assert.equal(config.properties?.inputFormat?.supportsText, true);
  assert.equal(config.optionSpecs?.maxOutputTokens?.max, FALLBACK.maxOutputTokens);
  assert.deepEqual(config.optionSpecs?.reasoningLevel?.values, ["disabled", "enabled"]);
  // 配置完整，新模型刷新进来即可执行。
  assert.deepEqual(
    resolve(rules, {
      providerId: "custom-example",
      modelId: "brand-new-unknown-model",
      apiType: "openai-chat-completions",
      baseUrl: "https://provider.example/v1",
    }).validateComplete(["providers", "custom-example", "models", "brand-new-unknown-model"]),
    [],
  );
});

/**
 * 内置供应商模型的期望取值。这些是调整兜底之前就成立的解析结果——
 * 直接钉住数值，兜底一旦泄漏到这些模型上，数值就会变，测试立刻失败。
 */
const BUILTIN_EXPECTED: readonly {
  providerId: string;
  modelId: string;
  contextWindow: number;
  supportsImage: boolean;
  maxOutputTokens: number;
}[] = [
  {
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3-Flash",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:zai-team-coding-plan",
    modelId: "GLM-5.3",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:zai-team-coding-plan",
    modelId: "GLM-5.3-Flash",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:zai-start-plan",
    modelId: "GLM-5.3-Flash",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:zai-start-plan",
    modelId: "GLM-5.2",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:zai-start-plan",
    modelId: "GLM-5-Turbo",
    contextWindow: 200000,
    supportsImage: true,
    maxOutputTokens: 64000,
  },
  {
    providerId: "account:bigmodel-individual-coding-plan",
    modelId: "GLM-5.3",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:bigmodel-individual-coding-plan",
    modelId: "GLM-5.3-Flash",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:bigmodel-team-coding-plan",
    modelId: "GLM-5.3",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:bigmodel-team-coding-plan",
    modelId: "GLM-5.3-Flash",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:bigmodel-start-plan",
    modelId: "GLM-5.3-Flash",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:bigmodel-start-plan",
    modelId: "GLM-5.2",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:bigmodel-start-plan",
    modelId: "GLM-5-Turbo",
    contextWindow: 200000,
    supportsImage: true,
    maxOutputTokens: 64000,
  },
  {
    providerId: "account:zai-offpeak-idle-plan",
    modelId: "GLM-5.3",
    contextWindow: 1000000,
    supportsImage: false,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:zai-offpeak-idle-plan",
    modelId: "GLM-5.3-Flash",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:bigmodel-offpeak-idle-plan",
    modelId: "GLM-5.3",
    contextWindow: 1000000,
    supportsImage: false,
    maxOutputTokens: 128000,
  },
  {
    providerId: "account:bigmodel-offpeak-idle-plan",
    modelId: "GLM-5.3-Flash",
    contextWindow: 1000000,
    supportsImage: true,
    maxOutputTokens: 128000,
  },
];

test("内置供应商模型的解析值不随兜底调整变化", () => {
  const { rules, raw } = loadRules();
  const { providers } = parseZCodeBuiltinProviderConfigRules(raw.config.providerConfigRules);
  const byId = new Map(providers.toJSON().map((provider) => [provider.providerId, provider]));
  for (const expected of BUILTIN_EXPECTED) {
    const provider = byId.get(expected.providerId);
    assert.ok(provider, `内置供应商不存在: ${expected.providerId}`);
    const api = (provider.config as { api?: { type?: string; baseUrl?: string } }).api;
    const config = resolve(rules, {
      providerId: expected.providerId,
      modelId: expected.modelId,
      apiType: api?.type,
      baseUrl: api?.baseUrl,
    }).toJSON();
    const label = `${expected.providerId}/${expected.modelId}`;
    assert.equal(
      config.properties?.contextWindow,
      expected.contextWindow,
      `${label} contextWindow`,
    );
    assert.equal(
      config.properties?.inputFormat?.supportsImage,
      expected.supportsImage,
      `${label} supportsImage`,
    );
    assert.equal(
      config.optionSpecs?.maxOutputTokens?.max,
      expected.maxOutputTokens,
      `${label} maxOutputTokens`,
    );
  }
});

test("builtin 配置目录本身可通过 schema 校验", () => {
  const { raw } = loadRules();
  assert.equal(raw.schemaVersion, 1);
  assert.equal(typeof raw.revision, "number");
  // parseZCodeBuiltinModelConfigRules / parseZCodeBuiltinProviderConfigRules 是 strict schema，
  // 能解析即通过校验。
  assert.ok(join(builtinPath).endsWith("zcode-builtin.json"));
});
