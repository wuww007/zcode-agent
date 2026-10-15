// Guarded 模式语义（模式/规则/继承，非全局门禁）（移植自官方 v3.15.1 tests/guarded-mode.test.ts，
// vitest → node:test）。纯断言，可独立运行：
//   npx tsx --test apps/zcode-cli/packages/core/src/permission/guarded-mode.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CronAutomationSchema,
  inheritPermissionMode,
  type CollaborationMode,
} from "@zcode/contracts";
import { PermissionService } from "./service.js";
import { bashToolEntry } from "../tool/handlers/bash.js";

describe("Guarded is an opt-in mode, not a global gate", () => {
  it("independent Plan keeps its restriction over guarded dangerous commands", () => {
    const service = new PermissionService();
    const context = {
      toolName: "Bash",
      input: { command: "rm -rf build" },
      mode: "guarded" as const,
      riskLevel: "high" as const,
    };
    const capability = {
      ...bashToolEntry.metadata,
      userApprovalRule: "safety.bash.remove-critical-path",
    };
    assert.partialDeepStrictEqual(service.checkPermission({ ...context, planEnabled: true }, capability), {
      decision: "deny",
      ruleId: "mode.plan.nonReadOnly",
    });
    assert.partialDeepStrictEqual(
      service.checkPermission({ ...context, planEnabled: false }, capability),
      { decision: "ask", approvalMode: "user-once" },
    );
  });

  it("guarded retains workflow alwaysAsk and ordinary session grants", () => {
    const service = new PermissionService();
    const context = {
      toolName: "CreateWorkflow",
      input: {},
      mode: "guarded" as const,
      riskLevel: "high" as const,
    };
    const capability = { alwaysAsk: true };
    assert.equal(service.checkPermission(context, capability).decision, "ask");
    service.grantSessionPermission([
      { type: "addRules", behavior: "allow", rules: [{ toolName: "CreateWorkflow" }] },
    ]);
    assert.equal(service.checkPermission(context, capability).decision, "allow");
  });

  it("automation records preserve explicit guarded/yolo and do not migrate absence", () => {
    const record = {
      automationId: "guarded-fixture",
      title: "fixture",
      cronExpr: "0 * * * *",
      prompt: "fixture",
      enabled: true,
      lifecycleStatus: "active",
      runCount: 0,
      recurring: true,
    };
    for (const mode of ["guarded", "yolo", undefined]) {
      const parsed = CronAutomationSchema.parse({ ...record, ...(mode ? { mode } : {}) });
      assert.equal(parsed.mode, mode);
    }
  });

  for (const parent of ["guarded", "yolo", "build", "edit", "plan", "auto"] as CollaborationMode[]) {
    it(`inheritance from ${parent} only transforms YOLO children`, () => {
      for (const child of [
        "yolo",
        "build",
        "edit",
        "plan",
        "auto",
        "guarded",
      ] as CollaborationMode[]) {
        assert.equal(
          inheritPermissionMode(parent, child),
          parent === "guarded" && child === "yolo" ? "guarded" : child,
        );
      }
    });
  }

  it("requires once approval only in guarded and preserves YOLO baseline for nonmatches", () => {
    const service = new PermissionService();
    for (const mode of ["guarded", "yolo"] as const) {
      for (const command of ["rm -rf build", "echo hello", "bash -c 'rm -rf build'"]) {
        const input = { command };
        const capability = bashToolEntry.resolvePermissionCapability?.(input, {
          mode,
          bashShellSelection: {
            dialect: "posix",
            source: "auto-detected",
            display: { name: "bash" },
          },
        });
        const decision = service.checkPermission(
          { toolName: "Bash", input, mode, riskLevel: "high" },
          { ...bashToolEntry.metadata, ...capability },
        );
        assert.equal(
          decision.decision,
          mode === "guarded" && command === "rm -rf build" ? "ask" : "allow",
          `${mode}: ${command}`,
        );
        assert.equal(
          decision.approvalMode,
          mode === "guarded" && command === "rm -rf build" ? "user-once" : undefined,
          `${mode}: ${command}`,
        );
      }
    }
  });

  // 2026-09-17 review：selection 缺失是基础设施状态，不能让 guarded 静默退回 YOLO。
  it("matches with POSIX grammar when the session shell selection is not yet available", () => {
    const input = { command: "rm -rf build" };
    const capability = bashToolEntry.resolvePermissionCapability?.(input, {
      mode: "guarded",
    });
    assert.deepStrictEqual(capability, {
      userApprovalRule: "safety.bash.remove-critical-path",
    });
    const legacy = bashToolEntry.resolvePermissionCapability?.(input, {
      mode: "guarded",
      bashShellSelection: {
        dialect: "legacy-shell",
        source: "legacy-fallback",
        display: { name: "system shell" },
      },
    });
    assert.equal(legacy, undefined);
  });
});
