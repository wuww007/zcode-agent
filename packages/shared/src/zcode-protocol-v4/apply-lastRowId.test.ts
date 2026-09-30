// 锚点窗口恢复的协议语义回归：rows.lastRowId 在 delta 上的维护必须与窗口同步，
// 否则客户端会把"尾部还有未加载行"判定错（向下补页边界消失或永不停页）。
// 仅依赖 shared 内部相对导入，可用 node --test 独立运行。
import assert from "node:assert/strict";
import test from "node:test";

import { applyConversationDelta, applyConversationDeltas } from "./apply.js";
import type { ConversationDelta } from "./delta.js";
import type { ConversationSnapshot } from "./snapshot.js";
import type { AssistantTextRow } from "./rows.js";

function assistantTextRow(rowId: number, seq: number, text = `row-${rowId}`): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: "turn-1",
    createdAt: 0,
    createdAtSeq: seq,
    text,
    state: "complete",
  };
}

function snapshotWith(
  rows: readonly AssistantTextRow[],
  extra: Partial<ConversationSnapshot["rows"]> = {},
): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: 0,
    revision: 0,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: true },
      resumeGoal: { allowed: true },
    },
    inputRouting: { mode: "startNow" },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: {
      window: rows,
      totalCount: rows.length,
      firstRowId: rows[0]?.rowId ?? null,
      lastRowId: null,
      ...extra,
    },
    // 测试只关心 rows 的 delta 语义，A 区其余字段按最小占位补齐（schema 校验由
    // shared 黄金测试负责，此处不重复）。
  } as unknown as ConversationSnapshot;
}

function appendedDelta(rowId: number, seq: number): ConversationDelta {
  return {
    op: "row.appended",
    row: assistantTextRow(rowId, seq),
  } as ConversationDelta;
}

test("row.appended 推进 lastRowId：未知（null）时初始化为追加行", () => {
  const snapshot = snapshotWith([assistantTextRow(1, 1)]);
  const next = applyConversationDelta(snapshot, appendedDelta(7, 2));
  assert.equal(next.rows.lastRowId, 7);
  assert.equal(next.rows.firstRowId, 1);
  assert.equal(next.rows.totalCount, 2);
});

test("row.appended 推进 lastRowId：取 max，rowId 单调", () => {
  const snapshot = snapshotWith([assistantTextRow(1, 1)], { lastRowId: 5 });
  const next = applyConversationDelta(snapshot, appendedDelta(7, 2));
  assert.equal(next.rows.lastRowId, 7);
});

test("row.appended 不回退 lastRowId（乱序防御）", () => {
  const snapshot = snapshotWith([assistantTextRow(1, 1)], { lastRowId: 10 });
  const next = applyConversationDelta(snapshot, appendedDelta(7, 2));
  assert.equal(next.rows.lastRowId, 10);
});

test("row.removed 裁剪尾部：lastRowId 收缩到 fromRowId - 1", () => {
  // 模拟锚点窗口：window 只含 [2,3]，全序 lastRowId = 9（尾部 4..9 未加载）。
  const snapshot = snapshotWith([assistantTextRow(2, 2), assistantTextRow(3, 3)], {
    firstRowId: 1,
    totalCount: 9,
    lastRowId: 9,
  });
  const next = applyConversationDelta(snapshot, {
    op: "row.removed",
    fromRowId: 8,
  } as ConversationDelta);
  assert.deepEqual(
    next.rows.window.map((row) => row.rowId),
    [2, 3],
  );
  assert.equal(next.rows.lastRowId, 7);
  // totalCount 只按窗口内实际被裁的行数递减（本例窗口 [2,3] 无命中），不因未加载行收缩。
  assert.equal(next.rows.totalCount, 9);
});

test("row.removed 整支裁剪：lastRowId 与 firstRowId 一同置空", () => {
  const snapshot = snapshotWith([assistantTextRow(2, 2)], { firstRowId: 1, lastRowId: 9 });
  const next = applyConversationDelta(snapshot, {
    op: "row.removed",
    fromRowId: 1,
  } as ConversationDelta);
  assert.equal(next.rows.firstRowId, null);
  assert.equal(next.rows.lastRowId, null);
  assert.equal(next.rows.totalCount, 0);
});

test("锚点窗口下 append 后 rewind：越界追加行被裁，补页边界随 fromRowId 收缩", () => {
  // 锚点窗口 [10..12]，尾部已到 20；rewind 到 15 后：追加的 21 被裁（≥15），
  // lastRowId 应收缩到 14 —— 向下补页边界必须与全序一致，不能复活已裁行。
  const base = snapshotWith(
    [assistantTextRow(10, 1), assistantTextRow(11, 2), assistantTextRow(12, 3)],
    { firstRowId: 1, totalCount: 20, lastRowId: 20 },
  );
  const next = applyConversationDeltas(base, [
    appendedDelta(21, 4),
    { op: "row.removed", fromRowId: 15 } as ConversationDelta,
  ]);
  assert.deepEqual(
    next.rows.window.map((row) => row.rowId),
    [10, 11, 12],
  );
  assert.equal(next.rows.lastRowId, 14);
});
