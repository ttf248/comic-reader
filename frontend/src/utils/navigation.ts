import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

/**
 * 应用内是否还有可回退的上一页。
 *
 * React Router 用的 history 包会把应用内历史深度写进
 * `history.state.idx`：idx 为 0 表示这是应用内的第一个页面（直接打开
 * 链接、刷新页面、从站外跳转进来）。这时执行 `navigate(-1)` 会一路退出
 * 应用，停在浏览器的空白页（about:blank）——用户看到的是整个应用消失。
 *
 * 翻页这类 replace 导航不会改变 idx，所以"在阅读器里翻到第 50 页再按
 * 返回"依然能正确回到列表。
 */
export function hasAppHistory(): boolean {
  if (typeof window === "undefined") return false;
  const state = window.history.state as { idx?: number } | null;
  return typeof state?.idx === "number" && state.idx > 0;
}

/**
 * 安全的"返回"：应用内还有历史就回退，否则去 fallback。
 *
 * fallback 必须是应用内的具体路由（不能是空串），否则会退到应用外面。
 */
export function useSafeBack(fallback: string): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    if (hasAppHistory()) {
      navigate(-1);
      return;
    }
    navigate(fallback);
  }, [navigate, fallback]);
}
