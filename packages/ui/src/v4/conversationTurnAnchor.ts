// 会话切回的锚点恢复 —— turn 渲染单元的锚点定位（纯函数）。
// 滚动记忆以「锚点行 rowId + 单元内偏移」表达离开位置；本模块负责在
// 重开的锚点窗口里把锚点行映射回虚拟列表单元索引。
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

/**
 * turn 渲染单元的锚点行：turn 内最小的 rowId（header 在场时即 header）。
 * 跨会话 rowId 可重复，仅在同一会话内比较。
 */
export function getConversationTurnUnitAnchorRowId(
  unit: ConversationTurnRenderUnit,
): number | null {
  const candidates = [
    unit.header?.rowId,
    unit.renderRows[0]?.rowId,
    unit.visibleUserInputs[0]?.rowId,
  ].filter((rowId): rowId is number => typeof rowId === "number");
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/**
 * 按锚点 rowId 定位渲染单元索引。
 * 优先命中 rowId 区间包含锚点的单元（窗口可能截掉 turn header，锚点行仍在单元内）；
 * 否则退回最后一个「锚点 ≤ 目标」的单元；找不到任何命中（目标早于全部已加载行）
 * 返回 null，由调用方决定等待补拉或回落贴底。
 */
export function findConversationTurnUnitIndexByAnchorRowId(
  units: readonly ConversationTurnRenderUnit[],
  anchorRowId: number,
): number | null {
  let lastBefore: number | null = null;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]!;
    const unitAnchor = getConversationTurnUnitAnchorRowId(unit);
    if (unitAnchor === null) continue;
    if (unitAnchor > anchorRowId) break;
    lastBefore = index;
    const unitLastRowId = unit.renderRows[unit.renderRows.length - 1]?.rowId;
    if (unitLastRowId !== undefined && unitLastRowId >= anchorRowId) return index;
  }
  return lastBefore;
}
