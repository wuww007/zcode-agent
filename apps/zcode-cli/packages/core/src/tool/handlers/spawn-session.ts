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
  type SpawnSessionInput,
  type SpawnSessionOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

// 跨工作区 spawn 要等宿主冷启动目标工作区的 CLI 进程，上限放宽到 90s（同区仍即时返回）。
const SPAWN_SESSION_TOOL_TIMEOUT_MS = 90_000;
const SPAWN_SESSION_MODEL_BYTES = 8_000;

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

  const result = await context.sessionSpawnPort.spawn(
    {
      parentSessionId: context.sessionId,
      prompt: parsed.prompt,
      ...(parsed.title ? { title: parsed.title } : {}),
      ...(parsed.workspace ? { workspace: parsed.workspace } : {}),
      // 继承当前 runtime 的模型，模型不可控入参（同 CronCreate 的注入约定）。
      ...(context.model
        ? { model: { providerId: context.model.providerId, modelId: context.model.modelId } }
        : {}),
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
      "Create a new peer task session (in the current workspace, or in another recently opened project via the optional workspace parameter) and start it on the given prompt immediately. The peer session is a full independent session with blank history; it runs in the background, does not see this conversation, and will never notify this session of progress or results — the user follows it in the task list. Spawned sessions cannot spawn further sessions. For parallel work where you need the results back in this conversation, use the Agent tool instead.",
    modelInstructions: [
      "Use this to hand off independent work to full peer sessions when the user asks for multiple parallel tasks/sessions and does not need the results back in this conversation.",
      "Write prompt as a complete standalone instruction: the peer session has blank history and will not see this conversation.",
      // 结果不回流是产品语义，必须让模型明确预期，避免它等待或轮询一个永远不会到来的通知。
      "The peer session runs independently and you will never be notified of its outcome; do not promise the user you will report its result later.",
      "To spawn several peers at once, send multiple SpawnSession tool uses in a single message so they start concurrently.",
      "workspace is only for running the task in a DIFFERENT project; it must be one of the user's recently opened projects (exact path from that list). If the call fails because the project is not in the recent list, pick one of the allowed paths from the error or omit workspace.",
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
