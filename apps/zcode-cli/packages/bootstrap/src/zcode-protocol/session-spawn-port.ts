import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { SessionSpawnPort } from "@zcode/contracts";
import { zcodeProtocolMethods, zcodeSpawnPeerSessionResultSchema } from "@zcode/shared";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

// 端口合成命令的固定 client 标识：所有 spawn 都来自同一 CLI 进程内的工具面，
// 不是独立 GUI 客户端；commandId 每次新建（uuid），与 GUI 每次点「新任务」同语义。
const SPAWN_SESSION_CLIENT_ID = "zcode-cli-session-spawn";

function spawnFailure(message: string, ack?: CommandAck): Error {
  const detail = ack?.reasonCode ?? ack?.message;
  return new Error(detail ? `${message}: ${detail}` : message);
}

/** 归一化模型传入的本地项目路径（展开 `~/`；相对路径按 CLI cwd 解析）。 */
function normalizeTargetWorkspacePath(raw: string): string {
  const expanded = raw.startsWith("~/") ? `${homedir()}${raw.slice(1)}` : raw;
  return isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(process.cwd(), expanded);
}

/**
 * 生效的目标模型 / 档位：工具给的显式覆盖优先，缺省继承父会话 record 的当前 selection
 * （「对等」语义的唯一来源，与 mode 同一条读取路径）。两条链路（同区 / 跨区）都必须用它——
 * 只在同区分支补默认，会让跨区 spawn 悄悄跑到目标工作区的默认模型上。
 */
function resolveEffectiveTarget(
  ownRecord: ZCodeProtocolSessionRecord | undefined,
  model: { providerId: string; modelId: string } | undefined,
  thoughtLevel: string | undefined,
): { model?: { providerId: string; modelId: string }; thoughtLevel?: string } {
  const inherited = ownRecord?.app.runtime.getSessionModelSelection();
  const providerId = model?.providerId ?? inherited?.providerId;
  const modelId = model?.modelId ?? inherited?.modelId;
  const level = thoughtLevel ?? inherited?.options?.reasoningLevel;
  return {
    ...(providerId !== undefined && modelId !== undefined
      ? { model: { providerId, modelId } }
      : {}),
    ...(level !== undefined ? { thoughtLevel: level } : {}),
  };
}

/**
 * 平级会话继承父会话的当前协作模式，加上 `resolveEffectiveTarget` 给出的模型与档位；
 * 两者皆无时返回空对象。
 *
 * 走**结构化** `modelSelection`（v4 的正式形态，与 GUI 草稿选型同形），不发扁平的
 * `config.provider/model/thought`（旧兼容形态）。档位在目标侧不匹配时
 * `applyRequestedSessionConfig` 会抛错、由 createSession 降级为 warn（不连坐创建）——
 * 但发起侧的校验已经在前，走到那一步只可能是目标进程的 provider 配置与发起进程不一致
 * （见 spec「Non-goals」的已知边界），所以这里不重复校验。
 */
function buildRequestedConfig(
  ownRecord: ZCodeProtocolSessionRecord | undefined,
  target: { model?: { providerId: string; modelId: string }; thoughtLevel?: string },
): {
  config?: {
    mode?: string;
    modelSelection?: {
      providerId: string;
      modelId: string;
      options?: { reasoningLevel: string };
    };
  };
} {
  const mode = ownRecord?.app.getMode();
  const modelSelection = target.model
    ? {
        ...target.model,
        ...(target.thoughtLevel ? { options: { reasoningLevel: target.thoughtLevel } } : {}),
      }
    : undefined;
  if (!mode && !modelSelection) return {};
  return {
    config: {
      ...(mode ? { mode } : {}),
      ...(modelSelection ? { modelSelection } : {}),
    },
  };
}

/**
 * 平级任务会话拉起端口：合成 v4 `createSession` 信封（含 firstInput 与
 * spawnedFromParentSessionId 来源标记）走 gateway.handleCommand，复用 GUI 新建会话的
 * 全链路（CommandInbox 幂等 → createSession handler → record 注册 → durable 账本 →
 * startPromptTurn 后台起 turn → sessions-index 推送），不复制任何一步。
 * 显式 title 再合成一条 renameSession 信封（best-effort，失败不连坐创建结果）。
 */
export function createProtocolSessionSpawnPort(
  context: ZCodeProtocolAgentServerContext,
  resolveOwnSession?: () => ZCodeProtocolSessionRecord | undefined,
): SessionSpawnPort {
  return {
    async spawn(request, options) {
      if (options?.signal?.aborted) {
        throw new Error("Session spawn was aborted before dispatch");
      }
      const gateway = context.v4Gateway;
      if (!gateway) {
        // createRecord 只在 v4 协议服务内执行，gateway 缺席说明 binder 接线不完整；
        // 不能静默降级成「创建但不启动」。
        throw new Error("proto.v4GatewayUnavailable");
      }
      const ownRecord = resolveOwnSession?.();
      const workspaceId = ownRecord?.workspace.workspaceKey;
      if (!workspaceId) {
        // workspaceKey 是 createSession payload 的 workspaceId（identity 优先、path 兜底，
        // 与 GUI 侧一致）；缺席说明 record 尚未就绪，fail-closed。
        throw new Error("proto.sessionNotFound");
      }
      // 生效的目标模型/档位在分支之前算好：跨区分支自己不读父记录（那是目标进程的事），
      // 两个分支必须共用同一份结果，否则跨区的默认继承会静默丢失。
      const target = resolveEffectiveTarget(ownRecord, request.model, request.thoughtLevel);
      // 跨工作区目标：一个 workspaceKey 一个 CLI 进程（UI 订阅/账号/MCP 均按进程隔离），
      // 不能在本进程直接给别的项目建会话（会话对目标项目的任务列表不可见）。
      // 改走宿主反向 RPC：宿主按 recentProjects 白名单裁决后在目标进程创建（cron 派发同构）。
      const targetWorkspace = request.workspace ? normalizeTargetWorkspacePath(request.workspace) : undefined;
      if (
        targetWorkspace !== undefined &&
        targetWorkspace !== ownRecord.workspace.workspacePath &&
        targetWorkspace !== ownRecord.workspace.workspaceKey
      ) {
        const result = await context.requestClient(
          zcodeProtocolMethods.spawnPeerSession,
          {
            workspacePath: targetWorkspace,
            prompt: request.prompt,
            ...(request.title ? { title: request.title } : {}),
            ...(target.model
              ? { model: `${target.model.providerId}/${target.model.modelId}` }
              : {}),
            ...(target.thoughtLevel ? { thoughtLevel: target.thoughtLevel } : {}),
            parentSessionId: request.parentSessionId,
          },
          zcodeSpawnPeerSessionResultSchema,
          // 目标工作区 CLI 可能要冷启动（进程拉起 + provider 配置同步），给足预算。
          { timeoutMs: 90_000 },
        );
        if (!result.ok) {
          // 业务失败原样带 message（含白名单提示）抛给模型自修复；不在端口层降级重试。
          throw new Error(result.message);
        }
        return { sessionId: result.sessionId };
      }
      const createAck = await gateway.handleCommand({
        commandId: randomUUID(),
        clientId: SPAWN_SESSION_CLIENT_ID,
        // createSession 的信封 sessionId 恒为 null（幂等桶），新会话 id 由 CLI 生成。
        sessionId: null,
        type: "createSession",
        issuedAt: Date.now(),
        payload: {
          workspaceId,
          firstInput: { text: request.prompt },
          // 来源标记：createRecord 据此挂 parentSessionId 并跳过 sessionSpawnPort
          // 注入——spawn 出的会话不得再派生（防递归）。
          spawnedFromParentSessionId: request.parentSessionId,
          // 模式与模型/档位继承走 createSession.config（首发前 applyRequestedSessionConfig
          // 生效）；mode 读父记录当前值（同 fork 继承先例 registerCommittedForkBestEffort），
          // 模型与档位结构化透传，不做字符串往返。
          ...buildRequestedConfig(ownRecord, target),
        },
      } satisfies CommandEnvelope);
      if (createAck.status !== "accepted" || createAck.result?.type !== "createSession") {
        context.logger?.warn("Session spawn createSession command was not accepted", {
          ackStatus: createAck.status,
          event: "zcode_protocol.session_spawn.create_failed",
          reasonCode: createAck.reasonCode,
        });
        throw spawnFailure("Failed to create the peer task session", createAck);
      }
      const sessionId = createAck.result.sessionId;
      if (request.title) {
        // 显式标题：复用 renameSession 命令（core setCustomSessionTitle，custom 粘性
        // 短路后续自动标题）。best-effort——标题失败不该连坐已经开跑的会话。
        try {
          const renameAck = await gateway.handleCommand({
            commandId: randomUUID(),
            clientId: SPAWN_SESSION_CLIENT_ID,
            sessionId,
            type: "renameSession",
            issuedAt: Date.now(),
            payload: { title: request.title },
          } satisfies CommandEnvelope);
          if (renameAck.status !== "accepted") {
            context.logger?.warn("Session spawn renameSession was not accepted", {
              ackStatus: renameAck.status,
              event: "zcode_protocol.session_spawn.rename_failed",
              reasonCode: renameAck.reasonCode,
              sessionId,
            });
          }
        } catch (error) {
          context.logger?.warn("Session spawn renameSession failed", {
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "zcode_protocol.session_spawn.rename_failed",
            sessionId,
          });
        }
      }
      return { sessionId };
    },
  };
}
