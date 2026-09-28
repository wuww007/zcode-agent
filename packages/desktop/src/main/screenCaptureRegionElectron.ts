import { desktopCapturer, nativeImage, systemPreferences } from "electron";
import type {
  ScreenCaptureDisplay,
  ScreenCaptureImage,
  ScreenRecordingAccess,
} from "./screenCaptureRegion.js";

/**
 * 选区截图的 Electron 默认实现：逐显示器捕获、macOS 屏幕录制权限、合成图解码。
 *
 * 独立成文件是为了让 `screenCaptureRegion.ts` 的协调器保持可注入与精简；
 * 这些默认实现不走 plain node 单测（依赖 Electron 运行时）。
 */

export async function captureDisplaysWithDesktopCapturer(
  displays: ScreenCaptureDisplay[],
): Promise<Map<string, ScreenCaptureImage>> {
  const images = new Map<string, ScreenCaptureImage>();
  // 逐显示器请求匹配的 thumbnailSize：getSources 的 thumbnail 会缩放到请求尺寸内，
  // 一次请求无法同时满足不同分辨率的显示器。
  for (const display of displays) {
    const physical = {
      width: Math.max(1, Math.ceil(display.size.width * display.scaleFactor)),
      height: Math.max(1, Math.ceil(display.size.height * display.scaleFactor)),
    };
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: physical,
    });
    const displayKey = String(display.id);
    // macOS 的 display_id 与 Display.id 稳定对应；缩略图尺寸兜底覆盖不报 display_id 的平台。
    const matched =
      sources.find((source) => source.display_id === displayKey) ??
      sources.find((source) => {
        const size = source.thumbnail?.getSize();
        return size?.width === physical.width && size?.height === physical.height;
      });
    const thumbnail = matched?.thumbnail;
    if (thumbnail && !thumbnail.isEmpty()) {
      images.set(displayKey, thumbnail as unknown as ScreenCaptureImage);
    }
  }
  return images;
}

export function readMacScreenRecordingAccess(): ScreenRecordingAccess {
  if (process.platform !== "darwin") return "granted";
  try {
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status === "granted") return "granted";
    if (status === "not-determined") return "undetermined";
    return "denied";
  } catch {
    // 状态读取失败时不拦截：让真实捕获结果说话（空图同样会落到引导授权分支）。
    return "granted";
  }
}

export function decodeImageWithNativeImage(
  buffer: Buffer,
): { width: number; height: number } | null {
  const decoded = nativeImage.createFromBuffer(buffer);
  if (decoded.isEmpty()) return null;
  return decoded.getSize();
}
