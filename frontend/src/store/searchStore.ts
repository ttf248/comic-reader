// 全局搜索状态：query / 排序 / 视图过滤 / 年份筛选
//
//   - 持久化到 localStorage
//   - 任意页面可读写，Home/Favorites/Recents 共享同一份过滤参数
//   - yearFilter：主页"时间线"点击某年时切换，作用于"全部图像"网格。
//     用 null 表示"未筛选"。注意：年份只对 album 有意义，
//     因此当 view 切到 collection/smart 时应在 UI 层清掉它。
//   - minImageCount:全局最小图数过滤,0 = 不过滤(默认)。隐藏「杂物相册」
//     (1-2 张的零碎文件夹),让「随便翻翻」的 feed 更干净。
//     只对 album 变体生效;collection / smart 不参与。
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 排序口径。
 *
 * - name   按名称
 * - count  按张数（漫画侧按页数）
 * - recent 按最近改（文件修改时间）
 * - added  按加入时间（业务日期：拍摄时间 > 文件夹名日期 > 修改时间，
 *          与后端「最近加入」同一口径）
 * - viewed 按最近看（访问记录）
 */
export type SortKey = 'name' | 'count' | 'recent' | 'added' | 'viewed'
export type ViewKey = 'all' | 'album' | 'collection' | 'smart'

interface SearchState {
  query: string
  sortBy: SortKey
  /**
   * 用户是否亲手选过排序。
   *
   * 没选过时，各页用各自的天然顺序（首页按名称、浏览足迹按时间）。
   * 选过一次之后，他挑的那个顺序对所有页面生效。
   */
  sortTouched: boolean
  view: ViewKey
  /**
   * 年份筛选：null = 不筛选；number = 精确年份；'other' = "其他"桶。
   * 点时间线上的年份卡时切换（再点同一张 = 取消）；切视图到
   * collection/smart 时由 UI 层清除。
   */
  yearFilter: number | 'other' | null
  /**
   * 最小图数过滤:0 = 不过滤(默认);N = 只显示图数 ≥ N 的 album。
   * 应用范围:Home 的「全部图像」网格、Recents、Favorites、Unread。
   * 不影响 collection / smart(它们的 count 含义不一样)。
   */
  minImageCount: number

  setQuery: (q: string) => void
  setSortBy: (s: SortKey) => void
  setView: (v: ViewKey) => void
  setYearFilter: (y: number | 'other' | null) => void
  toggleYearFilter: (y: number | 'other') => void
  setMinImageCount: (n: number) => void
  reset: () => void
}

export const useSearchStore = create<SearchState>()(
  persist(
    (set, get) => ({
      query: '',
      sortBy: 'name',
      sortTouched: false,
      // 默认 'all'，但用户最常看的是文件夹；提供 reset 入口可一键回到默认
      view: 'all',
      yearFilter: null,
      minImageCount: 0,
      setQuery: (q) => set({ query: q }),
      setSortBy: (s) => set({ sortBy: s, sortTouched: true }),
      setView: (v) => set({ view: v }),
      setYearFilter: (y) => set({ yearFilter: y }),
      toggleYearFilter: (y) =>
        set({ yearFilter: get().yearFilter === y ? null : y }),
      setMinImageCount: (n) => set({ minImageCount: Math.max(0, Math.floor(n)) }),
      reset: () =>
        set({
          query: '',
          sortBy: 'name',
          sortTouched: false,
          view: 'all',
          yearFilter: null,
          minImageCount: 0,
        }),
    }),
    {
      name: 'local-gallery-search',
      // 旧数据里没有 sortTouched：排序不是默认的「按名称」时，
      // 说明用户亲手选过，那一次选择继续生效。
      migrate: (persisted) => {
        const state = persisted as Partial<SearchState> | undefined
        if (!state) return state as unknown as SearchState
        if (typeof state.sortTouched !== 'boolean') {
          state.sortTouched = state.sortBy !== undefined && state.sortBy !== 'name'
        }
        return state as SearchState
      },
    },
  ),
)
