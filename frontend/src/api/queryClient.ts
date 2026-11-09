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
      // 404 是「资源不存在」：标签没了、相册被移走了，重试多少次结果
      // 都一样，却要让页面多等好几秒才说出「找不到」。
      //
      // 只挡 404，不挡整个 4xx：分页失败会以 400 回来（游标失效之类），
      // 那是可以重试的，页面也靠重试把「后续媒体加载失败」这条提示
      // 演出来（见 tests/e2e/browse.spec.ts 的分页失败用例）。
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status === 404) {
          return false
        }
        return failureCount < 3
      },
    },
  },
})
