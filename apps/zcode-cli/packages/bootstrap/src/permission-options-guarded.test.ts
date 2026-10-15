// Guarded 单次确认的协议选项投影（移植自官方 v3.15.1
// bootstrap/tests/guarded-permission-options.test.ts，vitest → node:test）。可独立运行：
//   npx tsx --test apps/zcode-cli/packages/bootstrap/src/permission-options-guarded.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildProtocolPermissionOptions } from "./permission-options.js";

describe("Guarded single-use protocol options", () => {
  it("single-use excludes both project and session grants", () => {
    for (const optionsPolicy of [undefined, "session-always-allow", "no-always-allow"] as const) {
      assert.deepStrictEqual(
        buildProtocolPermissionOptions({
          toolName: "Bash",
          approvalMode: "user-once",
          optionsPolicy,
        }).map((option) => option.kind),
        ["allow_once", "deny"],
      );
    }
  });
  it("explicit constraint removes persistence; absent constraint preserves old options", () => {
    assert.deepStrictEqual(
      buildProtocolPermissionOptions({
        toolName: "Bash",
        approvalMode: "user-once",
        input: { command: "rm -rf build" },
      }).map((option) => option.kind),
      ["allow_once", "deny"],
    );
    // 未声明 user-once 时保持旧选项面：allow_once / allow_always / deny（空更新列表即默认推导）。
    assert.deepStrictEqual(
      buildProtocolPermissionOptions({ toolName: "Bash", suggestedPermissionUpdates: [] }).map(
        (option) => option.kind,
      ),
      ["allow_once", "allow_always", "deny"],
    );
  });
});
