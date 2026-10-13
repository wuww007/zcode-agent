// SpawnSession 的 model/thoughtLevel 归一化回归（specs/spawn-session-tool.md「产品规则」2）。
// 纯函数 + 假目录，可独立运行：
//   npx tsx --test apps/zcode-cli/packages/core/src/tool/handlers/spawn-session.test.ts
// 注意：core 的 tsconfig 排除 **/*.test.ts，本文件不进 tsc；仓库也没有 runner 会自动跑它。

import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogEntry, ModelCatalogPort } from "@zcode/contracts";
import { resolveSpawnSessionInput, validateSpawnSessionInput } from "./spawn-session.js";
import type {
  ToolHandlerFailure,
  ToolInputResolutionResult,
  ToolInputValidationResult,
} from "../types.js";

function entry(overrides: Partial<ModelCatalogEntry>): ModelCatalogEntry {
  return { providerId: "p", modelId: "m", reasoningLevels: [], current: false, ...overrides };
}

const catalogOf = (entries: ModelCatalogEntry[]): ModelCatalogPort => ({
  listModels: () => entries,
});

function failureOf(
  result: ToolHandlerFailure | ToolInputResolutionResult | ToolInputValidationResult,
): ToolHandlerFailure {
  if (result.result !== false) {
    throw new Error(`expected a failure, got: ${JSON.stringify(result)}`);
  }
  return result;
}

function normalizedInputOf(result: ToolInputResolutionResult): Record<string, unknown> {
  if (result.result !== true) {
    throw new Error(`expected success, got: ${JSON.stringify(result)}`);
  }
  return result.input as Record<string, unknown>;
}

const TARGET = entry({
  providerId: "openai",
  modelId: "gpt-5",
  reasoningLevels: ["low", "high"],
  defaultReasoningLevel: "high",
});

test("不传 model 时恒等放行（继承当前会话，端口不接受覆盖）", () => {
  const input = { prompt: "do it" };
  const result = resolveSpawnSessionInput(input, catalogOf([TARGET]));
  assert.equal(result.result, true);
  assert.deepEqual(normalizedInputOf(result), input);
});

test("合法的一对归一化成规范形：注册表拼写 + providerId/modelId", () => {
  const result = resolveSpawnSessionInput(
    { prompt: "do it", model: "Openai/GPT-5", thoughtLevel: "HIGH" },
    catalogOf([TARGET]),
  );
  assert.deepEqual(normalizedInputOf(result), {
    prompt: "do it",
    model: "openai/gpt-5",
    thoughtLevel: "high",
  });
});

test("宿主没有模型目录时明确拒绝，不静默放行", () => {
  const failure = failureOf(
    resolveSpawnSessionInput(
      { prompt: "do it", model: "openai/gpt-5", thoughtLevel: "high" },
      undefined,
    ),
  );
  assert.equal(failure.errorCode, 42);
  assert.match(failure.message, /cannot resolve a model/);
});

test("model 带 $ 档位后缀被拒（两个参数的世界里它是矛盾来源）", () => {
  const failure = failureOf(
    resolveSpawnSessionInput(
      { prompt: "do it", model: "openai/gpt-5$high", thoughtLevel: "high" },
      catalogOf([TARGET]),
    ),
  );
  assert.equal(failure.errorCode, 41);
  assert.match(failure.message, /thoughtLevel/);
});

// 配对规则不在这里强制——它由 `validateSpawnSessionInput`（validateInput 钩子）在更早的位置拦住，
// 因为 schema 的 refine 不进 JSON Schema、executor 的首次校验看不见它。这条断言钉住分式：
// resolveInput 只做「值」的归一化，不拥有配对规则。
test("半对入参原样放行（配对由 validateInput 拦，不在这里兜）", () => {
  const input = { prompt: "do it", model: "openai/gpt-5" };
  const result = resolveSpawnSessionInput(input, catalogOf([TARGET]));
  assert.equal(result.result, true);
  assert.deepEqual(normalizedInputOf(result), input);
});

test("validateInput 拦下半对入参：确认窗之前就失败", () => {
  assert.deepEqual(validateSpawnSessionInput({ prompt: "do it" }), { result: true });
  assert.deepEqual(
    validateSpawnSessionInput({ prompt: "do it", model: "m", thoughtLevel: "high" }),
    {
      result: true,
    },
  );

  for (const half of [
    { prompt: "do it", model: "m" },
    { prompt: "do it", thoughtLevel: "high" },
  ]) {
    const failure = failureOf(validateSpawnSessionInput(half));
    assert.equal(failure.errorCode, 41);
    assert.match(failure.message, /set together/);
  }
});

test("模型解不出来时带回可选清单（模型可自修复）", () => {
  const failure = failureOf(
    resolveSpawnSessionInput(
      { prompt: "do it", model: "nope/nope", thoughtLevel: "high" },
      catalogOf([TARGET]),
    ),
  );
  assert.equal(failure.errorCode, 41);
  assert.match(failure.message, /openai\/gpt-5/);
  assert.match(failure.message, /ListModels/);
});

test("档位不属于该模型时列出该模型的合法档位", () => {
  const failure = failureOf(
    resolveSpawnSessionInput(
      { prompt: "do it", model: "openai/gpt-5", thoughtLevel: "medium" },
      catalogOf([TARGET]),
    ),
  );
  assert.equal(failure.errorCode, 41);
  assert.match(failure.message, /Its levels are: low, high/);
});

test("模型没有档位时不回落默认档，直接拒绝", () => {
  const failure = failureOf(
    resolveSpawnSessionInput(
      { prompt: "do it", model: "openai/plain", thoughtLevel: "high" },
      catalogOf([entry({ providerId: "openai", modelId: "plain" })]),
    ),
  );
  assert.equal(failure.errorCode, 41);
  assert.match(failure.message, /has no reasoning levels/);
});
