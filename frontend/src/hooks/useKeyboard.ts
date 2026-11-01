import { useEffect, useRef } from "react";
import { normalizeKey, shouldIgnoreShortcut } from "../utils/shortcuts";

// useKeyboard 注册全局键盘快捷键。
// handlers: { [combo: string]: handler }
// 输入、控件激活和已处理事件优先，避免页面快捷键重复执行。
export function useKeyboard(
  handlers: Record<string, (e: KeyboardEvent) => void>,
  enabled = true,
) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const fn = (e: KeyboardEvent) => {
      if (shouldIgnoreShortcut(e)) return;
      const combo = normalizeKey(e);
      const h = ref.current[combo];
      if (h) {
        e.preventDefault();
        h(e);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [enabled]);
}
