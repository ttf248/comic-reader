import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { prefsApi } from '../api/prefs'
import { useAppModeStore } from '../store/appModeStore'

/**
 * 全局工作台模式。
 *
 * mode 就是目录的内容属性：照片工作台只列照片目录的相册，漫画工作台只列漫画目录的。
 * 它决定列表呈现什么、页面用什么措辞，也决定相册点开进照片墙还是阅读器。
 */
export function useAppMode() {
  const mode = useAppModeStore((s) => s.mode)
  const ready = useAppModeStore((s) => s.ready)
  const setMode = useAppModeStore((s) => s.setMode)
  return { mode, ready, setMode }
}

/**
 * 用服务端偏好水合本地模式镜像。挂在应用顶层调用一次。
 *
 * 偏好读不出来时也要放行（用默认模式）：偏好接口故障不该把整个应用
 * 卡在骨架屏上——列表请求本来就带 kind，猜错一种用途只是少显示一半内容。
 */
export function useAppModeHydration() {
  const query = useQuery({
    queryKey: ['prefs'],
    queryFn: () => prefsApi.get(),
    staleTime: 5 * 60 * 1000,
  })
  const hydrate = useAppModeStore((s) => s.hydrate)

  useEffect(() => {
    if (query.data) {
      hydrate(query.data.appMode ?? 'photo')
      return
    }
    if (query.isError) hydrate('photo')
  }, [query.data, query.isError, hydrate])

  return query
}
