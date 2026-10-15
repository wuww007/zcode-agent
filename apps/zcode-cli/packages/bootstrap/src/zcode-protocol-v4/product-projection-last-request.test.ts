// 精确生成速度（usage.lastRequest）投影回归（specs/task-page-token-speed.md）：
// main_turn 的 model_request_completed 写入 TPS；ModelComplete 的 usage 补丁不得抹掉它；
// 非 main_turn / 时间缺失 / TTFT 非法时不写。
// 只依赖 @zcode/contracts 与本目录投影，可独立运行：
//   npx tsx --test apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection-last-request.test.ts
// 注意：仓库没有任何 runner 会自动跑这个文件。

import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { ConversationDelta, SessionUsageState } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";

const SESSION_ID = "session-speed";
const TURN_ID = "turn-speed";
const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");

let sequenceNumber = 0;
function makeEvent(type: string, payload: unknown, at = BASE_TIME): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-${sequenceNumber}` as SessionEvent["id"],
    sessionId: SESSION_ID as SessionEvent["sessionId"],
    turnId: TURN_ID as NonNullable<SessionEvent["turnId"]>,
    type: type as SessionEvent["type"],
    timestamp: new Date(at),
    traceId: "trace-speed" as SessionEvent["traceId"],
    sequenceNumber,
    payload,
  };
}

function turnStarted(): SessionEvent {
  return makeEvent(SessionEventType.TurnStarted, {
    turnNumber: 1,
    input: "hello",
    inputId: "input-1",
    messageId: "message-1",
  });
}

function requestCompleted(overrides: Record<string, unknown> = {}, at = BASE_TIME + 5_000) {
  return makeEvent(
    SessionEventType.ModelNetworkStatus,
    {
      type: "model_request_completed",
      timestamp: new Date(at).toISOString(),
      traceId: "trace-speed",
      requestId: "request-1",
      providerId: "provider-1",
      modelId: "model-1",
      transport: "sse",
      attempt: 1,
      maxAttempts: 1,
      querySource: "main_turn",
      durationMs: 3_000,
      timeToFirstContentMs: 1_000,
      usage: { inputTokens: 10, outputTokens: 100, totalTokens: 110 },
      ...overrides,
    },
    at,
  );
}

function modelComplete(): SessionEvent {
  return makeEvent(
    SessionEventType.ModelComplete,
    {
      content: "hi",
      stopReason: "end_turn",
      querySource: "main_turn",
      contextWindow: 200_000,
      usage: { inputTokens: 10, outputTokens: 100, totalTokens: 110 },
    },
    BASE_TIME + 5_200,
  );
}

function usagePatchOf(deltas: readonly ConversationDelta[]): SessionUsageState | null {
  for (const delta of deltas) {
    if (delta.op === "state.updated" && delta.patch.usage) return delta.patch.usage;
  }
  return null;
}

function startedProjection(): ProductProjection {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  projection.applyEvent(turnStarted());
  assert.equal(projection.getSnapshot().control.phase, "running");
  return projection;
}

test("main_turn 请求完成写入精确 TPS（outputTokens ÷ (durationMs − TTFT)）", () => {
  const projection = startedProjection();
  const usage = usagePatchOf(projection.applyEvent(requestCompleted()));
  assert.ok(usage?.lastRequest, "main_turn 完成事件必须写 lastRequest");
  assert.equal(usage.lastRequest.outputTokens, 100);
  assert.equal(usage.lastRequest.generationDurationMs, 2_000);
  assert.equal(usage.lastRequest.tokensPerSecond, 50);
  assert.equal(usage.lastRequest.completedAt, BASE_TIME + 5_000);
});

test("ModelComplete 的 usage 补丁保留 lastRequest", () => {
  const projection = startedProjection();
  projection.applyEvent(requestCompleted());
  const usage = usagePatchOf(projection.applyEvent(modelComplete()));
  assert.ok(usage, "ModelComplete 必须更新 usage");
  // context 水位按 usage 的 context token 口径（totalTokens=110），与本用例无关的既有语义。
  assert.equal(usage.contextWindow?.usedTokens, 110);
  assert.equal(usage.lastRequest?.tokensPerSecond, 50);
  // 快照状态（而非只有该帧）也必须保留。
  assert.equal(projection.getSnapshot().usage.lastRequest?.tokensPerSecond, 50);
});

test("非 main_turn（subagent / 标题生成）不写 lastRequest", () => {
  const projection = startedProjection();
  const subagent = projection.applyEvent(requestCompleted({ querySource: "subagent" }));
  assert.equal(usagePatchOf(subagent)?.lastRequest, undefined);
  const title = projection.applyEvent(requestCompleted({ querySource: "title" }));
  assert.equal(usagePatchOf(title)?.lastRequest, undefined);
  assert.equal(projection.getSnapshot().usage.lastRequest, undefined);
});

test("时间缺失 / TTFT ≥ duration 时不写 lastRequest", () => {
  const projection = startedProjection();
  projection.applyEvent(requestCompleted({ timeToFirstContentMs: undefined }));
  assert.equal(projection.getSnapshot().usage.lastRequest, undefined);
  projection.applyEvent(requestCompleted({ durationMs: 1_000 }));
  assert.equal(projection.getSnapshot().usage.lastRequest, undefined);
});

test("usage.outputTokens 缺失时不写 lastRequest", () => {
  const projection = startedProjection();
  projection.applyEvent(requestCompleted({ usage: { inputTokens: 10 } }));
  assert.equal(projection.getSnapshot().usage.lastRequest, undefined);
});
