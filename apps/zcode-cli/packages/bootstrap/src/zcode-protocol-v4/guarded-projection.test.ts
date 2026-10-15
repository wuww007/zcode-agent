// Guarded 单次确认在 continuous/replayable 两条投放链与 replay 上的投影一致性
// （移植自官方 v3.15.1 bootstrap/tests/guarded-projection.test.ts，vitest → node:test）。
// 可独立运行：
//   npx tsx --test apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/guarded-projection.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSessionId,
  createRootTraceContext,
  SessionEventType,
  type SessionEvent,
} from "@zcode/contracts";
import {
  DELIVERY_PROFILES,
  filterConversationDeltasForProfile,
  conversationSnapshotSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";

describe("guarded continuous/replayable share authoritative pending approval", () => {
  it("keeps once-only options and feedback through both delivery profiles and replay", () => {
    const sessionId = createSessionId("guarded-projection");
    const trace = createRootTraceContext({ sessionId });
    const event = {
      id: "guarded-permission-event",
      sessionId,
      traceId: trace.traceId,
      sequenceNumber: 1,
      timestamp: new Date(),
      type: SessionEventType.PermissionRequested,
      payload: {
        approvalMode: "user-once",
        fullAccessSupported: true,
        requestId: "guarded-request",
        toolCallId: "bash",
        toolName: "Bash",
        riskLevel: "high",
        reason: "Dangerous command",
        input: { command: "rm -rf fixture" },
      },
    } as SessionEvent;
    const live = new ProductProjection(sessionId, "epoch");
    const deltas = live.applyEvent(event);
    for (const profile of [DELIVERY_PROFILES.continuous, DELIVERY_PROFILES.replayable]) {
      assert.deepStrictEqual(filterConversationDeltasForProfile(deltas, profile), deltas);
    }
    const restored = new ProductProjection(sessionId, "epoch");
    restored.applyEvent(event);
    const current = conversationSnapshotSchema.parse(live.getSnapshot());
    const replayed = conversationSnapshotSchema.parse(restored.getSnapshot());
    assert.deepStrictEqual(replayed.pendingInteractions, current.pendingInteractions);
    assert.partialDeepStrictEqual(current.pendingInteractions[0]?.payload, {
      kind: "permission",
      freeText: true,
    });
    const payload = current.pendingInteractions[0]!.payload;
    if (payload.kind !== "permission") throw new Error("Expected permission");
    // user-once：只保留一次允许与拒绝；fullAccessSupported 被 approvalMode 抑制。
    assert.deepStrictEqual(
      payload.options.map((option) => option.kind),
      ["allowOnce", "deny"],
    );
    assert.equal(payload.fullAccessOption, undefined);
    live.applyEvent({
      ...event,
      id: "resolved" as SessionEvent["id"],
      sequenceNumber: 2,
      type: SessionEventType.PermissionResolved,
      payload: { requestId: "guarded-request", toolCallId: "bash", decision: "deny" },
    });
    assert.deepStrictEqual(live.getSnapshot().pendingInteractions, []);
  });
});
