import { create } from "zustand";

/**
 * 照片墙上的临时多选。
 *
 * 与相册列表的批量选择分开存：那边选的是「本相册」，这边选的是
 * 「这一张」。两者的条目形状不同（照片要带文件名与所属相册才能做
 * 并排对比），混在一份选择里会让两边都别扭。
 *
 * 它是临时状态：不持久化，也不进浏览器存储。刷新页面即清空。
 */

// 一次最多能选多少张。照片墙可能一屏就有几十张，全选一本大相册
// 会到几千张 —— 但真要一次处理几千张精选的人几乎没有，
// 上限挡住的是误操作而不是正当需求。
const MAX_SELECTION = 2000;

export interface PhotoSelectionEntry {
  id: string;
  name: string;
  /** 所属相册的资源 ID；精选页里的照片来自不同相册。 */
  albumId?: string;
  albumName?: string;
  kind?: string;
  version?: string;
  width?: number;
  height?: number;
}

interface PhotoSelectionState {
  /** 选择作用域。作用域变了（换相册、换页面）选择即清空。 */
  scope: string;
  /** 是否处于多选模式。 */
  active: boolean;
  /** 提交中：期间不允许再次改动选择。 */
  busy: boolean;
  entries: Record<string, PhotoSelectionEntry>;
  ensureScope: (scope: string) => void;
  start: () => void;
  clear: () => void;
  toggle: (entry: PhotoSelectionEntry) => boolean;
  selectMany: (entries: PhotoSelectionEntry[]) => boolean;
  setBusy: (busy: boolean) => void;
}

export const usePhotoSelectionStore = create<PhotoSelectionState>((set, get) => ({
  scope: "",
  active: false,
  busy: false,
  entries: {},
  ensureScope: (scope) => {
    if (scope !== get().scope) set({ scope, active: false, entries: {} });
  },
  start: () => {
    if (!get().busy) set({ active: true });
  },
  clear: () => {
    if (!get().busy) set({ active: false, entries: {} });
  },
  toggle: (entry) => {
    if (get().busy) return false;
    const entries = { ...get().entries };
    if (entries[entry.id]) delete entries[entry.id];
    else {
      if (Object.keys(entries).length >= MAX_SELECTION) return false;
      entries[entry.id] = entry;
    }
    set({ entries });
    return true;
  },
  selectMany: (incoming) => {
    if (get().busy) return false;
    const entries = { ...get().entries };
    for (const entry of incoming) entries[entry.id] = entry;
    if (Object.keys(entries).length > MAX_SELECTION) return false;
    set({ entries });
    return true;
  },
  setBusy: (busy) => set({ busy }),
}));

/** 当前选中的条目，按选择顺序排列。 */
export function selectedPhotoEntries(
  entries: Record<string, PhotoSelectionEntry>,
): PhotoSelectionEntry[] {
  return Object.values(entries);
}
