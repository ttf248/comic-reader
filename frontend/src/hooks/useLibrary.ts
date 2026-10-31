import { useEffect, useMemo } from "react";
import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { LibraryRevisionChangedError, libraryApi } from "../api/library";
import { ACTIVITY_CHANGED_EVENT } from "../api/activity";

export const libraryQueryKeys = {
  root: ["library"] as const,
  manifest: () => [...libraryQueryKeys.root, "manifest"] as const,
  activitySummary: () =>
    [...libraryQueryKeys.root, "activity-summary"] as const,
  dashboard: () => [...libraryQueryKeys.root, "dashboard"] as const,
  unreadAlbums: () => [...libraryQueryKeys.root, "unread-albums"] as const,
  children: (parentId: string) =>
    [...libraryQueryKeys.root, "children", parentId] as const,
  media: (albumId: string) =>
    [...libraryQueryKeys.root, "media", albumId] as const,
  tags: () => [...libraryQueryKeys.root, "tags"] as const,
  tagAlbums: (tag: string) =>
    [...libraryQueryKeys.root, "tag-albums", tag] as const,
  nodes: (ids: string[]) =>
    [...libraryQueryKeys.root, "nodes", ...ids] as const,
};

export function useLibraryManifest() {
  return useQuery({
    queryKey: libraryQueryKeys.manifest(),
    queryFn: () => libraryApi.manifest(),
  });
}

// 应用常驻层统一同步阅读派生缓存；画廊和其他页面也会修改未打开列表的状态。
export function useLibraryActivitySync() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      for (const queryKey of [
        libraryQueryKeys.activitySummary(),
        libraryQueryKeys.dashboard(),
        libraryQueryKeys.unreadAlbums(),
      ]) {
        // 失效未挂载页面的缓存，但只立即重新获取当前有订阅的数据。
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    window.addEventListener(ACTIVITY_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(ACTIVITY_CHANGED_EVENT, refresh);
  }, [queryClient]);
}

// 常驻侧边栏只需要未读计数，不能为 badge 下载跨根的完整相册摘要。
export function useLibraryActivitySummary() {
  return useQuery({
    queryKey: libraryQueryKeys.activitySummary(),
    queryFn: () => libraryApi.activitySummary(),
    staleTime: 30_000,
  });
}

// 首页仪表盘包含有限未读预览和在读摘要；活动变更后立即刷新，避免进度卡滞后。
export function useLibraryDashboard() {
  return useQuery({
    queryKey: libraryQueryKeys.dashboard(),
    queryFn: () => libraryApi.dashboard(),
    staleTime: 30_000,
  });
}

// 未读页直接取得服务端筛好的相册，不能先下载全库再批量查询每条阅读活动。
export function useLibraryUnreadAlbums() {
  return useQuery({
    queryKey: libraryQueryKeys.unreadAlbums(),
    queryFn: () => libraryApi.allUnreadAlbums(),
    staleTime: 30_000,
  });
}

export function useLibraryChildren(
  parentId: string,
  expectedRevision?: number,
) {
  return useQuery({
    queryKey: [...libraryQueryKeys.children(parentId), expectedRevision],
    queryFn: async () => {
      const page = await libraryApi.allChildren(parentId);
      if (
        expectedRevision !== undefined &&
        page.revision !== expectedRevision
      ) {
        throw new LibraryRevisionChangedError();
      }
      return page;
    },
    enabled: parentId.length > 0,
  });
}

export function useAlbumMedia(albumId: string, expectedRevision?: number) {
  // 详情页只先取首屏媒体；调用方在虚拟网格接近末尾时继续取下一页。
  // 阅读器仍可使用 libraryApi.allMedia 一次性建立跨页导航上下文。
  return useInfiniteQuery({
    queryKey: [...libraryQueryKeys.media(albumId), expectedRevision],
    queryFn: async ({ pageParam }) => {
      const response = await libraryApi.mediaPage(albumId, pageParam);
      const page = response.page;
      if (
        expectedRevision !== undefined &&
        page.revision !== expectedRevision
      ) {
        throw new LibraryRevisionChangedError();
      }
      return page;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: albumId.length > 0,
  });
}

export function useLibraryTags(enabled = true, expectedRevision?: number) {
  return useQuery({
    queryKey: [...libraryQueryKeys.tags(), expectedRevision],
    queryFn: async () => {
      const page = await libraryApi.allTags();
      if (
        expectedRevision !== undefined &&
        page.revision !== expectedRevision
      ) {
        throw new LibraryRevisionChangedError();
      }
      return page;
    },
    enabled,
  });
}

export function useTagAlbums(tag: string) {
  return useQuery({
    queryKey: libraryQueryKeys.tagAlbums(tag),
    queryFn: () => libraryApi.allTagAlbums(tag),
    enabled: tag.length > 0,
  });
}

export function useLibraryNodes(ids: string[]) {
  return useQuery({
    queryKey: libraryQueryKeys.nodes(ids),
    queryFn: () => libraryApi.queryNodes(ids),
    enabled: ids.length > 0,
  });
}

// 首页只装配 manifest、各根直属节点与标签摘要，不加载嵌套树或媒体数组。
export function useLibraryOverview() {
  const manifestQuery = useLibraryManifest();
  const manifest = manifestQuery.data?.manifest;
  const roots = manifest?.roots ?? [];
  const childrenQueries = useQueries({
    queries: roots.map((root) => ({
      queryKey: [
        ...libraryQueryKeys.children(root.id),
        manifest?.revision,
      ] as const,
      queryFn: async () => {
        const page = await libraryApi.allChildren(root.id);
        if (page.revision !== manifest?.revision) {
          throw new LibraryRevisionChangedError();
        }
        return page;
      },
    })),
  });
  const tagsQuery = useLibraryTags(!!manifest, manifest?.revision);
  const nodes = useMemo(
    () => childrenQueries.flatMap((query) => query.data?.items ?? []),
    [childrenQueries],
  );

  return {
    manifest,
    nodes,
    tags: tagsQuery.data?.items ?? [],
    isLoading:
      manifestQuery.isLoading ||
      childrenQueries.some((query) => query.isLoading) ||
      tagsQuery.isLoading,
    isError:
      manifestQuery.isError ||
      childrenQueries.some((query) => query.isError) ||
      tagsQuery.isError,
  };
}
