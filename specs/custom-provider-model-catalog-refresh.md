# Spec：自定义供应商模型列表刷新

## 问题

1. 自定义供应商（personal provider）的模型列表只能手工逐个添加/删除：用户从供应商文档抄回模型 ID，
   在「添加模型」弹窗里逐条录入。供应商上架新模型、下架旧模型后，本地列表与接口实际能力脱节，
   且没有任何拉取入口。
2. 仓库当前不存在向供应商拉取模型目录的能力：没有任何 `/models` 请求代码，OpenCode Go 模型目录
   同步的 spec 已在 commit `25b39fe` 被主动删除，无实现可复用。
3. Renderer 不能直连供应商网络：`IPlatformService` 没有 HTTP 能力，跨进程能力必须走 RPC service。

## 方案概述

在自定义供应商的「模型」区块标题行增加一个刷新按钮。点击后按该供应商已配置的接口协议拉取最新
模型目录，并以单次原子写合并进本地模型列表：

- 删除本地有、接口没有的模型（连同它的个人配置规则）；
- 添加接口有、本地没有的模型（默认启用，走推荐配置）；
- 已经存在的模型完全不动（成员、顺序、个人配置规则一律保持）。

交互为一步式：点击即拉取并写入，用 toast 汇报增删数量；不做预览确认对话框。

## 状态所有权

| 状态                                              | 所有者                                     | 说明                                       |
| ------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| 供应商接口的模型目录                              | 供应商 HTTP 接口                           | 唯一上游事实源；每次刷新重新拉取，不缓存   |
| `personalModelIds` / `modelOrder` / `models` 规则 | `ProviderConfigService`（personal 层）     | 本地唯一事实源；刷新是唯一批量成员写入口   |
| `builtinModelIds`                                 | 模板/官方基线（`withModelMembershipFrom`） | 保存路径写不进去；刷新不得新增或删除它     |
| 刷新按钮的 pending/禁用原因                       | `InlineEditableProviderCard`               | 仅本次交互的 UI 状态，不持久化             |
| 增删计数（toast 文案）                            | `useModelProviders`                        | 由刷新前后的权威 View 差集推导，不单独存储 |

合并写在 `ProviderConfigService.refreshPersonalModels` 内单次 `#updatePersonal` 完成：成员、
顺序、模型规则同一次 Repository update 提交。不循环调用 `addPersonalModel` /
`deletePersonalModel`——那会每次写文件 + 刷 Registry，且对已存在/不存在的 ID 直接抛错。

## 协议变更（全部 additive）

1. `zcodeProtocolMethods.providerFetchProviderModels = "provider/fetchProviderModels"`。
2. `zcodeProviderFetchProviderModelsParamsSchema`：`{ workspace: zcodeWorkspaceRefSchema,
providerId: string }`，`.strict()`。与 `provider/testModelConnectivity` 同样按 workspace 寻址
   （Registry 是进程级事实，但请求仍需一个 workspace app 承载）。
3. `zcodeProviderFetchProviderModelsResultSchema`：判别联合
   `{ ok: true, models: [{ id }] }` | `{ ok: false, error: { code, message } }`，`.strict()`。
   `code` 取值：`provider-unavailable`（无 baseUrl / 非 api-key 鉴权）、`auth-failed`、
   `unsupported-protocol`、`invalid-response`、`empty-catalog`、`network`、`timeout`。
   错误走结构化返回而非抛出，与 `ModelConnectivityResult` 一致。

协议请求构造（按 `api.type` 三分支，与 `toAiSdkProviderConfig` 同源）：

| `api.type`                | URL                                           | 关键请求头                                                                       |
| ------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| `openai-chat-completions` | `{baseUrl 去尾斜杠}/models`                   | `Authorization: Bearer {apiKey}`                                                 |
| `openai-responses`        | `{baseUrl 去尾斜杠}/models`                   | `Authorization: Bearer {apiKey}`                                                 |
| `anthropic-messages`      | `{normalizeAnthropicBaseURL(baseUrl)}/models` | `x-api-key`、`anthropic-version: 2023-06-01`、兼容网关的 `Authorization: Bearer` |

- `api.headers`（用户自配）最后合并，同名键用户优先；用户已配 `Authorization` 时不覆盖。
- 响应宽松解析：接受 `data[]` / `models[]` / 顶层数组；每项接受字符串或 `{ id }` / `{ name }`。
  空数组视为 `empty-catalog` 失败——不能把用户的本地列表清空。

## CLI（bootstrap / adapters）

- `adapters/src/model/provider-model-catalog.ts`：纯函数式 URL/请求头构造 + 响应解析，
  网络 I/O 经注入的 `HttpClientPort`（复用 `createNodeWebFetchHttpClientAdapter`，已带代理、
  TLS CA、超时、响应体上限与结构化错误码）。
- `ZCodeApp.fetchProviderModels({ providerId })`：从 `deps.providerRegistry.getProvider()` 取
  完整配置（`api.type` / `api.baseUrl` / `api.headers` / `access.apiKey`），调上面的目录函数。
  Registry 读取与连接测试同规：先 `refreshProviderRegistry` 再取，不旁路创建配置事实。
- `workspace-model-runtime.ts` 新增 handler，照抄 `testProviderModelConnectivity` 的
  「先 refresh registry → 找活跃 session 的 app → 否则建 app → 调用 → 关闭临时 app」结构。
- `server.ts` 注册新 case。

## services / provider

- `IProviderSettingsService.refreshProviderModels(input): Promise<ProviderSettingsView>`：
  `ensureReady()` → 经注入的 executor 拉目录 → `facade.refreshPersonalModels(providerId, modelIds)`
  → 返回刷新后的权威 View。executor 未装配时抛错（与 `testModelConnectivity` 同规）。
- `ProviderSettingsFacade.refreshPersonalModels` 走 `#mutateProvider(providerId,
"refresh-models", ...)`，保持同 provider 写串行、刷新后返回权威 View。
- `ProviderConfigService.refreshPersonalModels(providerId, modelIds, membership)`：
  `assertMembershipCurrent` 后，`nextPersonal = 远程目录 \ builtinModelIds`；
  `personalModelIds` 替换为 `nextPersonal`；`modelOrder` 传旧 order（`resolveOwnedOrder`
  自动保留旧序、剔除被删 ID）；`models` 对消失 ID `deleteExact`，对新增 ID
  `setExact(new ModelConfig({ enabled: true }))`（未变 ID 不碰，避免把 inherited 物化）。

## Renderer UI

- 按钮：`ProviderModelsSection` 标题行、「添加模型」左侧，图标按钮（`RefreshCw`）+
  `aria-label`，`data-testid={TID_MODEL_PROVIDER_REFRESH_MODELS_BUTTON}`。仅自定义供应商渲染
  （账号型供应商不出现）。
- 点击链路在 `InlineEditableProviderCard.handleRefreshModels`：先
  `commitPendingDraft("refresh-models")` flush 未保存的 baseUrl / apiKey / apiFormat 草稿，
  否则会用旧值请求（与 `handleTestModel` 同规）。
- 远端/无本地 workspace：按钮禁用并说明原因，沿用连接测试的
  `connectivityWorkspaceRequired` / `connectivityWorkspacePath` fail-closed 判定。
- 反馈：pending →「正在拉取模型列表…」；成功按增删计数分别提示「模型列表已更新：新增 N 个，
  删除 M 个」或「模型列表已是最新」；失败显示服务端 message，可重试。
- 失败不改变本地列表。

## 事件顺序（点击刷新）

```
用户点击 ⟳ → handleRefreshModels
  → commitPendingDraft（落盘 baseUrl / apiKey / apiFormat，等待 Provider 操作队列排空）
  → providerSettingsService.refreshProviderModels({ workspacePath, providerId })
      → ensureReady() → executor.fetchProviderModels(...)
          → CLI: refreshProviderRegistry → app.fetchProviderModels({ providerId })
              → registry.getProvider(providerId) → HttpClientPort.request(GET {url}/models)
              → 宽松解析 → { ok: true, models: [{id}] }
      → facade.refreshPersonalModels(providerId, modelIds)
          → #mutateProvider 串行 → config-service 单次 #updatePersonal（成员 + 顺序 + 规则）
          → mutations.refresh("settings:refresh-models") → getView()
  → useModelProviders commitProviderSettingsView(view)（revision 守卫）
  → UI diff 前后模型列表 → toast 增删计数
```

## 失败语义

| 场景                           | 行为                                               |
| ------------------------------ | -------------------------------------------------- |
| baseUrl 为空 / 非 api-key 鉴权 | `provider-unavailable`，提示先补全连接信息，不请求 |
| 接口返回 401/403               | `auth-failed`，原样透出 message，本地列表不变      |
| 接口返回空数组                 | `empty-catalog`，不清空本地列表                    |
| 超时 / 网络 / 代理失败         | `timeout` / `network`，可重试                      |
| 非三种受支持协议               | `unsupported-protocol`                             |
| 远端会话且无本地 workspace     | 按钮禁用并说明原因，不发起请求                     |
| 个人配置 revision 冲突         | 抛错，toast 提示重试；不局部落盘                   |

## 新模型的参数来源与兜底策略

接口只提供模型 ID。新模型的参数（contextWindow、输入格式、maxOutputTokens、reasoningLevel
等）不在请求里，而由本地规则目录 `config/provider/zcode-builtin.json` 的 `modelConfigRules`
解析得出，与「添加模型」弹窗走同一条链路。规则分五类按序叠加，后命中覆盖先命中：

`modelRules`（模型 ID 正则）→ `modelApiRules`（模型 ID + 协议）→ `providerSiteRules`
（模型 ID + 协议 + Base URL）→ `templateModelRules`（模板 + 模型 ID）→ 个人精确规则。

推荐规则匹配**全串锚定且忽略大小写**（`^(?:pattern)$` + `i`），所以 `.*MiniMax-M3` 能命中
接口返回的小写 `minimax-m3`。

兜底规则是 `modelRules[0]` 的 `modelMatch: ".*"`，每个模型都会命中，是「未被任何专用正则
认识」与「完全没有配置」之间唯一的一层。revision 31 起其取值为：

| 字段                          | 值                    | 理由                                                   |
| ----------------------------- | --------------------- | ------------------------------------------------------ |
| `contextWindow`               | 1000000               | 取当时主流模型的上界量级，避免把长上下文请求误判为超限 |
| `maxOutputTokens.max`         | 128000                | 同上，覆盖大输出场景                                   |
| `inputFormat`                 | 文本 + 图片           | 图文是当前最普遍的能力组合；视频/音频/PDF 仍关闭，保守 |
| `reasoningLevel.values`       | `disabled`、`enabled` | 两档是任何模型都支持的子集，不虚构细档位               |
| `supportsJsonSchemaOutput` 等 | `false`               | 能力位默认关闭，由专用规则显式打开                     |
| `enabled`                     | `true`                | 与「添加模型」一致，新增即可用                         |

兜底值的性质是**保守猜测而非实测**。它只应影响「完全没有任何专用正则认识」的模型。

**关键约束：兜底对所有模型生效，包括在售模板模型。** 调整兜底前必须全量比对
`templateModelRules` 的 modelId、各模板 `builtinModelIds`、`builtinProviderModelRules`
覆盖到的每一个模型的解析值。本次调整（revision 31）就波及了 23 个靠兜底取值的在售模板模型
（openrouter 与 opencode-zen 系列）——它们的 `max_tokens` 会从 32K 变成 128K 且
`turn-model-step.ts` 不做 clamp，`supportsImage` 翻 true 也会让本地图片校验放行。

因此这 23 个模型已用 `templateModelRules` 显式钉回调整前的取值（200000 / 不支图 / 32000），
使兜底调整只作用于真正未知的模型。回归测试
`packages/services/test/builtinModelCatalogFallback.test.ts` 钉住兜底取值、这 23 个模型的
取值、内置供应商模型的取值，以及「未知模型才拿激进值」——以后再调兜底，测试会立刻指出
影响面。待这些模型补齐真实元数据后，钉住规则应被替换成真实值并删除。

鉴权判定用 `isApiKeyAccess()`（同时接受 `api-key` 与 `zhipu-coding-plan-api-key`），与正式
执行链 `toAiSdkProviderConfig` 和 UI 门禁 `isApiKeyProvider` 同判。模板选择器第一项
`zai-api` 用的就是 `zhipu-coding-plan-api-key`，窄化成 `=== "api-key"` 会让从该模板创建的
自定义供应商永远拉不到目录。

目录 URL 必须按 URL 语义拼接（`new URL` 后改 `pathname`）：字符串拼接会把 `/models` 吞进
query（baseUrl 带 `?token=` 时），而执行链把 baseUrl 交给 AI SDK 按 URL 语义处理。
目录请求不跟随重定向（`redirect: "manual"`）：`HttpClientPort` 仅在无代理/无自定义 CA 时
真正 follow，否则走 `node:http` 完全不跟随，同一供应商在有无代理下行为不一致；且 fetch
规范只剥离跨域的 `Authorization`，不剥离自定义的 `x-api-key`，跟随重定向存在 key 外泄风险。

## 验收场景

1. 自定义供应商配置好 baseUrl + apiKey 后点刷新，本地列表与接口一致：新增的模型出现且默认启用，
   消失的模型连同个人配置被删除，已存在模型的顺序与配置不变。
2. 接口返回的目录与本地完全一致时，提示「模型列表已是最新」，不产生可见的列表变化。
3. 接口返回空数组 / 401 / 超时，分别给出对应提示，本地列表保持原样。
4. baseUrl 或 apiKey 为空时点击，提示先补全连接信息，不发出网络请求。
5. 未保存的 baseUrl / apiKey 草稿在点击刷新时被先落盘，拉取使用刚输入的值。
6. 带模板继承 builtin 模型的自定义供应商刷新后，builtin 模型数量与顺序不变，只同步 personal 成员。
7. 手机远控（无本地 workspace）打开模型设置，刷新按钮禁用且能看到原因说明。
8. `pnpm typecheck` 与 `pnpm lint` 通过。
9. 调整兜底规则后，`builtinModelCatalogFallback.test.ts` 全部通过，且全量比对显示
   在售模板模型与内置供应商模型的解析值无变化。
