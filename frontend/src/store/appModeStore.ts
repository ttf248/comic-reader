import { create } from 'zustand'
import { queryClient } from '../api/queryClient'
import { prefsApi } from '../api/prefs'
import type { AppMode } from '../api/library'

/**
 * 全局工作台模式。
 *
 * 它的真相源是服务端偏好（state/web_settings.json），本地这份只是镜像：
 * 切换要立刻反映到界面，但真正持久化的是服务端。
 *
 * 模式是「我现在看哪一类」，相册自身的 contentKind 是「这本怎么打开」，
 * 两者正交——模式只过滤列表，不改变任何一本相册的打开方式。
 */
interface AppModeState {
  mode: AppMode
  /** 服务端偏好是否已读取。列表查询在它就绪前不发请求。 */
  ready: boolean
  /** 用服务端返回的值水合本地镜像。 */
  hydrate: (mode: AppMode) => void
  /** 切换模式：乐观更新 + 写服务端，失败则回滚。 */
  setMode: (mode: AppMode) => void
}

export const useAppModeStore = create<AppModeState>()((set, get) => ({
  mode: 'photo',
  ready: false,

  hydrate: (mode) => {
    // 水合只在本地还没有就绪时生效：用户切换后刷新页面时，
    // 服务端的旧值不应该把刚选的模式覆盖回去。
    if (get().ready) return
    set({ mode, ready: true })
  },

  setMode: (mode) => {
    const previous = get().mode
    if (previous === mode) return
    // ready 一并置位：用户已经选过模式，服务端稍后返回的旧值不该覆盖它。
    set({ mode, ready: true })
    void prefsApi
      .patch({ appMode: mode })
      .then((saved) => {
        queryClient.setQueryData(['prefs'], saved)
      })
      .catch(() => {
        // 写失败就回到原模式：界面不能停在一个服务端并不认可的状态上。
        set({ mode: previous })
      })
  },
}))
