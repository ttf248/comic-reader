import { create } from "zustand";
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useSearchStore } from "./searchStore";
import type { ContentKind } from "../api/library";

export interface SelectionItem {
  id: string;
  albumId?: string;
  title: string;
  contentKind?: ContentKind;
  imageCount: number;
}
interface SelectionState {
  scope: string;
  active: boolean;
  busy: boolean;
  items: Record<string, SelectionItem>;
  ensureScope: (scope: string) => void;
  start: () => void;
  clear: () => void;
  toggle: (item: SelectionItem) => boolean;
  selectLoaded: (items: SelectionItem[]) => boolean;
  finish: (scope: string) => void;
}
// 仅保留至多 1,000 个待操作标识与摘要，不持久化，也不复制媒体库。
export const useSelectionStore = create<SelectionState>((set, get) => ({
  scope: "",
  active: false,
  busy: false,
  items: {},
  ensureScope: (scope) => {
    if (scope !== get().scope) set({ scope, active: false, items: {} });
  },
  start: () => {
    if (!get().busy) set({ active: true });
  },
  clear: () => {
    if (!get().busy) set({ active: false, items: {} });
  },
  toggle: (item) => {
    if (get().busy) return false;
    const items = { ...get().items };
    if (items[item.id]) delete items[item.id];
    else {
      if (Object.keys(items).length >= 1000) return false;
      items[item.id] = item;
    }
    set({ items });
    return true;
  },
  selectLoaded: (loaded) => {
    if (get().busy) return false;
    const items = { ...get().items };
    for (const item of loaded) items[item.id] = item;
    if (Object.keys(items).length > 1000) return false;
    set({ items });
    return true;
  },
  finish: (scope) =>
    set(
      get().scope === scope
        ? { busy: false, active: false, items: {} }
        : { busy: false },
    ),
}));

export function useSelectionScope() {
  const location = useLocation();
  const query = useSearchStore((s) => s.query);
  const view = useSearchStore((s) => s.view);
  const year = useSearchStore((s) => s.yearFilter);
  const minimum = useSearchStore((s) => s.minImageCount);
  const scope = JSON.stringify([location.pathname, query, view, year, minimum]);
  useEffect(() => useSelectionStore.getState().ensureScope(scope), [scope]);
}
