import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { activityApi } from "../api/activity";

interface Options {
  albumId: string;
  pageIndex: number;
  pageCount: number;
  enabled: boolean;
  onSaved: () => void;
  onSaveFailed: () => void;
}

// 图片进度的去抖和已确认写入后的缓存刷新。翻页状态仍属于阅读器；
// 全局写入顺序由 activityApi 管理，清理定时器不会取消已经发送的请求。
export function useImageProgressSync({
  albumId,
  pageIndex,
  pageCount,
  enabled,
  onSaved,
  onSaveFailed,
}: Options) {
  const queryClient = useQueryClient();
  const save = useCallback(
    async (id: string, index: number, count: number) => {
      try {
        await activityApi.setImage(id, index, count);
        onSaved();
        void queryClient.invalidateQueries({
          queryKey: ["activity-query", "image"],
        });
        void queryClient.invalidateQueries({
          queryKey: ["activity", "image", id],
        });
      } catch (error) {
        onSaveFailed();
        throw error;
      }
    },
    [queryClient, onSaved, onSaveFailed],
  );

  useEffect(() => {
    if (!enabled || !albumId || pageCount <= 0) return;
    const timer = setTimeout(() => {
      void save(albumId, pageIndex, pageCount).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [albumId, pageIndex, pageCount, enabled, save]);

  return { save };
}
