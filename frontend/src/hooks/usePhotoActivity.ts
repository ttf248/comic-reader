import { useCallback, useEffect, useRef } from "react";
import { activityApi } from "../api/activity";

const WRITE_INTERVAL_MS = 1500;

/**
 * 记录照片浏览进度（最后看到第几张）。
 *
 * 与漫画阅读进度分开存放：照片墙里翻到第 12 张，不应该被当成
 * 「漫画读到第 12 页」。写入按最小间隔节流，避免快速翻图时打出
 * 一串请求；离开页面时补一次最后位置。
 */
export function usePhotoActivity(albumId: string | null | undefined) {
  const pendingRef = useRef<{ index: number; total: number } | null>(null);
  const lastWriteRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending || !albumId) return;
    pendingRef.current = null;
    lastWriteRef.current = Date.now();
    void activityApi.setPhoto(albumId, pending.index, pending.total).catch(
      () => {},
    );
  }, [albumId]);

  const record = useCallback(
    (index: number, total: number) => {
      if (!albumId || total <= 0) return;
      pendingRef.current = { index, total };
      const elapsed = Date.now() - lastWriteRef.current;
      if (elapsed >= WRITE_INTERVAL_MS) {
        flush();
        return;
      }
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        flush();
      }, WRITE_INTERVAL_MS - elapsed);
    },
    [albumId, flush],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      flush();
    };
  }, [flush]);

  return { record };
}
