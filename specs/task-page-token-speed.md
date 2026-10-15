# Spec：任务页显示当前 token 生成速度

## 问题

1. 任务页（v4 会话主视图）只在 composer 工具条展示 context 用量，用户看不到「本轮生成有多快」。
2. 流式期间拿不到精确 token 计数：AI SDK `finish` chunk 才汇总 usage，provider 协议中
   Anthropic/OpenAI 兼容层也只在流尾给 usage，`ModelStreamingPayload` 只有
   `delta/done/kind`，不带 token 数。
3. 精确 TPS 计算已存在但只服务开发者工具：`calculateOutputTps`
   （`packages/shared/src/session-debug.ts`）由 CLI `observeSessionDebug` 在
   `model_request_completed` 时计算，UI 侧仅 `DeveloperToolsPane` 每 1s 轮询展示。

## 方案概述

两段式，两个事实源各自负责自己的边界：

- **流中（实时估值，UI 侧）**：投影 store 在每个 delta 帧 apply 时喂
  `GenerationSpeedTracker`，按「流式追加的字符数 → token 估算」做 3s 滑动窗口速率；
  显示为 `≈52 tok/s`。
- **每个主请求完成后（精确值，CLI 侧）**：v4 投影在 `model_request_completed`
  事件上复用共享 `calculateOutputTps` 计算，写进会话 `usage.lastRequest`。
  该字段当前**没有 UI 消费方**（见展示规则），保留为投影侧 usage 事实供后续使用
  （例如「hover 看上次速度」）；若确认不再需要，连同 `lastRequestUsageDelta`、
  schema 与投影单测一并清理。

展示规则：**只有正在输出 token 时指示器可见**——生成中显示 `≈N tok/s`（滑动窗口估值），
其余一切情况隐藏（不显示 0，也不显示上一次请求的速度）。

## 状态所有权

| 状态                         | 所有者                                        | 说明                                                        |
| ---------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| 精确 TPS（每主请求）         | v4 投影 `usage.lastRequest`                   | 由 `model_request_completed`（`querySource=main_turn`）推导 |
| 流中估算速率                 | UI `GenerationSpeedTracker`（store 实例字段） | 纯派生视图值，不持久化、不进协议、不跨进程                  |
| 每行已计入字符数（行内账本） | 同上 tracker                                  | 仅用于 upserted 差分，防重复计数                            |
| 读数可见性（estimate/隐藏）  | `GenerationSpeedIndicator`                    | 只读 tracker 估值 + `control.phase`，不新增存储             |

同一公式两处消费（开发者工具 round 与 `usage.lastRequest`）都调用共享
`calculateOutputTps`，不各自实现。

## 协议变更（additive）

`SessionUsageState`（`packages/shared/src/zcode-protocol-v4/snapshot.ts`）新增可选键：

```ts
lastRequest?: {
  outputTokens: number;
  generationDurationMs: number; // durationMs − timeToFirstContentMs
  tokensPerSecond: number;
  completedAt: number; // epoch ms（事件时间）
};
```

- 键级整体替换语义不变：投影只在 `model_request_completed` 与 `ModelComplete`
  两处构造 usage 补丁，后者必须显式保留 `lastRequest`。
- 冷恢复不种子化该字段（`SessionUsageSeed` 不扩展）：历史任务是旧事实，
  打开历史会话不显示速度，直到本进程内产生新生成。
- 旧客户端收到未知键按既有 strip 语义丢弃，无需版本门。

## 估算口径（流中估值）

- 字符计数只取模型输出两类流式路径：
  - `row.delta` `path="text"`（assistantText / reasoning 行，含思考）；
  - `row.delta` `path="inputText"`（toolCall 行的工具参数）。
  - **排除** `output.text`（工具执行输出，非模型生成）与 `summaryText`（子代理输出，
    与精确值 `main_turn` 口径不一致）。
- 换算与 CLI 上下文计量同源：`estimateTokensFromText`（中文 ×2 权重 ÷ 3，
  常数 `ESTIMATED_TOKEN_CHAR_DIVISOR`）；窗口聚合用字符计数变体，避免逐 delta
  `ceil` 的累积偏差。
- CLI 侧合并器（`coalesceConversationDeltas`）可能用 `row.upserted` 吞掉同批
  `row.delta`，因此 upserted/appended 按行做「新长度 − 已计入长度」正差分补齐；
  `row.removed(fromRowId)` 清掉 ≥ fromRowId 的行内账本。
- 窗口：3s 滑动；`elapsed = now − max(窗口内首样本时刻, now − 3s)`；
  不足 400ms 或窗口内估算 token < 5 → 无估值（不显示），避免开流瞬间的尖峰数字。
- 不缓存、不持久化、不参与会话状态；`sample()` 只在 UI 渲染时按当前时刻计算。

## 事件顺序

```
流中估值（UI，单进程）:
CLI publisher ──delta 帧──▶ ConversationProjectionStore.applyFrame
                              ├─ applyConversationDeltas（既有）
                              └─ tracker.observeDeltas(appliedDeltas, monotonicNow())
                                        ▲
GenerationSpeedIndicator（250ms tick，仅 phase=running）
   └─ tracker.sample(now) → ≈N tok/s

精确值（跨进程，事件驱动）:
adapter ──model_request_completed(usage, durationMs, timeToFirstContentMs)──▶ core 事件流
   └─ v4 投影 onModelNetworkStatus（querySource=main_turn）
        └─ calculateOutputTps → state.updated{ usage{ ..., lastRequest } }
             └─ UI snapshot.usage.lastRequest → 指示器直接显示
```

## 展示规则

- 位置：
  - 可输入会话（主任务页）：composer 工具条 context usage 左侧（`data-variant="composer"`）。
  - 只读 pane（子代理会话观察视图，`readOnly` 的 SessionPane，无 composer）：
    会话头部 chrome 槽位（`ConversationHeader` 的 trailing，`data-variant="header"`，
    带卡片底以保证悬浮在滚动内容上的可读性）。宿主只在 `readOnly` 时挂载，
    避免与主 pane 工具条读数重复。
- **可见性 = 当前输出速度非零**：只有正在输出 token 时才渲染。
  - 生成中且窗口内有样本：`≈{tps} tok/s`。
  - 其余一切情况（未运行、工具执行间隙、等待首 token、轮次结束、用户 Stop、
    失败、草稿、历史任务冷开）：**不渲染**——既不显示 0，也不显示上一次请求的速度，
    避免把过期数字冒充当前速度。
- 父子会话各算各的：父会话读数只含父模型自身输出（子代理输出在父投影里是
  `subagent` 行的 `summaryText`，被排除）；子代理观察视图读的是 child session
  自己 store 的 tracker，两者互不影响，可同时出现（分屏）。
- 最近一次请求的精确速度（`usage.lastRequest`）当前没有 UI 展示位；开发者在
  DeveloperToolsPane 仍可看精确 TPS 表。
- 切换任务：指示器跟随 store 实例（SessionLease）切换，旧 store 的样本不串台。
- e2e 锚点：`data-testid=TID_V4_GENERATION_SPEED`、`data-variant`（composer/header）、
  `data-tps`（估算值）；元素存在即「生成中」，消失即「无输出」。

## 失败语义

| 场景                             | 行为                                                            |
| -------------------------------- | --------------------------------------------------------------- |
| `usage.outputTokens` 缺失 / 非法 | `calculateOutputTps` 返回 null → 不写 lastRequest（协议侧事实） |
| `durationMs ≤ TTFT` / 缺时间     | 同上                                                            |
| 流中断 / 用户 Stop               | 窗口样本自然衰减到空 → 指示器隐藏                               |
| 断线重订阅 snapshot              | 快照行只播种行内账本（不计入生成），窗口样本自然过期            |
| 工具执行/等待间隙（无新 delta）  | 估值衰减消失 → 指示器隐藏，不显示上一请求速度                   |
| 子代理/委员会/标题生成请求       | summaryText 不计入估值；非 main_turn 不进 lastRequest           |

## 验收场景

1. 发起一轮对话，流式期间 composer 工具条出现 `≈N tok/s` 并随生成节奏更新。
2. 输出停止（请求完成、工具执行间隙、等待首 token、用户 Stop、失败）后指示器隐藏，
   不残留过期的高速数字。
3. 一轮多个模型步骤（工具调用间隔）：步骤间指示器隐藏，新步骤开始流式后重新出现。
4. 新任务草稿（draft/prewarm）与历史任务冷开：不出现指示器。
5. 切换任务：不显示上一任务的残留读数；新任务生成中显示新任务估值。
6. 长思考（reasoning）阶段速率包含思考 token；工具参数生成阶段速率包含 inputText。
7. 打开子代理观察视图（只读 pane）：子代理生成中头部出现 `≈N tok/s`（`data-variant="header"`），
   停止后消失；主任务页工具条的读数不受子代理影响。
8. `pnpm typecheck` / `pnpm lint` 通过；tracker 单测（窗口、upsert 差分、行删除、
   路径过滤）通过。
