import type { Locale } from "@zcode/shared";
import {
  screenCaptureOverlayCopy,
  screenCaptureToolbarHtml,
} from "./screenCaptureRegionToolbar.js";

export {
  screenCaptureOverlayCopy,
  type ScreenCaptureOverlayCopy,
} from "./screenCaptureRegionToolbar.js";

/**
 * 选区截图遮罩窗口的呈现层：冻结画面、暗幕、选区、标注 canvas 与工具条的整页 HTML。
 *
 * 与窗口生命周期分开（对齐 windowsCuaOperationIndicatorContent 的拆分）：
 * 这里跟着画面布局走，工具条按钮在 `screenCaptureRegionToolbar.ts`，
 * `screenCaptureRegion.ts` 跟着捕获时机与 Electron 窗口行为走。
 *
 * 页面是 main 自产的 data-URL，唯一的特权出口是 `window.zcodeScreenCaptureOverlay`
 * （专用 preload 只暴露 onImageData/ready/finish/cancel）。
 * 注意：内联 `<script>` 是模板字符串，里面的交互代码必须是纯 JS——写成 TS 注解
 * 能通过编译，但浏览器会静默 SyntaxError（e2e 冒烟抓到过）。
 */

function overlayHtml(locale: Locale, copy: ScreenCaptureOverlayCopy): string {
  // 确认图标用直线段 polyline + 方形端帽（产品要求：确认 icon 不带弧度）。
  const script = `
(function () {
  var bridge = window.zcodeScreenCaptureOverlay;
  if (!bridge) return;
  var shot = document.getElementById("shot");
  var dim = document.getElementById("dim");
  var selection = document.getElementById("selection");
  var badge = document.getElementById("badge");
  var canvas = document.getElementById("ink");
  var ctx = canvas.getContext("2d");
  var toolbar = document.getElementById("toolbar");
  var EDGE = 8;
  var scaleFactor = 1;
  var dragStart = null;
  var rect = null;
  var rectBeforeDrag = null;
  var finished = false;
  var tool = "none";
  var color = "#ff453a";
  var strokes = [];
  var drawing = null;

  function normalizeRect(x0, y0, x1, y1) {
    return {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
    };
  }

  function inToolbar(target) {
    // 合成事件（自动化测试、无障碍路径）可能把 window 当 target，contains 只收 Node。
    return target instanceof Element && toolbar.contains(target);
  }

  function insideRect(x, y) {
    return rect && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
  }

  function positionToolbar() {
    var left = rect.x + rect.width - toolbar.offsetWidth;
    var top = rect.y + rect.height + EDGE;
    if (top + toolbar.offsetHeight > window.innerHeight) {
      top = rect.y + rect.height - toolbar.offsetHeight - EDGE;
    }
    if (top < 0) top = Math.max(0, window.innerHeight - toolbar.offsetHeight - EDGE);
    left = Math.max(EDGE, Math.min(left, window.innerWidth - toolbar.offsetWidth - EDGE));
    toolbar.style.left = left + "px";
    toolbar.style.top = top + "px";
  }

  function syncToolButtons() {
    var buttons = toolbar.querySelectorAll("[data-tool]");
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].dataset.tool === tool) buttons[i].classList.add("active");
      else buttons[i].classList.remove("active");
    }
    var swatches = toolbar.querySelectorAll("[data-color]");
    for (var j = 0; j < swatches.length; j++) {
      if (swatches[j].dataset.color === color) swatches[j].classList.add("active");
      else swatches[j].classList.remove("active");
    }
  }

  function drawStroke(g, stroke) {
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = stroke.color;
    g.fillStyle = stroke.color;
    g.lineWidth = 3;
    if (stroke.tool === "pen") {
      var pts = stroke.points;
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      g.stroke();
      return;
    }
    if (stroke.tool === "line") {
      g.beginPath();
      g.moveTo(stroke.x0, stroke.y0);
      g.lineTo(stroke.x1, stroke.y1);
      g.stroke();
      return;
    }
    if (stroke.tool === "rect") {
      g.strokeRect(Math.min(stroke.x0, stroke.x1), Math.min(stroke.y0, stroke.y1),
        Math.abs(stroke.x1 - stroke.x0), Math.abs(stroke.y1 - stroke.y0));
      return;
    }
    if (stroke.tool === "ellipse") {
      g.beginPath();
      g.ellipse((stroke.x0 + stroke.x1) / 2, (stroke.y0 + stroke.y1) / 2,
        Math.abs(stroke.x1 - stroke.x0) / 2, Math.abs(stroke.y1 - stroke.y0) / 2, 0, 0, Math.PI * 2);
      g.stroke();
      return;
    }
    if (stroke.tool === "arrow") {
      g.beginPath();
      g.moveTo(stroke.x0, stroke.y0);
      g.lineTo(stroke.x1, stroke.y1);
      g.stroke();
      var angle = Math.atan2(stroke.y1 - stroke.y0, stroke.x1 - stroke.x0);
      var head = 12;
      g.beginPath();
      g.moveTo(stroke.x1, stroke.y1);
      g.lineTo(stroke.x1 - head * Math.cos(angle - Math.PI / 7), stroke.y1 - head * Math.sin(angle - Math.PI / 7));
      g.lineTo(stroke.x1 - head * Math.cos(angle + Math.PI / 7), stroke.y1 - head * Math.sin(angle + Math.PI / 7));
      g.closePath();
      g.fill();
    }
  }

  function redrawInk() {
    if (!rect) {
      canvas.style.display = "none";
      return;
    }
    canvas.style.display = "block";
    canvas.style.left = rect.x + "px";
    canvas.style.top = rect.y + "px";
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    var w = Math.max(1, Math.round(rect.width * scaleFactor));
    var h = Math.max(1, Math.round(rect.height * scaleFactor));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // dip 坐标 → canvas 设备像素：先缩放再平移出选区原点。
    ctx.setTransform(scaleFactor, 0, 0, scaleFactor, -rect.x * scaleFactor, -rect.y * scaleFactor);
    for (var i = 0; i < strokes.length; i++) drawStroke(ctx, strokes[i]);
    if (drawing) drawStroke(ctx, drawing);
  }

  function render() {
    if (!rect) {
      selection.style.display = "none";
      badge.style.display = "none";
      toolbar.style.display = "none";
      dim.style.opacity = "1";
      redrawInk();
      return;
    }
    dim.style.opacity = "0";
    selection.style.display = "block";
    selection.style.left = rect.x + "px";
    selection.style.top = rect.y + "px";
    selection.style.width = rect.width + "px";
    selection.style.height = rect.height + "px";
    badge.style.display = "block";
    badge.textContent = Math.round(rect.width) + " \\u00d7 " + Math.round(rect.height);
    var badgeTop = rect.y >= 28 ? rect.y - 22 : rect.y + rect.height + 6;
    badge.style.left = rect.x + "px";
    badge.style.top = badgeTop + "px";
    toolbar.style.display = "flex";
    positionToolbar();
    syncToolButtons();
    redrawInk();
  }

  function compose() {
    // 选区画面 + 标注 → 最终 PNG（物理像素分辨率），base64 无 data: 前缀。
    var w = Math.max(1, Math.round(rect.width * scaleFactor));
    var h = Math.max(1, Math.round(rect.height * scaleFactor));
    var out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    var g = out.getContext("2d");
    g.drawImage(shot, rect.x * scaleFactor, rect.y * scaleFactor, rect.width * scaleFactor, rect.height * scaleFactor, 0, 0, w, h);
    g.setTransform(scaleFactor, 0, 0, scaleFactor, -rect.x * scaleFactor, -rect.y * scaleFactor);
    for (var i = 0; i < strokes.length; i++) drawStroke(g, strokes[i]);
    var dataUrl = out.toDataURL("image/png");
    return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), width: w, height: h };
  }

  function finish() {
    if (finished || !rect || rect.width < 1 || rect.height < 1) return;
    finished = true;
    var payload = {
      region: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
    if (strokes.length > 0) {
      try {
        var composed = compose();
        payload.imageDataBase64 = composed.base64;
        payload.imageWidth = composed.width;
        payload.imageHeight = composed.height;
      } catch (error) {
        // 合成失败退回无标注裁剪，不阻断截图。
      }
    }
    bridge.finish(payload);
  }

  function cancel() {
    if (finished) return;
    finished = true;
    bridge.cancel();
  }

  window.addEventListener("mousedown", function (event) {
    if (finished || event.button !== 0) return;
    if (inToolbar(event.target)) return;
    if (tool !== "none" && insideRect(event.clientX, event.clientY)) {
      var point = { x: event.clientX, y: event.clientY };
      drawing = tool === "pen"
        ? { tool: "pen", color: color, points: [point] }
        : { tool: tool, color: color, x0: point.x, y0: point.y, x1: point.x, y1: point.y };
      redrawInk();
      return;
    }
    // 重新框选：清空旧标注，避免笔画坐标系错位。
    dragStart = { x: event.clientX, y: event.clientY };
    rectBeforeDrag = rect;
    strokes = [];
    drawing = null;
    redrawInk();
  });
  window.addEventListener("mousemove", function (event) {
    if (finished) return;
    // macOS 只为 key window 应用 CSS 光标：非焦点遮罩（外接屏 showInactive 弹出）
    // 会显示默认箭头。无焦点时通知 main 抢焦点，focus 跟随鼠标；获得焦点后
    // document.hasFocus() 变 true，自动停止上报。
    if (!document.hasFocus() && bridge.notifyHover) bridge.notifyHover();
    if (drawing) {
      if (drawing.tool === "pen") drawing.points.push({ x: event.clientX, y: event.clientY });
      else { drawing.x1 = event.clientX; drawing.y1 = event.clientY; }
      redrawInk();
      return;
    }
    if (!dragStart) return;
    rect = normalizeRect(dragStart.x, dragStart.y, event.clientX, event.clientY);
    render();
  });
  window.addEventListener("mouseup", function (event) {
    if (finished) return;
    if (drawing) {
      strokes.push(drawing);
      drawing = null;
      redrawInk();
      return;
    }
    if (!dragStart) return;
    var start = dragStart;
    dragStart = null;
    var next = normalizeRect(start.x, start.y, event.clientX, event.clientY);
    if (next.width < 3 || next.height < 3) {
      // 误触单击：恢复拖拽前的选区（可能为空），双击确认与单击互不干扰。
      rect = rectBeforeDrag;
      rectBeforeDrag = null;
      render();
      return;
    }
    rect = next;
    rectBeforeDrag = null;
    render();
  });
  window.addEventListener("dblclick", function (event) {
    if (inToolbar(event.target)) return;
    // 标注模式下双击是绘图手势的一部分，不触发确认。
    if (tool !== "none") return;
    finish();
  });
  window.addEventListener("contextmenu", function (event) {
    event.preventDefault();
    cancel();
  });
  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape") cancel();
    else if (event.key === "Enter") finish();
  });
  toolbar.addEventListener("mousedown", function (event) {
    event.stopPropagation();
  });
  document.getElementById("confirm").addEventListener("click", finish);
  document.getElementById("cancel").addEventListener("click", cancel);
  document.getElementById("undo").addEventListener("click", function () {
    if (drawing) return;
    strokes.pop();
    redrawInk();
  });
  var toolButtons = toolbar.querySelectorAll("[data-tool]");
  for (var t = 0; t < toolButtons.length; t++) {
    toolButtons[t].addEventListener("click", function (event) {
      var next = event.currentTarget.dataset.tool;
      tool = tool === next ? "none" : next;
      syncToolButtons();
    });
  }
  var swatches = toolbar.querySelectorAll("[data-color]");
  for (var c = 0; c < swatches.length; c++) {
    swatches[c].addEventListener("click", function (event) {
      color = event.currentTarget.dataset.color;
      syncToolButtons();
    });
  }

  bridge.onImageData(function (payload) {
    scaleFactor = typeof payload.scaleFactor === "number" && payload.scaleFactor > 0 ? payload.scaleFactor : 1;
    shot.onload = function () {
      shot.style.display = "block";
      bridge.ready();
    };
    shot.src = "data:image/png;base64," + payload.dataBase64;
  });
})();
`;

  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>
  * { box-sizing: border-box; user-select: none; -webkit-user-select: none; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; cursor: crosshair; }
  #shot { position: absolute; inset: 0; width: 100%; height: 100%; display: none; -webkit-user-drag: none; }
  #dim { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.35); pointer-events: none; }
  #selection { position: absolute; display: none; border: 1px solid #38bdf8; box-shadow: 0 0 0 100000px rgba(0, 0, 0, 0.35); pointer-events: none; }
  #ink { position: absolute; display: none; pointer-events: none; }
  #badge { position: absolute; display: none; padding: 2px 6px; border-radius: 4px; background: rgba(15, 23, 42, 0.85); color: #fff; font: 12px/1.4 -apple-system, "Segoe UI", sans-serif; pointer-events: none; white-space: nowrap; }
  #toolbar { position: absolute; display: none; align-items: center; gap: 4px; padding: 5px 6px; border-radius: 6px; background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(255, 255, 255, 0.14); }
  #toolbar .tb-btn { display: flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: none; border-radius: 4px; background: transparent; color: #fff; cursor: pointer; padding: 0; }
  #toolbar .tb-btn:hover { background: rgba(255, 255, 255, 0.14); }
  #toolbar .tb-btn.active { background: #38bdf8; color: #04283a; }
  #toolbar .tb-sep { width: 1px; height: 18px; background: rgba(255, 255, 255, 0.2); margin: 0 2px; }
  #toolbar .tb-swatch { width: 18px; height: 18px; border: none; border-radius: 3px; cursor: pointer; padding: 0; }
  #toolbar .tb-swatch.active { outline: 2px solid #fff; outline-offset: 1px; }
  #confirm { background: #38bdf8; color: #04283a; width: 32px; }
  #confirm:hover { background: #5ecbfa; }
  #cancel { background: rgba(255, 255, 255, 0.14); color: #fff; width: 32px; }
</style>
</head>
<body>
<img id="shot" alt="" draggable="false">
<div id="dim"></div>
<div id="selection"></div>
<canvas id="ink"></canvas>
<div id="badge"></div>
${screenCaptureToolbarHtml(copy)}
<script>${script}</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function screenCaptureOverlayDataUrl(locale: Locale): string {
  return `data:text/html;base64,${Buffer.from(overlayHtml(locale, screenCaptureOverlayCopy(locale)), "utf8").toString("base64")}`;
}
