import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemePref = 'light' | 'dark' | 'system'
export type ViewMode = 'grid' | 'list'
export type AccentKey = 'graphite' | 'indigo' | 'rose' | 'forest' | 'ochre' | 'plum'

// UI 状态：侧边栏、主题、强调色、视图模式、toast 通知。
//
// 持久化只覆盖外观偏好（侧边栏折叠、主题、视图模式、强调色）→ localStorage。
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

  accent: AccentKey
  setAccent: (a: AccentKey) => void

  viewMode: ViewMode
  setViewMode: (v: ViewMode) => void

  breadcrumbs: { label: string; to?: string }[]
  setBreadcrumbs: (bc: { label: string; to?: string }[]) => void

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

      accent: 'graphite',
      setAccent: (a) => set({ accent: a }),

      viewMode: 'grid',
      setViewMode: (v) => set({ viewMode: v }),

      breadcrumbs: [],
      setBreadcrumbs: (bc) => set({ breadcrumbs: bc }),

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
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        theme: s.theme,
        accent: s.accent,
        viewMode: s.viewMode,
      }),
    },
  ),
)

