import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useUIStore } from "../../store/uiStore";
import { CopyIcon, CheckIcon } from "./Icon";

interface Props {
  /** 复制到剪贴板的文本。 */
  value: string;
  /** 触屏/鼠标 enter 时显示的提示文字。 */
  title?: string;
}

type CopyStatus = "idle" | "copying" | "copied" | "failed";

function copyWithSelection(button: HTMLButtonElement, value: string): boolean {
  const doc = button.ownerDocument;
  const previousFocus = doc.activeElement;
  const textarea = doc.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  try {
    // 模态 dialog 外的元素不可聚焦，临时选区必须放在按钮所属弹窗内。
    (button.closest("dialog[open]") ?? doc.body).appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    if (doc.activeElement !== textarea) return false;
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    const restoreFocus = doc.activeElement === textarea;
    textarea.remove();
    if (
      restoreFocus &&
      previousFocus instanceof HTMLElement &&
      previousFocus.isConnected
    ) {
      previousFocus.focus({ preventScroll: true });
    }
  }
}

// 优先使用剪贴板 API；不可用或被拒绝时尝试临时选区，并在按钮上反馈结果。
export default function CopyButton({ value, title }: Props) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const feedbackTimer = useRef<number | null>(null);
  const request = useRef(0);
  const inFlight = useRef(false);
  const pushToast = useUIStore((s) => s.pushToast);

  useEffect(() => {
    setStatus((current) => (current === "copying" ? current : "idle"));
    return () => {
      request.current += 1;
      if (feedbackTimer.current !== null) {
        window.clearTimeout(feedbackTimer.current);
        feedbackTimer.current = null;
      }
    };
  }, [value]);

  async function onClick(event: MouseEvent<HTMLButtonElement>) {
    if (inFlight.current) return;
    const button = event.currentTarget;
    const attempt = ++request.current;
    const isCurrent = () => request.current === attempt && button.isConnected;
    inFlight.current = true;
    if (feedbackTimer.current !== null) {
      window.clearTimeout(feedbackTimer.current);
      feedbackTimer.current = null;
    }
    setStatus("copying");
    try {
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
          copied = true;
        }
      } catch {
        // 权限或上下文受限时尝试下面的选区复制。
      }
      if (!isCurrent()) return;
      if (!copied) copied = copyWithSelection(button, value);
      if (!isCurrent()) return;
      if (copied) {
        setStatus("copied");
        feedbackTimer.current = window.setTimeout(() => {
          feedbackTimer.current = null;
          if (isCurrent()) setStatus("idle");
        }, 1500);
      } else {
        setStatus("failed");
        pushToast({ kind: "error", message: "复制失败，请检查浏览器权限" });
      }
    } finally {
      inFlight.current = false;
      if (button.isConnected && !isCurrent()) setStatus("idle");
    }
  }

  const label =
    status === "copying"
      ? "正在复制…"
      : status === "copied"
        ? "已复制"
        : status === "failed"
          ? "复制失败，重试"
          : (title ?? "复制");

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center justify-center w-4 h-4 rounded text-fg-subtle hover:text-fg hover:bg-bg-subtle transition-colors"
      title={label}
      aria-label={label}
      aria-busy={status === "copying" || undefined}
    >
      {status === "copied" ? <CheckIcon size={10} /> : <CopyIcon size={10} />}
    </button>
  );
}
