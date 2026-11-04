import { QueryClient } from '@tanstack/react-query'

/**
 * 全应用共用的 TanStack Query 客户端。
 *
 * 单独成模块是为了让 store 也能拿到它：模式切换要在写服务端偏好后
 * 同步更新 ["prefs"] 缓存，而 store 不是 React 组件，用不了 useQueryClient。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
})
