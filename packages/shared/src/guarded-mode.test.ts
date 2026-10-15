// Guarded 的 wire 枚举与模式目录 round-trip（移植自官方 v3.15.1
// packages/shared/test/guardedMode.test.ts，vitest → node:test）。可独立运行：
//   npx tsx --test packages/shared/src/guarded-mode.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getZCodeAgentAvailableModes,
  getZCodeAgentModeSelectOptions,
  normalizeAvailableZCodeMode,
} from "./zcode-agent-model-state.js";
import { submissionModeSchema } from "./zcode-protocol-v4/submission.js";
import { zcodeSessionModeSchema } from "./zcode-protocol-legacy-types.js";
import { executionStateSchema, resolveExecutionState } from "./execution-state.js";

describe("guarded wire and mode catalog", () => {
  it("uses autonomous display copy without renaming the guarded value", () => {
    const copy = {
      name: "Autonomous mode",
      description: "Ask when there’s risk",
    };
    assert.deepStrictEqual(
      getZCodeAgentAvailableModes().find((mode) => mode.id === "guarded"),
      {
        id: "guarded",
        ...copy,
      },
    );
    assert.deepStrictEqual(
      getZCodeAgentModeSelectOptions().find((option) => option.value === "guarded"),
      { value: "guarded", ...copy },
    );
  });

  it("preserves guarded across independent Plan transitions and serialization", () => {
    const current = resolveExecutionState({
      mode: "guarded",
      planEnabled: true,
    });
    assert.deepStrictEqual(executionStateSchema.parse(current), {
      mode: "guarded",
      planEnabled: true,
    });
    assert.deepStrictEqual(resolveExecutionState({ planEnabled: false }, current), {
      mode: "guarded",
      planEnabled: false,
    });
  });

  it("round trips the opt-in value without changing the default", () => {
    assert.equal(submissionModeSchema.parse("guarded"), "guarded");
    assert.equal(zcodeSessionModeSchema.parse("guarded"), "guarded");
    assert.equal(normalizeAvailableZCodeMode("guarded"), "guarded");
    const ids = getZCodeAgentAvailableModes().map((mode) => mode.id);
    assert.equal(ids[0], "build", "default candidate stays first");
    assert.ok(ids.includes("guarded"));
    assert.deepStrictEqual(ids, ["build", "guarded", "plan", "yolo"]);
    assert.deepStrictEqual(
      getZCodeAgentModeSelectOptions().map((option) => option.value),
      ids,
    );
    assert.equal(submissionModeSchema.safeParse("unknown").success, false);
  });

  it("keeps historical edit valid without advertising it as a new choice", () => {
    assert.equal(submissionModeSchema.parse("edit"), "edit");
    assert.equal(zcodeSessionModeSchema.parse("edit"), "edit");
    assert.equal(normalizeAvailableZCodeMode("edit"), "edit");
    assert.equal(
      getZCodeAgentAvailableModes().some((mode) => mode.id === "edit"),
      false,
    );
  });
});
