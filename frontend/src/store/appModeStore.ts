import { create } from 'zustand'
import { queryClient } from '../api/queryClient'
import { prefsApi } from '../api/prefs'
import type { AppMode } from '../api/library'

/**
 * 上次使用的工作台。
 *
 * 它只是「落地页偏好」：进入应用根路径时落到照片侧还是漫画侧。
 * 当前在看哪一侧由 URL 路径前缀决定（`/photo` / `/comic`），不归这里管。
 *
 * 真相源是服务端偏好（state/web_settings.json），本地这份只是镜像。
 */
interface AppModeState {
  /** 上次使用的工作台；服务端还没回话时先用默认值。 */
  preference: AppMode
  /** 服务端偏好是否已读取。 */
  hydrated: boolean
  /** 用服务端返回的值水合本地镜像。 */
  hydrate: (mode: AppMode) => void
  /** 记住新的偏好：乐观更新 + 写服务端，失败则回滚。 */
  switchPreference: (mode: AppMode) => void
}

export const useAppModeStore = create<AppModeState>()((set, get) => ({
  preference: 'photo',
  hydrated: false,

  hydrate: (mode) => {
    // 水合只在本地还没有就绪时生效：用户切换后刷新页面时，
    // 服务端的旧值不应该把刚选的模式覆盖回去。
    if (get().hydrated) return
    set({ preference: mode, hydrated: true })
  },

  switchPreference: (mode) => {
    const previous = get().preference
    if (previous === mode) return
    // hydrated 一并置位：用户已经选过模式，服务端稍后返回的旧值不该覆盖它。
    set({ preference: mode, hydrated: true })
    void prefsApi
      .patch({ appMode: mode })
      .then((saved) => {
        queryClient.setQueryData(['prefs'], saved)
      })
      .catch(() => {
        // 写失败就回到原偏好：界面不能停在一个服务端并不认可的状态上。
        set({ preference: previous })
      })
  },
}))
