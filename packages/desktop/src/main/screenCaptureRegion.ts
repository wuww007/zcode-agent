/* eslint-disable max-lines -- 会话生命周期（互斥/看门狗/多遮罩销毁路径）必须在一个文件里原子收口，拆散会让销毁路径更难审计（同 desktopMainIpcPlatform）。 */
import { BrowserWindow, screen } from "electron";
import type { BrowserWindowConstructorOptions, Rectangle } from "electron";
import { InternalChannels, type Locale, type ScreenRegionCaptureOutcome } from "@zcode/shared";
import { screenCaptureOverlayDataUrl } from "./screenCaptureRegionContent.js";
import {
  buildScreenCaptureFilename,
  computePhysicalCropRect,
  isComposedImageSizeAcceptable,
  parseComposedImage,
  sanitizeSelectionRegion,
} from "./screenCaptureRegionMath.js";
import {
  captureDisplaysWithDesktopCapturer,
  decodeImageWithNativeImage,
  readMacScreenRecordingAccess,
} from "./screenCaptureRegionElectron.js";

/**
 * 微信式选区截图的 main 侧协调器（多屏）：
 * 捕获所有显示器 → 每屏一个遮罩窗口 → 任一遮罩上选区/标注 → 裁剪或采用合成图回传。
 *
 * 会话（N 个遮罩窗口生命周期 + pending invoke promise）的唯一所有者；任何销毁路径
 * （确认/取消/任一遮罩意外关闭/调用方窗口关闭/dispose）都收敛到 settleAndCleanup，
 * promise 恰好 settle 一次。spec：specs/composer-screen-capture.md。
 */

const OVERLAY_READY_WATCHDOG_MS = 5_000;

/** 目标显示器的窄化描述，便于测试注入。 */
export interface ScreenCaptureDisplay {
  id: number | string;
  scaleFactor: number;
  size: { width: number; height: number };
  bounds: Rectangle;
}

/** nativeImage 的窄化结构；真实 NativeImage 天然满足该结构。 */
export interface ScreenCaptureImage {
  getSize(): { width: number; height: number };
  isEmpty(): boolean;
  crop(rect: { x: number; y: number; width: number; height: number }): ScreenCaptureImage;
  toPNG(): Buffer;
}

export interface ScreenCaptureOverlayWindow {
  destroy(): void;
  focus(): void;
  isDestroyed(): boolean;
  isFocused(): boolean;
  loadURL(url: string): Promise<void>;
  moveTop(): void;
  on(event: "closed", listener: () => void): unknown;
  setAlwaysOnTop(flag: boolean, level?: Parameters<BrowserWindow["setAlwaysOnTop"]>[1]): void;
  setMenu(menu: null): void;
  show(): void;
  showInactive(): void;
  webContents: {
    // Electron 的 WebContents.id 是只读属性（Electron 41 无 getId() 方法）。
    id: number;
    send(channel: string, payload: unknown): void;
  };
}

/** 调用方窗口的窄化结构，用于「调用方已关闭 → 取消会话」联动。 */
export interface ScreenCaptureCallerWindow {
  isDestroyed(): boolean;
  once(event: "closed", listener: () => void): unknown;
}

export type ScreenRecordingAccess = "granted" | "undetermined" | "denied";

type ScreenCaptureFailureReason = Extract<ScreenRegionCaptureOutcome, { ok: false }>["reason"];

interface ScreenCaptureRegionCoordinatorOptions {
  logger: {
    info?: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
  getLocale: () => Locale;
  resolvePreloadPath: () => string;
  createWindow?: (options: Record<string, unknown>) => ScreenCaptureOverlayWindow;
  getCursorScreenPoint?: () => { x: number; y: number };
  getDisplayNearestPoint?: (point: { x: number; y: number }) => ScreenCaptureDisplay;
  getAllDisplays?: () => ScreenCaptureDisplay[];
  captureDisplays?: (displays: ScreenCaptureDisplay[]) => Promise<Map<string, ScreenCaptureImage>>;
  getScreenRecordingAccess?: () => ScreenRecordingAccess;
  decodeImage?: (buffer: Buffer) => { width: number; height: number } | null;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
  now?: () => Date;
}

interface OverlayEntry {
  display: ScreenCaptureDisplay;
  image: ScreenCaptureImage;
  overlay: ScreenCaptureOverlayWindow;
  webContentsId: number;
  shown: boolean;
}

interface ActiveCaptureSession {
  entries: OverlayEntry[];
  cursorDisplayKey: string;
  settle: (outcome: ScreenRegionCaptureOutcome | null) => void;
  watchdog: ReturnType<typeof setTimeout> | null;
  finished: boolean;
  readyCount: number;
}

export function createScreenCaptureRegionCoordinator(
  options: ScreenCaptureRegionCoordinatorOptions,
) {
  const createWindow =
    options.createWindow ??
    ((windowOptions: Record<string, unknown>) =>
      new BrowserWindow(
        windowOptions as unknown as BrowserWindowConstructorOptions,
      ) as unknown as ScreenCaptureOverlayWindow);
  const getCursorScreenPoint =
    options.getCursorScreenPoint ?? (() => screen.getCursorScreenPoint());
  const getDisplayNearestPoint =
    options.getDisplayNearestPoint ??
    ((point: { x: number; y: number }) =>
      screen.getDisplayNearestPoint(point) as ScreenCaptureDisplay);
  const getAllDisplays =
    options.getAllDisplays ?? (() => screen.getAllDisplays() as ScreenCaptureDisplay[]);
  const captureDisplays = options.captureDisplays ?? captureDisplaysWithDesktopCapturer;
  const getScreenRecordingAccess = options.getScreenRecordingAccess ?? readMacScreenRecordingAccess;
  const decodeImage = options.decodeImage ?? decodeImageWithNativeImage;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = options.cancelSchedule ?? ((timer) => clearTimeout(timer));
  const now = options.now ?? (() => new Date());

  let session: ActiveCaptureSession | null = null;
  let disposed = false;

  function settleAndCleanup(outcome: ScreenRegionCaptureOutcome | null): void {
    const current = session;
    if (!current || current.finished) return;
    current.finished = true;
    if (current.watchdog) {
      cancelSchedule(current.watchdog);
      current.watchdog = null;
    }
    session = null;
    for (const entry of current.entries) {
      try {
        if (!entry.overlay.isDestroyed()) entry.overlay.destroy();
      } catch (error) {
        options.logger.debug?.("[screen-capture] 销毁遮罩窗口失败", error);
      }
    }
    current.settle(outcome);
  }

  function cancelSession(): void {
    settleAndCleanup(null);
  }

  function failSession(reason: ScreenCaptureFailureReason): void {
    settleAndCleanup({ ok: false, reason });
  }

  function findEntry(webContentsId: number): OverlayEntry | null {
    if (!session || session.finished) return null;
    return session.entries.find((entry) => entry.webContentsId === webContentsId) ?? null;
  }

  /** sender 校验入口：只有本会话自己创建的遮罩 webContents 才被信任。 */
  function ownsOverlayWebContents(webContentsId: number): boolean {
    return findEntry(webContentsId) !== null;
  }

  function handleOverlayReady(webContentsId: number): void {
    const entry = findEntry(webContentsId);
    if (!entry || !session) return;
    if (!entry.shown) {
      entry.shown = true;
      const overlay = entry.overlay;
      if (!overlay.isDestroyed()) {
        // 光标所在屏获得焦点，其余屏只置顶显示；focus 抢焦点会把用户从当前输入流里拉走。
        if (String(entry.display.id) === session.cursorDisplayKey) {
          overlay.show();
          overlay.focus();
        } else {
          overlay.showInactive();
        }
        overlay.moveTop();
        // screen-saver 层级在 show 之后声明：部分平台会在 show 时重置 alwaysOnTop。
        overlay.setAlwaysOnTop(true, "screen-saver");
      }
    }
    session.readyCount += 1;
    if (session.readyCount >= session.entries.length && session.watchdog) {
      cancelSchedule(session.watchdog);
      session.watchdog = null;
    }
  }

  function handleOverlayFinish(webContentsId: number, payload: unknown): void {
    const entry = findEntry(webContentsId);
    if (!entry) return;
    if (typeof payload !== "object" || payload === null) {
      options.logger.warn("[screen-capture] 遮罩窗口上报了不可信的确认请求，按取消处理");
      cancelSession();
      return;
    }
    const request = payload as Record<string, unknown>;
    const { display, image } = entry;
    const region = sanitizeSelectionRegion(
      request["region"],
      display.size.width,
      display.size.height,
    );
    if (!region) {
      options.logger.warn("[screen-capture] 遮罩窗口上报了不可信的选区，按取消处理");
      cancelSession();
      return;
    }
    const size = image.getSize();
    const cropRect = computePhysicalCropRect(region, display.scaleFactor, size.width, size.height);
    if (!cropRect) {
      failSession("capture-failed");
      return;
    }

    // 有标注时 overlay 已在本地合成最终 PNG；尺寸与裁剪矩形对得上才采用，
    // 否则回退无标注裁剪（丢标注但不失败），避免伪造/错位图顶替真实截图。
    const composed = parseComposedImage(request);
    if (composed) {
      let decoded: { width: number; height: number } | null = null;
      try {
        decoded = decodeImage(Buffer.from(composed.base64, "base64"));
      } catch (error) {
        options.logger.warn("[screen-capture] 标注合成图解码失败，回退无标注裁剪", error);
      }
      if (decoded && isComposedImageSizeAcceptable(decoded.width, decoded.height, cropRect)) {
        settleAndCleanup({
          ok: true,
          dataBase64: composed.base64,
          filename: buildScreenCaptureFilename(now()),
          contentType: "image/png",
          size: Math.ceil((composed.base64.length * 3) / 4),
          width: decoded.width,
          height: decoded.height,
        });
        return;
      }
      options.logger.warn(
        `[screen-capture] 标注合成图尺寸不匹配 (${decoded?.width}x${decoded?.height} vs ${cropRect.width}x${cropRect.height})，回退无标注裁剪`,
      );
    }

    let png: Buffer;
    try {
      png = image.crop(cropRect).toPNG();
    } catch (error) {
      options.logger.warn("[screen-capture] 裁剪截图失败", error);
      failSession("capture-failed");
      return;
    }
    settleAndCleanup({
      ok: true,
      dataBase64: png.toString("base64"),
      filename: buildScreenCaptureFilename(now()),
      contentType: "image/png",
      size: png.byteLength,
      width: cropRect.width,
      height: cropRect.height,
    });
  }

  function handleOverlayCancel(webContentsId: number): void {
    if (!findEntry(webContentsId)) return;
    cancelSession();
  }

  /**
   * macOS 只为 key window 应用 CSS 光标：非焦点遮罩（外接屏 showInactive 弹出）
   * 会显示默认箭头而不是十字。overlay 在鼠标进入且自身无焦点时上报，这里为其
   * 抢焦点（focus 跟随鼠标）；只在 macOS 需要——Windows/Linux 的非焦点窗口
   * 光标本来就正常，抢焦点反而会打断用户当前输入。
   */
  function handleOverlayHover(webContentsId: number): void {
    if (process.platform !== "darwin") return;
    const entry = findEntry(webContentsId);
    if (!entry || !entry.shown) return;
    const overlay = entry.overlay;
    if (!overlay.isDestroyed() && !overlay.isFocused()) {
      overlay.focus();
    }
  }

  async function capture(
    callerWindow: ScreenCaptureCallerWindow | null,
  ): Promise<ScreenRegionCaptureOutcome | null> {
    if (disposed) {
      return { ok: false, reason: "capture-failed" };
    }
    if (session) {
      return { ok: false, reason: "busy" };
    }

    const access = getScreenRecordingAccess();
    if (access === "denied") {
      return { ok: false, reason: "screen-recording-permission" };
    }
    if (!callerWindow || callerWindow.isDestroyed()) {
      return { ok: false, reason: "capture-failed" };
    }

    const cursorDisplay = getDisplayNearestPoint(getCursorScreenPoint());
    const cursorDisplayKey = String(cursorDisplay.id);
    // 必须在遮罩窗口创建之前捕获：遮罩窗口自身不能出现在画面里。
    let images: Map<string, ScreenCaptureImage>;
    try {
      images = await captureDisplays(getAllDisplays());
    } catch (error) {
      options.logger.warn("[screen-capture] 捕获显示器画面失败", error);
      return { ok: false, reason: "capture-failed" };
    }
    if (!images.has(cursorDisplayKey)) {
      // macOS 首次授权（not-determined）期间 getSources 返回空图；这不是普通失败，
      // 走权限引导而不是泛化报错。
      if (access === "undetermined" && process.platform === "darwin") {
        return { ok: false, reason: "screen-recording-permission" };
      }
      return { ok: false, reason: "capture-failed" };
    }

    return await new Promise<ScreenRegionCaptureOutcome | null>((resolve) => {
      const entries: OverlayEntry[] = [];
      // 任一显示器创建失败都整单放弃：部分遮罩的部分截图会让用户误以为功能正常。
      for (const [displayKey, image] of images) {
        const display =
          displayKey === cursorDisplayKey
            ? cursorDisplay
            : getAllDisplays().find((candidate) => String(candidate.id) === displayKey);
        if (!display) continue;
        let overlay: ScreenCaptureOverlayWindow;
        try {
          overlay = createWindow({
            x: display.bounds.x,
            y: display.bounds.y,
            width: display.size.width,
            height: display.size.height,
            frame: false,
            transparent: false,
            hasShadow: false,
            backgroundColor: "#000000",
            show: false,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            autoHideMenuBar: true,
            webPreferences: {
              preload: options.resolvePreloadPath(),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              devTools: false,
              backgroundThrottling: false,
            },
          });
        } catch (error) {
          options.logger.warn("[screen-capture] 创建遮罩窗口失败", error);
          for (const entry of entries) {
            try {
              if (!entry.overlay.isDestroyed()) entry.overlay.destroy();
            } catch (destroyError) {
              options.logger.debug?.("[screen-capture] 清理遮罩窗口失败", destroyError);
            }
          }
          resolve({ ok: false, reason: "capture-failed" });
          return;
        }
        if (process.platform !== "darwin") {
          overlay.setMenu(null);
        }
        entries.push({
          display,
          image,
          overlay,
          webContentsId: overlay.webContents.id,
          shown: false,
        });
      }
      if (entries.length === 0) {
        resolve({ ok: false, reason: "capture-failed" });
        return;
      }

      const active: ActiveCaptureSession = {
        entries,
        cursorDisplayKey,
        settle: resolve,
        watchdog: null,
        finished: false,
        readyCount: 0,
      };
      session = active;

      for (const entry of entries) {
        entry.overlay.on("closed", () => {
          // 任一遮罩窗口被系统或用户意外关闭：会话必须收敛，否则互斥锁永远占用。
          if (session === active) {
            settleAndCleanup(null);
          }
        });
      }
      callerWindow.once("closed", () => {
        if (session === active) {
          cancelSession();
        }
      });

      // 看门狗覆盖「loadURL 挂起 / 页面脚本崩溃导致永远 Ready 不了」两条路径：
      // 不清理会留下不可交互的隐形会话并永久占用互斥锁。
      active.watchdog = schedule(() => {
        if (session !== active || active.finished) return;
        options.logger.warn("[screen-capture] 遮罩窗口超时未就绪，放弃本次截图会话");
        failSession("capture-failed");
      }, OVERLAY_READY_WATCHDOG_MS);

      for (const entry of entries) {
        const overlay = entry.overlay;
        void overlay
          .loadURL(screenCaptureOverlayDataUrl(options.getLocale()))
          .then(() => {
            if (session !== active || active.finished || overlay.isDestroyed()) return;
            overlay.webContents.send(InternalChannels.ScreenCaptureOverlayImageData, {
              dataBase64: entry.image.toPNG().toString("base64"),
              scaleFactor: entry.display.scaleFactor,
            });
          })
          .catch((error) => {
            if (session !== active || active.finished) return;
            options.logger.warn("[screen-capture] 加载遮罩窗口内容失败", error);
            failSession("capture-failed");
          });
      }
    });
  }

  function dispose(): void {
    disposed = true;
    cancelSession();
  }

  return {
    capture,
    handleOverlayReady,
    handleOverlayFinish,
    handleOverlayCancel,
    handleOverlayHover,
    ownsOverlayWebContents,
    dispose,
  };
}

export type ScreenCaptureRegionCoordinator = ReturnType<
  typeof createScreenCaptureRegionCoordinator
>;
