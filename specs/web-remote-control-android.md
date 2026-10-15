# Web 远程控制（Android + 外部 relay）

移植自官方 v3.15.1。桌面 main 进程注册为外部 relay 的 device 端，手机 App 扫码后经 relay 桥接触发桌面已有 Host attachment。**与本地既有 server web 模式（`?remote=<id>` / web-remote-replayable）是两条独立链路，互不改动。**

## 产品规则

1. 默认连官方 relay（`wss://zcode.z.ai/ws`）与官方托管页面（`<origin>/remote/v3|v4`）；env 可覆盖：
   `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`、`ZCODE_WEB_REMOTE_CONTROL_URL`（web 侧为
   `VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` / `VITE_ZCODE_BASE_URL`）。自部署 endpoint 的
   relay 与页面同源（`<origin>/ws`）。
2. relay 只做鉴权、配对、心跳与转发；桌面侧设备身份（sid）与 passHash 分离：sid 进 AppSettings，
   passHash 必须走 credentialService，不进设置文件。
3. pairing 材料（sid/hash/ts）由桌面生成二维码；旧的 pairing 被新一次顶替（resetPairing 后才换）。
4. endpoint 切换时挂起在飞远控（`suspend(winId, "endpoint-changed")`），由 renderer 用新地址重开。
5. Bot 远端连接状态的 `remoteSessionId -> workspaceIdentity` 绑定与远控共用 workspace 同步，
   但**独立于远控是否开启**（未开启时也要同步已连接的 remote session）。
6. 手机端只 attachment 桌面的 Host：provider 可用性判定、登录入口守卫对手机根不生效
   （`isWebRemoteControlRoot`）。
7. android 壳（packages/android）是自包含 gradle 工程：扫码/输入 URL → 白名单校验
   （生产仅 `https://zcode.z.ai/remote*`，debug 放开 localhost/局域网）→ 最近 5 条链接
   （SharedPreferences）→ 前台服务保活 + 亮屏。WebView 禁 file/content 访问与混合内容，
   UA 追加 `ZCodeAndroid/<ver>`。

## 架构与事件顺序

```text
renderer(trigger) ──StartWebRemoteControl──▶ main/webRemoteControlIpc ──authorizeStart──▶ manager
manager ──device_register(relay ws)──▶ relay ──pairing(matched)──▶ 二维码可扫
手机 App 扫码 → 官方 /remote 页面 ──window_control 连接──▶ relay ──data(app payload)──▶ manager
manager ──MessagePort + sharedHostAttachments──▶ 窗口 Host attachment（workspace bridge）
Host ──platform-method 请求──▶ manager ──relay payload──▶ 手机页面 ──response──▶ 回传
main ──WebRemoteControlStatusChanged──▶ renderer（dialog/trigger 状态）
renderer ──SyncWebRemoteControlWorkspaces/Tasks──▶ main（manager 缓存，桥接切换用）
手机点 reconnect ──WebRemoteControlReconnectWorkspace──▶ renderer ──结果回传
```

## 状态所有权

- 远控生命周期（device 注册、pairing、socket 状态、workspace/task 缓存）：manager（main 进程）。
- Host attachment 与 workspace bridge：窗口 Host；手机复用同一 attachment，不另起 Agent。
- 二维码/sid/passHash：settings + credentialService。
- UI 只展示状态与发起操作，草稿态不参与全局远控状态判定（Root 轮询真实 status）。

## 验收场景

1. 桌面点开 trigger → 弹 QR 对话框；relay 连接后二维码含 sid/hash；status 变化实时同步 dialog/trigger。
2. 手机扫码 → 页面加载桌面 workspace；task 列表与桌面一致（含 pinned/archived）。
3. 手机切换 workspace / 打开 task → 桌面窗口 Host 完成 bridge，手机看到真实会话。
4. 手机断连/relay 抖动 → 状态恢复提示，bridge 超时失败给出可读失败原因。
5. endpoint 切换 → 在飞远控挂起，重开后新二维码。
6. android App：扫码打开官方 `/remote` 页面；debug 包可用 localhost/局域网；最近链接持久化。
7. 普通 Web 模式（`?remote=` server 模式）与桌面不受影响：未开启远控时 task 同步不订阅整表。
8. 真机端到端（扫码 → 连接 → 操作）需官方 relay 与手机，**未在本机验证**；本机只做类型、
   lint 与结构冒烟。

## 未移植 / 已知边界

- 官方 `packages/share-ui`、`packages/web-share`（会话分享）与手机端 OSS 托管页面不在本仓库。
- `packages/android` 需 JDK 21 + AGP 9.2.1 构建，本机无 Android SDK，**未构建验证**。
- relay 服务端为官方基础设施；自部署需另行部署 relay 与 OSS 页面。
- 官方 v3.15.1 的 test endpoint 独立 relay 分支未移植（属 test endpoint 特性）。
