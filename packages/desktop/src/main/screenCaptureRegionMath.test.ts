// 选区截图纯函数回归：DIP→物理像素换算必须 clamp 到位图边界，零尺寸裁剪返回 null。
// 纯数据模块，可用 tsx --test 独立运行（见 specs/composer-screen-capture.md）。
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScreenCaptureFilename,
  computePhysicalCropRect,
  isComposedImageSizeAcceptable,
  sanitizeSelectionRegion,
} from "./screenCaptureRegionMath.js";

test("sanitizeSelectionRegion 放行合法选区并四舍五入为有效矩形", () => {
  const region = sanitizeSelectionRegion({ x: 10.4, y: 8.6, width: 100, height: 50 }, 500, 400);
  assert.deepEqual(region, { x: 10.4, y: 8.6, width: 100, height: 50 });
});

test("sanitizeSelectionRegion 拒绝非数字与零尺寸", () => {
  assert.equal(sanitizeSelectionRegion(null, 500, 400), null);
  assert.equal(sanitizeSelectionRegion("rect", 500, 400), null);
  assert.equal(
    sanitizeSelectionRegion({ x: 0, y: 0, width: Number.NaN, height: 10 }, 500, 400),
    null,
  );
  assert.equal(sanitizeSelectionRegion({ x: 0, y: 0, width: "100", height: 10 }, 500, 400), null);
  assert.equal(sanitizeSelectionRegion({ x: 0, y: 0, width: 0, height: 10 }, 500, 400), null);
  assert.equal(sanitizeSelectionRegion({ x: 0, y: 0, width: 10, height: -5 }, 500, 400), null);
});

test("sanitizeSelectionRegion 把越界选区 clamp 回遮罩窗口范围", () => {
  const region = sanitizeSelectionRegion({ x: -10, y: -10, width: 520, height: 440 }, 500, 400);
  assert.ok(region);
  assert.equal(region.x, 0);
  assert.equal(region.y, 0);
  assert.equal(region.width, 500);
  assert.equal(region.height, 400);
});

test("computePhysicalCropRect 按 scaleFactor 换算物理像素", () => {
  const rect = computePhysicalCropRect({ x: 10.5, y: 20, width: 100, height: 50 }, 2, 400, 300);
  assert.deepEqual(rect, { x: 21, y: 40, width: 200, height: 100 });
});

test("computePhysicalCropRect 在非整数缩放下 clamp 到位图边界", () => {
  // DIP 100x100 @1.5 → 物理 150；选区拖到 DIP 边界外不能超出 150px 位图。
  const rect = computePhysicalCropRect({ x: 50, y: 50, width: 100, height: 100 }, 1.5, 150, 150);
  assert.deepEqual(rect, { x: 75, y: 75, width: 75, height: 75 });
});

test("computePhysicalCropRect 拒绝非法缩放、空位图与空选区", () => {
  const region = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(computePhysicalCropRect(region, 0, 400, 300), null);
  assert.equal(computePhysicalCropRect(region, Number.NaN, 400, 300), null);
  assert.equal(computePhysicalCropRect(region, 2, 0, 300), null);
  assert.equal(computePhysicalCropRect(region, 2, 400.5, 300), null);
});

test("buildScreenCaptureFilename 与窗口截图命名同构", () => {
  const name = buildScreenCaptureFilename(new Date("2026-09-28T08:09:10.112Z"));
  assert.equal(name, "zcode-screenshot-2026-09-28T08-09-10-112Z.png");
});

test("isComposedImageSizeAcceptable 容差内采用、偏差大或非法尺寸拒绝", () => {
  const crop = { width: 600, height: 400 };
  assert.equal(isComposedImageSizeAcceptable(600, 400, crop), true);
  // 四舍五入的 ±2px 容差内采用。
  assert.equal(isComposedImageSizeAcceptable(602, 398, crop), true);
  assert.equal(isComposedImageSizeAcceptable(603, 400, crop), false);
  assert.equal(isComposedImageSizeAcceptable(300, 200, crop), false);
  assert.equal(isComposedImageSizeAcceptable(600, 0, crop), false);
  assert.equal(isComposedImageSizeAcceptable(600.5, 400, crop), false);
  assert.equal(isComposedImageSizeAcceptable(Number.NaN, 400, crop), false);
});
