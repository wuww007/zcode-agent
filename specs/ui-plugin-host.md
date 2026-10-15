# 插件 UI 宿主 / Gen UI（UI Plugin / MCP Apps）

移植自官方 v3.15.1（`@modelcontextprotocol/ext-apps@2.0.0` 生态）。本地在 v3.14.3 基线上按功能摘取：**仅支持桌面本地工作区**，web 与手机远控没有沙箱宿主，插件 UI 直接回退为普通 MCP 工具卡片。

## 产品规则

1. 插件可携带可交互页面：MCP 工具结果经 `_meta.ui.resourceUri`（`ui://` scheme）带上 HTML 页面，会话侧栏可打开该插件的 surface 面板。页面与宿主的通信走 MCP Apps 规范（`@modelcontextprotocol/ext-apps` 的 `App` 客户端）。
2. **能力边界**：只有桌面端提供 `IPlatformService.pluginSandbox`；缺省时（web / 手机远控 / 远程 workspace）`PluginUiToolCallBlock` 渲染普通 MCP 卡片，不出现沙箱 webview。
3. Gen UI（`apps/zcode-cli/packages/visualize-plugin`）是内置示例插件：经插件市场安装后，模型产出 `ui://` 工件时在会话内渲染交互视图，并提供 Tweak 面板改样式后回送。
4. 沙箱页面运行在独立 Electron partition（`plugin-sandbox:<id>`）与 `zcode-sandbox:` 自定义 scheme 下，资源级 CSP 四类域（connect/resource/frame/baseUri）由插件 `_meta.ui.csp` 声明，宿主合并白名单后下发给 guest；未声明的域默认拒绝。
5. 页面不经 Node/contextBridge：preload 只把 main 送来的 MessagePort 组转交受信 relay shell，`window.zcode` / `window.openai` 别名脚本由 `plugin-sandbox://` 同源服务。

## 四层架构（状态所有者与调用方向）

```
shared/mcp-apps（契约 + schema）
  ↑ consumers
cli/bootstrap/zcode-protocol/mcp-ui（agent 侧协议处理器）
  ↑ ZCodeProtocol 方法（mcp/uiOpenInstance … mcp/uiResolveAppToolCall）
services/plugin-ui-bridge + gen-ui（host 侧服务：校验/登记/配额）
  ↑ RPC（IZCodeAgentService.mcpUi* / pluginUi* 方法）
desktop/main/pluginSandbox（webContentsView 沙箱宿主）+ host/pluginSandbox（登记桥）
  ↑ IPC（plugin-sandbox-register-request/result + MessagePort）
ui/plugin-ui + gen-ui（renderer 宿主：卡片、侧栏、Provider）
```

1. **shared 契约层**（`packages/shared/src/mcp-apps/`）：resourceUri/CSP/sampling/appTools 的 schema 与归一化函数；`buildMcpAppsClientCapabilities()` 供 adapter 宣告 `extensions["io.modelcontextprotocol/ui"]`。协议方法名与参数 schema 登记在 `zcode-protocol/index.ts` 的 `zcodeProtocolMethods` 与 `zcodeProtocolSessionMethodContracts`。
2. **agent 侧处理器**（`bootstrap/src/zcode-protocol/mcp-ui/`，17 文件）：实例凭据（`McpUiInstances`，按 workspace+session+scopeId+generation 隔离，appIdentity 决定存储身份）、session access（归属校验走会话冻结 catalog）、sampling / appTools / notifications 三个信箱。**页面实例凭据与连接代际的唯一 owner 在 agent 进程**；host 侧只做校验与转发，不保存沙箱或会话事实。
3. **host 侧服务**（`packages/services/src/plugin-ui-bridge/` + `gen-ui/`）：`IPluginUiBridgeService`（打开/校验/回收/关闭实例、资源与工具调用代理、surface 列表）、`IPluginUiSamplingService`、`IPluginUiAppToolsService`、`IGenUiService`。`ZCodeApp` 新增 `readMcpResource / callMcpToolForUi / sampleModel / replaceMcpAppProvidedTools / listPluginUiSurfaces` 等方法，全部走 session 自己的 `mcpPort`。
4. **沙箱宿主**（`packages/desktop/src/main/pluginSandbox/`）：webContentsView + guest CSP + 资源配额 + 权限门（camera/microphone/geolocation/clipboardWrite 由资源 `_meta.ui.permissions` 声明）。`host/pluginSandbox` 只持 pending 传输（request/result 关联），宿主退出即 reject 全部未完成登记。
5. **renderer 宿主**（`packages/ui/src/plugin-ui/` + `gen-ui/`）：`PluginUiSessionProvider` 在 SessionPane 边界注入 scope 与命令入口；`ToolCallBlockRenderContext.pluginUi` 把"在侧栏打开"回调带进工具卡渲染上下文。

## 关键接口与约束

- **MCP 适配器**（`adapters/src/mcp/index.ts`）：新增 `readResource / listResources / listResourceTemplates / subscribeResource / unsubscribeResource / unsubscribeResourcesBySubscriber`，与 `callTool` 共用同一条连接等待与断连重连骨架（`resolveConnectedRecord`）。订阅按 `(serverName, uri)` 引用计数：0→1 才真订阅、1→0 才退订、断连重连后按登记表重放（`McpResourceSubscriptionRegistry`）。`toolListRevision()` 累计 `tools/list_changed` 次数，runtime 回合开始前比较后重拉。
- **工具可见性**：`resolveMcpToolVisibility` 是唯一实现（`descriptor.visibility → ui.visibility → 两者都可见`）。不含 "model" 的工具仍进 registry 复用元数据，但 `providerVisible: false` 不进 provider contracts；不含 "app" 的工具拒绝 `mcp/uiCallTool`。
- **App-Provided Tools**：页面 `tools/list` 结果整体替换本会话暴露集（`app__` 前缀，不覆盖内置/MCP 工具）；模型调用经实例信箱（`mcp/uiRegisterAppTools` / `claimAppToolCall` / `resolveAppToolCall`）到达渲染端，认领与回传按 callId 幂等，信箱投递走 v4 live 增量 `pluginUi.appToolCall`。
- **连接固定**：页面写操作固定持有 `{ identity, generation }` 连接快照；审批期间连接被替换时执行前二次校验，不一致即拒。`appConnectionSnapshot` 由 canonical 化的 server 配置哈希派生，凭据不进入协议或日志。
- **v4 协议**：`pluginUi.resourceUpdated / resourceListChanged / appToolCall / instanceClosed` 四个 live-only delta（`shared/zcode-protocol-v4/delta.ts`），只在 delta 帧应用后触发旁路监听，不进快照、不改行；`conversationProjectionStore.onLiveDeltas` 是唯一订阅入口。

## 验收场景

1. 桌面安装带 `ui.surfaces` 的插件 → 工作区侧栏出现面板入口 → 打开后沙箱 webview 渲染 `ui://` HTML；同一资源在 web/手机远控下渲染普通 MCP 卡片。
2. MCP 工具结果带 `_meta.ui.resourceUri` → 工具卡展示插件 UI 卡片（`TID_PLUGIN_UI_CARD`）→ 可"在侧栏打开"（`TID_PLUGIN_UI_OPEN_SIDE_PANE`），webview 带 `TID_PLUGIN_UI_WEBVIEW`。
3. 资源订阅：页面订阅的 `ui://` 资源在 MCP server 侧更新 → agent 经 `routeMcpServerNotification` 拆成会话级 live 增量 → 页面收到新内容；断连重连后订阅按登记表重放。
4. 页面 sampling：页面发起 sampling → 走会话模型与认证、不创建 turn、`model_usage` 记账 querySource=`mcp_app_sampling`；取消先于 admission 到达时留下终态，旧请求后到达不执行。
5. App-Provided Tools：模型看到 `app__` 工具 → 调用经信箱到页面 → 认领后页面执行并回传；取消时只有一个终态结果。
6. CSP：资源声明的 connect 域之外发起网络请求被 guest 拦截；未声明 permissions 的媒体能力请求被拒绝。

## 已知限制（如实记录）

- 官方 desktop e2e（`gen-ui-e2e.mjs` / `mcp-apps-host-e2e.mjs` 的 fixture 用例）未在本次移植中执行，留待桌面端人工冒烟。
- `visualize-plugin` 的 vendored 运行时资产与 `runtime-manifest.json` 一致性由 `gen-ui-runtime-assets.test.ts` 锁定；完整 APK/E2E 之外的沙箱真机链路（真实插件市场安装 → 触发生成）需 `pnpm dev:desktop` 手动验证。
- MCP elicitation（server → client 提问）与本功能共用 adapter 端口类型，但端口实现未移植（官方独立特性），server 的 `elicitation/create` 会收到 method not found。
