# Spec：OpenCode Go 套餐模型目录动态同步

## 问题

1. `config/provider/zcode-builtin.json` 中 `opencode-go-chat / opencode-go-messages / opencode-go-responses`
   三个模板的 `builtinModelIds` 是静态清单（当前 revision 30，共 25 个模型）。Go 套餐模型增删频繁
   （实测线上 `/models` 已出现 `longcat-2.0`、`muse-spark-1.3-contributor` 等未收录模型），用户必须等
   App 发版 + 服务端 revision 递增才能看到新模型。
2. 静态清单不反映账号当前实际可用性：套餐下线的模型仍显示可选，直到调用报错才被发现。

## 目标 / 非目标

目标：

- 已配置 Go API key 的用户，模型选择器展示该套餐**实时全量**模型：新增自动出现，下线自动标记。
- 无网络 / 无 key / 响应异常时优雅降级到静态清单或上次缓存，不阻塞选择与调用。

非目标（本期不做，设计保留兼容）：

- OpenCode 账号 OAuth 登录（沿用现有 API key 手动配置 + `apiKeyManagementUrl` 引导）。
- 用量 / 额度展示（`GET /zen/go/v1/usage` 可作为后续增强）。
- Zen 免费目录的自动发现（`zen/v1/models` 无需认证，接入时复用同一 Source，参数化 endpoint + auth）。

## 数据源与接口

- 端点：`GET {baseUrl}/models`，即 `https://opencode.ai/zen/go/v1/models`（三个模板共用同一 baseUrl）。
- 鉴权：`Authorization: Bearer <用户已配置的 Go API key>`（OpenAI 风格；messages 调用仍按协议用 `x-api-key`，与本发现请求无关）。
- 响应结构（已实测 zen 侧 200 返回；Go 侧持真实 key 验证后如有出入再修订）：

  ```json
  {
    "object": "list",
    "data": [{ "id": "glm-5.3", "object": "model", "created": 0, "owned_by": "opencode" }]
  }
  ```

  关键事实：**响应不含协议族（chat/responses/anthropic）、不含 contextWindow 等元数据**——因此静态目录必须继续作为「协议归属 + 元数据」的权威来源，动态发现只提供「id 存在性 + 新鲜度」。

- 解析：zod 宽松校验，仅采信 `data[].id`（trim 后非空、去重）；其余字段忽略。`data` 为空数组视为异常响应，不应用（防误清空）。

## 方案概述

分层复用现有 provider config 架构（builtin → account → personal 三层 overlay）：

- **基线层（质量）**：现有 bundled JSON + zcode 远端 release（revision 递增）继续负责协议归属、
  模型元数据、显示名、排序。服务端运营更新仍是「已知模型的元数据修正」通道。
- **新鲜度层（增量）**：新增 **OpenCode Catalog Source**（实现放 `packages/provider-node`，与
  `ZCodeBuiltinRemoteSynchronizer` 同模式），用用户已配置的 key 定期拉取 `/models`，产出
  「动态目录快照」，在 `ProviderConfigService` 作为一层 overlay 参与合并。
- 目录 = 静态 ∪ 动态，合并规则见下节。

### 目录合并规则

1. 静态目录中的 id 在 `/models` 中**仍存在** → 行为不变（协议族、元数据、排序均以静态为准）。
2. 静态目录中的 id 在 `/models` 中**缺失** → option 保留但置 `disabledReason: "套餐已下线"`，
   不删除；选中它的进行中会话走既有 `sessionModelTransition`（registryFallback）自动迁移。
3. `/models` 中**新增** id：
   - 命中已知协议映射（静态目录本身即 id→协议族的映射表）→ 挂到对应协议族模板实例，元数据按静态规则补齐。
   - 未知 id → 默认挂到**同 endpoint 的 `openai-chat-completions` 模板实例**（Go 套餐中该协议
     占比最高、最通用），元数据用保守默认值（不虚构 contextWindow），`description` 标注
     「自动发现」，并通过 additive 协议字段 `origin: "discovered"` 供选择器渲染徽标。
   - 用户可在设置页把该 id 手动加入其他协议族的 provider 卡（personal overlay 已支持，
     personal 优先级最高，永不被动态目录覆盖或删除）。
   - 仅挂到**用户已创建**的实例；未创建对应协议族实例时不展示（设置页 provider 卡可提示
     「发现 N 个模型属于 OpenCode Go (Chat)，一键添加」作为可选增强）。
4. 同一 id 命中多个协议族实例时以静态归属为准；跨协议调用失败属用户配置问题，
   由既有 `providerTestModelConnectivity` 人工验证兜底。

### 同步调度与缓存

| 项         | 规则                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 成功 TTL   | 1 小时（对齐 `ZCodeBuiltinRemoteSynchronizer.successIntervalMs`）                                                                                         |
| 失败退避   | 指数退避（复用既有 synchronizer 行为）；429 尊重 `Retry-After`                                                                                            |
| 触发时机   | ① `provider-config-runtime` 既有 60s 调度 tick；② 该 provider 卡 key 保存成功后立即刷新；③ 设置页打开时 stale-while-revalidate；④ provider 卡「刷新」按钮 |
| 多进程去重 | lease 控制文件（同 zcode-builtin-refresh 模式）：desktop Host / CLI Worker / CLI standalone 同机只允许一个持有者拉取，结果经文件 + 事件共享               |
| 缓存布局   | LKG 文件，按 endpoint + key 指纹隔离（对齐 `zcode-builtin-cache-paths.ts` 的 Endpoint 隔离思路）；离线启动读 LKG                                          |
| key 失效   | 401/403 → 标记 key 失效并**停止轮询**，设置页与 provider 卡明确提示；key 变更后恢复                                                                       |

## 对照路线：服务端 release 自动跟进（零客户端代码）

若 zcode 的 control plane / CDN release 管道可控，可在服务端加定时任务：拉 opencode
`/models` → 按已知映射合入三个模板的 `builtinModelIds` → 递增 revision 推 CDN，
客户端现有 1h TTL 同步自动生效，**客户端零改动**。局限：

- 滞后 = 服务端任务周期 + 客户端 TTL，无法做到账号级「当前可用」事实与即时下线标记；
- 服务端需维护一个真实 Go 订阅 key（Go `/models` 需认证，zen 侧无需）；
- 不在本仓库范围内的改动，依赖度存疑。

结论：两条路线互补不冲突——服务端管道负责**已知模型的元数据质量**（协议归属、
contextWindow、排序），客户端 Source 负责**新模型及时可见与账号级可用性**。本 spec
以客户端路线为主，服务端路线作为既有 release 运营的增强项独立推进。

## 状态所有权

| 状态                                   | 所有者                                                                                           | 说明                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 动态目录快照 / LKG                     | OpenCode Catalog Source（各环境各自持有：desktop Host、远端 Environment 服务端、CLI standalone） | 文件 + 内存单例；只产出快照，不做合并                  |
| 合并后 provider 成员清单与 option 投影 | `ProviderConfigService` → `ProviderRegistryService` → Facade                                     | 唯一合并点；builtin/account/dynamic/personal 顺序固定  |
| Go API key                             | 既有 credential 存储不变                                                                         | 发现请求经与请求期凭据相同的解析路径取 key，禁止落日志 |
| 选中模型 / 会话模型状态                | 既有 session model selection 链路不变                                                            | 本 spec 不改任何选中语义                               |
| 「自动发现」徽标渲染                   | Renderer（`modelSelectionGroups` / badge）                                                       | 只读投影，无本地状态                                   |

## 协议变更（目标：零破坏，仅一处 additive）

动态目录全部在 provider config 层消化：UI 经既有 `ModelSelectionView` + `onDidChange` 广播获取，
CLI Worker 经既有 env 配置文件 + `provider/updateAccountConfig` 推送获得同一目录，**不新增协议消息**。

唯一 additive 变更：`zcodeModelOptionSchema` 增加可选 `origin?: "builtin" | "discovered"`，
旧发送端缺省视为 `"builtin"`。仅用于 UI 徽标，不参与任何路由/准入判断。

## 双链路与多环境

- **desktop-continuous**：Host 进程内 Source 持有快照并参与合并，renderer 经 RPC 投影订阅刷新。
- **web-remote-replayable**：Provider/Model 事实属于目标 Environment——远端 workspace 由服务端
  （现有注册远端 `IModelSelectionService` 的位置）运行同一 Source；手机端不直接访问 OpenCode，
  复用既有投影刷新。
- **CLI standalone（无 Host）**：`packages/provider-node` 共享实现，与 `zcode-builtin-download`
  同模式直接可用。

## 事件顺序

```
[每个持有 provider registry 的环境内]
provider-config-runtime 60s tick ┐
key 保存成功事件                 ├→ CatalogSource.refresh()
设置页打开(SWR) / 手动刷新       ┘   （lease 持有者执行；非持有者等结果事件）
    → GET /models (Bearer key) → zod 校验 → 与上次快照 diff
    → LKG 落盘 + 内存快照更新 → onDidChange
    → ProviderConfigService 重新合并 (builtin + dynamic + personal)
    → ProviderRegistryService.refresh → Facade onDidChange → RPC event
    → renderer useModelSelectionView 重读 View（revision 守卫）→ 选择器原地更新
并行：CLI Worker 经既有 env 文件 / provider/updateAccountConfig 获得同一目录
失败分支：网络/5xx/格式异常 → 沿用 LKG + 退避；401/403 → 停轮询 + 提示
```

## 失败语义

| 场景                                      | 行为                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| 无网络 / 5xx / 响应格式非法 / `data` 为空 | 沿用 LKG（无 LKG 则仅静态清单），指数退避重试                                     |
| 401 / 403                                 | 停止轮询并标记 key 失效；设置页与 provider 卡提示；key 更新后立即恢复             |
| 动态发现模型调用失败（协议归错等）        | 既有 `providerTestModelConnectivity` 人工验证 + `sessionModelTransition` fallback |
| 静态模型被套餐下线                        | option 置灰标注，不删除；进行中会话 registryFallback 迁移                         |
| key 未配置                                | 不发起发现请求，仅静态清单；`apiKeyManagementUrl` 引导不变                        |

## 验收场景

1. 配置 Go key 后，选择器 OpenCode Go 分组展示 `/models` 全量模型（≥ 静态清单数）；线上新增
   模型在一个 TTL 周期内自动出现，无需发版。
2. 套餐下线某模型：该 option 置灰并标注「套餐已下线」；选中它的会话自动 fallback，无崩溃。
3. 断网启动显示上次缓存目录，联网后自动补拉成功且 UI 原地刷新（无闪烁重排语义变化）。
4. key 失效停止轮询并有明确提示；重新填 key 后立即刷新成功。
5. 未知新模型 id 出现在 chat 族并带「自动发现」徽标；可手动迁移到其他协议族卡并调用成功。
6. 同机 desktop Host 与 CLI Worker 不重复请求 `/models`（lease 去重生效）。
7. 手机远控（replayable）下模型列表与所属 Environment 事实一致，手机侧不直接访问 OpenCode。
8. 协议消息向后兼容：旧版本 CLI / 渲染端在含 `origin` 字段的消息下正常工作。

## 待确认 / 风险

- Go 侧 `/models` 的鉴权头与返回是否严格同 zen 侧一致，需持真实 Go key 实测后冻结 schema。
- 未知 id 默认归 chat 族是启发式，可能归错协议；兜底是连通性测试 + 手动迁移 + 服务端 revision 快速跟进。
- 若 OpenCode 未来在 `/models` 元数据中加入协议 / 上下文长度字段，解析可平滑升级为直接采信，
  届时静态目录退化为纯展示元数据来源。
