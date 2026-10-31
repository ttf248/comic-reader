interface CopyOptions {
  source?: HTMLElement;
  /** 异步权限检查结束后，调用方已失效时不再创建临时选区。 */
  canFallback?: () => boolean;
}

function copyWithSelection(
  value: string,
  doc: Document,
  source?: HTMLElement,
): boolean {
  const previousFocus = doc.activeElement;
  // 菜单可能在等待权限期间卸载，此时使用当前仍连接的焦点元素。
  const context = source?.isConnected ? source : previousFocus;
  const dialog =
    context instanceof Element ? context.closest("dialog[open]") : null;
  const textarea = doc.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  try {
    // 模态 dialog 外的元素不可聚焦，临时选区必须放在所属弹窗内。
    (dialog ?? doc.body).appendChild(textarea);
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

// 只处理复制能力与选区清理，成功、失败和组件生命周期由调用方反馈。
export async function copyText(
  value: string,
  { source, canFallback }: CopyOptions = {},
): Promise<boolean> {
  const doc = source?.ownerDocument ?? document;
  try {
    const clipboard = doc.defaultView?.navigator.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(value);
      return true;
    }
  } catch {
    // 权限或上下文受限时尝试下面的选区复制。
  }
  if (canFallback && !canFallback()) return false;
  return copyWithSelection(value, doc, source);
}
