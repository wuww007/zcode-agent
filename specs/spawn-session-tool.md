# Spec：SpawnSession 工具（模型一键拉起平级任务会话）

## 问题

当前模型只能通过 Agent 工具派生子 agent。子 agent 是当前任务的**子级**：受限运行时
（`subagents.enabled=false`、无 Cron/OffPeak、默认 maxTurns、结果回流父会话），不是与当前任务
对等的会话。用户希望模型能"一键拉起多个与当前任务平级的新任务会话"——即完整的、独立的
`interactive` 会话，各自运行、用户可在任务列表中查看和接管。

宿主层本就支持一个 CLI 进程承载 N 个 session（`context.sessions` 注册表 + GUI `createSession`
命令链路），本变更把该能力以工具形式暴露给模型。

## 产品规则

1. 模型在会话内调用 `SpawnSession` 创建平级任务会话；一条消息内可并行调用多次（`concurrentSafe`）。
   可选 `workspace` 指定目标项目：缺省=父会话工作区（本地链路直达）；传其他本地路径时**必须是
   用户最近打开过的项目**（白名单=宿主 settings 的 `recentProjects`，全局有序、上限 10 条），
   经宿主反向 RPC（`spawnPeerSession`）路由到目标工作区的 CLI 进程创建——不允许多 CLI 进程
   模型任意指定路径（宿主是白名单唯一裁决者；不在名单返回业务错误并回带可选列表供模型自修复）。
   远程工作区暂不支持跨区 spawn（记为 non-goal）。
2. 平级会话 = 完整 `interactive` 会话：空白历史，工具传入的 `prompt` 作为首条用户输入立即开跑；
   继承父会话的 workspace / 协作模式 / 模型。可选 `title` 覆盖标题；缺省沿用 first_input 标题
   （派生会话不做二次自动命名，与 fork/副屏同规则）。
3. **结果不回流**：父会话不收到任何通知或事件；工具同步返回新 `sessionId` 后即结束。
   新会话经既有 `sessions-index` 推送出现在侧栏任务列表，用户自行点开查看。
4. **禁止递归**：注入门看 `parentSessionId`——派生会话（spawn 拉起、fork、selection side chat）
   一律不注入 `sessionSpawnPort`，`subagent_child` 同样不暴露（注册层双保险）。parentID 已持久化，
   冷恢复（resume）后派生会话不会重新拿到该工具；只有根会话能拉起平级任务。
5. **审批**：`needsApproval: true`，build 模式逐次弹确认；用户可 always-allow 获得真正一键体验。
   plan 模式下按既有权限规则拒绝（非只读副作用工具）。
6. UI 不自动开 pane；仅任务列表出现（`sessions-index` 现有行为，零额外 UI 联动）。

## 状态所有权

| 状态                    | 所有者                                                                        | 说明                                                               |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 新会话 record / 事实    | CLI `context.sessions` + sqlite session store                                 | 唯一事实源；与 GUI 手动新建会话完全同构                            |
| 首条输入 admission 账本 | `session_input`（`admitInputCommand`）                                        | 复用既有 durable 账本，崩溃可收口                                  |
| 父会话持有的知识        | 仅工具返回值里的 `sessionId` 字符串                                           | 父会话不维护子会话状态，无同步、无监听                             |
| spawn 来源标记          | createSession payload `spawnedFromParentSessionId` → record `parentSessionId` | 协议层 carrier；防递归的生效判据是持久化的 parentID（resume 存活） |

## 接口

### 工具（模型面）

- 名称：`SpawnSession`（`SPAWN_SESSION_TOOL_NAME`，contracts `tools/spawn-session.ts`）
- 输入：`{ prompt: string(min 1), title?: string, workspace?: string(本地项目路径) }`
- 输出：`{ sessionId, message }`；`message` 字段明确告知"已创建并开始执行；该会话独立运行，
  不会通知本会话；可在任务列表查看"（默认 JSON 序列化进 tool result，无 formatModelContent）
- 元数据：`readOnly: false`、`concurrentSafe: true`、`needsApproval: true`、
  `sideEffectScope: "session"`、`timeout: none`

### 端口（core ↔ bootstrap）

`SessionSpawnPort`（contracts `interfaces/session-spawn.port.ts`）：

```
spawn({ parentSessionId, prompt, title?, model?, workspace? }, { signal? }) → { sessionId }
```

bootstrap 实现（`zcode-protocol/session-spawn-port.ts`）：

- **同工作区**（`workspace` 缺省或等于父记录 workspacePath/workspaceKey）：合成 v4 `createSession` 信封
  （`sessionId: null`、`firstInput.text = prompt`、`spawnedFromParentSessionId = parentSessionId`、
  `config.mode/modelSelection` 取父记录当前值），走本进程 `gateway.handleCommand` 全链路
  （CommandInbox 幂等 → createSession handler → `createSessionRecordForV4` → `admitInputCommand`
  → `startPromptTurn` 后台起 turn），不复制逻辑。
- **跨工作区**（`workspace` 为其他本地路径，`~/` 前缀先展开）：`context.requestClient`
  调宿主方法 `spawnPeerSession`（timeout 90s），宿主校验白名单后用
  `sendConversationCommandV4(createSession 信封 + firstInput + spawnedFromParentSessionId)`
  在目标工作区进程创建（复用 `createHostCommandEnvelope`，与 bots 的 v4Create 先例同构）；
  可选 `title` 经第二条 `renameSession` 信封 best-effort 覆盖。白名单不含目标时宿主返回
  `{ ok:false, errorCategory:"workspace_not_recent", allowedWorkspaces }`，端口翻译成业务错误。

### 协议

`createSession` payload 新增可选 `spawnedFromParentSessionId: string`（additive，旧 CLI 静默丢弃，
fail-closed——旧行为是创建普通会话并暴露工具，见"兼容性"）。

## 事件顺序

```
模型 (父会话 turn)
  │ tool_call: SpawnSession { prompt, title? }
  ▼
spawn-session handler (core/tool/handlers)
  │ context.sessionSpawnPort.spawn(...)   ← 端口缺席 = ConfigurationError
  ▼
createProtocolSessionSpawnPort (bootstrap)
  │ 合成 CommandEnvelope(createSession, sessionId=null,
  │   payload { workspaceId, firstInput, spawnedFromParentSessionId })
  ▼
gateway.handleCommand → CommandInbox → createSession handler
  ├─ createSessionRecordForV4：注册 record（parentSessionId 指向父）
  │    createRecord 见 parentSessionId → 不注入 sessionSpawnPort（防递归）
  ├─ sessions-index fanout → 侧栏出现新任务
  ├─ admitInputCommand（durable 账本）
  └─ startPromptTurn → 后台独立 turn（不阻塞父 turn）
  ▼
返回 { sessionId, message } → tool result → 父模型继续
```

## 验收场景

1. 主会话一条消息并行调用两次 `SpawnSession`：两个新会话出现在侧栏任务列表，各自独立执行，
   互不阻塞，父 turn 不被挂起。
2. spawn 出的会话是完整 interactive 会话：无副屏限制命令集、可被用户点开继续对话/停止/删除。
3. spawn 出的会话的工具面没有 `SpawnSession`（递归禁止）；`subagent_child` 也没有。
4. build 模式下每次调用弹审批确认；always-allow 后不再弹。plan 模式下拒绝执行。
5. spawn 完成后父会话不出现任何 `<task-notification>` 或其他自动消息。
6. 新会话继承父会话 workspace、协作模式与当前模型；标题缺省沿用 first_input 标题
   （显式传 `title` 时走 renameSession 覆盖）。
7. 工具调用失败（如 gateway 不可达）时返回错误而非静默成功；重复重试产生独立新会话
   （commandId 每次新建，不跨重试去重——与 GUI 每次点"新任务"语义一致）。
8. 跨区 spawn：`workspace` 传最近打开过的项目路径 → 新会话出现在**该项目**的任务列表、
   parentID 指向发起会话、继承模型；`workspace` 传不在 recentProjects 的路径 → 工具返回
   业务错误且错误文案携带可选项目列表；同区 spawn 行为与既有验收完全一致（不经过宿主）。

## 保持不变 / Non-goals

- 结果回流通知、中途进度查询工具（用户明确不要）。
- spawn 会话加入 automation/offpeak 派发轮 denylist（cron prompt 主动 spawn 属用户显式配置，
  一跳扩张可控；记为后续可选加固）。
- 自动开 pane。
- 兄弟会话间通信。
- 任务列表对 spawn 会话的专属文案：spawn 会话带 parentID，列表在标题缺失时会复用
  "fork 的未命名任务"措辞（`taskList.forkedUntitled`）；因 first_input 标题通常在场，接受现状。

## 兼容性

- `spawnedFromParentSessionId` 是 additive 字段：旧 CLI 收到后静默丢弃 → 创建出的会话会暴露
  `SpawnSession`（递归失效但功能正常）。新 CLI 收到旧端信封（无字段）→ 正常创建（GUI 路径不受影响）。
- TUI / headless 不注入 `sessionSpawnPort`（端口在场即工具在场，同 Cron/OffPeak），行为不变。
