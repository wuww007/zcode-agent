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
  })
  .strict();
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
