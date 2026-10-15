// 任务页「当前 token 生成速度」指示器（composer 工具条，context usage 左侧）。
//
// 读数语义 = 当前输出速度（见 specs/task-page-token-speed.md）：
// - 生成中且有窗口样本：tracker 的滑动窗口估值，显示 `≈N tok/s`；只在
//   control.phase=running 时刷新。
// - 没有输出（未运行、工具执行间隙、等待首 token、轮次结束、草稿、历史冷开）：
//   隐藏——不显示 0、也不显示上一次请求的速度，避免把过期数字冒充当前速度。
import { memo, useEffect, useState } from "react";
import { TID_V4_GENERATION_SPEED } from "@zcode/shared";
import type { SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { generationSpeedNow, type GenerationSpeedTracker } from "@/v4/generationSpeed.js";

/** 指示器刷新节奏：够平滑又不至于每次 delta 都重渲染。 */
const REFRESH_INTERVAL_MS = 250;

export const GenerationSpeedIndicator = memo(function GenerationSpeedIndicator({
  tracker,
  phase,
  variant = "composer",
}: {
  tracker: GenerationSpeedTracker | null;
  phase: SessionPhase | null;
  /**
   * composer：工具条内裸文本。
   * header：只读 pane（子代理会话）的悬浮 chrome 槽位，需要卡片底以满足滚动内容上的可读性。
   */
  variant?: "composer" | "header";
}) {
  const { intl } = useZCodeIntl();
  const running = phase === "running";
  // 估值与 tracker 实例绑定：切换任务（新 store）后旧读数立即失效，不串台。
  const [live, setLive] = useState<{ tracker: GenerationSpeedTracker; tps: number } | null>(null);

  useEffect(() => {
    if (!tracker || !running) {
      setLive(null);
      return;
    }
    const tick = () => {
      const sample = tracker.sample(generationSpeedNow());
      const next = sample ? Math.round(sample.tokensPerSecond) : null;
      setLive((previous) =>
        previous?.tracker === tracker && previous.tps === next
          ? previous
          : next === null
            ? null
            : { tracker, tps: next },
      );
    };
    tick();
    const timer = window.setInterval(tick, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [tracker, running]);

  const liveTps = live && live.tracker === tracker ? live.tps : null;
  if (liveTps === null) return null;

  return (
    <span
      data-testid={TID_V4_GENERATION_SPEED}
      data-variant={variant}
      data-tps={liveTps}
      title={intl.formatMessage({ id: "chat.generationSpeed.estimateTooltip" })}
      className={
        variant === "header"
          ? "pointer-events-auto inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] px-2 text-ui-sm tabular-nums text-[var(--color-foreground-subtle)] shadow-md"
          : "inline-flex shrink-0 items-center whitespace-nowrap text-ui-sm tabular-nums text-foreground-subtle"
      }
    >
      {intl.formatMessage({ id: "chat.generationSpeed.estimateValue" }, { tps: liveTps })}
    </span>
  );
});
