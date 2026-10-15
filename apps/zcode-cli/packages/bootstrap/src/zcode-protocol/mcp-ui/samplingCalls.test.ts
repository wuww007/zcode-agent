// MCP App sampling 准入与终态所有权（移植自官方 v3.15.1，vitest → node:test）。
// 可独立运行：
//   npx tsx --test apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/samplingCalls.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { McpUiSamplingCalls } from "./samplingCalls.js";
const scope = (token: string, sessionId = "session") => ({
  token,
  sessionId,
  signal: new AbortController().signal,
});
/**
 * 手写计时器桩：node:test 的 mock timers 不提供 pending 计数与异步推进，
 * 这两个断言（取消后不留 60s 超时、绝对截止时间生效）只能自行替换 setTimeout。
 */
function installFakeTimers() {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let nextId = 1;
  const timers = new Map<number, { due: number; run: () => void }>();
  let now = 0;
  globalThis.setTimeout = ((run: () => void, ms?: number) => {
    const id = nextId++;
    timers.set(id, { due: now + (ms ?? 0), run });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id);
  }) as typeof globalThis.clearTimeout;
  return {
    get pending() {
      return timers.size;
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        // 每轮只触发到 target 为止的最近一个计时器；回调里可能再排新计时器。
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.due <= target)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].due);
        due[1].run();
        // 让回调排出的 Promise 链跑到下一个微任务检查点。
        await new Promise<void>((resolve) => real.setTimeout(resolve, 0));
      }
      now = target;
    },
    restore() {
      globalThis.setTimeout = real.setTimeout;
      globalThis.clearTimeout = real.clearTimeout;
    },
  };
}

test("cancels before admission and rejects all duplicate completions", async () => {
  const calls = new McpUiSamplingCalls(),
    s = scope("one");
  let runs = 0;
  const run = async () => {
    runs += 1;
    return 1;
  };
  assert.equal(calls.cancel(s, "early").cancelled, false);
  await assert.rejects(calls.execute(s, "early", run), /Duplicate/);
  assert.equal(runs, 0);
  assert.equal(await calls.execute(s, "ok", run), 1);
  await assert.rejects(calls.execute(s, "ok", run), /Duplicate/);
  assert.equal(calls.cancel(s, "ok").cancelled, false);
});

test("aborts execution immediately, drops late success and frees capacity", async () => {
  const calls = new McpUiSamplingCalls(),
    s = scope("one"),
    gate = Promise.withResolvers<number>();
  let signal!: AbortSignal;
  const first = calls.execute(s, "a", async (value) => {
    signal = value;
    return gate.promise;
  });
  const rejected = assert.rejects(first, /cancelled/);
  calls.cancel(s, "a");
  gate.resolve(5);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(
    await calls.execute(s, "b", async () => 2),
    2,
  );
});

test("closes the original instance without touching its replacement", async () => {
  const calls = new McpUiSamplingCalls(),
    close = new AbortController();
  const old = { ...scope("old"), signal: close.signal };
  const first = calls.execute(old, "same", () => new Promise(() => {}));
  const rejected = assert.rejects(first, /cancelled/);
  close.abort();
  assert.equal(
    await calls.execute(scope("new"), "same", async () => 7),
    7,
  );
  await rejected;
  await assert.rejects(calls.execute(old, "later", async () => 8));
});

test("enforces instance/session/global caps and releases all timers on cancellation", async (t) => {
  const timers = installFakeTimers();
  t.after(() => timers.restore());
  const calls = new McpUiSamplingCalls();
  const scopes = Array.from({ length: 8 }, (_, i) => scope(String(i), i < 4 ? "a" : "b"));
  const waiting = scopes.map((s) =>
    calls
      .execute(s, "x", () => new Promise(() => {}))
      .catch(() => {}),
  );
  await assert.rejects(calls.execute(scopes[0]!, "y", async () => 0), /busy/);
  await assert.rejects(calls.execute(scope("session-full", "a"), "y", async () => 0), /busy/);
  await assert.rejects(calls.execute(scope("agent-full", "c"), "y", async () => 0), /busy/);
  scopes.forEach((s) => calls.cancel(s, "x"));
  await Promise.all(waiting);
  // pending 为 0 才说明取消路径没有泄漏 60s 超时。
  assert.equal(timers.pending, 0);
  assert.equal(
    await calls.execute(scope("next"), "y", async () => 4),
    4,
  );
});

test("has an absolute deadline even if the model never settles", async (t) => {
  const timers = installFakeTimers();
  t.after(() => timers.restore());
  const calls = new McpUiSamplingCalls();
  let signal!: AbortSignal;
  const promise = calls.execute(scope("one"), "timeout", (s) => {
    signal = s;
    return new Promise(() => {});
  });
  const rejected = assert.rejects(promise, /timed out/);
  await timers.advance(60_000);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(timers.pending, 0);
});

test("bounds terminal history without forgetting cancelled IDs", async () => {
  const calls = new McpUiSamplingCalls(),
    s = scope("bounded");
  for (let i = 0; i < 4096; i++) calls.cancel(s, `op-${i}`);
  assert.throws(() => calls.cancel(s, "overflow"), /limit/);
  await assert.rejects(calls.execute(s, "op-0", async () => 1), /Duplicate/);
  await assert.rejects(calls.execute(s, "overflow", async () => 1), /limit/);
  assert.equal(
    await calls.execute(scope("replacement"), "op-0", async () => 2),
    2,
  );
});
