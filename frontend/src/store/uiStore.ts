import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemePref = 'light' | 'dark' | 'system'
export type ViewMode = 'grid' | 'list'

// UI 状态：侧边栏、主题、视图模式、toast 通知。
//
// 持久化只覆盖外观偏好（侧边栏折叠、主题、视图模式）→ localStorage。
// toast、面包屑等临时状态不进 localStorage。
interface Toast {
  id: string
  kind: 'info' | 'success' | 'warning' | 'error'
  message: string
  ttl: number
}

interface UIState {
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (v: boolean) => void

  theme: ThemePref
  setTheme: (t: ThemePref) => void

  viewMode: ViewMode
  setViewMode: (v: ViewMode) => void

  /**
   * 是否配置了多个媒体根。只有多根时卡片才显示「来自 X」来源标记——
   * 单一根下每张卡片都挂同一句来源纯属噪音。
   */
  multiRoot: boolean
  setMultiRoot: (v: boolean) => void

  toasts: Toast[]
  pushToast: (t: Omit<Toast, 'id' | 'ttl'> & { ttl?: number }) => string
  dismissToast: (id: string) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),

      theme: 'system',
      setTheme: (t) => set({ theme: t }),

      viewMode: 'grid',
      setViewMode: (v) => set({ viewMode: v }),

      multiRoot: false,
      setMultiRoot: (v) => set({ multiRoot: v }),

      toasts: [],
      pushToast: (t) => {
        const id = Math.random().toString(36).slice(2, 10)
        const toast: Toast = {
          id,
          kind: t.kind,
          message: t.message,
          ttl: t.ttl ?? 2800,
        }
        set({ toasts: [...get().toasts, toast] })
        if (toast.ttl > 0) {
          setTimeout(() => get().dismissToast(id), toast.ttl)
        }
        return id
      },
      dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
    }),
    {
      name: 'local-gallery-ui',
      version: 1,
      // v0 曾持久化过一组可切换的强调色；强调色改为跟随主题方案后，
      // 那个偏好作废，迁移时把旧键丢掉，避免残留在 localStorage 里。
      migrate: (persisted) => {
        const state = persisted as Partial<UIState> & { accent?: unknown }
        if ('accent' in state) delete state.accent
        return state as UIState
      },
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        theme: s.theme,
        viewMode: s.viewMode,
      }),
    },
  ),
)

