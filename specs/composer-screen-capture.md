# Spec：聊天输入框截图（微信桌面端同款选区截图）

> v2（2026-09-28）：新增外接显示器支持（每个显示器一个遮罩）、截图标注
> （画笔/直线/矩形/椭圆/箭头 + 三色 + 撤销）、确认按钮改为直线段 SVG 图标。
> v1 的单屏链路是多屏的特例（`getAllDisplays` 返回单元素）。

## 问题

聊天 composer 只支持粘贴/拖拽/文件选择器三种方式添加图片附件。用户想把屏幕上
某个区域（其他 App、终端报错、设计稿等）发给 agent，当前必须先走系统截图工具、
保存或复制、再回到 ZCode 粘贴，链路断裂。微信桌面端在输入框旁提供剪刀按钮：
点击后整屏变暗、拖拽选区、标注、确认后图片直接进入输入框待发送——本 spec 在
ZCode 桌面端复刻该核心链路，并覆盖外接显示器场景。

## 方案概述

- **入口**：composer 输入框下方 leading 工具栏新增截图按钮（剪刀图标）。仅当
  `IPlatformService.captureScreenRegion` 存在（即桌面平台）时渲染；Web / 移动端
  无此方法，入口自然隐藏。
- **主链路（多屏）**：点击按钮 → renderer `invoke(CaptureScreenRegion)` → main
  在遮罩窗口出现**之前**用 `desktopCapturer` 捕获**所有显示器**的整屏位图
  （按 `display_id` 匹配源，缩略图尺寸兜底匹配）→ main 在**每个显示器**上创建
  一个全屏无边框遮罩窗口（加载内联 data-URL 页面，背景为该显示器的冻结画面）；
  光标所在显示器的遮罩 `show()+focus()`，其余 `showInactive()` → 用户在任意一个
  遮罩上拖拽选区 → 可选标注 → 确认后：
  - 无标注：main 用 `nativeImage.crop` 按选区裁剪**该遮罩所属显示器**的位图；
  - 有标注：overlay 在本地把「选区画面 + 标注」合成为最终 PNG（物理像素分辨率）
    随 finish 上报，main 校验尺寸后采用（校验失败回退无标注裁剪并 warn）。
    最终 PNG base64 随原 invoke Promise 返回 renderer → composer 转成 `File` 走
    既有 `addAttachmentFiles` 链路（上传、预览、序列化全部复用，不新增附件状态）。
- **标注工具**：选区释放后工具条展开：画笔（自由手绘）、直线、矩形、椭圆、箭头
  五种工具 + 红/蓝/黄三色 + 撤销。标注笔画只在选区内可见（canvas 按选区裁剪）；
  重新框选会清空已有标注；工具激活时双击不再触发确认（避免与绘图冲突）。
- **交互细节（对齐微信）**：选区有 1px 高亮边框 + 尺寸角标；确认图标为直线段
  SVG 勾（无弧度、方形端帽），工具条按钮为小圆角矩形（非圆形）；Enter /
  双击（工具未激活时）/ ✓ 确认；Esc / 右键 / ✕ 取消整个截图；拖拽位移过小
  （<3px，视为误触单击）时保持原选区不变。
- **失败与权限**：macOS 屏幕录制权限未授予或捕获结果为空 → 返回结构化失败
  `screen-recording-permission`，composer 用现有附件错误横幅展示本地化文案；
  其他捕获异常返回 `capture-failed`；同一时刻仅允许一个截图会话（`busy`）。

## 状态所有权

| 状态                                               | 所有者                                                     | 说明                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 截图会话（N 个遮罩窗口生命周期 + pending promise） | main `screenCaptureRegion` coordinator                     | 唯一所有者，负责所有销毁路径；任一遮罩关闭即取消全会话                        |
| 选区矩形 / 标注笔画 / 标注合成图                   | 遮罩 overlay renderer 页面局部状态                         | 纯 DOM/canvas 交互状态，不进任何 store，不跨 IPC 传矢量标注                   |
| 各显示器整屏位图                                   | main（`nativeImage`，按 displayId 索引）                   | 无标注时裁剪以 main 持有的原图为准；有标注时以 overlay 合成图为准（尺寸校验） |
| composer 待发送附件                                | `useComposerAttachments` + `composerAttachmentUploadStore` | 截图结果只是又一张图片附件，不新增状态路径                                    |
| 按钮请求中态                                       | composer 按钮组件局部 state                                | 防重复触发；overlay 打开期间按钮禁用                                          |

## 协议变更（全部 additive）

1. `PlatformChannels` 4 个通道（`packages/shared/src/channels.ts`）：
   - `CaptureScreenRegion`（`zcode:capture-screen-region`）：app renderer → main，
     invoke，请求 `void`，响应 `ScreenRegionCaptureOutcome | null`（null = 用户取消）。
   - `ScreenCaptureOverlayReady`：overlay preload → main，send，画面绘制完成。
   - `ScreenCaptureOverlayFinish`：overlay preload → main，invoke，请求
     `ScreenCaptureOverlayFinishRequest`：`{ region: ScreenCaptureSelectionRegion; imageDataBase64?; imageWidth?; imageHeight? }`
     （`imageDataBase64` 为标注合成 PNG 的裸 base64；无标注时缺省，main 自行裁剪）。
   - `ScreenCaptureOverlayCancel`：overlay preload → main，invoke，用户取消。
   - `ScreenCaptureOverlayHover`：overlay preload → main，send。macOS 只为 key window
     应用 CSS 光标，非焦点遮罩（`showInactive` 弹出的非光标屏）会显示默认箭头；
     遮罩页在 `mousemove` 且 `document.hasFocus()` 为 false 时上报，main 仅在
     macOS 下为该遮罩抢焦点（focus 跟随鼠标），让十字光标在任意显示器立即生效。
2. `packages/shared/src/platform.ts`：`ScreenCaptureSelectionRegion`、
   `ScreenCaptureOverlayFinishRequest`、`ScreenRegionCaptureResult`（ok 分支，含
   `dataBase64/filename/contentType/size/width/height`）、
   `ScreenRegionCaptureFailureReason`（`screen-recording-permission | capture-failed | busy`）、
   `ScreenRegionCaptureFailure`、`ScreenRegionCaptureOutcome`；`IPlatformService`
   可选方法 `captureScreenRegion?()`。
3. `InternalChannels.ScreenCaptureOverlayImageData`：main → overlay，send，
   payload `{ dataBase64, scaleFactor }`（该显示器的整屏 PNG + 缩放系数）。
4. 语义不变量：
   - 选区坐标是遮罩窗口内的 **DIP 坐标**；多屏时每个遮罩只知道自己 display 的
     bounds/scaleFactor，跨屏不做坐标换算。
   - 标注矢量数据**不出 overlay**：overlay 本地合成最终 PNG（`canvas.toDataURL`），
     main 只收位图。main 用 `nativeImage.createFromBuffer` 解码并校验尺寸
     （`isComposedImageSizeAcceptable`，纯函数可单测），与裁剪矩形误差 ≤2px
     才采用，否则 warn + 回退无标注裁剪。
   - `ScreenCaptureOverlay*` 通道只接受 coordinator 自己创建的 webContents 的
     消息（sender 校验），防止其他 renderer 伪造选区/合成图。
   - 新通道不进 `zcode-protocol` / `zcode-protocol-v4`：renderer↔main 桌面能力
     通道，不是 app↔agent 会话协议。

## Main（coordinator / IPC）

- `screenCaptureRegion.ts`：`createScreenCaptureRegionCoordinator({ logger, getLocale, resolvePreloadPath })`
  提供 `capture(callerWindow)` 与 `dispose()`。Electron 依赖（`desktopCapturer`、
  `screen`、`BrowserWindow`、`systemPreferences`、`nativeImage`）通过注入便于测试；
  `computePhysicalCropRect` / `sanitizeSelectionRegion` / `isComposedImageSizeAcceptable`
  为纯函数（`screenCaptureRegionMath.ts`，plain node 单测）。
- 捕获：`screen.getAllDisplays()` → 逐显示器 `desktopCapturer.getSources`
  （thumbnailSize = 该显示器物理像素），`source.display_id === String(display.id)`
  匹配，缩略图尺寸兜底匹配；光标所在显示器必须匹配成功，否则按权限/失败语义返回。
- 会话互斥：已有活跃会话时 `capture()` 直接返回 `{ ok:false, reason:"busy" }`。
- 遮罩窗口（每显示器一个）：`frame:false、resizable/movable/minimizable/maximizable:false、
fullscreenable:false、skipTaskbar、hasShadow:false、alwaysOnTop('screen-saver')、
show:false`，bounds = 该显示器 bounds；先加载、绘制完再显示（光标显示器
  `show()+focus()`，其余 `showInactive()`），避免闪黑屏。
- 销毁路径全部收敛：确认 / 取消 / **任一**遮罩窗口被系统关闭 / 调用方窗口关闭 /
  dispose。任何一条路径触发都销毁全部窗口并 settle pending promise（确认 → 结果，
  其余 → null 或失败对象），promise 只 settle 一次。
- IPC handler 在 `desktopMainIpcPlatform.ts` 注册，随现有 platform handlers 装配。

## Overlay 页面（data-URL，无框架）

- `screenCaptureRegionContent.ts` 产出内联 HTML：冻结画面 `<img>` 铺满 + 半透明
  暗幕 + 选区（`box-shadow: 0 0 0 100000px` 挖亮洞）+ 尺寸角标 + 标注 canvas
  （绝对定位于选区，backing store 按 scaleFactor 放大保证清晰）+ 工具条。
- 工具条：`画笔 | 直线 | 矩形 | 椭圆 | 箭头` + `红/蓝/黄色板` + `撤销` +
  `确认(直线段勾 SVG)/取消(X SVG)`，全部为小圆角矩形按钮；图标为内联 SVG。
- 绘图：工具激活时在选区内拖拽绘制（pen 收集点、形状工具拖出预览），笔画按
  选区裁剪；撤销弹出最后一笔；确认时若有标注，先在离屏 canvas 合成
  （背景 = 选区区域位图 + 笔画），`toDataURL` 后随 finish 上报。
- 交互代码为原生 JS（**纯 JS，不得写 TS 注解**——内联模板字符串里的 TS 语法
  能过编译但浏览器静默 SyntaxError）；经专用 preload（`screenCaptureOverlay.ts`，
  `contextBridge` 仅暴露 `onImageData/ready/finish/cancel`，沙箱内运行）。
- 页面文案仅工具条 title/aria（按 locale 注入），无其他文本。

## Renderer 数据层（desktop renderer）

- `desktopPlatform.ts` 把 `captureScreenRegion` 转发到 `window.zcode`；
  `packages/client/src/globals.d.ts` 补充可选成员声明。

## Renderer UI（packages/ui）

- `chatAttachments.ts`：`createScreenshotAttachmentFile`：base64 → `File`
  （PNG、时间戳文件名 `zcode-screenshot-<ISO>.png`），纯函数可单测。
- `useComposerAttachments.captureScreenAttachment()`：能力检测 → 调
  `platform.captureScreenRegion` → 取消静默返回 / 失败写 `attachmentError`
  （映射本地化文案）/ 成功走 `addAttachmentFiles`。
- `V4ComposerScreenshotButton`：`useOptionalPlatform` 平台门（无方法不渲染，
  缺 provider 静默降级，对齐 `V4ComposerCuaEntry` 两层门模式）；ghost 图标按钮 +
  `ControlHintTooltip`；请求中禁用防重入。
- i18n：`chat.composer.screenshot`、`chat.composer.screenshot.permissionError`、
  `chat.composer.screenshot.failed`（zh-CN / en-US 同步）。

## 事件顺序

```
Composer(button)         Main coordinator              Overlays (每显示器一个)
      |                        |                            |
      | invoke CaptureScreen   |                            |
      |----------------------->|                            |
      |                        | 权限检查(macOS)             |
      |                        | 逐显示器捕获整屏            |
      |                        | 创建 N 个遮罩(show:false)   |
      |                        | send OverlayImageData ----->| (各自的画面 + scaleFactor)
      |                        |                    绘制背景 |
      |                        |<-- send OverlayReady ------| (每个遮罩各自上报)
      |                        | 光标屏 show+focus；其余 showInactive
      |     （拖拽选区 → 标注(可选) → Enter/✓ 确认）           |
      |                        |<-- invoke Finish(region, 合成图?) -| (仅发生拖拽的那个遮罩)
      |                        | 校验合成图 / crop → PNG     |
      |                        | 销毁全部遮罩                 |
      |<-- resolve outcome ----|                            |
      | base64→File→addAttachmentFiles                      |
```

失败分支：权限不足 / 捕获为空 / 异常 → coordinator 直接销毁并返回
`{ ok:false, reason }`；取消（Esc/✕/右键/任一遮罩意外关闭/调用方关闭）→ resolve `null`。

## 失败语义

| 场景                                                    | 行为                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| macOS 屏幕录制权限未授予 / 捕获结果为空                 | 返回 `screen-recording-permission`；composer 展示本地化提示 |
| desktopCapturer 异常 / 光标显示器无匹配源               | 返回 `capture-failed`；composer 展示通用失败提示            |
| 非光标显示器无匹配源                                    | 跳过该显示器的遮罩，不影响其余显示器截图                    |
| 已有截图会话进行中再次触发                              | 返回 `busy`；按钮处于禁用态，正常用户不可达                 |
| 用户 Esc / ✕ / 右键                                     | resolve `null`，无任何 UI 反馈                              |
| 任一遮罩窗口被系统关闭 / 调用方窗口关闭                 | settle pending promise（null），销毁全部遮罩                |
| 选区过小（<3px 拖拽）                                   | 视为误触：保持原选区不变，不关闭遮罩                        |
| 标注合成图缺失字段 / 解码为空 / 尺寸与裁剪矩形偏差 >2px | warn 日志，回退无标注裁剪（丢弃标注，不失败）               |
| 截图超过附件 inline 上限                                | 由既有 `serializeChatComposerAttachment` 20MiB 边界处理     |

## 验收场景

1. 多屏环境点击截图按钮：**所有**显示器同时出现遮罩；在外接显示器上拖拽选区并
   确认，得到的是外接屏对应区域的内容（不是主屏画面）。
2. 拖出选区后展开标注工具条；选画笔在选区内手绘、选椭圆画圈、选箭头划线，
   切换红/蓝/黄色生效；撤销逐笔回退；确认后附件图片包含标注内容。
3. 无标注直接确认：结果与 v1 一致（main 裁剪）；有标注时合成图被采用。
4. 重新框选后旧标注被清空。
5. 确认/取消图标为直线段 SVG（无弧度），按钮为小圆角矩形。
6. 遮罩内按 Esc（或 ✕ / 右键）：全部遮罩消失，附件列表无变化，无错误提示。
7. 拖拽 2px 内的"点击"：选区保持不变，遮罩保留。
8. macOS 未授予屏幕录制权限：显示权限提示文案，不出现遮罩。
9. Web 端与缺 PlatformProvider 环境：截图按钮不渲染，其余 composer 功能不受影响。
10. 截图会话进行中按钮禁用；会话结束后恢复可用。
11. 纯函数单测：`computePhysicalCropRect`（scaleFactor/越界 clamp/最小 1×1）、
    `isComposedImageSizeAcceptable`（容差、非法输入）。
