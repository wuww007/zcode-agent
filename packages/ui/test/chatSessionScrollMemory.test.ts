// 会话切回的滚动记忆回归：锚点字段（anchorRowId / anchorOffsetPx）随状态一起
// 保存/读取/LRU 淘汰；贴底保存不携带锚点。纯数据模块，可用 tsx --test 独立运行。
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatSessionScrollMemoryKey,
  readChatSessionScrollMemoryState,
  resolveChatSessionScrollRestoreTop,
  saveChatSessionScrollMemoryState,
} from "../src/lib/chatSessionScrollMemory.js";

function state(scrollTop: number, extra: Record<string, unknown> = {}) {
  return {
    scrollTop,
    scrollHeight: 4000,
    clientHeight: 800,
    wasPinnedToBottom: false,
    updatedAt: 1,
    ...extra,
  };
}

test("锚点字段随滚动记忆一起保存与读取", () => {
  const key = buildChatSessionScrollMemoryKey({ workspacePath: "/w", sessionId: "s1" });
  assert.ok(key);
  saveChatSessionScrollMemoryState(key, state(1234, { anchorRowId: 42, anchorOffsetPx: 18 }));
  const restored = readChatSessionScrollMemoryState(key);
  assert.equal(restored?.anchorRowId, 42);
  assert.equal(restored?.anchorOffsetPx, 18);
  assert.equal(restored?.scrollTop, 1234);
});

test("贴底保存不携带锚点（恢复走贴底路径）", () => {
  const key = buildChatSessionScrollMemoryKey({ workspacePath: "/w", sessionId: "s2" });
  assert.ok(key);
  saveChatSessionScrollMemoryState(key, state(3200, { wasPinnedToBottom: true }));
  const restored = readChatSessionScrollMemoryState(key);
  assert.equal(restored?.wasPinnedToBottom, true);
  assert.equal(restored?.anchorRowId, undefined);
});

test("重复保存同一会话覆盖锚点（切走再切回读最新值）", () => {
  const key = buildChatSessionScrollMemoryKey({ workspacePath: "/w", sessionId: "s3" });
  assert.ok(key);
  saveChatSessionScrollMemoryState(key, state(500, { anchorRowId: 10 }));
  saveChatSessionScrollMemoryState(key, state(2200, { anchorRowId: 30, anchorOffsetPx: 5 }));
  const restored = readChatSessionScrollMemoryState(key);
  assert.equal(restored?.anchorRowId, 30);
  assert.equal(restored?.scrollTop, 2200);
});

test("旧记忆（无锚点字段）仍可读取，恢复路径按无锚点处理", () => {
  const key = buildChatSessionScrollMemoryKey({ workspacePath: "/w", sessionId: "s4" });
  assert.ok(key);
  saveChatSessionScrollMemoryState(key, state(900));
  const restored = readChatSessionScrollMemoryState(key);
  assert.equal(restored?.anchorRowId, undefined);
  // 旧路径的 clamp 恢复不受影响：锚点窗口下内容高度不足时钳到可滚动范围。
  assert.equal(
    resolveChatSessionScrollRestoreTop(
      { scrollTop: 3200 },
      { scrollHeight: 1000, clientHeight: 800 },
    ),
    200,
  );
});

test("LRU 淘汰仍生效：超过 200 条时最旧会话被挤出", () => {
  const keys: string[] = [];
  for (let i = 0; i < 205; i += 1) {
    const key = buildChatSessionScrollMemoryKey({ workspacePath: "/w", sessionId: `lru-${i}` });
    assert.ok(key);
    keys.push(key);
    saveChatSessionScrollMemoryState(key, state(i, { anchorRowId: i }));
  }
  assert.equal(readChatSessionScrollMemoryState(keys[0]!), null);
  const last = readChatSessionScrollMemoryState(keys[keys.length - 1]!);
  assert.equal(last?.anchorRowId, 204);
});
