import { CopyPlusIcon } from "lucide-react";
import { TID_SPAWN_SESSION_CARD } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

// SpawnSession 的静态轮尾卡（OffPeakCreate 兄弟实现，样式契约一致）。
// 纯展示：平级会话归任务列表承载，卡片不提供跳转（会话打开是用户的列表操作）。

export interface SpawnSessionCardSession {
  /** 新会话 id（工具输出）；缺失时卡片仍展示 prompt，仅退回普通工具行语义减弱。 */
  sessionId?: string;
  /** 传给新会话的任务提示（工具输入）。 */
  prompt?: string;
  /** 目标项目路径（工具输入 workspace）；缺省=当前工作区，不展示。 */
  workspace?: string;
}

const MAX_PROMPT_DISPLAY_LENGTH = 80;

function normalizeToolName(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}

export function isSpawnSessionToolCall(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): boolean {
  return [toolCall.toolName, toolCall.kind, toolCall.title].some(
    (value) => normalizeToolName(value) === "spawnsession",
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** 从工具输出候选里读新会话 id；无 id 视为无效输出（调用方回退普通工具行）。 */
export function readSpawnSessionOutputSessionId(value: unknown): string | null {
  const normalizedValue = typeof value === "string" ? parseJsonString(value) : value;
  if (!isPlainRecord(normalizedValue)) {
    return null;
  }
  const sessionId =
    typeof normalizedValue.sessionId === "string" && normalizedValue.sessionId.trim()
      ? normalizedValue.sessionId.trim()
      : undefined;
  return sessionId ?? null;
}

/** 行级 output 缺席（truncated ref / replay / 旧投影）时的多候选兜底，候选集与 OffPeak 卡一致。 */
export function readSpawnSessionToolCallSessionId(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | null {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawResult = isPlainRecord(raw?.result) ? raw.result : null;
  const candidates = [
    toolCall.output,
    raw?.rawOutput,
    raw?.output,
    rawResult?.content,
    rawResult?.display,
    raw?.result,
    toolCall.content,
  ];
  for (const candidate of candidates) {
    const sessionId = readSpawnSessionOutputSessionId(candidate);
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
}

function truncatePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length <= MAX_PROMPT_DISPLAY_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_PROMPT_DISPLAY_LENGTH)}…`;
}

export function SpawnSessionCard({ session }: { session: SpawnSessionCardSession }) {
  const { intl } = useZCodeIntl();
  const title = session.prompt?.trim()
    ? truncatePrompt(session.prompt)
    : intl.formatMessage({ id: "spawnSession.chatCreated.defaultTitle" });
  // 产品语义就是结果不回流：必须在卡面明示，避免用户在本会话里等一个不会来的汇报。
  const independentHint = intl.formatMessage({
    id: "spawnSession.chatCreated.independentHint",
  });
  const workspaceHint = session.workspace
    ? `${intl.formatMessage(
        { id: "spawnSession.chatCreated.targetWorkspace" },
        { path: session.workspace },
      )} · `
    : "";
  const hint = session.sessionId
    ? `${workspaceHint}${session.sessionId} · ${independentHint}`
    : `${workspaceHint}${independentHint}`;

  return (
    <div
      data-testid={TID_SPAWN_SESSION_CARD}
      className="my-1 w-full rounded-xl border border-border/70 bg-card/70 px-3 py-3 shadow-sm backdrop-blur-sm"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
          <CopyPlusIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-base font-medium text-foreground">{title}</div>
          <div className="mt-0.5 truncate text-ui-base text-foreground-subtle">{hint}</div>
        </div>
      </div>
    </div>
  );
}
