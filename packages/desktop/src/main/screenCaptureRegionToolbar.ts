import type { Locale } from "@zcode/shared";

/**
 * 选区截图遮罩工具条的呈现层：标注工具、色板、撤销与确认/取消按钮的 HTML。
 *
 * 独立成文件是因为工具条跟着产品交互走（加工具/换图标），而 `screenCaptureRegionContent.ts`
 * 的其余部分跟着画面布局走；确认图标是直线段 SVG 勾（产品要求：确认 icon 不带弧度）。
 */

export interface ScreenCaptureOverlayCopy {
  confirmTitle: string;
  cancelTitle: string;
  toolPen: string;
  toolLine: string;
  toolRect: string;
  toolEllipse: string;
  toolArrow: string;
  undo: string;
  colorRed: string;
  colorBlue: string;
  colorYellow: string;
}

export function screenCaptureOverlayCopy(locale: Locale): ScreenCaptureOverlayCopy {
  return locale === "zh-CN"
    ? {
        confirmTitle: "确认截图",
        cancelTitle: "取消截图",
        toolPen: "画笔",
        toolLine: "直线",
        toolRect: "矩形",
        toolEllipse: "椭圆",
        toolArrow: "箭头",
        undo: "撤销",
        colorRed: "红色",
        colorBlue: "蓝色",
        colorYellow: "黄色",
      }
    : {
        confirmTitle: "Confirm capture",
        cancelTitle: "Cancel capture",
        toolPen: "Pen",
        toolLine: "Line",
        toolRect: "Rectangle",
        toolEllipse: "Ellipse",
        toolArrow: "Arrow",
        undo: "Undo",
        colorRed: "Red",
        colorBlue: "Blue",
        colorYellow: "Yellow",
      };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 直线段图标：方形端帽 + 直角拐点，无任何弧度。 */
function icon(inner: string): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${inner}</svg>`;
}

function toolIcon(inner: string): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

export function screenCaptureToolbarHtml(copy: ScreenCaptureOverlayCopy): string {
  const title = (key: keyof ScreenCaptureOverlayCopy) => escapeHtml(copy[key]);
  return `<div id="toolbar">
  <button class="tb-btn" data-tool="pen" type="button" title="${title("toolPen")}" aria-label="${title("toolPen")}">${toolIcon('<path d="M4 20 L6.5 13.5 L16.5 3.5 L20.5 7.5 L10.5 17.5 Z"/><path d="M14 6 L18 10"/>')}</button>
  <button class="tb-btn" data-tool="line" type="button" title="${title("toolLine")}" aria-label="${title("toolLine")}">${toolIcon('<path d="M5 19 L19 5"/>')}</button>
  <button class="tb-btn" data-tool="rect" type="button" title="${title("toolRect")}" aria-label="${title("toolRect")}">${toolIcon('<rect x="4.5" y="6.5" width="15" height="11"/>')}</button>
  <button class="tb-btn" data-tool="ellipse" type="button" title="${title("toolEllipse")}" aria-label="${title("toolEllipse")}">${toolIcon('<ellipse cx="12" cy="12" rx="8" ry="5.5"/>')}</button>
  <button class="tb-btn" data-tool="arrow" type="button" title="${title("toolArrow")}" aria-label="${title("toolArrow")}">${toolIcon('<path d="M5 19 L17 7"/><path d="M11 7 L17 7 L17 13"/>')}</button>
  <span class="tb-sep"></span>
  <button class="tb-swatch" data-color="#ff453a" type="button" title="${title("colorRed")}" aria-label="${title("colorRed")}" style="background:#ff453a"></button>
  <button class="tb-swatch" data-color="#0a84ff" type="button" title="${title("colorBlue")}" aria-label="${title("colorBlue")}" style="background:#0a84ff"></button>
  <button class="tb-swatch" data-color="#ffcc00" type="button" title="${title("colorYellow")}" aria-label="${title("colorYellow")}" style="background:#ffcc00"></button>
  <span class="tb-sep"></span>
  <button class="tb-btn" id="undo" type="button" title="${title("undo")}" aria-label="${title("undo")}">${toolIcon('<path d="M8 5 L3 10 L8 15"/><path d="M3 10 L14 10"/>')}</button>
  <span class="tb-sep"></span>
  <button class="tb-btn" id="confirm" type="button" title="${title("confirmTitle")}" aria-label="${title("confirmTitle")}">${icon('<polyline points="4,13 9.5,18.5 20,6"/>')}</button>
  <button class="tb-btn" id="cancel" type="button" title="${title("cancelTitle")}" aria-label="${title("cancelTitle")}">${icon('<path d="M6 6 L18 18"/><path d="M18 6 L6 18"/>')}</button>
</div>`;
}
