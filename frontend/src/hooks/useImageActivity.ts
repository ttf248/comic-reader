import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  activityApi,
  isActivityNotFound,
  type Activity,
  type ImageActivity,
} from "../api/activity";

const ACTIVITY_BATCH_SIZE = 1_000;

export function useImageActivity(albumId: string | null | undefined) {
  return useQuery({
    queryKey: ["activity", "image", albumId],
    queryFn: async () => {
      if (!albumId) return null;
      try {
        return await activityApi.getImage(albumId);
      } catch (error) {
        if (isActivityNotFound(error)) return null;
        throw error;
      }
    },
    enabled: !!albumId,
    staleTime: 30 * 1000,
  });
}

// 首页等列表只查图片活动，避免视频秒数混入相册页码语义。
export function useImageActivities(albumIds: string[], enabled = true) {
  const canonicalAlbumIds = useMemo(
    () => Array.from(new Set(albumIds)).sort(),
    [albumIds],
  );

  return useQuery({
    queryKey: ["activity-query", "image", canonicalAlbumIds],
    queryFn: async () => {
      const chunks: string[][] = [];
      for (
        let offset = 0;
        offset < canonicalAlbumIds.length;
        offset += ACTIVITY_BATCH_SIZE
      ) {
        chunks.push(
          canonicalAlbumIds.slice(offset, offset + ACTIVITY_BATCH_SIZE),
        );
      }
      const responses = await Promise.all(
        chunks.map((chunk) => activityApi.queryImages(chunk)),
      );
      return responses.reduce<Record<string, ImageActivity>>(
        (all, response) => {
          for (const activity of response.activities) {
            all[activity.albumId] = activity;
          }
          return all;
        },
        {},
      );
    },
    enabled: enabled && canonicalAlbumIds.length > 0,
    staleTime: 30 * 1000,
  });
}

function invalidateImageActivities(
  queryClient: ReturnType<typeof useQueryClient>,
  albumId?: string,
) {
  queryClient.invalidateQueries({ queryKey: ["activity-query", "image"] });
  if (albumId) {
    queryClient.invalidateQueries({
      queryKey: ["activity", "image", albumId],
    });
  } else {
    queryClient.invalidateQueries({ queryKey: ["activity", "image"] });
  }
}

// 把漫画阅读活动推到最后一个 0-based 页索引。
//
// 阅读进度只属于漫画工作台：照片浏览不留进度，因此没有第二处写入点。
export function useMarkAlbumRead() {
  const queryClient = useQueryClient();
  return useMutation<Activity, Error, { albumId: string; total: number }>({
    mutationFn: ({ albumId, total }) => {
      if (total <= 0) throw new Error("empty albums cannot be marked as read");
      return activityApi.setImage(albumId, total - 1, total, "explicit");
    },
    onSuccess: (_data, { albumId }) =>
      invalidateImageActivities(queryClient, albumId),
  });
}

// 未读由没有图片活动表达；不能写入第 0 页来重置。
export function useResetAlbumRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ albumId }: { albumId: string }) =>
      activityApi.removeImage(albumId),
    onSuccess: (_data, { albumId }) =>
      invalidateImageActivities(queryClient, albumId),
  });
}

// 批量标记已读只落盘一次。
export function useMarkAlbumsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (items: { albumId: string; total: number }[]) => {
      const readable = items.filter((item) => item.total > 0);
      if (readable.length === 0) {
        return { ok: 0, failed: 0, total: items.length };
      }
      const result = await activityApi.setBatch(
        readable.map((item) => ({
          albumId: item.albumId,
          mediaKind: "image" as const,
          pageIndex: item.total - 1,
          pageCount: item.total,
        })),
      );
      return {
        ok: result.updated,
        failed: items.length - readable.length,
        total: items.length,
      };
    },
    onSuccess: () => invalidateImageActivities(queryClient),
  });
}
