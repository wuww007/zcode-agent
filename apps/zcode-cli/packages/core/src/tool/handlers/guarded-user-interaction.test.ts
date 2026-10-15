// Guarded 用户交互完成（AskUserQuestion）（移植自官方 v3.15.1 tests/guarded-user-interaction.test.ts，
// vitest → node:test/mock.fn）。行为级测试，可独立运行：
//   npx tsx --test apps/zcode-cli/packages/core/src/tool/handlers/guarded-user-interaction.test.ts

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  createSessionId,
  createToolCallId,
  SessionEventType,
  type CollaborationMode,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
  type SessionEvent,
} from "@zcode/contracts";
import { createToolExecutor } from "../executor/impl.js";
import { askUserQuestionToolEntry } from "./ask-user-question.js";
import { createToolRegistry } from "../registry.js";
import { PermissionService } from "../../permission/service.js";

const QUESTION = "Which color should we use?";
const INPUT = {
  questions: [
    {
      header: "Color",
      question: QUESTION,
      options: [
        { label: "Blue", description: "Use blue" },
        { label: "Red", description: "Use red" },
      ],
    },
  ],
};

async function runQuestion(options: {
  mode?: CollaborationMode;
  answers?: unknown;
  deny?: boolean;
  hookAnswers?: boolean;
}) {
  const registry = createToolRegistry();
  const handler = mock.fn(askUserQuestionToolEntry.handler);
  registry.register({ ...askUserQuestionToolEntry, handler });
  const requests: PermissionBrokerRequest[] = [];
  const events: SessionEvent[] = [];
  let permissionHookCalls = 0;
  const executor = createToolExecutor({
    mode: options.mode ?? "guarded",
    sessionId: createSessionId("guarded-question"),
    registry,
    permissionService: new PermissionService(),
    emitEvent: async (event) => {
      events.push(event);
    },
    permissionBroker: {
      async requestPermission(request, requestOptions): Promise<PermissionBrokerResult> {
        requests.push(request);
        // 有界失败：回归时立即报错，不让重复问答把测试挂死。
        if (requests.length > (options.hookAnswers ? 2 : 1)) {
          throw new Error("User answer must not reopen the interaction");
        }
        if (options.hookAnswers && requests.length === 1) {
          return new Promise((_, reject) => {
            requestOptions!.signal!.addEventListener("abort", () => reject(new Error("Hook won")), {
              once: true,
            });
          });
        }
        return options.deny
          ? { decision: "deny", reason: "No answer" }
          : { decision: "modify", modifiedInput: { ...INPUT, answers: options.answers } };
      },
    },
    ...(options.hookAnswers
      ? {
          hookRunner: {
            run: async ({ hookEventName }) => {
              if (hookEventName === "PermissionRequest") permissionHookCalls++;
              return {
                additionalContexts: [] as string[],
                ...(hookEventName === "PermissionRequest" && requests.length === 1
                  ? {
                      permissionRequestResult: {
                        behavior: "allow" as const,
                        updatedInput: { ...INPUT, answers: { [QUESTION]: "Hook answer" } },
                      },
                    }
                  : {}),
              };
            },
          },
        }
      : {}),
  });
  const result = await executor.execute({
    id: createToolCallId("guarded-question"),
    name: "AskUserQuestion",
    input: INPUT,
  });
  return { result, requests, events, handler, permissionHookCalls };
}

for (const mode of ["yolo", "guarded"] as const) {
  describe(`${mode} user interaction completion`, () => {
    for (const answer of ["Blue", "Custom teal", undefined]) {
    it(`returns ${answer} without reopening the question`, async () => {
      const answers = answer === undefined ? {} : { [QUESTION]: answer };
      const { result, requests, events, handler } = await runQuestion({ mode, answers });
      assert.equal(result.success, true);
      assert.partialDeepStrictEqual(result.output, { answers });
      assert.match(
        typeof result.modelContent === "string" ? result.modelContent : "",
        new RegExp((answer ?? "The user did not provide answers").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.equal(requests.length, 1);
      assert.equal(handler.mock.callCount(), 1);
      assert.deepStrictEqual(
        events.map((event) => event.type),
        [
          SessionEventType.PermissionRequested,
          SessionEventType.PermissionResolved,
          SessionEventType.ToolCallStarted,
          SessionEventType.ToolCallResult,
        ],
      );
    });
  }

  it("still rejects invalid answers before the handler", async () => {
    const { result, requests, handler } = await runQuestion({ mode, answers: 42 });
    assert.equal(result.success, false);
    assert.equal(requests.length, 1);
    assert.equal(handler.mock.callCount(), 0);
  });

    it("still respects user denial", async () => {
      const { result, requests, handler } = await runQuestion({ mode, deny: true });
      assert.equal(result.success, false);
      assert.match(result.error?.message ?? "", /No answer/);
      assert.equal(requests.length, 1);
      assert.equal(handler.mock.callCount(), 0);
    });
  });
}

it("rechecks Hook changes instead of treating them as a user's answer", async () => {
  const answers = { [QUESTION]: "Real user answer" };
  const { result, requests, handler, permissionHookCalls } = await runQuestion({
    answers,
    hookAnswers: true,
  });
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[1]!.requestId, requests[0]!.requestId);
  assert.partialDeepStrictEqual(result.output, { answers });
  assert.equal(handler.mock.callCount(), 1);
  assert.equal(permissionHookCalls, 1);
});
