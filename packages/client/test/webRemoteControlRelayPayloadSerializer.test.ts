// Web 远控 relay payload 序列化器（移植自官方 v3.15.1
// packages/client/test/webRemoteControlRelayPayloadSerializer.test.ts，vitest → node:test）。
// 可独立运行：
//   npx tsx --test packages/client/test/webRemoteControlRelayPayloadSerializer.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  encodeWebRemoteControlRpcTransportMessage,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import { WebRemoteControlRelayPayloadSerializer } from "../src/webRemoteControlRelayPayloadSerializer.js";

describe("WebRemoteControlRelayPayloadSerializer", () => {
  it("reuses the identical final JSON and byte count for one immutable raw payload", () => {
    const serializer = new WebRemoteControlRelayPayloadSerializer();
    const [payload] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
      bridgeSessionId: "bridge-1",
      firstPhysicalSeq: 1,
      messageSeq: 1,
    });

    const first = serializer.prepare(payload, 100);
    const replay = serializer.prepare(payload, 200);

    assert.equal(replay, first);
    assert.equal(replay.json, first.json);
    assert.equal(replay.message.client_ts, 100);
    assert.equal(replay.bytes, new TextEncoder().encode(replay.json).byteLength);
  });

  it("distinguishes a permanent oversize envelope from a bounded payload", () => {
    const serializer = new WebRemoteControlRelayPayloadSerializer();
    const bounded: WebRemoteControlAppPayload = {
      zcode_type: "app-error",
      reason: "unexpected-error",
      error: "中文🙂bounded",
    };
    const oversize: WebRemoteControlAppPayload = {
      zcode_type: "app-error",
      reason: "unexpected-error",
      error: "x".repeat(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes),
    };

    const preparedBounded = serializer.prepare(bounded, 1);
    assert.equal(serializer.isOversize(preparedBounded), false);
    assert.equal(preparedBounded.bytes, new TextEncoder().encode(preparedBounded.json).byteLength);
    const preparedOversize = serializer.prepare(oversize, 1);
    assert.equal(serializer.isOversize(preparedOversize), true);
    assert.ok(
      preparedOversize.bytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
    );
  });
});
