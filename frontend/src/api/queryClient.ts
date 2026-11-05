import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './client'

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
      // 4xx 是请求本身不成立（标签不存在、没有权限、资源已移走）：
      // 重试多少次结果都一样，却要让页面多等好几秒才说出「找不到」。
      // fetch 层本来就只重试 5xx / 408 / 429，TanStack 这层要跟它一致。
      retry: (failureCount, error) => {
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        ) {
          return false
        }
        return failureCount < 3
      },
    },
  },
})
