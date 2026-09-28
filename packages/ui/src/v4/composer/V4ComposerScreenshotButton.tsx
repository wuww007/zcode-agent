/**
 * composer 选区截图入口按钮（微信桌面端同款：整屏遮罩 → 拖拽选区 → 图片进附件区）。
 *
 * 纯展示件，两层门与 V4ComposerCuaEntry 对齐：
 * - 平台门前置层用 useOptionalPlatform：缺 PlatformProvider 的宿主（组件级测试等）
 *   静默降级为不渲染，而不是把整个 composer 拖崩；
 * - platform 未实现 captureScreenRegion（Web / 移动端）时同样不渲染。
 * 捕获与裁剪都在 main 完成，这里只负责触发与防重入。
 */
import { memo, useState } from "react";
import { ScissorsIcon } from "lucide-react";
import { TID_V4_COMPOSER_SCREENSHOT } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface V4ComposerScreenshotButtonProps {
  disabled?: boolean;
  onCapture: () => Promise<void>;
}

function V4ComposerScreenshotButtonImpl(props: V4ComposerScreenshotButtonProps) {
  const platform = useOptionalPlatform();
  const { intl } = useZCodeIntl();
  const [pending, setPending] = useState(false);
  if (!platform || typeof platform.captureScreenRegion !== "function") return null;

  const label = intl.formatMessage({ id: "chat.composer.screenshot" });
  // captureScreenAttachment 内部已吞掉异常（失败映射为附件错误横幅），这里只管防重入。
  const handleCapture = async () => {
    if (pending) return;
    setPending(true);
    try {
      await props.onCapture();
    } catch {
      // hook 承诺不 reject；这里兜底保证 pending 复位。
    } finally {
      setPending(false);
    }
  };

  return (
    <ControlHintTooltip title={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        disabled={props.disabled || pending}
        data-testid={TID_V4_COMPOSER_SCREENSHOT}
        data-composer-collapse-priority="3"
        aria-label={label}
        onClick={() => {
          void handleCapture();
        }}
        className="rounded-lg"
      >
        {pending ? <Spinner className="size-4" /> : <ScissorsIcon className="size-4" />}
        <span className="sr-only">{label}</span>
      </Button>
    </ControlHintTooltip>
  );
}

export const V4ComposerScreenshotButton = memo(V4ComposerScreenshotButtonImpl);
