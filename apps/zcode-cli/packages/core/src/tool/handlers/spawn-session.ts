// ============================================================
// SpawnSession Tool Handler - 拉起与当前会话平级的任务会话
// ============================================================

import {
  CoreErrorType,
  SPAWN_SESSION_TOOL_NAME,
  SpawnSessionInputJsonSchema,
  SpawnSessionInputSchema,
  SpawnSessionOutputJsonSchema,
  SpawnSessionOutputSchema,
  createCoreError,
  type ModelCatalogEntry,
  type ModelCatalogPort,
  type SpawnSessionInput,
  type SpawnSessionOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import {
  ZCODE_MODEL_REASONING_SEPARATOR,
  parseModelPickerValue,
} from "@zcode/shared/model-selection";
import {
  formatModelCatalogId,
  resolveModelReference,
  resolveReasoningLevel,
} from "./model-reference.js";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
  ToolInputResolutionResult,
  ToolInputValidationResult,
} from "../types.js";

// 跨工作区 spawn 要等宿主冷启动目标工作区的 CLI 进程，上限放宽到 90s（同区仍即时返回）。
const SPAWN_SESSION_TOOL_TIMEOUT_MS = 90_000;
const SPAWN_SESSION_MODEL_BYTES = 8_000;

/**
 * 业务失败码。数值只是日志位（executor 投影成 `code: "N"`），判别键在 message 前缀。
 * 从 41 起编只为与 workflow 内省表（1/2）、ResumeWorkflowRun（11–15）、AmendWorkflow（21–23）、
 * ListModels（31）视觉不撞车。
 */
const SPAWN_SESSION_ERROR_CODE = {
  /** model/thoughtLevel 解不成当前模型配置里的合法组合。 */
  MODEL_UNRESOLVED: 41,
  /** 宿主没给模型目录，无法校验这对覆盖值。 */
  MODEL_CATALOG_UNAVAILABLE: 42,
} as const;

const PAIRING_REQUIRED_MESSAGE =
  "model and thoughtLevel must be set together: pass both, or neither to inherit this session's model and level.";

function spawnFailure(errorCode: number, message: string): ToolHandlerFailure {
  return { result: false, errorCode, message };
}

/**
 * 配对规则的**唯一闸门**，位置在确认窗与 PreToolUse 之前（同 `validateInput` 的定位）。
 *
 * 不能只靠 schema 的 `.refine`：executor 的首次校验读的是 `inputSchema`（JSON Schema），而
 * `toToolJsonSchema` 会丢掉 refine——半对入参能通过首次校验、一路走到确认窗，最后才由 handler 的
 * `parse` 抛一个原始 Zod 错（用户白点一次确认，模型也读不懂）。schema 的 refine 仍然保留：它是
 * 契约声明本身，也给直接消费 schema 的调用点（测试等）同一道约束。
 */
export function validateSpawnSessionInput(input: unknown): ToolInputValidationResult {
  if (typeof input !== "object" || input === null) return { result: true };
  const candidate = input as { model?: unknown; thoughtLevel?: unknown };
  // 与 schema refine 同一条判据（只看存在性，不看值）：空串之类留给 JSON Schema 报。
  if ((candidate.model === undefined) === (candidate.thoughtLevel === undefined)) {
    return { result: true };
  }
  return spawnFailure(SPAWN_SESSION_ERROR_CODE.MODEL_UNRESOLVED, PAIRING_REQUIRED_MESSAGE);
}

/** 档位对不上：清单给的是**这个模型的**档位（与 `$level` 那条同一口径，措辞按两个参数的世界来）。 */
function describeReasoningLevelMismatch(entry: ModelCatalogEntry, level: string): string {
  const id = formatModelCatalogId(entry);
  if (entry.reasoningLevels.length === 0) {
    return `\`${level}\` is not a reasoning level of ${id}: that model has no reasoning levels. Pick a model that has them, or omit both model and thoughtLevel to inherit this session's model and level.`;
  }
  return `\`${level}\` is not a reasoning level of ${id}. Its levels are: ${entry.reasoningLevels.join(", ")}.`;
}

/**
 * 归一化 `model` / `thoughtLevel`：解成规范形（注册表拼写）或业务失败。位置在确认窗**之前**
 * （与 CreateWorkflow 同一条理由）——窗上要显示这次 spawn 会把会话跑到哪个模型上，而解不出来的
 * 调用根本不该开窗。
 *
 * 规则见 spec「产品规则」2：模型必须能在**当前模型配置**里唯一解析，档位必须是该模型声明的档位
 * 之一。「匹配不上就回落默认档」是这里刻意不做的事：静默降级会让用户拿到一个他没要的档位。
 * 成对规则不在这里——它由 schema 的 refine 强制，而 executor 保证走到本函数的入参已通过校验。
 *
 * 端口缺席而覆盖值在场时**明确拒绝**，不静默放行（同 `SUBAGENT_MODEL_UNAVAILABLE` 的理由）：
 * 一个没校验过的字符串发下去，最后会在目标进程里变成「档位悄悄用默认」，没人看得出来。
 */
export function resolveSpawnSessionInput(
  input: unknown,
  catalog: ModelCatalogPort | undefined,
): ToolInputResolutionResult {
  const parsed = SpawnSessionInputSchema.safeParse(input);
  // 解析失败原样放行：配对已由 `validateSpawnSessionInput` 在更早的位置拦下，剩下的是字段级问题
  // （prompt 缺失、空串、多余键），那些 JSON Schema 首次校验看得见、也归它报，这里不抢。
  if (!parsed.success) return { result: true, input };
  const requestedModel = parsed.data.model;
  if (requestedModel === undefined) return { result: true, input };

  // schema 的 refine 已保证两个字段成对；这个判断只为类型收窄（半对入参到不了这里，
  // 真到了 handler 也会在 parse 时抛）。
  const requestedLevel = parsed.data.thoughtLevel;
  if (requestedLevel === undefined) return { result: true, input };
  if (requestedModel.includes(ZCODE_MODEL_REASONING_SEPARATOR)) {
    // 与 `thoughtLevel` 并存时 `$level` 后缀会形成矛盾来源（谁说了算没有答案），直接说清正确写法。
    return spawnFailure(
      SPAWN_SESSION_ERROR_CODE.MODEL_UNRESOLVED,
      `model must be a plain model id: drop the \`${ZCODE_MODEL_REASONING_SEPARATOR}\` level suffix and pass the level in thoughtLevel.`,
    );
  }
  if (catalog === undefined) {
    return spawnFailure(
      SPAWN_SESSION_ERROR_CODE.MODEL_CATALOG_UNAVAILABLE,
      "This host cannot resolve a model for the peer session, so model/thoughtLevel cannot be used. Omit both to inherit this session's model and level.",
    );
  }

  const resolution = resolveModelReference(requestedModel, catalog.listModels());
  // 解不出来即整次调用失败：会话不创建，确认窗也不开（与 workflow 的 subagent_model 同一条路）。
  if (!resolution.ok) {
    return spawnFailure(SPAWN_SESSION_ERROR_CODE.MODEL_UNRESOLVED, resolution.message);
  }
  const canonicalLevel = resolveReasoningLevel(resolution.entry, requestedLevel);
  if (canonicalLevel === undefined) {
    return spawnFailure(
      SPAWN_SESSION_ERROR_CODE.MODEL_UNRESOLVED,
      describeReasoningLevelMismatch(resolution.entry, requestedLevel),
    );
  }
  return {
    result: true,
    input: {
      ...parsed.data,
      model: formatModelCatalogId(resolution.entry),
      thoughtLevel: canonicalLevel,
    },
  };
}

/**
 * 取回归一化后的结构化选型。走不到 throw：`resolveSpawnSessionInput` 必定先产出
 * `providerId/modelId`（无 `$` 后缀）形；能到这里说明有调用点绕过了 `resolveInput`，
 * 那是接线故障——按接线故障喊出来，而不是把畸形串发给端口。
 */
function parseCanonicalModelId(canonical: string): { providerId: string; modelId: string } {
  try {
    const { providerId, modelId } = parseModelPickerValue(canonical);
    return { providerId, modelId };
  } catch (cause) {
    throw new Error(`spawn model reached the handler un-canonicalised: ${canonical}`, { cause });
  }
}

function assertSessionSpawnPort(
  context: ToolExecutionContext,
  toolName: typeof SPAWN_SESSION_TOOL_NAME,
): asserts context is ToolExecutionContext & {
  sessionSpawnPort: NonNullable<ToolExecutionContext["sessionSpawnPort"]>;
} {
  if (context.sessionSpawnPort) return;
  // 端口只注入非 spawn 来源的协议主会话；spawn 出的会话与 TUI/headless/subagent
  // 一律缺席。与 Cron/OffPeak 同一模式：端口缺席即能力缺席。
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `SessionSpawnPort is not configured for ${toolName}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: false,
    },
  );
}

const spawnSessionHandler: ToolHandler = async (input, context) => {
  const parsed = SpawnSessionInputSchema.parse(input) as SpawnSessionInput;
  assertSessionSpawnPort(context, SPAWN_SESSION_TOOL_NAME);

  const requestedModel =
    parsed.model === undefined ? undefined : parseCanonicalModelId(parsed.model);
  const result = await context.sessionSpawnPort.spawn(
    {
      parentSessionId: context.sessionId,
      prompt: parsed.prompt,
      ...(parsed.title ? { title: parsed.title } : {}),
      ...(parsed.workspace ? { workspace: parsed.workspace } : {}),
      // 显式覆盖（`resolveInput` 已按当前模型配置校验并 canonical 化，两者成对）。缺省不传：
      // 由 bootstrap 端口读父会话 record 的当前 selection 补，避免「谁是当前模型」有第二个来源。
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(parsed.thoughtLevel ? { thoughtLevel: parsed.thoughtLevel } : {}),
    },
    { signal: context.abortSignal },
  );
  return {
    sessionId: result.sessionId,
    message: [
      `Created peer task session ${result.sessionId} and started it on the prompt.`,
      parsed.workspace ? `It runs in project ${parsed.workspace}.` : undefined,
      "It runs independently in the background: you will NOT receive its progress or result, and it will not see this conversation.",
      "The user can follow it in the task list. This session cannot spawn further sessions.",
    ]
      .filter((part): part is string => Boolean(part))
      .join(" "),
  } satisfies SpawnSessionOutput;
};

function spawnSessionPermission(): ToolPermissionSpec {
  return {
    permission: "session.spawn",
    reason: "SpawnSession creates and starts a new independent task session in this workspace",
    riskLevel: "medium" as const,
    sideEffectScope: "session" as const,
    needsApproval: true,
    patternSources: ["toolName", "input"],
    denyPriority: "beforeAsk" as const,
  };
}

export const spawnSessionToolEntry: ToolEntry = {
  capability: "Create a peer task session that works on a task independently",
  metadata: {
    name: SPAWN_SESSION_TOOL_NAME,
    description:
      "Create a new peer task session (in the current workspace, or in another recently opened project via the optional workspace parameter) and start it on the given prompt immediately. The peer session is a full independent session with blank history; it runs in the background, does not see this conversation, and will never notify this session of progress or results — the user follows it in the task list. By default it inherits the model and reasoning level this session is running on; pass model and thoughtLevel together (and only when the user explicitly asks for a different model or a lower reasoning effort) to move it onto another one. Spawned sessions cannot spawn further sessions. For parallel work where you need the results back in this conversation, use the Agent tool instead.",
    modelInstructions: [
      "Use this to hand off independent work to full peer sessions when the user asks for multiple parallel tasks/sessions and does not need the results back in this conversation.",
      "Write prompt as a complete standalone instruction: the peer session has blank history and will not see this conversation.",
      // 结果不回流是产品语义，必须让模型明确预期，避免它等待或轮询一个永远不会到来的通知。
      "The peer session runs independently and you will never be notified of its outcome; do not promise the user you will report its result later.",
      "To spawn several peers at once, send multiple SpawnSession tool uses in a single message so they start concurrently.",
      "workspace is only for running the task in a DIFFERENT project; it must be one of the user's recently opened projects (exact path from that list). If the call fails because the project is not in the recent list, pick one of the allowed paths from the error or omit workspace.",
      // 缺省继承当前模型与档位；只有用户点名要换才设这两个字段，且必须成对。
      "Omit model and thoughtLevel to inherit the model and reasoning level this session is running on — that is the default and the usual case. Set them together, and only when the user explicitly asks the peer session to run on a different model (or a lower reasoning effort); thoughtLevel must be one of that model's levels, which ListModels lists per row as reasoningLevels. A call that sets only one of the two is rejected, and a model or level that is not configured on this host is rejected with the available choices.",
      "If you need the work's result back in this conversation, use the Agent tool (optionally run_in_background) instead — its completion reports back to you.",
      "This tool is unavailable inside spawned sessions and subagents; do not ask one to spawn more sessions.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: SPAWN_SESSION_TOOL_TIMEOUT_MS,
    maxOutputBytes: SPAWN_SESSION_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: spawnSessionHandler,
  // 配对在 hook/确认窗之前拦（refine 不进 JSON Schema，executor 首次校验看不见它）。
  validateInput: (input) => validateSpawnSessionInput(input),
  // model/thoughtLevel 是唯一需要宿主事实才能定下来的入参：解不出当前模型配置里的合法组合就
  // 在确认窗前失败（同 CreateWorkflow 的 subagent_model）。
  resolveInput: (input, context) => resolveSpawnSessionInput(input, context.modelCatalogPort),
  inputSchema: SpawnSessionInputJsonSchema,
  outputSchema: SpawnSessionOutputJsonSchema,
  runtimeInputSchema: SpawnSessionInputSchema,
  runtimeOutputSchema: SpawnSessionOutputSchema,
  permission: spawnSessionPermission(),
  resultBudget: {
    maxInlineBytes: SPAWN_SESSION_MODEL_BYTES,
    maxModelBytes: SPAWN_SESSION_MODEL_BYTES,
    strategy: "truncate" as const,
    preview: {
      maxBytes: SPAWN_SESSION_MODEL_BYTES,
      direction: "head" as const,
    },
  },
  timeout: {
    defaultMs: SPAWN_SESSION_TOOL_TIMEOUT_MS,
    maxMs: SPAWN_SESSION_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    // 端口只在派发前响应取消；handleCommand 进行中被取消时 record 可能已建好并开跑，
    // 不能承诺「未创建」——指引用户到任务列表确认。
    userVisibleMessage:
      "SpawnSession was cancelled; the peer session may already have been created — check the task list",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
