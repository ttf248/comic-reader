import { create } from "zustand";

// 当前所在分区的记录：路由 → 分区 id。
//
// 页面负责判定「现在看到的是哪一段」，侧栏负责把它显示出来。
// 两者隔着组件树，用一个极小的 store 传递：侧栏的条目下多出行
// 当前分区，用户在左侧随时知道自己在这一页的哪一段。

interface SectionNavState {
  active: Record<string, string>;
  setActive: (pathname: string, sectionId: string) => void;
}

export const useSectionNavStore = create<SectionNavState>((set) => ({
  active: {},
  setActive: (pathname, sectionId) =>
    set((state) =>
      state.active[pathname] === sectionId
        ? state
        : { active: { ...state.active, [pathname]: sectionId } },
    ),
}));
