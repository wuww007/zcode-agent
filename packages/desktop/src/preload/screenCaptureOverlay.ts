/**
 * 选区截图遮罩窗口的 preload。
 *
 * 不复用主窗口那个庞大的 preload：遮罩窗口是全屏置顶窗口，攻击面越小越好
 * （对齐 cuaPermissionPanel 的做法）。只暴露四个成员——接收冻结画面、报告就绪、
 * 确认选区、取消截图。
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  InternalChannels,
  PlatformChannels,
  type ScreenCaptureOverlayFinishRequest,
} from "@zcode/shared";

export interface ScreenCaptureOverlayImageData {
  dataBase64: string;
  /** 目标显示器的 devicePixelRatio；标注 canvas 按它放大 backing store。 */
  scaleFactor: number;
}

contextBridge.exposeInMainWorld("zcodeScreenCaptureOverlay", {
  /** 订阅 main 推送的整屏冻结画面（PNG base64 + scaleFactor），返回 disposer。 */
  onImageData: (callback: (payload: ScreenCaptureOverlayImageData) => void) => {
    const listener = (_event: unknown, payload: ScreenCaptureOverlayImageData) => callback(payload);
    ipcRenderer.on(InternalChannels.ScreenCaptureOverlayImageData, listener);
    return () =>
      ipcRenderer.removeListener(InternalChannels.ScreenCaptureOverlayImageData, listener);
  },
  /** 冻结画面绘制完成，main 可以显示遮罩窗口。 */
  ready: () => ipcRenderer.send(PlatformChannels.ScreenCaptureOverlayReady),
  /** 用户确认选区；有标注时附带 overlay 本地合成的最终 PNG。 */
  finish: (payload: ScreenCaptureOverlayFinishRequest) =>
    ipcRenderer.invoke(PlatformChannels.ScreenCaptureOverlayFinish, payload),
  /** 用户取消截图（Esc / ✕ / 右键）。 */
  cancel: () => ipcRenderer.invoke(PlatformChannels.ScreenCaptureOverlayCancel),
  /**
   * 鼠标已进入本遮罩但窗口无焦点。macOS 只为 key window 应用 CSS 光标，
   * 非焦点遮罩显示默认箭头；main 收到后为本窗口抢焦点，十字光标才能生效。
   */
  notifyHover: () => ipcRenderer.send(PlatformChannels.ScreenCaptureOverlayHover),
});
