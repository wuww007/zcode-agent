// ============================================================
// Token Estimation
// ============================================================

import { estimateTokensFromText } from "@zcode/shared";

/**
 * 估算文本的 token 数量。
 * 口径（除数与中文权重）收敛在 @zcode/shared 的 estimateTokensFromText，
 * 与 UI 生成速度估算共用同一实现，这里只保留 core 侧的调用名。
 */
export function estimateTokens(text: string): number {
  return estimateTokensFromText(text);
}
