import { useEffect, useMemo } from "react";
import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { LibraryRevisionChangedError, libraryApi } from "../api/library";
import { ACTIVITY_CHANGED_EVENT } from "../api/activity";
import { useUIStore } from "../store/uiStore";
import { useAppMode } from "./useAppMode";
import type { AppMode } from "../api/library";

export const libraryQueryKeys = {
  root: ["library"] as const,
  /**
   * 模式维度。列表型查询都带上模式：切换工作台等于换一组查询键，
   * React Query 会自动去拉新数据，旧模式的缓存留着，切回来是秒开。
   */
  mode: (mode: AppMode) => [...libraryQueryKeys.root, "mode", mode] as const,
  // 与模式无关：切模式不重取。
  manifest: () => [...libraryQueryKeys.root, "manifest"] as const,
  media: (albumId: string) =>
    [...libraryQueryKeys.root, "media", albumId] as const,
  nodes: (ids: string[]) =>
    [...libraryQueryKeys.root, "nodes", ...ids] as const,
  // 与模式相关。
  activitySummary: (mode: AppMode) =>
    [...libraryQueryKeys.mode(mode), "activity-summary"] as const,
  dashboard: (mode: AppMode) =>
    [...libraryQueryKeys.mode(mode), "dashboard"] as const,
  unreadAlbums: (mode: AppMode) =>
    [...libraryQueryKeys.mode(mode), "unread-albums"] as const,
  children: (parentId: string, mode: AppMode) =>
    [...libraryQueryKeys.mode(mode), "children", parentId] as const,
  tags: (mode: AppMode) => [...libraryQueryKeys.mode(mode), "tags"] as const,
  tagAlbums: (tag: string, mode: AppMode) =>
    [...libraryQueryKeys.mode(mode), "tag-albums", tag] as const,
};

export function useLibraryManifest() {
  const query = useQuery({
    queryKey: libraryQueryKeys.manifest(),
    queryFn: () => libraryApi.manifest(),
  });
  // 多根时才需要在卡片上标来源：单一根下每张卡片都挂「来自 X」是噪音。
  const rootCount = query.data?.manifest.roots?.length ?? 0;
  const setMultiRoot = useUIStore((s) => s.setMultiRoot);
  useEffect(() => {
    setMultiRoot(rootCount > 1);
  }, [rootCount, setMultiRoot]);
  return query;
}

// 应用常驻层统一同步阅读派生缓存；画廊和其他页面也会修改未打开列表的状态。
export function useLibraryActivitySync() {
  const queryClient = useQueryClient();
  const { mode } = useAppMode();
  useEffect(() => {
    const refresh = () => {
      for (const queryKey of [
        libraryQueryKeys.activitySummary("photo"),
        libraryQueryKeys.activitySummary("comic"),
        libraryQueryKeys.dashboard(mode),
        libraryQueryKeys.unreadAlbums(mode),
      ]) {
        // 失效未挂载页面的缓存，但只立即重新获取当前有订阅的数据。
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    window.addEventListener(ACTIVITY_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(ACTIVITY_CHANGED_EVENT, refresh);
  }, [queryClient, mode]);
}

// 两种用途各自的未读计数。侧栏两组各挂一个徽标，
// 它们互不替代：照片的未浏览数不该被漫画的未读数顶掉。
export function useUnreadCountsByKind() {
  const { ready } = useAppMode();
  const photo = useQuery({
    queryKey: libraryQueryKeys.activitySummary("photo"),
    queryFn: () => libraryApi.activitySummary("photo"),
    staleTime: 30_000,
    enabled: ready,
  });
  const comic = useQuery({
    queryKey: libraryQueryKeys.activitySummary("comic"),
    queryFn: () => libraryApi.activitySummary("comic"),
    staleTime: 30_000,
    enabled: ready,
  });
  return {
    photo: photo.data?.summary.unreadCount ?? 0,
    comic: comic.data?.summary.unreadCount ?? 0,
  };
}

// 当前模式下的未读计数。
export function useLibraryActivitySummary() {
  const { mode, ready } = useAppMode();
  return useQuery({
    queryKey: libraryQueryKeys.activitySummary(mode),
    queryFn: () => libraryApi.activitySummary(mode),
    staleTime: 30_000,
    enabled: ready,
  });
}

// 首页仪表盘包含有限未读预览和在读摘要；活动变更后立即刷新，避免进度卡滞后。
export function useLibraryDashboard() {
  const { mode, ready } = useAppMode();
  return useQuery({
    queryKey: libraryQueryKeys.dashboard(mode),
    queryFn: () => libraryApi.dashboard(mode),
    staleTime: 30_000,
    enabled: ready,
  });
}

// 未读页直接取得服务端筛好的相册，不能先下载全库再批量查询每条阅读活动。
export function useLibraryUnreadAlbums() {
  const { mode, ready } = useAppMode();
  return useQuery({
    queryKey: libraryQueryKeys.unreadAlbums(mode),
    queryFn: () => libraryApi.allUnreadAlbums(mode),
    staleTime: 30_000,
    enabled: ready,
  });
}

export function useLibraryChildren(
  parentId: string,
  expectedRevision?: number,
) {
  const { mode, ready } = useAppMode();
  return useQuery({
    queryKey: [...libraryQueryKeys.children(parentId, mode), expectedRevision],
    queryFn: async () => {
      const page = await libraryApi.allChildren(parentId, mode);
      if (
        expectedRevision !== undefined &&
        page.revision !== expectedRevision
      ) {
        throw new LibraryRevisionChangedError();
      }
      return page;
    },
    enabled: parentId.length > 0 && ready,
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
  const { mode, ready } = useAppMode();
  return useQuery({
    queryKey: [...libraryQueryKeys.tags(mode), expectedRevision],
    queryFn: async () => {
      const page = await libraryApi.allTags(mode);
      if (
        expectedRevision !== undefined &&
        page.revision !== expectedRevision
      ) {
        throw new LibraryRevisionChangedError();
      }
      return page;
    },
    enabled: enabled && ready,
  });
}

export function useTagAlbums(tag: string) {
  const { mode, ready } = useAppMode();
  return useQuery({
    queryKey: libraryQueryKeys.tagAlbums(tag, mode),
    queryFn: () => libraryApi.allTagAlbums(tag, mode),
    enabled: tag.length > 0 && ready,
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
  const { mode, ready } = useAppMode();
  const childrenQueries = useQueries({
    queries: roots.map((root) => ({
      queryKey: [
        ...libraryQueryKeys.children(root.id, mode),
        manifest?.revision,
      ] as const,
      queryFn: async () => {
        const page = await libraryApi.allChildren(root.id, mode);
        if (page.revision !== manifest?.revision) {
          throw new LibraryRevisionChangedError();
        }
        return page;
      },
      enabled: ready,
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
