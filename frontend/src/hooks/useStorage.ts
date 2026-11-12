import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { cacheApi, formatBytes, type CacheStats } from "../api/cache";
import {
  storageApi,
  type JobOutput,
  type StorageAbsolutePaths,
  type StorageUsage,
} from "../api/storage";
import { useUIStore } from "../store/uiStore";

export const storageUsageKey = ["storage-usage"] as const;
export const storagePathsKey = ["storage-paths"] as const;
export const cacheStatsKey = ["cache-stats"] as const;
export const jobOutputKey = (jobId: string) => ["job-output", jobId] as const;

/** 媒体派生缓存的五类 scope，与后端的 /api/cache/clear 一致。 */
export type MediaCacheScope =
  | "thumbs"
  | "converted"
  | "previews"
  | "faststart"
  | "transcode";

export function mediaCacheScopeLabel(scope: MediaCacheScope): string {
  switch (scope) {
    case "thumbs":
      return "缩略图";
    case "converted":
      return "转换图";
    case "previews":
      return "预览图";
    case "faststart":
      return "faststart";
    case "transcode":
      return "转码";
  }
}

/**
 * 本机存储的数据层。
 *
 * 三块数据各管各的：分析占用与路径来自本机存储接口，媒体派生缓存占用
 * 复用既有的缓存统计接口。清理动作成功后只失效对应的查询，不动别的。
 */
export function useStorageUsage(): UseQueryResult<StorageUsage, Error> {
  return useQuery({
    queryKey: storageUsageKey,
    queryFn: async () => (await storageApi.usage()).usage,
    staleTime: 15_000,
  });
}

/**
 * 本机绝对路径。
 *
 * 这个接口只允许回环访问：局域网客户端会拿到 403 local_access_required。
 * 调用方要把它当「这台设备看不到绝对路径」处理，而不是错误。
 */
export function useStoragePaths(): UseQueryResult<StorageAbsolutePaths, Error> {
  return useQuery({
    queryKey: storagePathsKey,
    queryFn: async () => (await storageApi.paths()).paths,
    staleTime: 60_000,
    retry: false,
  });
}

/** 单次任务的产物占用。折叠状态下不启用，一个请求都不发。 */
export function useJobOutput(
  jobId: string,
  enabled: boolean,
): UseQueryResult<JobOutput, Error> {
  return useQuery({
    queryKey: jobOutputKey(jobId),
    queryFn: async () => (await storageApi.jobOutput(jobId)).output,
    enabled,
    staleTime: 300_000,
    retry: false,
  });
}

export interface MediaCacheState {
  stats?: CacheStats;
  loading: boolean;
  refreshing: boolean;
  /** 正在清理的 scope；"all" 表示一键全清。 */
  clearing?: MediaCacheScope | "all";
  refresh: () => void;
  clear: (scope: MediaCacheScope) => void;
  clearAll: () => void;
}

/**
 * 媒体派生缓存的占用与清理。
 *
 * 清理语义与后端一致：只动 derived/ 下五类派生目录，不碰状态与用户数据。
 */
export function useMediaCache(): MediaCacheState {
  const queryClient = useQueryClient();
  const pushToast = useUIStore((s) => s.pushToast);

  const statsQuery = useQuery({
    queryKey: cacheStatsKey,
    queryFn: () => cacheApi.stats(),
    staleTime: 5_000,
  });

  const scopeMutation = useMutation({
    mutationFn: (scope: MediaCacheScope) => cacheApi.clearCache(scope),
    onSuccess: (result, scope) => {
      void queryClient.invalidateQueries({ queryKey: cacheStatsKey });
      const sub = result[scope];
      if (!sub || sub.deleted === 0) {
        pushToast({
          kind: "info",
          message: `${mediaCacheScopeLabel(scope)} 缓存本就是空的`,
        });
        return;
      }
      const freed =
        sub.freedBytes > 0 ? ` · 释放 ${formatBytes(sub.freedBytes)}` : "";
      pushToast({
        kind: "success",
        message: `已清空 ${mediaCacheScopeLabel(scope)} ${sub.deleted} 个文件${freed}`,
      });
    },
    onError: (_error, scope) =>
      pushToast({
        kind: "error",
        message: `清空${mediaCacheScopeLabel(scope)}缓存失败`,
      }),
  });

  const allMutation = useMutation({
    mutationFn: () => cacheApi.clearCache("all"),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: cacheStatsKey });
      if (result.totalDeleted === 0) {
        pushToast({ kind: "info", message: "缓存本就是空的" });
        return;
      }
      pushToast({
        kind: "success",
        message: `已清空全部缓存 · ${result.totalDeleted} 个文件 · 释放 ${formatBytes(
          result.totalFreedBytes,
        )}`,
      });
    },
    onError: () =>
      pushToast({ kind: "error", message: "清空全部缓存失败" }),
  });

  return {
    stats: statsQuery.data,
    loading: statsQuery.isLoading,
    refreshing: statsQuery.isFetching,
    clearing: scopeMutation.isPending
      ? scopeMutation.variables
      : allMutation.isPending
        ? "all"
        : undefined,
    refresh: () => void statsQuery.refetch(),
    clear: (scope) => scopeMutation.mutate(scope),
    clearAll: () => allMutation.mutate(),
  };
}
