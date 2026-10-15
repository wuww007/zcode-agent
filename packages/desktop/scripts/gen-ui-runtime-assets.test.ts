// Gen UI 运行时资产打包一致性（移植自官方 v3.15.1，vitest → node:test）。
// 可独立运行：
//   npx tsx --test packages/desktop/scripts/gen-ui-runtime-assets.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyGenUiRuntimeAssets } from "./gen-ui-runtime-assets.mjs";

test("packages the same pinned runtime assets used by standalone export", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gen-ui-assets-"));
  const source = new URL(
    "../../../apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/",
    import.meta.url,
  );
  const manifest = JSON.parse(await readFile(new URL("runtime-manifest.json", source), "utf8"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  try {
    // 清单只承载当前资源的完整性数据，避免把无关的构建元数据带入分发包。
    assert.deepStrictEqual(Object.keys(manifest), ["files"]);
    assert.deepStrictEqual(Object.keys(manifest.files).sort(), [
      "calendar.js",
      "tweak.js",
      "visualize.css",
      "visualize.html",
    ]);
    for (const entry of Object.values(manifest.files)) {
      assert.deepStrictEqual(Object.keys(entry as object), ["sha256"]);
    }
    await copyGenUiRuntimeAssets(directory);
    const vendors = JSON.parse(await readFile(join(directory, "vendor/manifest.json"), "utf8"));
    for (const resource of vendors.resources) {
      for (const [file, hash] of [
        [resource.file, resource.sha256],
        [resource.licenseFile, resource.licenseSha256],
      ]) {
        const bytes = await readFile(join(directory, "vendor", file));
        assert.deepStrictEqual(bytes, await readFile(new URL(`vendor/${file}`, source)));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
      }
    }
    for (const file of ["visualize.css", "visualize.html", "calendar.js"]) {
      const bytes = await readFile(join(directory, file));
      assert.deepStrictEqual(bytes, await readFile(new URL(file, source)));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.files[file].sha256);
    }
    const tweak = await readFile(
      new URL("../src/renderer/src/plugin-sandbox/genUiTweakRuntime.js", import.meta.url),
    );
    assert.equal(
      createHash("sha256").update(tweak).digest("hex"),
      manifest.files["tweak.js"].sha256,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
