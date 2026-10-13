// ============================================================
// SpawnSession tool - spawn a peer task session from the current session
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const SPAWN_SESSION_TOOL_NAME = "SpawnSession";

const nonEmptyString = z.string().trim().min(1);

export const SpawnSessionInputSchema = z
  .object({
    prompt: nonEmptyString.describe(
      "The task for the new peer session. It becomes that session's first user input and the session starts working on it immediately. Write it as a complete standalone instruction: the peer session has blank history and will not see this conversation.",
    ),
    title: nonEmptyString
      .optional()
      .describe(
        "Optional short title for the new session shown in the task list. Omit to let the host auto-generate a title from the prompt.",
      ),
    workspace: nonEmptyString
      .optional()
      .describe(
        "Local project path to create the peer session in, when it should run in a DIFFERENT project than this conversation. It must be one of the user's recently opened projects (the host validates against that list); pass the exact path as shown in the recent-projects list. Omit to create the session in the current workspace.",
      ),
    // model/thoughtLevel 成对：只给其一无法确定目标配置（schema 层下面 refine 拒绝）。是否已配置、
    // 档位是否属于该模型由 core handler 校验，失败带回候选清单让模型自修复。
    model: nonEmptyString
      .optional()
      .describe(
        "Model for the peer session, as `providerId/modelId` or a model id. Must be one of the models this host has configured. REQUIRED whenever `thoughtLevel` is set, and vice versa. Omit BOTH to have the peer session inherit the model and reasoning level this session is running on; set them only when the user explicitly asks the peer session to run on a different model.",
      ),
    thoughtLevel: nonEmptyString
      .optional()
      .describe(
        "Reasoning effort level for `model`. Must be one of that model's levels (every ListModels row lists its `reasoningLevels`). REQUIRED whenever `model` is set, and cannot be set without `model`.",
      ),
  })
  .strict()
  // intervalUnit/interval 同款配对规则（automation.ts）：入参 JSON Schema 会丢掉 refine，
  // 所以成对约束同时写进两个字段的 describe，让模型知道而不是撞错。
  .refine((input) => (input.model === undefined) === (input.thoughtLevel === undefined), {
    message: "model and thoughtLevel must be set together",
    path: ["thoughtLevel"],
  });
export type SpawnSessionInput = z.infer<typeof SpawnSessionInputSchema>;
export const SpawnSessionInputJsonSchema = toToolJsonSchema(SpawnSessionInputSchema);

export const SpawnSessionOutputSchema = z
  .object({
    sessionId: nonEmptyString.describe("Id of the created peer session."),
    message: nonEmptyString,
  })
  .strict();
export type SpawnSessionOutput = z.infer<typeof SpawnSessionOutputSchema>;
export const SpawnSessionOutputJsonSchema = toToolJsonSchema(SpawnSessionOutputSchema);
