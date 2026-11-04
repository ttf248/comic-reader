import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  activityApi,
  isActivityNotFound,
  type Activity,
  type ImageActivity,
  type PhotoActivity,
} from "../api/activity";
import type { ContentKind } from "../api/library";

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
  queryClient.invalidateQueries({ queryKey: ["activity-query", "photo"] });
  if (albumId) {
    queryClient.invalidateQueries({
      queryKey: ["activity", "image", albumId],
    });
    queryClient.invalidateQueries({
      queryKey: ["activity", "photo", albumId],
    });
  } else {
    queryClient.invalidateQueries({ queryKey: ["activity", "image"] });
    queryClient.invalidateQueries({ queryKey: ["activity", "photo"] });
  }
}

// 批量读照片浏览活动（mediaKind: "photo"）。
// 照片工作台里相册的进度条读的是它，不是漫画页码。
export function usePhotoActivities(albumIds: string[], enabled = true) {
  const canonicalAlbumIds = useMemo(
    () => Array.from(new Set(albumIds)).sort(),
    [albumIds],
  );

  return useQuery({
    queryKey: ["activity-query", "photo", canonicalAlbumIds],
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
        chunks.map((chunk) => activityApi.queryPhotos(chunk)),
      );
      return responses.reduce<Record<string, PhotoActivity>>(
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

// 把图片活动推到最后一个 0-based 页索引。
//
// contentKind 决定写哪一种活动：漫画相册写 image（页码），
// 照片相册写 photo（浏览位置）。写错的话，照片相册的「未浏览」判定
// 看的是 photo 活动，标记完它仍然算没看过。
export function useMarkAlbumRead() {
  const queryClient = useQueryClient();
  return useMutation<Activity, Error, { albumId: string; total: number; contentKind?: ContentKind }>({
    mutationFn: ({ albumId, total, contentKind = "comic" }) => {
      if (total <= 0) throw new Error("empty albums cannot be marked as read");
      return contentKind === "photo"
        ? activityApi.setPhoto(albumId, total - 1, total)
        : activityApi.setImage(albumId, total - 1, total);
    },
    onSuccess: (_data, { albumId }) =>
      invalidateImageActivities(queryClient, albumId),
  });
}

// 未读由没有图片活动表达；不能写入第 0 页来重置。
export function useResetAlbumRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      albumId,
      contentKind = "photo",
    }: {
      albumId: string;
      contentKind?: ContentKind;
    }) =>
      contentKind === "photo"
        ? activityApi.removePhoto(albumId)
        : activityApi.removeImage(albumId),
    onSuccess: (_data, { albumId }) =>
      invalidateImageActivities(queryClient, albumId),
  });
}

// 批量标记已读只落盘一次。
export function useMarkAlbumsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      items: { albumId: string; total: number; contentKind?: ContentKind }[],
    ) => {
      const readable = items.filter((item) => item.total > 0);
      if (readable.length === 0) {
        return { ok: 0, failed: 0, total: items.length };
      }
      const result = await activityApi.setBatch(
        readable.map((item) => ({
          albumId: item.albumId,
          mediaKind:
            item.contentKind === "photo" ? ("photo" as const) : ("image" as const),
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
