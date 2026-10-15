// 生成速度 tracker 的纯逻辑回归（见 specs/task-page-token-speed.md）：
// 窗口速率、路径过滤、合并器 upsert 差分、行删除与快照播种。
// 纯数据模块，可用 tsx --test 独立运行。
import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationDelta, ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { GenerationSpeedTracker } from "../src/v4/generationSpeed.js";

const T0 = 1_000_000;

function assistantRow(rowId: number, text: string): ConversationRow {
  return { kind: "assistantText", rowId, text, state: "streaming" } as unknown as ConversationRow;
}

function toolRow(rowId: number, inputText: string): ConversationRow {
  return { kind: "toolCall", rowId, inputText, toolName: "x" } as unknown as ConversationRow;
}

function rowDelta(rowId: number, path: string, append: string): ConversationDelta {
  return { op: "row.delta", rowId, path, append } as ConversationDelta;
}

test("纯文本 delta：按窗口聚合估算 token 并给出速率", () => {
  const tracker = new GenerationSpeedTracker();
  // 120 个非中文字符 ÷ 3 = 40 tokens，跨 1s 生成 → 40 tok/s。
  tracker.observeDeltas([rowDelta(1, "text", "a".repeat(60))], T0);
  tracker.observeDeltas([rowDelta(1, "text", "b".repeat(60))], T0 + 1_000);
  const sample = tracker.sample(T0 + 1_001);
  assert.ok(sample);
  assert.equal(sample.windowTokens, 40);
  assert.ok(Math.abs(sample.tokensPerSecond - 40) < 1);
});

test("中文按两倍字符权重估算", () => {
  const tracker = new GenerationSpeedTracker();
  // 30 个中文字符 ×2 = 60 权重 ÷ 3 = 20 tokens。
  tracker.observeDeltas([rowDelta(1, "text", "中".repeat(30))], T0);
  const sample = tracker.sample(T0 + 1_000);
  assert.ok(sample);
  assert.equal(sample.windowTokens, 20);
});

test("只有 output.text / summaryText 追加时不计入生成", () => {
  const tracker = new GenerationSpeedTracker();
  tracker.observeDeltas([rowDelta(1, "output.text", "x".repeat(300))], T0);
  tracker.observeDeltas([rowDelta(2, "summaryText", "y".repeat(300))], T0 + 100);
  assert.equal(tracker.sample(T0 + 1_000), null);
});

test("窗口不足最小时长不返回样本（开流尖峰抑制）", () => {
  const tracker = new GenerationSpeedTracker();
  tracker.observeDeltas([rowDelta(1, "text", "a".repeat(300))], T0);
  assert.equal(tracker.sample(T0 + 200), null);
  assert.ok(tracker.sample(T0 + 500));
});

test("样本全部滑出窗口后速率归空（停滞不残留）", () => {
  const tracker = new GenerationSpeedTracker();
  tracker.observeDeltas([rowDelta(1, "text", "a".repeat(300))], T0);
  assert.ok(tracker.sample(T0 + 1_000));
  assert.equal(tracker.sample(T0 + 3_000 + 1), null);
});

test("合并器用 upserted 吞掉 delta 后按正差分补齐，不重复计数", () => {
  const tracker = new GenerationSpeedTracker();
  tracker.observeDeltas(
    [
      { op: "row.appended", row: assistantRow(5, "") } as ConversationDelta,
      rowDelta(5, "text", "a".repeat(90)),
    ],
    T0,
  );
  // 同批 upsert 携带完整 150 字符：只补 60 的新增部分。
  tracker.observeDeltas(
    [{ op: "row.upserted", row: assistantRow(5, "a".repeat(150)) } as ConversationDelta],
    T0 + 500,
  );
  const sample = tracker.sample(T0 + 1_000);
  assert.ok(sample);
  assert.equal(sample.windowTokens, 50); // 150 字符 ÷ 3
});

test("未见过的新行 upsert 不计入（历史文本不当作生成）", () => {
  const tracker = new GenerationSpeedTracker();
  tracker.observeDeltas(
    [{ op: "row.upserted", row: assistantRow(9, "a".repeat(300)) } as ConversationDelta],
    T0,
  );
  assert.equal(tracker.sample(T0 + 1_000), null);
});

test("快照播种：已有正文不算生成，后续追加才算", () => {
  const tracker = new GenerationSpeedTracker();
  tracker.seedRows([assistantRow(3, "a".repeat(300))]);
  tracker.observeDeltas([rowDelta(3, "text", "b".repeat(90))], T0);
  const sample = tracker.sample(T0 + 1_000);
  assert.ok(sample);
  assert.equal(sample.windowTokens, 30);
});

test("row.removed 清掉行内账本：同 rowId 重建后从零计", () => {
  const tracker = new GenerationSpeedTracker();
  tracker.observeDeltas(
    [
      { op: "row.appended", row: assistantRow(7, "") } as ConversationDelta,
      rowDelta(7, "text", "a".repeat(90)),
    ],
    T0,
  );
  tracker.observeDeltas([{ op: "row.removed", fromRowId: 7 } as ConversationDelta], T0 + 100);
  // 重建后同 rowId 的 upsert 视为新行：不计入。
  tracker.observeDeltas(
    [{ op: "row.upserted", row: assistantRow(7, "a".repeat(300)) } as ConversationDelta],
    T0 + 200,
  );
  const sample = tracker.sample(T0 + 1_000);
  assert.ok(sample);
  assert.equal(sample.windowTokens, 30); // 只有删除前的 90 字符
});

test("工具参数（inputText）计入生成速度", () => {
  const tracker = new GenerationSpeedTracker();
  tracker.observeDeltas(
    [
      { op: "row.appended", row: toolRow(11, "") } as ConversationDelta,
      rowDelta(11, "inputText", "a".repeat(150)),
    ],
    T0,
  );
  const sample = tracker.sample(T0 + 1_000);
  assert.ok(sample);
  assert.equal(sample.windowTokens, 50);
});

test("同一时刻的多条 delta 合并为一条样本", () => {
  const tracker = new GenerationSpeedTracker();
  tracker.observeDeltas([rowDelta(1, "text", "a".repeat(30))], T0);
  tracker.observeDeltas([rowDelta(1, "text", "a".repeat(30))], T0);
  tracker.observeDeltas([rowDelta(1, "text", "a".repeat(30))], T0);
  const sample = tracker.sample(T0 + 1_000);
  assert.ok(sample);
  assert.equal(sample.windowTokens, 30);
});
