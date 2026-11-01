import type { KeyboardEvent } from "react";

// 菜单拥有焦点时隔离背景快捷键，保留菜单项原生的 Space/Enter 激活。
export function handleMenuKeyDown(
  event: KeyboardEvent<HTMLElement>,
  onClose: () => void,
): void {
  event.stopPropagation();
  if (
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  )
    return;
  if (event.key === "Escape") {
    event.preventDefault();
    onClose();
    return;
  }
  if (["ArrowLeft", "ArrowRight", "PageUp", "PageDown"].includes(event.key)) {
    event.preventDefault();
    return;
  }
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
    ),
  );
  if (items.length === 0) return;
  const current = items.findIndex((item) => item === document.activeElement);
  let next: number;
  switch (event.key) {
    case "ArrowDown":
      next = current < 0 ? 0 : (current + 1) % items.length;
      break;
    case "ArrowUp":
      next =
        current < 0
          ? items.length - 1
          : (current + items.length - 1) % items.length;
      break;
    case "Home":
      next = 0;
      break;
    default:
      next = items.length - 1;
  }
  items[next].focus();
}
