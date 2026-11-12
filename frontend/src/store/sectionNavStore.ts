import { create } from "zustand";

// 当前所在分区的记录：路由 → 分区 id。
//
// 页面负责判定「现在看到的是哪一段」，侧栏负责把它显示出来。
// 两者隔着组件树，用一个极小的 store 传递：侧栏的条目下多出当前分区，
// 用户在左侧随时知道自己停在这一页的哪一段。

interface SectionNavState {
  active: Record<string, string>;
  /**
   * 用户点分区跳转时锁定的分区。
   *
   * 宽屏上分区排成两列，两列的标题在同一高度 —— 只看位置就分不清刚才是
   * 点了左边还是右边的那一段。锁定到用户自己滚动（滚轮 / 触摸 / 翻页键）
   * 为止，这段时间里侧栏就按用户点的那个显示。
   */
  pinned: Record<string, string>;
  setActive: (pathname: string, sectionId: string) => void;
  pin: (pathname: string, sectionId: string) => void;
  releasePins: () => void;
}

export const useSectionNavStore = create<SectionNavState>((set) => ({
  active: {},
  pinned: {},
  setActive: (pathname, sectionId) =>
    set((state) =>
      state.active[pathname] === sectionId
        ? state
        : { active: { ...state.active, [pathname]: sectionId } },
    ),
  pin: (pathname, sectionId) =>
    set((state) => ({
      active: { ...state.active, [pathname]: sectionId },
      pinned: { ...state.pinned, [pathname]: sectionId },
    })),
  releasePins: () => set({ pinned: {} }),
}));
