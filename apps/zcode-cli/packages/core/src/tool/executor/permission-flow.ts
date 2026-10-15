import {
  CoreErrorType,
  createCoreError,
  isCoreError,
  traceContextToLogContext,
  type CollaborationMode,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
  type PermissionRuleset,
  type TraceContext,
  type ToolExecutionSpanWriter,
} from "@zcode/contracts";
import type { HookRunResult } from "../../hooks/index.js";
import type { PermissionContext } from "../../permission/service.js";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolExecutionResult,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { normalizeToolExecutionInput } from "../input-normalization.js";
import { resolveToolApproval } from "./approval-gate.js";
import { createErrorResult, createPermissionErrorResult } from "./errors.js";
import { emitPermissionDenied, emitPermissionRequested, emitPermissionResolved } from "./events.js";
import { applyPreToolPermissionDecision, runPermissionRequestHooks } from "./hook-flow.js";
import { preparePermissionInput, snapshotPermissionInput } from "./permission-input.js";
import { racePermissionResponders } from "./permission-responder-race.js";
import {
  loadProjectPermissionRuleset,
  persistProjectPermissionUpdates,
} from "./permission-rules-persistence.js";
import {
  resolveRuntimePermissionCapability,
  resolveRuntimePermissionContext,
} from "./permission-capability.js";
import { buildDefaultPermissionUpdates } from "./permission-suggestions.js";
import { recheckPermissionHookModifiedInput } from "./permission-input-recheck.js";
import type { ToolExecutorDeps } from "./types.js";
import { summarizeInput } from "./utils.js";
import { validateInput } from "./validation.js";
import { applyMemoryFilePermission } from "./memory-file-permission.js";

type ToolPermissionFlowResult =
  | { allowed: true; executionInput: unknown; permissionWaitMs?: number }
  | { allowed: false; result: ToolExecutionResult };

export async function resolveToolPermission(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  entry: ToolEntry,
  executionInput: unknown,
  preToolHookResult: HookRunResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
  telemetry?: ToolExecutionSpanWriter,
  /** guarded 钉住的上下文（mode/bashShellSelection/cwd 快照）；由 executor 构造，重判必须复用同一份。 */
  preparedContext?: ToolRuntimePermissionCapabilityContext,
): Promise<ToolPermissionFlowResult> {
  // 判权上下文唯一构造点：guarded matcher 靠 mode 与 shell 文法命中，重判/改写路径
  // 都必须看到同一份，否则匹配会静默失效。
  const runtimePermissionContext: ToolRuntimePermissionCapabilityContext = {
    ...resolveRuntimePermissionContext(deps),
    ...preparedContext,
    mode,
  };
  const pinnedWorkingDirectory = runtimePermissionContext.workingDirectory;

  let projectRules: PermissionRuleset | null;
  try {
    projectRules = await loadProjectPermissionRuleset(deps);
  } catch (error) {
    return {
      allowed: false,
      result: createErrorResult(
        toolCall,
        createCoreError(CoreErrorType.StorageError, "Failed to load project permission rules", {
          cause: error instanceof Error ? error : undefined,
          context: { sessionId: deps.sessionId, toolCallId: toolCall.id, toolName: toolCall.name },
          recoverable: true,
        }),
      ),
    };
  }

  // rewrite 循环：Hook 改写（guarded）与普通重判的 ask 回写都以新输入重走一次判权。
  // firstInput 控制 PreToolUse 覆盖只在首轮生效；hooksAvailable 在首个请求发出后关闭
  // （重写轮的请求必须是纯用户单次确认，不能再有 Hook 竞速）。
  let firstInput = true;
  let hooksAvailable = true;
  let permissionWaitMs = 0;
  while (true) {
    const rulePolicy = entry.resolvePermissionRulePolicy?.(
      executionInput,
      runtimePermissionContext,
    );
    const permissionContext: PermissionContext = {
      toolName: toolCall.name,
      input: executionInput,
      riskLevel: entry.metadata.riskLevel,
      mode,
      prePlanMode: deps.sessionModePort?.getPrePlanMode(),
      planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
      // workflow 草稿免确认要按工作目录解析相对路径；guarded 用钉住的 cwd。
      workingDirectory: pinnedWorkingDirectory ?? deps.getWorkingDirectory(),
    };

    let permissionDecision = deps.permissionService.checkPermission(
      permissionContext,
      resolveRuntimePermissionCapability(entry, executionInput, runtimePermissionContext),
      projectRules,
      rulePolicy,
    );
    // 危险单次确认（user-once）与重写轮不吃 PreToolUse 的整体 allow：那等于让 Hook
    // 代批一次明确要求用户点头的执行。
    if (firstInput && permissionDecision.approvalMode !== "user-once") {
      permissionDecision = applyPreToolPermissionDecision(
        permissionDecision,
        preToolHookResult,
        mode,
      );
    }
    firstInput = false;
    permissionDecision = applyMemoryFilePermission({
      decision: permissionDecision,
      executionInput,
      memoryRoot: deps.getMemoryRoot?.(),
      toolName: toolCall.name,
      workingDirectory: pinnedWorkingDirectory ?? deps.getWorkingDirectory(),
      workspaceRoot: deps.getWorkspaceRoot(),
    });

    deps.logger?.debug("Tool permission evaluated", {
      ...traceContextToLogContext(traceContext),
      decision: permissionDecision.decision,
      event: "tool.permission.evaluated",
      inputSummary: summarizeInput(toolCall.input),
      mode,
      module: "core.tool.executor",
      reason: permissionDecision.reason,
      riskLevel: permissionDecision.riskLevel,
      ruleId: permissionDecision.ruleId,
      sideEffectScope: permissionDecision.sideEffectScope,
      status:
        permissionDecision.decision === "allow"
          ? "completed"
          : permissionDecision.decision === "ask"
            ? "waiting"
            : "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });

    if (permissionDecision.allowed) {
      telemetry?.setPermissionDecision("not_required");
      return { allowed: true, executionInput, ...(permissionWaitMs ? { permissionWaitMs } : {}) };
    }

    if (permissionDecision.decision === "deny") {
      telemetry?.setPermissionDecision("denied");
      await emitPermissionDenied(deps, toolCall, permissionDecision.reason, traceContext);

      deps.logger?.warn("Tool permission denied", {
        ...traceContextToLogContext(traceContext),
        decision: permissionDecision.decision,
        event: "tool.permission.denied",
        mode,
        module: "core.tool.executor",
        reason: permissionDecision.reason,
        ruleId: permissionDecision.ruleId,
        status: "failed",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
      return {
        allowed: false,
        result: createPermissionErrorResult(toolCall, permissionDecision.reason, {
          decision: permissionDecision.decision,
          mode,
          ruleId: permissionDecision.ruleId,
        }),
      };
    }

    // 工具预览（prepareApproval 的 proceed）只能控制普通审批；guarded 的单次确认必须弹窗。
    const approval =
      permissionDecision.approvalMode === "user-once"
        ? { gate: "ask" as const }
        : resolveToolApproval(deps, toolCall, entry, executionInput, traceContext);
    if (approval.gate === "proceed") {
      telemetry?.setPermissionDecision("not_required");
      return { allowed: true, executionInput, ...(permissionWaitMs ? { permissionWaitMs } : {}) };
    }

    const requestId = `perm_${crypto.randomUUID()}`;
    telemetry?.markPermissionRequested();
    // user-once 不提供也不接受项目/会话永久授权：建议更新清空，UI 侧的
    // fullAccessSupported 也由 emitPermissionRequested 按 approvalMode 抑制。
    const suggestedPermissionUpdates =
      permissionDecision.approvalMode === "user-once"
        ? []
        : (rulePolicy?.suggestedPermissionUpdates ??
          buildDefaultPermissionUpdates(toolCall.name, executionInput, entry.permissionCapabilityGroup));
    const approvalEvent = {
      ...approval,
      ...(permissionDecision.approvalMode
        ? { approvalMode: permissionDecision.approvalMode }
        : {}),
    };

    let brokerResult: PermissionBrokerResult;
    let normalizedHookModifiedInput: unknown;
    let useNormalizedHookModifiedInput = false;
    const permissionWaitStartedAt = Date.now();
    try {
      // 根因：先发布会让"事件一到就点击"的立即应答早于 deferred 登记，点击被静默丢弃。
      // racePermissionResponders 构造时同步登记 broker（与 hook 并发竞速，先到者胜、败者
      // 被 abort），所以先启动竞速、后发布事件——确认窗一可见就有应答的归宿。
      // settled 包装在创建同刻挂上，emit 悬挂期间产生的拒绝不会成为未处理拒绝。
      const raceSettled = racePermissionResponders({
        onHookFailure: (error) => {
          // hook 链故障只令其退赛：辅助应答方的基础设施故障不应替用户做拒绝决定，
          // 确认窗继续等待 broker 应答。
          deps.logger?.warn("PermissionRequest hook chain failed; waiting for client decision", {
            ...traceContextToLogContext(traceContext),
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "tool.permission.hook_race_forfeited",
            module: "core.tool.executor",
            requestId,
            status: "waiting",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
        },
        requestBroker: (brokerSignal, claimResponse) =>
          deps.permissionBroker.requestPermission(
            {
              input: executionInput,
              mode,
              reason: permissionDecision.reason ?? `Tool ${toolCall.name} requires approval`,
              requestId,
              requestedAt: new Date(),
              riskLevel: permissionDecision.riskLevel,
              ruleId: permissionDecision.ruleId,
              sessionId: deps.sessionId,
              sideEffectScope: permissionDecision.sideEffectScope,
              suggestedPermissionUpdates,
              ...(permissionDecision.approvalMode
                ? { approvalMode: permissionDecision.approvalMode }
                : {}),
              ...(approval.optionsPolicy ? { optionsPolicy: approval.optionsPolicy } : {}),
              toolCallId: toolCall.id as PermissionBrokerRequest["toolCallId"],
              toolName: toolCall.name,
              traceId: traceContext.traceId,
              turnId: traceContext.turnId ?? deps.turnId,
            },
            {
              signal: brokerSignal,
              claimResponse,
              timeoutMs: deps.permissionTimeoutMs,
            },
          ),
        // user-once 与重写轮不跑 PermissionRequest hook：Hook allow 不代批。
        runHooks:
          hooksAvailable && permissionDecision.approvalMode !== "user-once"
            ? (hookSignal) =>
                runPermissionRequestHooks(
                  deps,
                  toolCall,
                  executionInput,
                  requestId,
                  permissionDecision,
                  mode,
                  traceContext,
                  hookSignal,
                )
            : async () => undefined,
        ...(signal === undefined ? {} : { signal }),
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await emitPermissionRequested(
        deps,
        toolCall,
        executionInput,
        requestId,
        permissionDecision.riskLevel,
        permissionDecision.reason,
        suggestedPermissionUpdates,
        traceContext,
        approvalEvent,
      );
      const settled = await raceSettled;
      if (!settled.ok) throw settled.error;
      hooksAvailable = false;
      const raceOutcome = settled.value;
      brokerResult = raceOutcome.result;
      const permissionHookResult = raceOutcome.source === "hook" ? raceOutcome.result : undefined;

      // guarded 的应答校验先行：单次确认不接受 escalate 与任何持久授权，
      // modify 必须携带 modifiedInput——响应载荷不能自造授权豁免。
      if (mode === "guarded") {
        validateGuardedPermissionResponse(
          brokerResult,
          permissionDecision.approvalMode === "user-once",
        );
      }

      if (permissionHookResult?.decision === "modify") {
        if (mode === "guarded") {
          // guarded：Hook 改写不当作用户批准。把改写后的输入冻结为新的审批对象，
          // 重走一轮判权（此时 hooks 已关闭），命中的危险命令仍要求用户单次确认。
          executionInput = snapshotPermissionInput(
            preparePermissionInput(permissionHookResult.modifiedInput ?? executionInput, entry, deps),
          );
          continue;
        }
        normalizedHookModifiedInput = normalizeToolExecutionInput({
          entry,
          input: permissionHookResult.modifiedInput ?? executionInput,
          logger: deps.logger,
          source: "permission",
        });
        useNormalizedHookModifiedInput = true;
        if (!validateInput(normalizedHookModifiedInput, entry)) {
          // PermissionRequest hook 可以改写目标路径，修改后的输入不能沿用修改前的权限结果。
          const recheck = await recheckPermissionHookModifiedInput({
            deps,
            entry,
            mode,
            modifiedInput: normalizedHookModifiedInput,
            projectRules,
            requestId,
            signal,
            toolCall,
            traceContext,
            runtimePermissionContext,
          });
          if (recheck.permissionDecision) permissionDecision = recheck.permissionDecision;
          if (recheck.brokerResult) {
            brokerResult = recheck.brokerResult;
            useNormalizedHookModifiedInput = brokerResult.decision === "allow";
          }
        }
      }
      if (signal?.aborted) {
        telemetry?.setPermissionDecision("denied");
        const cancelled = createCoreError(
          CoreErrorType.ToolCancelled,
          "Permission request cancelled",
          { recoverable: true },
        );
        await emitPermissionResolved(
          deps,
          toolCall,
          requestId,
          { decision: "deny", reason: cancelled.message, resolvedAt: new Date() },
          traceContext,
        );
        return { allowed: false, result: createErrorResult(toolCall, cancelled) };
      }
    } catch (error) {
      telemetry?.setPermissionDecision("denied");
      const coreError = isCoreError(error)
        ? error
        : createCoreError(
            // guarded 的 broker/协议故障不能伪装成策略拒绝——模型会把基础设施故障
            // 当成"命令被策略禁止"并改写方案。
            mode === "guarded"
              ? CoreErrorType.ToolExecutionFailed
              : CoreErrorType.PermissionDenied,
            "Permission request failed",
            {
              cause: error instanceof Error ? error : undefined,
              context: { requestId, toolCallId: toolCall.id, toolName: toolCall.name },
              recoverable: true,
            },
          );
      await emitPermissionResolved(
        deps,
        toolCall,
        requestId,
        {
          decision: "deny",
          reason: coreError.message,
          resolvedAt: new Date(),
        },
        traceContext,
      );
      return { allowed: false, result: createErrorResult(toolCall, coreError) };
    }

    const resolvedPermission = {
      ...brokerResult,
      resolvedAt: brokerResult.resolvedAt ?? new Date(),
    };
    permissionWaitMs += Math.max(0, Math.round(Date.now() - permissionWaitStartedAt));
    await emitPermissionResolved(deps, toolCall, requestId, resolvedPermission, traceContext);

    deps.logger?.info("Tool permission resolved", {
      ...traceContextToLogContext(traceContext),
      decision: resolvedPermission.decision,
      event: "tool.permission.resolved",
      mode,
      module: "core.tool.executor",
      reason: resolvedPermission.reason,
      requestId,
      status:
        resolvedPermission.decision === "allow" || resolvedPermission.decision === "modify"
          ? "completed"
          : "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });

    if (resolvedPermission.decision === "deny") {
      telemetry?.setPermissionDecision("denied");
      return {
        allowed: false,
        result: createPermissionErrorResult(
          toolCall,
          resolvedPermission.reason,
          {
            decision: resolvedPermission.decision,
            mode,
            reasonSource: resolvedPermission.reasonSource,
            requestId,
            ruleId: permissionDecision.ruleId,
          },
          resolvedPermission.preserveReasonFormatting
            ? { preserveReasonFormatting: true }
            : undefined,
        ),
      };
    }

    if (resolvedPermission.decision === "escalate") {
      telemetry?.setPermissionDecision("denied");
      return {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(
            CoreErrorType.PermissionEscalation,
            resolvedPermission.reason ?? `Permission escalation requested for ${toolCall.name}`,
            {
              context: {
                decision: resolvedPermission.decision,
                mode,
                requestId,
                ruleId: permissionDecision.ruleId,
                toolName: toolCall.name,
              },
              recoverable: true,
            },
          ),
        ),
      };
    }

    if (resolvedPermission.permissionUpdates?.length) {
      try {
        await persistProjectPermissionUpdates(
          deps,
          resolvedPermission.permissionUpdates,
          traceContext,
        );
      } catch (error) {
        return {
          allowed: false,
          result: createErrorResult(
            toolCall,
            createCoreError(
              CoreErrorType.StorageError,
              "Failed to persist project permission update",
              {
                cause: error instanceof Error ? error : undefined,
                context: {
                  requestId,
                  sessionId: deps.sessionId,
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                },
                recoverable: true,
              },
            ),
          ),
        };
      }
    }

    if (resolvedPermission.sessionPermissionUpdates?.length) {
      // 会话免确认：只进内存里的会话 ruleset，
      // 与上面的项目级持久化互不可见。
      deps.permissionService.grantSessionPermission(resolvedPermission.sessionPermissionUpdates);
      deps.logger?.info("Session permission granted", {
        ...traceContextToLogContext(traceContext),
        event: "tool.permission.session_grant.applied",
        module: "core.tool.executor",
        requestId,
        status: "completed",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        updateCount: resolvedPermission.sessionPermissionUpdates.length,
      });
    }

    telemetry?.setPermissionDecision("granted");
    // guarded 下任何携带 modifiedInput 的响应都按改后输入执行——批准与改写是同一件事，
    // 不能只认 modify 决策而让 allow 载荷悄悄落回原输入（或让非法载荷绕过校验）。
    const carriesModifiedInput =
      resolvedPermission.decision === "modify" ||
      (mode === "guarded" && resolvedPermission.modifiedInput !== undefined);
    if (!carriesModifiedInput) {
      return {
        allowed: true,
        executionInput: useNormalizedHookModifiedInput ? normalizedHookModifiedInput : executionInput,
        permissionWaitMs,
      };
    }

    let modifiedInput = useNormalizedHookModifiedInput
      ? normalizedHookModifiedInput
      : normalizeToolExecutionInput({
          entry,
          input: resolvedPermission.modifiedInput ?? executionInput,
          logger: deps.logger,
          source: "permission",
        });
    if (mode === "guarded") {
      // 用户已批准的修改同样冻结：批准之后输入不得再被改写。
      modifiedInput = snapshotPermissionInput(modifiedInput);
    }
    const modifiedInputValidation = validateInput(modifiedInput, entry);
    if (modifiedInputValidation) {
      return {
        allowed: false,
        result: createErrorResult(toolCall, modifiedInputValidation),
      };
    }
    return { allowed: true, executionInput: modifiedInput, permissionWaitMs };
  }
}

/**
 * guarded 应答的形状校验：单次确认（once）不接受 escalate 与任何持久授权，
 * modify 必须携带 modifiedInput。形状不合法直接抛错——broker 层故障，
 * 不能当用户拒绝也不能放行。
 */
function validateGuardedPermissionResponse(
  response: PermissionBrokerResult,
  once: boolean,
): void {
  const decisions = ["allow", "deny", "modify", ...(once ? [] : ["escalate"])];
  if (
    !response ||
    !decisions.includes(response.decision) ||
    (response.reason !== undefined && typeof response.reason !== "string") ||
    (response.permissionUpdates !== undefined &&
      (!Array.isArray(response.permissionUpdates) ||
        (once && response.permissionUpdates.length > 0))) ||
    (response.decision === "modify" && response.modifiedInput === undefined) ||
    (response.sessionPermissionUpdates !== undefined &&
      (!Array.isArray(response.sessionPermissionUpdates) ||
        (once && response.sessionPermissionUpdates.length > 0)))
  ) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      "Invalid permission response; single-use requests cannot persist project rules",
      { recoverable: true },
    );
  }
}
