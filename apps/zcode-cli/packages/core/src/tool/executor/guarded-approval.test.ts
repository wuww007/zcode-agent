// Guarded executor 授权边界（移植自官方 v3.15.1 tests/guarded-approval.test.ts，
// vitest → node:test/mock.fn）。真实 executor + 真实 broker 的行为级测试，可独立运行：
//   npx tsx --test apps/zcode-cli/packages/core/src/tool/executor/guarded-approval.test.ts
// 注意：core 的 tsconfig 排除 **/*.test.ts，本文件不进 tsc。
//
// 与官方的差异（本地为 v3.14.3 单文件审批流内联，未引入 registered 信号）：
// - "cancels while registration is pending (deferred)" 用例不移植——registered 信号是
//   官方 permission-request 拆分的机制，本地 broker 在构造时同步登记，无此窗口。
// - 普通（非 guarded）重判沿用本地"同 requestId 关闭旧请求再开新请求"的语义，
//   不是官方的"新 id + rewrite transition"。

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  CoreErrorType,
  createSessionId,
  createToolCallId,
  SessionEventType,
  type CollaborationMode,
  type ExecutionShellSelection,
  type PermissionBrokerResult,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionRuleset,
  type SessionEvent,
} from "@zcode/contracts";
import { createToolExecutor } from "./impl.js";
import { createToolRegistry } from "../registry.js";
import { bashToolEntry } from "../handlers/bash.js";
import { PermissionService } from "../../permission/service.js";
import { createManualPermissionBroker } from "../../permission/broker.js";
import type { ToolEntry, ToolExecutionContext } from "../types.js";

const POSIX: ExecutionShellSelection = {
  dialect: "posix",
  source: "auto-detected",
  display: { name: "bash" },
};

/** 轮询等待条件成立；替代官方的 vi.waitFor。 */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  setCwd: (next: string) => void;
  setMode: (next: CollaborationMode) => void;
  execute: (command?: string, signal?: AbortSignal) => Promise<{
    success: boolean;
    output?: { stdout: string };
    error?: { type?: string; message?: string };
  }>;
  handler: ReturnType<typeof mock.fn>;
  hooks: ReturnType<typeof mock.fn>;
  broker: ReturnType<typeof createManualPermissionBroker>;
  requests: PermissionBrokerRequest[];
  events: SessionEvent[];
  shell: ExecutionShellSelection;
  saveProjectPermission: ReturnType<typeof mock.fn>;
}

function harness(
  options: {
    mode?: CollaborationMode;
    answer?: (request: PermissionBrokerRequest) => Promise<PermissionBrokerResult>;
    noBroker?: boolean;
    deferredBroker?: PermissionBrokerPort;
    hookInput?: unknown;
    permissionHookInput?: unknown;
    timeoutMs?: number;
    validateInput?: ToolEntry["validateInput"];
    prepareApproval?: ToolEntry["prepareApproval"];
    resolvePermissionCapability?: ToolEntry["resolvePermissionCapability"];
    projectRules?: PermissionRuleset;
    onPublished?: (
      requestId: string,
      broker: ReturnType<typeof createManualPermissionBroker>,
    ) => void;
  } = {},
): Harness {
  const registry = createToolRegistry();
  const handler = mock.fn(async (_input: unknown, _context: ToolExecutionContext) => ({
    stdout: "controlled handler result",
    stderr: "",
    exitCode: 0,
    interrupted: false,
  }));
  registry.register({
    ...bashToolEntry,
    handler,
    outputSchema: undefined,
    ...(options.validateInput ? { validateInput: options.validateInput } : {}),
    ...(options.prepareApproval ? { prepareApproval: options.prepareApproval } : {}),
    ...(options.resolvePermissionCapability
      ? { resolvePermissionCapability: options.resolvePermissionCapability }
      : {}),
  });
  const events: SessionEvent[] = [];
  const requests: PermissionBrokerRequest[] = [];
  const shell = structuredClone(POSIX);
  let mode = options.mode ?? "guarded";
  let cwd = "/workspace/original";
  const hooks = mock.fn(async (input: unknown) => ({
    additionalContexts: [] as string[],
    permissionBehavior:
      options.permissionHookInput === undefined ? ("allow" as const) : ("ask" as const),
    ...((input as { hookEventName?: string }).hookEventName === "PreToolUse" &&
    options.hookInput !== undefined
      ? { updatedInput: options.hookInput }
      : {}),
    ...((input as { hookEventName?: string }).hookEventName === "PermissionRequest" &&
    options.permissionHookInput !== undefined
      ? {
          permissionRequestResult: {
            behavior: "allow" as const,
            updatedInput: options.permissionHookInput,
          },
        }
      : {}),
  }));
  const saveProjectPermission = mock.fn();
  const broker = createManualPermissionBroker({
    onRequest: (request) => {
      requests.push(request);
    },
  });
  const executor = createToolExecutor({
    registry,
    getMode: () => mode,
    getWorkingDirectory: () => cwd,
    sessionId: createSessionId("guarded"),
    permissionService: new PermissionService(),
    permissionTimeoutMs: options.timeoutMs,
    sessionStore: {
      getSession: async () => ({ projectID: "guarded-project" }),
      getProjectPermission: async () => options.projectRules ?? { allow: [{ toolName: "Bash" }] },
      saveProjectPermission,
    } as never,
    hookRunner: { run: hooks },
    getBashShellSelection: () => shell,
    ...(!options.noBroker
      ? {
          permissionBroker:
            options.deferredBroker ??
            (options.answer
              ? {
                  requestPermission: async (request: PermissionBrokerRequest) => {
                    requests.push(request);
                    return options.answer!(request);
                  },
                }
              : broker),
        }
      : {}),
    emitEvent: async (event) => {
      events.push(event);
      if (event.type === SessionEventType.PermissionRequested) {
        options.onPublished?.(event.payload.requestId!, broker);
      }
    },
  });
  const execute = (command = "rm -rf build", signal?: AbortSignal) =>
    executor.execute(
      { id: createToolCallId("guarded"), name: "Bash", input: { command } },
      { signal },
    ) as Promise<{
      success: boolean;
      output?: { stdout: string };
      error?: { type?: string; message?: string };
    }>;
  return {
    setCwd: (next: string) => {
      cwd = next;
    },
    setMode: (next: CollaborationMode) => {
      mode = next;
    },
    execute,
    handler,
    hooks,
    broker,
    requests,
    events,
    shell,
    saveProjectPermission,
  };
}

const handlerCallCount = (h: Harness): number => h.handler.mock.callCount();

describe("Guarded executor authorization boundary", () => {
  const lifecycleCases = [
    ["posix", "rm -r tree", "remove-critical-path"],
    ["git-bash", "rm first second", "remove-critical-path"],
    ["cmd", "rd /S tree", "cmd-remove-tree"],
    ["cmd", "erase /P file", "cmd-delete-files"],
    ["posix", "find . -type f -delete", "find-delete"],
    ["posix", "find -d . -type f -delete", "find-delete"],
    ["posix", "find -x . -type f -delete", "find-delete"],
    ["posix", "git clean -f", "git-clean-force"],
    ["git-bash", "robocopy src dst /MIR", "robocopy-delete"],
    ["posix", "rm first --help", "remove-critical-path"],
    ["cmd", "rd target/s/q", "cmd-remove-tree"],
    ["cmd", "rd/s/q target", "cmd-remove-tree"],
    ["cmd", "del/q target\\one.txt", "cmd-delete-files"],
    ["git-bash", "env MSYS2_ARG_CONV_EXCL=/MIR robocopy /c/src /c/dst /MIR", "robocopy-delete"],
  ] as const;
  const verdicts = [
    ["guarded", "deny", false, 1],
    ["guarded", "allow", true, 1],
    ["yolo", "deny", true, 0],
  ] as const;

  for (const [dialect, command, rule] of lifecycleCases) {
    for (const [mode, decision, success, requests] of verdicts) {
      it(`deletion lifecycle: ${dialect} / ${command} — ${mode} / ${decision}`, async () => {
        const h = harness({ mode });
        h.shell.dialect = dialect;
        const pending = h.execute(command);
        if (requests) {
          await waitFor(() => h.broker.listPendingRequests().length === 1, "pending request");
          assert.equal(handlerCallCount(h), 0, "handler must not run before approval");
          assert.equal(
            h.broker.resolvePermission(h.requests[0]!.requestId, {
              decision,
              reason: "Keep deletion fixture",
            }),
            true,
          );
        }
        const result = await pending;
        assert.equal(result.success, success);
        assert.equal(h.requests.length, requests);
        if (requests) {
          assert.partialDeepStrictEqual(h.requests[0], {
            approvalMode: "user-once",
            ruleId: `safety.bash.${rule}`,
            input: { command },
          });
          assert.equal(
            h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "allow" }),
            false,
            "late approval must be invalid",
          );
        }
        assert.equal(handlerCallCount(h), success ? 1 : 0);
        if (success) {
          assert.deepStrictEqual(h.handler.mock.calls[0]?.arguments[0], { command });
          assert.partialDeepStrictEqual(result.output, { stdout: "controlled handler result" });
        } else {
          assert.match(result.error?.message ?? "", /Keep deletion fixture/);
        }
        // PreToolUse allow 不能替代用户批准：hooks 至少跑过一次（但 PermissionRequest hook
        // 在 user-once 下不跑）。
        assert.ok(h.hooks.mock.callCount() > 0);
        assert.equal(saveProjectCalls(h), 0, "user-once must not persist project rules");
        assert.deepStrictEqual(h.broker.listPendingRequests(), []);
      });

      it(`cancellation keeps files unexecuted and clears the real broker: ${dialect} / ${command}`, async () => {
        const h = harness();
        h.shell.dialect = dialect;
        const controller = new AbortController();
        const result = h.execute(command, controller.signal);
        await waitFor(() => h.broker.listPendingRequests().length === 1, "pending request");
        controller.abort();
        assert.equal((await result).success, false);
        assert.equal(handlerCallCount(h), 0);
        assert.equal(saveProjectCalls(h), 0);
        assert.deepStrictEqual(h.broker.listPendingRequests(), []);
      });
    }
  }

  function saveProjectCalls(h: Harness): number {
    return h.saveProjectPermission.mock.callCount();
  }

  for (const [mode, decision, success, requests] of verdicts) {
    it(`glob force refspec: ${mode} / ${decision}`, async () => {
      const h = harness({ mode, answer: async () => ({ decision }) });
      const command = "git push origin +refs/heads/*:refs/heads/*";
      const result = await h.execute(command);
      assert.equal(result.success, success);
      assert.equal(h.requests.length, requests);
      if (requests) {
        assert.partialDeepStrictEqual(h.requests[0], {
          approvalMode: "user-once",
          ruleId: "safety.bash.git-push-force",
          input: { command },
        });
      }
      assert.equal(handlerCallCount(h), success ? 1 : 0);
      if (success) assert.deepStrictEqual(h.handler.mock.calls[0]?.arguments[0], { command });
      assert.equal(saveProjectCalls(h), 0);
      assert.deepStrictEqual(h.broker.listPendingRequests(), []);
    });
  }

  it("单次确认不会被工具预览的 proceed 放行", async () => {
    const prepareApproval = mock.fn(() => ({ gate: "proceed" as const }));
    const h = harness({ prepareApproval, answer: async () => ({ decision: "deny" }) });
    assert.equal((await h.execute()).success, false);
    assert.equal(h.requests.length, 1);
    assert.equal(prepareApproval.mock.callCount(), 0, "prepareApproval must not bypass user-once");
    assert.equal(handlerCallCount(h), 0);
  });

  for (const [mode, decision, success, requests] of verdicts) {
    it(`CMD REM-named redirection: ${mode} / ${decision}`, async () => {
      const h = harness({ mode, answer: async () => ({ decision }) });
      h.shell.dialect = "cmd";
      const command = ">rem git reset --hard";
      const result = await h.execute(command);
      assert.equal(result.success, success);
      assert.equal(h.requests.length, requests);
      if (requests) {
        assert.partialDeepStrictEqual(h.requests[0], {
          approvalMode: "user-once",
          ruleId: "safety.bash.git-reset-hard",
          input: { command },
        });
      }
      assert.equal(handlerCallCount(h), success ? 1 : 0);
      assert.equal(saveProjectCalls(h), 0);
      assert.deepStrictEqual(h.broker.listPendingRequests(), []);
    });
  }

  for (const [mode, decision, success, requests] of verdicts) {
    it(`rm trailing help/version: ${mode} / ${decision}`, async () => {
      const h = harness({
        mode,
        answer: async () => ({ decision, reason: "Keep fixture files" }),
      });
      const command = "rm -rf target --help --version";
      const result = await h.execute(command);
      assert.equal(result.success, success);
      assert.equal(h.requests.length, requests);
      if (requests) {
        assert.partialDeepStrictEqual(h.requests[0], {
          approvalMode: "user-once",
          ruleId: "safety.bash.remove-critical-path",
          input: { command },
        });
      }
      assert.equal(handlerCallCount(h), success ? 1 : 0);
      if (!success) assert.match(result.error?.message ?? "", /Keep fixture files/);
      assert.equal(saveProjectCalls(h), 0);
      assert.deepStrictEqual(h.broker.listPendingRequests(), []);
    });
  }

  it("hook rewrite recheck receives the same prepared context as the first decision", async () => {
    const contexts: unknown[] = [];
    const h = harness({
      mode: "build",
      permissionHookInput: { command: "git reset --hard" },
      projectRules: { ask: [{ toolName: "Bash" }] },
      resolvePermissionCapability: (input, context) => {
        contexts.push(context);
        return bashToolEntry.resolvePermissionCapability?.(input, context);
      },
    });
    const controller = new AbortController();
    const pending = h.execute("echo original", controller.signal);
    try {
      await waitFor(() => h.requests.length === 2, "two requests (recheck)");
      assert.ok(contexts.length >= 2);
      for (const context of contexts) {
        assert.partialDeepStrictEqual(context, {
          mode: "build",
          bashShellSelection: h.shell,
          workingDirectory: "/workspace/original",
        });
      }
    } finally {
      controller.abort();
      await pending;
    }
  });

  it("replaces a hook-approved edited input with a fresh user-only request", async () => {
    const h = harness({ permissionHookInput: { command: "rm -rf replacement" } });
    const pending = h.execute("echo harmless");
    await waitFor(() => h.requests.length === 2, "rewritten request");
    const [original, guarded] = h.requests;
    assert.equal(original?.approvalMode, undefined);
    assert.partialDeepStrictEqual(guarded, {
      approvalMode: "user-once",
      input: { command: "rm -rf replacement" },
    });
    assert.notEqual(guarded?.requestId, original?.requestId);
    // 旧请求已因 Hook 改写关闭：迟到批准无效，只剩改写后的用户单次确认。
    assert.equal(h.broker.resolvePermission(original!.requestId, { decision: "allow" }), false);
    assert.equal(h.broker.listPendingRequests().length, 1);
    assert.equal(handlerCallCount(h), 0);
    h.broker.resolvePermission(guarded!.requestId, { decision: "deny" });
    assert.equal((await pending).success, false);
    assert.equal(saveProjectCalls(h), 0);
    assert.deepStrictEqual(h.broker.listPendingRequests(), []);
  });

  it("reclassifies a PreToolUse edit before approval even with project allow", async () => {
    const h = harness({
      hookInput: { command: "rm -rf replacement" },
      answer: async () => ({ decision: "deny" }),
    });
    assert.equal((await h.execute("echo harmless")).success, false);
    assert.deepStrictEqual(h.requests[0]?.input, { command: "rm -rf replacement" });
    assert.equal(handlerCallCount(h), 0);
    assert.equal(saveProjectCalls(h), 0);
  });

  it("does not let PreToolUse/PermissionRequest auto-allow a dangerous request", async () => {
    const h = harness();
    const pending = h.execute();
    await waitFor(() => h.requests.length === 1, "user-once request");
    assert.equal(handlerCallCount(h), 0);
    assert.partialDeepStrictEqual(h.requests[0], {
      approvalMode: "user-once",
      ruleId: "safety.bash.remove-critical-path",
    });
    assert.equal(
      h.hooks.mock.calls.some(
        (call) =>
          (call.arguments[0] as { hookEventName?: string }).hookEventName === "PermissionRequest",
      ),
      false,
      "PermissionRequest hook must not run for user-once",
    );
    h.broker.resolvePermission(h.requests[0]!.requestId, {
      decision: "deny",
      reason: "Keep my files",
    });
    const result = await pending;
    assert.equal(result.success, false);
    assert.match(result.error?.message ?? "", /Keep my files/);
    assert.equal(handlerCallCount(h), 0);
    assert.deepStrictEqual(h.broker.listPendingRequests(), []);
    assert.equal(saveProjectCalls(h), 0);
  });

  it("reuses the session shell selection and executes with the approved cwd exactly once", async () => {
    const h = harness();
    const pending = h.execute();
    await waitFor(() => h.requests.length === 1, "user-once request");
    h.setCwd("/workspace/changed");
    h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "allow" });
    assert.equal((await pending).success, true);
    assert.equal(handlerCallCount(h), 1);
    const context = h.handler.mock.calls[0]?.arguments[1] as ToolExecutionContext;
    assert.equal(context.bashShellSelection, h.shell);
    assert.partialDeepStrictEqual(context, {
      bashShellSelection: { dialect: "posix" },
      workingDirectory: "/workspace/original",
    });
    assert.equal(h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "allow" }), false);
  });

  for (const decision of ["allow", "modify"] as const) {
    it(`executes a broker-approved dangerous edit once without reapproval: ${decision}`, async () => {
      const modifiedInput = { command: "git reset --hard" };
      let responses = 0;
      const h = harness({
        answer: async () => {
          // 回归时有界失败，不让重复审批挂住测试或不断请求相同输入。
          if (++responses > 1) return { decision: "deny", reason: "Unexpected reapproval" };
          h.setMode("yolo");
          h.setCwd("/workspace/changed");
          return { decision, modifiedInput };
        },
      });
      assert.equal((await h.execute()).success, true);
      assert.equal(h.requests.length, 1);
      assert.equal(h.requests[0]?.mode, "guarded");
      assert.equal(handlerCallCount(h), 1);
      const handlerInput = h.handler.mock.calls[0]?.arguments[0];
      assert.deepStrictEqual(handlerInput, modifiedInput);
      assert.notEqual(handlerInput, modifiedInput, "handler receives a frozen copy");
      assert.equal(Object.isFrozen(handlerInput), true, "approved input must be a frozen snapshot");
      const context = h.handler.mock.calls[0]?.arguments[1] as ToolExecutionContext;
      assert.equal(context.bashShellSelection, h.shell);
      assert.partialDeepStrictEqual(context, {
        bashShellSelection: { dialect: "posix" },
        workingDirectory: "/workspace/original",
      });
      assert.equal(
        h.events.filter((e) => e.type === SessionEventType.PermissionResolved).length,
        1,
      );
      assert.equal(saveProjectCalls(h), 0);
    });
  }

  const illegalAnswers: PermissionBrokerResult[] = [
    {
      decision: "allow",
      permissionUpdates: [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] }],
    } as PermissionBrokerResult,
    { decision: "invalid" } as unknown as PermissionBrokerResult,
    { decision: "allow", permissionUpdates: {} } as unknown as PermissionBrokerResult,
    {
      decision: "allow",
      sessionPermissionUpdates: [
        { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] },
      ],
    } as PermissionBrokerResult,
    { decision: "allow", reason: {} } as unknown as PermissionBrokerResult,
    { decision: "modify", modifiedInput: { command: 42 } } as unknown as PermissionBrokerResult,
    { decision: "allow", modifiedInput: { command: 42 } } as unknown as PermissionBrokerResult,
    {
      decision: "modify",
      modifiedInput: { command: "git reset --hard" },
      permissionUpdates: [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] }],
    } as PermissionBrokerResult,
  ];
  for (const [index, answer] of illegalAnswers.entries()) {
    it(`rejects illegal/invalid/persistent response #${index} without executing`, async () => {
      const h = harness({ answer: async () => answer });
      assert.equal((await h.execute()).success, false);
      assert.equal(handlerCallCount(h), 0);
      assert.equal(saveProjectCalls(h), 0);
    });
  }

  it("times out and removes the pending request without executing or storing rules", async () => {
    const h = harness({ timeoutMs: 10 });
    assert.equal((await h.execute()).error?.type, CoreErrorType.PermissionTimeout);
    assert.equal(h.requests.length, 1);
    assert.deepStrictEqual(h.broker.listPendingRequests(), []);
    assert.equal(handlerCallCount(h), 0);
    assert.equal(saveProjectCalls(h), 0);
    assert.equal(h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "allow" }), false);
  });

  it("cleans pending on cancellation", async () => {
    const h = harness();
    const abort = new AbortController();
    const pending = h.execute(undefined, abort.signal);
    await waitFor(() => h.requests.length === 1, "user-once request");
    abort.abort();
    assert.equal((await pending).error?.type, CoreErrorType.ToolCancelled);
    assert.deepStrictEqual(h.broker.listPendingRequests(), []);
    assert.equal(handlerCallCount(h), 0);
  });

  it("mode switching does not settle an existing request", async () => {
    const h = harness();
    const pending = h.execute();
    await waitFor(() => h.requests.length === 1, "user-once request");
    h.setMode("yolo");
    assert.equal(handlerCallCount(h), 0);
    h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "deny" });
    assert.equal((await pending).success, false);
    assert.equal((await h.execute()).success, true);
    assert.equal(h.requests.length, 1, "second run executes under yolo with no new request");
  });

  it("fails without an interactive broker", async () => {
    const h = harness({ noBroker: true });
    assert.equal((await h.execute()).error?.type, CoreErrorType.ConfigurationError);
    assert.equal(handlerCallCount(h), 0);
  });

  it("original YOLO executes the same command with no new approval", async () => {
    const h = harness({ mode: "yolo" });
    assert.equal((await h.execute()).success, true);
    assert.deepStrictEqual(h.requests, []);
    assert.equal(handlerCallCount(h), 1);
    const context = h.handler.mock.calls[0]?.arguments[1] as ToolExecutionContext;
    assert.equal(context.bashShellSelection, h.shell);
  });

  it("registers the broker before publishing a request that can be answered immediately", async () => {
    let delivered = false;
    const h = harness({
      timeoutMs: 30,
      onPublished: (id, broker) => {
        delivered = broker.resolvePermission(id, { decision: "allow" });
      },
    });
    assert.equal((await h.execute()).success, true);
    assert.equal(delivered, true, "broker must be registered before the event is published");
    assert.equal(handlerCallCount(h), 1);
    assert.equal(
      h.events.filter((e) => e.type === SessionEventType.PermissionResolved).length,
      1,
    );
  });

  it("preserves infrastructure errors without describing them as user denial", async () => {
    const h = harness({
      answer: async () => {
        throw new Error("transport unavailable");
      },
    });
    const result = await h.execute();
    assert.equal(result.success, false);
    // guarded 的 broker 故障必须落成 ToolExecutionFailed（非 PermissionDenied），
    // 否则模型把基础设施故障误判为"命令被策略禁止"。
    assert.equal(result.error?.type, CoreErrorType.ToolExecutionFailed);
    assert.equal(handlerCallCount(h), 0);
  });
});
