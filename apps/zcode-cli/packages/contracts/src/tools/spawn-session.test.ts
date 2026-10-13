// SpawnSession 入参回归：model/thoughtLevel 必须成对（specs/spawn-session-tool.md「产品规则」2）。
// 纯 schema、只依赖同目录相对导入，可独立运行：
//   npx tsx --test apps/zcode-cli/packages/contracts/src/tools/spawn-session.test.ts
// 注意：仓库没有任何 runner 会自动跑这个文件。

import assert from "node:assert/strict";
import test from "node:test";

import { SpawnSessionInputJsonSchema, SpawnSessionInputSchema } from "./spawn-session.js";

test("不传 model/thoughtLevel 合法：继承当前会话的模型与档位", () => {
  assert.equal(SpawnSessionInputSchema.safeParse({ prompt: "do it" }).success, true);
});

test("成对传 model + thoughtLevel 合法", () => {
  assert.equal(
    SpawnSessionInputSchema.safeParse({
      prompt: "do it",
      model: "openai/gpt-5",
      thoughtLevel: "high",
    }).success,
    true,
  );
});

test("只传 model 或只传 thoughtLevel 被拒", () => {
  assert.equal(
    SpawnSessionInputSchema.safeParse({ prompt: "do it", model: "openai/gpt-5" }).success,
    false,
  );
  assert.equal(
    SpawnSessionInputSchema.safeParse({ prompt: "do it", thoughtLevel: "high" }).success,
    false,
  );
});

test("两个字段都出现在给模型的入参 JSON Schema 里", () => {
  const properties = jsonSchemaProperties();
  assert.ok(properties.model, "model 字段缺席");
  assert.ok(properties.thoughtLevel, "thoughtLevel 字段缺席");
});

// `toToolJsonSchema` 用 effectStrategy: "input"，refine 不进 JSON Schema，所以配对规则只能靠
// describe 讲给模型听。这条断言守的就是那个约定——改 schema 时别把文案删了，以为 refine 会自己生效。
test("配对规则写进字段描述（refine 不会进 JSON Schema）", () => {
  const properties = jsonSchemaProperties();
  const model = properties.model as Record<string, unknown>;
  const thoughtLevel = properties.thoughtLevel as Record<string, unknown>;
  assert.match(String(model.description), /thoughtLevel/);
  assert.match(String(thoughtLevel.description), /model/);
});

function jsonSchemaProperties(): Record<string, unknown> {
  return (SpawnSessionInputJsonSchema.properties ?? {}) as Record<string, unknown>;
}
