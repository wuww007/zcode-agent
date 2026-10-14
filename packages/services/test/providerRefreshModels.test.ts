import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";

/**
 * 覆盖自定义供应商「刷新模型列表」的合并语义：
 * 删除目录里没有的、添加目录里新增的、已存在的成员与其规则一律不动。
 */

const personalConfig = {
  schemaVersion: 1,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "custom-example",
          providerName: "Example",
          enabled: true,
          config: {
            access: { type: "api-key", apiKey: "test-only-key" },
            api: { type: "openai-chat-completions", baseUrl: "https://provider.example/v1" },
            personalModelIds: ["model-b", "model-a"],
            modelOrder: ["model-b", "model-a"],
          },
        },
        {
          // 带模板的实例：builtinModelIds 由模板基线提供，刷新不得新增或删除它们。
          providerId: "template-example",
          templateId: "deepseek",
          enabled: true,
          config: {
            access: { type: "api-key", apiKey: "test-only-key" },
            api: { type: "openai-chat-completions", baseUrl: "https://provider.example/v1" },
            personalModelIds: ["custom-deepseek"],
            modelOrder: ["custom-deepseek"],
          },
        },
        {
          // modelOrder 未声明：全量导入/分发与手改 personal.json 都能产出这种形态。
          providerId: "unordered-example",
          enabled: true,
          config: {
            access: { type: "api-key", apiKey: "test-only-key" },
            api: { type: "openai-chat-completions", baseUrl: "https://provider.example/v1" },
            personalModelIds: ["zeta", "alpha"],
          },
        },
      ],
    },
    modelConfigRules: {
      providerModelRules: [
        {
          providerId: "custom-example",
          modelId: "model-b",
          config: { enabled: true, properties: { contextWindow: 64000 } },
        },
      ],
      manualProviderModelRules: [],
    },
  },
};

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-provider-refresh-models-"));
  setDataBaseDir(dir);
  const configDir = getAppConfigDir();
  await mkdir(configDir, { recursive: true });
  const personalPath = join(configDir, "personal.json");
  await writeFile(personalPath, JSON.stringify(personalConfig));
  const runtime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: personalPath,
    personalPollingIntervalMs: false,
    watch: false,
  });
  return {
    runtime,
    async dispose() {
      runtime.dispose();
      setDataBaseDir(null);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("refresh adds missing models, removes absent ones, and leaves existing members untouched", async () => {
  const fixture = await setup();
  try {
    await fixture.runtime.start();
    const configService = fixture.runtime.configService;
    await configService.refreshPersonalModels("custom-example", ["model-b", "model-c", "model-d"]);
    const config = await configService.read();
    const provider = config.personalProviders.getRule("custom-example");
    assert.ok(provider);
    // 新增的追加在后，已存在的保持原位，被删的退出成员。
    assert.deepEqual(provider.config.personalModelIds, ["model-b", "model-c", "model-d"]);
    // modelOrder 只剔除被删成员，保留用户已有顺序。
    assert.deepEqual(provider.config.modelOrder, ["model-b", "model-c", "model-d"]);
    // 已存在模型的个人规则原样保留。
    assert.equal(
      config.personalModels.getExact("custom-example", "model-b")?.properties?.contextWindow,
      64000,
    );
    // 被删模型的规则一并清除。
    assert.equal(config.personalModels.getExact("custom-example", "model-a"), undefined);
    // 新增模型只落 enabled，其余走推荐配置，不物化成个人规则。
    assert.deepEqual(config.personalModels.getExact("custom-example", "model-c")?.toJSON(), {
      enabled: true,
    });
  } finally {
    await fixture.dispose();
  }
});

test("refresh keeps builtin members out of personal ids and never removes them", async () => {
  const fixture = await setup();
  try {
    await fixture.runtime.start();
    const configService = fixture.runtime.configService;
    // 目录里带回模板 builtin 成员与一个全新模型。
    await configService.refreshPersonalModels("template-example", [
      "deepseek-flash",
      "custom-deepseek",
      "model-e",
    ]);
    const config = await configService.read();
    const provider = config.personalProviders.getRule("template-example");
    assert.ok(provider);
    // 目录里的 builtin 成员不能重复加进 personal。
    assert.deepEqual(provider.config.personalModelIds, ["custom-deepseek", "model-e"]);
    // 再次刷新且目录不再包含该 personal 成员时，builtin 成员仍在（由模板基线提供）。
    await configService.refreshPersonalModels("template-example", ["deepseek-flash"]);
    const after = await configService.read();
    const providerAfter = after.personalProviders.getRule("template-example");
    assert.ok(providerAfter);
    assert.deepEqual(providerAfter.config.personalModelIds, []);
    assert.equal(after.personalModels.getExact("template-example", "model-e"), undefined);
  } finally {
    await fixture.dispose();
  }
});

test("refresh with an unchanged catalog is a no-op that keeps the stored revision", async () => {
  const fixture = await setup();
  try {
    await fixture.runtime.start();
    const configService = fixture.runtime.configService;
    const before = await configService.read();
    await configService.refreshPersonalModels("custom-example", ["model-b", "model-a"]);
    const after = await configService.read();
    assert.equal(after.revision, before.revision);
    const provider = after.personalProviders.getRule("custom-example");
    assert.ok(provider);
    assert.deepEqual(provider.config.personalModelIds, ["model-b", "model-a"]);
  } finally {
    await fixture.dispose();
  }
});

test("refresh preserves the relative order of existing members when modelOrder is undeclared", async () => {
  const fixture = await setup();
  try {
    await fixture.runtime.start();
    const configService = fixture.runtime.configService;
    // 目录顺序与本地相反，且带一个全新模型。
    await configService.refreshPersonalModels("unordered-example", ["alpha", "newcomer", "zeta"]);
    const config = await configService.read();
    const provider = config.personalProviders.getRule("unordered-example");
    assert.ok(provider);
    // modelOrder 为空时 resolveOwnedOrder 退化为 personalModelIds 顺序，
    // 所以这里必须仍是「已有成员原序在前、新成员追加在后」，不能被目录顺序改写。
    assert.deepEqual(provider.config.personalModelIds, ["zeta", "alpha", "newcomer"]);
    assert.deepEqual(provider.config.modelOrder, ["zeta", "alpha", "newcomer"]);
  } finally {
    await fixture.dispose();
  }
});
