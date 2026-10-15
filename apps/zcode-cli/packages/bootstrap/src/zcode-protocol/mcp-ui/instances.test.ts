// MCP App 实例凭据（移植自官方 v3.15.1，vitest → node:test）。
// 可独立运行：
//   npx tsx --test apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/instances.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { McpUiInstances, mcpUiInstances } from "./instances.js";
import { createMcpUiSessionAccess } from "./sessionAccess.js";
const binding = {
  workspace: "w",
  sessionId: "s",
  pluginId: "p",
  serverName: "m",
  scopeId: "v",
  resourceUri: "ui://app",
  ownerWebContentsId: 1,
};

test("rejects a resource read completing after its connection was replaced", async () => {
  let source = { identity: "source", generation: 1 };
  const lease = mcpUiInstances.open(binding, source);
  const result = Promise.withResolvers<{ contents: [] }>();
  const record = {
    app: { getMcpAppConnectionSnapshot: () => source, readMcpResource: () => result.promise },
  } as unknown as Parameters<typeof createMcpUiSessionAccess>[0];
  const scope = { ...binding, workspace: { workspacePath: binding.workspace }, instance: lease };
  const access = createMcpUiSessionAccess(record, scope);
  const reading = access.readResource(binding.serverName, binding.resourceUri);
  const rejected = assert.rejects(reading, /no longer authorized/);
  source = { ...source, generation: 2 };
  const replacement = mcpUiInstances.open(binding, source);
  result.resolve({ contents: [] });
  await rejected;
  assert.deepStrictEqual(mcpUiInstances.validate(replacement, scope, source).lease, replacement);
  mcpUiInstances.close(replacement);
});

test("rejects old completion and late disposal without touching the replacement", () => {
  const owner = new McpUiInstances();
  const source = { identity: "source", generation: 1 };
  const a = owner.open(binding, source);
  owner.close(a);
  const b = owner.open(binding, source);
  assert.throws(() =>
    owner.validate(a, { ...binding, workspace: { workspacePath: binding.workspace } }, source),
  );
  assert.equal(owner.close(a), false);
  assert.deepStrictEqual(
    owner.validate(b, { ...binding, workspace: { workspacePath: binding.workspace } }, source)
      .lease,
    b,
  );
});

test("isolates workspace, server, owner and connection generation", () => {
  const owner = new McpUiInstances();
  const source = { identity: "source", generation: 1 };
  const a = owner.open(binding, source);
  const b = owner.open({ ...binding, workspace: "other" }, source);
  assert.notEqual(a.appIdentity, b.appIdentity);
  assert.throws(() =>
    owner.validate(
      a,
      { ...binding, workspace: { workspacePath: binding.workspace }, serverName: "other" },
      source,
    ),
  );
  assert.throws(() =>
    owner.validate(
      a,
      { ...binding, workspace: { workspacePath: binding.workspace } },
      { ...source, generation: 2 },
    ),
  );
});

test("invalidates before abort listeners and disposes only once", () => {
  const owner = new McpUiInstances();
  const source = { identity: "source", generation: 1 };
  const a = owner.open(binding, source);
  const record = owner.validate(
    a,
    { ...binding, workspace: { workspacePath: binding.workspace } },
    source,
  );
  record.cancel.signal.addEventListener("abort", () =>
    assert.throws(() =>
      owner.validate(a, { ...binding, workspace: { workspacePath: binding.workspace } }, source),
    ),
  );
  assert.equal(owner.close(a), true);
  assert.equal(owner.close(a), false);
  assert.equal(record.cancel.signal.aborted, true);
});

test("shares storage identity across owners but closing one cannot revoke the other", () => {
  const owner = new McpUiInstances();
  const source = { identity: "source", generation: 1 };
  const first = owner.open(binding, source);
  const second = owner.open({ ...binding, ownerWebContentsId: 2 }, source);
  assert.equal(first.appIdentity, second.appIdentity);
  assert.notEqual(first.token, second.token);
  assert.ok(second.generation > first.generation);
  owner.close(first);
  const scope = {
    ...binding,
    workspace: { workspacePath: "unused", workspaceIdentity: " w " },
  };
  assert.deepStrictEqual(owner.validate(second, scope, source).lease, second);
  assert.throws(() =>
    owner.validate(
      second,
      { ...scope, workspace: { workspacePath: "w", workspaceIdentity: "different" } },
      source,
    ),
  );
});

test("account change revokes old credentials and keeps new storage identity isolated", () => {
  const owner = new McpUiInstances();
  const source = { identity: "source", generation: 1 };
  const first = owner.open({ ...binding, accountContext: "account-a" }, source);
  const scope = { ...binding, workspace: { workspacePath: "w" } };
  const signal = owner.validate(first, scope, source).cancel.signal;
  const second = owner.open({ ...binding, accountContext: "account-b" }, source);
  assert.equal(signal.aborted, true);
  assert.notEqual(first.appIdentity, second.appIdentity);
  assert.equal(owner.close(first), false);
  assert.deepStrictEqual(owner.validate(second, scope, source).lease, second);
});

test("a forged scope or stale generation cannot revoke a valid instance", () => {
  const owner = new McpUiInstances();
  const source = { identity: "source", generation: 1 };
  const lease = owner.open(binding, source);
  const scope = { ...binding, workspace: { workspacePath: "w" } };
  const signal = owner.validate(lease, scope, source).cancel.signal;
  assert.throws(() => owner.validate(lease, { ...scope, serverName: "forged" }, null));
  assert.throws(() => owner.validate({ ...lease, generation: 0 }, scope, null));
  assert.equal(signal.aborted, false);
  assert.deepStrictEqual(owner.validate(lease, scope, source).lease, lease);
  assert.throws(() => owner.validate(lease, scope, null));
  assert.equal(signal.aborted, true);
});
