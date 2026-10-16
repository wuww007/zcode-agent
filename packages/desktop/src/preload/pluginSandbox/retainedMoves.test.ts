// 沙箱 retained move（移植自官方 v3.15.1，vitest → node:test）。
// 可独立运行：
//   npx tsx --test packages/desktop/src/preload/pluginSandbox/retainedMoves.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { enableSandboxRetainedMoves } from "./retainedMoves.js";

test("preserves only opted-in webviews and restores customElements.define", () => {
  const connectedCalls: unknown[] = [];
  const disconnectedCalls: unknown[] = [];
  const connected = (...args: unknown[]) => {
    connectedCalls.push(args);
  };
  const disconnected = (...args: unknown[]) => {
    disconnectedCalls.push(args);
  };
  class ElementStub {
    moveBefore() {}
  }
  class Webview extends ElementStub {
    retained = true;
    hasAttribute() {
      return this.retained;
    }
    connectedCallback = connected;
    disconnectedCallback = disconnected;
  }
  Object.assign(Webview.prototype, {
    connectedCallback: connected,
    disconnectedCallback: disconnected,
  });
  const defineCalls: unknown[] = [];
  const define = (...args: unknown[]) => {
    defineCalls.push(args);
  };
  const originals = {
    Element: globalThis.Element,
    customElements: globalThis.customElements,
  };
  // vi.stubGlobal 的等价物：临时替换并保证还原。
  (globalThis as unknown as { Element: unknown }).Element = ElementStub;
  (globalThis as unknown as { customElements: unknown }).customElements = { define };
  try {
    assert.equal(enableSandboxRetainedMoves(), true);
    customElements.define("webview", Webview as unknown as CustomElementConstructor);
    assert.equal(customElements.define, define);
    const page = new Webview();
    const move = (Webview.prototype as unknown as { connectedMoveCallback(): void })
      .connectedMoveCallback;
    move.call(page);
    assert.equal(disconnectedCalls.length, 0);
    page.retained = false;
    move.call(page);
    assert.equal(disconnectedCalls.length, 1);
    assert.equal(connectedCalls.length, 1);
    page.disconnectedCallback();
    assert.equal(disconnectedCalls.length, 2);
  } finally {
    (globalThis as unknown as { Element: unknown }).Element = originals.Element;
    (globalThis as unknown as { customElements: unknown }).customElements =
      originals.customElements;
    void defineCalls;
  }
});
