# Spec：会话切换的锚点滚动恢复（v4 conversation）

## 问题

1. 切回长上下文任务时，订阅首帧只有尾部 60 行快照（`snapshotTailWindowRows`），滚动恢复把记忆的
   绝对 `scrollTop` 钳到当前窗口高度内，恢复位置落在窗口顶附近而非离开时的位置。
2. 恢复依赖 "detached restore" 等 `scrollHeight` 追平离开时的值，但没有任何自动补齐历史的
   路径，长会话永远等不到，位置漂移成为常态。

## 方案概述

滚动记忆从「绝对 scrollTop」升级为「锚定行 + 行内偏移」；订阅支持按锚点行开窗
（anchor window）替代尾部窗口；窗口与实时尾部之间存在间隙时，新增 `loadNewer`
游标分页向尾部渐进补齐。恢复一次落地，不再等待 scrollHeight 追平。

## 状态所有权

| 状态                                                                                    | 所有者                                                     | 说明                                            |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| 滚动记忆（anchorRowId / anchorOffsetPx / scrollTop / scrollHeight / wasPinnedToBottom） | Renderer `chatSessionScrollMemory`（内存 Map，LRU 200 条） | UI 偏好，不进 Host 持久层                       |
| 消息行（rows.window）与 seq 水位                                                        | CLI Host projection                                        | 唯一事实源；renderer 只持窗口投影               |
| `newerCursorRowId`（窗口→尾部补齐游标）                                                 | Renderer `ConversationProjectionStore`                     | 仅锚点快照消费时建立                            |
| `restoreAnchorRowId`（待消费订阅锚点）                                                  | Renderer store 私有字段                                    | 首个 snapshot 应用后清空，只消费一次            |
| 锚点窗口选择                                                                            | CLI Host publisher                                         | `getWireSnapshotForSubscription` 按订阅参数裁决 |

## 协议变更（全部 additive）

1. `rowsWindowSchema.lastRowId: number | null`（default null = 旧发送端未知）：
   当前有效分支最后一行的 rowId。`window` 末行 `< lastRowId` ⇔ 尾部还有未加载行。
   delta 维护：`row.appended` → `lastRowId = max(lastRowId ?? rowId, rowId)`；
   `row.removed` → 整支裁剪置 null，否则 `min(lastRowId, fromRowId - 1)`（rowId 单调）。
2. `subscribeParamsSchema.initialWindowAnchorRowId?: number`：订阅方请求以该行为中心
   开初始窗口（取代尾部窗口）；仅对 conversation topic 有语义，其余 topic 忽略。
3. `v4ConversationRowsRangeParamsSchema.afterRowId?: number`：与 `beforeRowId` 二选一，
   取 `rowId > afterRowId` 的前 `limit` 行（rowId 升序）；`hasMore` 按游标方向判定。

语义不变量（与既有规则一致）：

- 快照 `seq` 始终是全投影水位；锚点窗口只是行选择，后续 delta 帧 `fromSeq === snapshot.seq`
  正常衔接，`row.appended` 推入窗口末尾（与锚点窗口之间可能存在 rowId 间隙）。
- 快照整体替换规则不变：recovery / forceSnapshot 回落为尾部窗口，
  `newerCursorRowId` 同步清空（恢复退化为贴底，可接受）。
- `firstRowId`/`totalCount` 保持全序口径；锚点窗口不改变 `hasOlderRows` 判定。

## Host（publisher / gateway）

- 订阅参数携带 `initialWindowAnchorRowId` 时：可见行全序中定位锚点行（缺失则取第一个
  `rowId >= anchor` 的行；仍无则回落尾部窗口），窗口 = 锚点前后各 `snapshotAnchorWindowRows / 2` 行
  （总量 ≤ `snapshotAnchorWindowRows`，且必含锚点行）。`lastRowId` 用全序口径（截断不改）。
- `rowsRange` 支持 `afterRowId` 游标；只读、无状态、超时重发安全（与 `beforeRowId` 同规）。

## Renderer 数据层（ConversationProjectionStore / SessionDataLayer）

- `SessionDataLayer.acquire(sessionId, { restoreAnchorRowId })`：仅 cold 创建 store 时
  把锚点传入首次 `connect`；warm/keep_warm 复用现有订阅，不重开窗。
- `connect({ restoreAnchorRowId })`：仅当当前无 snapshot（首次订阅）时记录；此后每次
  subscribe 在 `snapshot === null` 期间都携带该锚点（覆盖 cold 订阅重试/换代重连）。
- 首个 snapshot 应用时：若本代订阅携带锚点 → `newerCursorRowId = window 末行 rowId`；
  否则（尾部快照 / recovery）`newerCursorRowId = null`。锚点字段清空。
- `hasNewerRows(snapshot, newerCursorRowId)`：`newerCursorRowId != null && lastRowId != null
&& newerCursorRowId < lastRowId`。
- `loadNewer(limit)`：单飞（`loadingNewer`）；游标 = `newerCursorRowId`；
  `rowsRange({ afterRowId })` 结果按 rowId 去重合入窗口（与已追加的尾部行共存）；
  游标推进到本页末行；空页且 `hasMore=false`（间隙被 rewind 裁掉）→ 游标直接追平 `lastRowId`。
  epoch 不匹配 / 游标失效 → 整批丢弃（与 `loadOlder` 同规）。
- `loadAllNewer()`：循环 `loadNewer` 直到追平或无进展；「回到最新」按钮使用。

## Renderer UI（SessionPane / ConversationTimeline / chatSessionScrollMemory）

保存（用户滚动 / scope 切换 / 卸载）：

- 离底（`wasPinnedToBottom === false`）时额外保存锚点：视口顶命中的虚拟单元（turn）的
  首行 `rowId` 与 `scrollTop - item.start` 偏移。贴底时不存锚点。
- 旧记忆（无锚点字段）继续走既有 clamp 恢复路径，行为不变。

恢复（sessionKey 变化）：

- 记忆带锚点 → 进入 `waitFor: "anchor"` 的 pending 恢复：等 rows 中出现锚点行后，
  `virtualizer.scrollToIndex(锚点单元, align: start)` + 下一帧补 `anchorOffsetPx`；
  连续两次落地 scrollTop 收敛（差 < 1px）或用户滚动即释放；锚点不可达（补拉耗尽）
  → 回落贴底。不做绝对 scrollTop clamp。
- 无锚点 / 贴底 → 维持现状（贴底或旧 clamp 路径）。

间隙补齐：

- 用户滚动接近窗口底部且 `hasNewerRows` → 自动 `loadNewer`（与顶部预取对称）。
- 「回到最新」按钮：`hasNewerRows` 时先 `loadAllNewer()` 再贴底（跟随态交给既有
  底部锚定 effect），否则维持直接贴底。

## 事件顺序（切回会话）

```
setActiveTaskId → SessionPane acquire(sessionId, {restoreAnchorRowId})
  → [cold] store.connect(subscribe + initialWindowAnchorRowId)
  → Host 构建锚点窗口 snapshot（seq = 全投影水位）
  → renderer 应用 snapshot（newerCursorRowId = 窗口末行）→ Timeline 渲染
  → pending 恢复等锚点行出现 → scrollToIndex + 偏移 → 收敛释放
并行：Host delta 持续推送 → seq 衔接 → row.appended 入窗口尾部（间隙保留）
用户向下滚动近底部 → loadNewer 翻页 → 间隙闭合 → 回到既有尾窗语义
```

## 失败语义

| 场景                               | 行为                                                     |
| ---------------------------------- | -------------------------------------------------------- |
| 锚点行已被 rewind/compact 裁掉     | Host 取第一个 `rowId >= anchor` 的行；窗口为空则回落尾部 |
| recovery / forceSnapshot 替换快照  | 回落尾部窗口 + 贴底（`newerCursorRowId` 清空）           |
| 锚点补拉耗尽仍无锚点行（renderer） | 释放 pending，回落贴底                                   |
| loadNewer 空页且无更多             | 游标追平 `lastRowId`，边界消失                           |
| 记忆 LRU 淘汰 / 旧版本记忆无锚点   | 维持现状：尾部窗口 + 贴底                                |

## 验收场景

1. 长会话（>200 行）滚到中部切走再切回，恢复后视口首行内容与离开时一致（误差 ≤ 1 行高）。
2. 切回后向上滚动可继续翻更早历史（loadOlder 不回归）。
3. 切回后向下滚动逐页补齐到尾部，间隙闭合后实时新消息正常追加，无丢序。
4. 贴底离开的会话切回仍尾部 + 贴底（现有行为回归）。
5. 锚点行被裁 / recovery 快照替换，分别落最近行 / 落底部，无报错无空白。
6. 恢复过程收敛（连续两帧落点一致），无持续跳动。
7. 「回到最新」在间隙未闭合时先补齐再贴底，消息不丢。
