import type { ScreenCaptureSelectionRegion } from "@zcode/shared";

/**
 * 选区截图的纯函数层：选区校验、DIP→物理像素换算、文件名。
 *
 * 独立成文件是因为 coordinator 依赖 Electron 运行时，而这些函数要在 plain node
 * （tsx --test）下单测；协议细节见 specs/composer-screen-capture.md。
 */

const MIN_SELECTION_EDGE_DIP = 1;

/**
 * 校验并归一化 overlay 上报的选区：四个字段必须是有限数字，尺寸至少 1 DIP，
 * 并 clamp 到遮罩窗口（目标显示器）范围内。返回 null 表示 payload 不可信。
 */
export function sanitizeSelectionRegion(
  payload: unknown,
  maxWidthDip: number,
  maxHeightDip: number,
): ScreenCaptureSelectionRegion | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  const x = candidate["x"];
  const y = candidate["y"];
  const width = candidate["width"];
  const height = candidate["height"];
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  if (typeof width !== "number" || !Number.isFinite(width)) return null;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  if (width < MIN_SELECTION_EDGE_DIP || height < MIN_SELECTION_EDGE_DIP) return null;
  if (maxWidthDip <= 0 || maxHeightDip <= 0) return null;
  const left = Math.min(Math.max(x, 0), maxWidthDip - MIN_SELECTION_EDGE_DIP);
  const top = Math.min(Math.max(y, 0), maxHeightDip - MIN_SELECTION_EDGE_DIP);
  const right = Math.min(Math.max(x + width, left + MIN_SELECTION_EDGE_DIP), maxWidthDip);
  const bottom = Math.min(Math.max(y + height, top + MIN_SELECTION_EDGE_DIP), maxHeightDip);
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * DIP 选区 → 物理像素裁剪矩形。先做 DIP clamp，再乘 scaleFactor 并四舍五入，
 * 最后 clamp 到位图边界；空矩形返回 null（nativeImage.crop 拒绝零尺寸）。
 */
export function computePhysicalCropRect(
  region: ScreenCaptureSelectionRegion,
  scaleFactor: number,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; width: number; height: number } | null {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return null;
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight)) return null;
  if (imageWidth <= 0 || imageHeight <= 0) return null;

  const clampedDip = sanitizeSelectionRegion(
    region,
    imageWidth / scaleFactor,
    imageHeight / scaleFactor,
  );
  if (!clampedDip) return null;

  const left = clampInt(Math.round(clampedDip.x * scaleFactor), 0, imageWidth);
  const top = clampInt(Math.round(clampedDip.y * scaleFactor), 0, imageHeight);
  const right = clampInt(
    Math.round((clampedDip.x + clampedDip.width) * scaleFactor),
    left,
    imageWidth,
  );
  const bottom = clampInt(
    Math.round((clampedDip.y + clampedDip.height) * scaleFactor),
    top,
    imageHeight,
  );
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { x: left, y: top, width, height };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * 校验 overlay 上报的标注合成图尺寸：与按选区算出的裁剪矩形偏差 ≤tolerance 才采用，
 * 防止伪造/错位的合成图顶替真实截图。不匹配时 main 回退无标注裁剪。
 */
export function isComposedImageSizeAcceptable(
  width: number,
  height: number,
  cropRect: { width: number; height: number },
  tolerance = 2,
): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  if (width <= 0 || height <= 0) return false;
  return (
    Math.abs(width - cropRect.width) <= tolerance && Math.abs(height - cropRect.height) <= tolerance
  );
}

/** 截图附件文件名：与 captureWindowScreenshot 的 `zcode-error-<ISO>.png` 同构。 */
export function buildScreenCaptureFilename(now: Date = new Date()): string {
  return `zcode-screenshot-${now.toISOString().replace(/[:.]/g, "-")}.png`;
}

/** 标注合成图 base64 的防御上限（约 36MB PNG），超限视为不可信直接回退裁剪。 */
export const MAX_COMPOSED_BASE64_CHARS = 48 * 1024 * 1024;

/**
 * 解析 overlay 确认请求里的标注合成图字段；`imageDataBase64` 缺省表示无标注（返回 null），
 * 字段存在但类型/长度不合法同样返回 null（main 回退无标注裁剪）。
 */
export function parseComposedImage(
  payload: Record<string, unknown>,
): { base64: string; width: number; height: number } | null {
  const base64 = payload["imageDataBase64"];
  const width = payload["imageWidth"];
  const height = payload["imageHeight"];
  if (base64 === undefined) return null;
  if (
    typeof base64 !== "string" ||
    base64.length === 0 ||
    base64.length > MAX_COMPOSED_BASE64_CHARS
  ) {
    return null;
  }
  if (typeof width !== "number" || !Number.isFinite(width)) return null;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  return { base64, width, height };
}
