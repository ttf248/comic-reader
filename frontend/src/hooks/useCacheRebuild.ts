import { useEffect, useRef } from "react";
import { sse } from "../api/client";
import type { CacheRebuildProgress, CacheRebuildStatus } from "../api/cache";
import { useCacheRebuildStore } from "../store/cacheRebuildStore";

const REBUILD_EVENTS: CacheRebuildStatus[] = [
  "pending",
  "running",
  "complete",
  "cancelled",
  "error",
];

function isRebuildProgress(value: unknown): value is CacheRebuildProgress {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CacheRebuildProgress>;
  return (
    typeof candidate.jobId === "string" && typeof candidate.status === "string"
  );
}

/**
 * 订阅缓存重建任务的进度。
 *
 * 连接的生命周期跟着 jobId 走，不跟着组件挂载走：设置页被切走再切回来，
 * 重建也还在跑，进度不该断。jobId 存在共享 store 里，跨页面也接得上。
 */
export function useCacheRebuild() {
  const jobId = useCacheRebuildStore((s) => s.jobId);
  const progress = useCacheRebuildStore((s) => s.progress);
  const connectionState = useCacheRebuildStore((s) => s.connectionState);
  const setProgress = useCacheRebuildStore((s) => s.setProgress);
  const setConnectionState = useCacheRebuildStore((s) => s.setConnectionState);
  const clear = useCacheRebuildStore((s) => s.clear);

  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!jobId) return;
    setConnectionState("connecting");
    const close = sse(
      `/api/cache/rebuild/${encodeURIComponent(jobId)}/events`,
      (_name, data) => {
        if (!isRebuildProgress(data)) return;
        setProgress(data);
        if (data.status !== "pending" && data.status !== "running") {
          // 终态之后服务端会关闭连接；不主动关掉的话 EventSource
          // 会自己重连，反复订阅一个已经结束的任务。
          closeRef.current?.();
          closeRef.current = null;
        }
      },
      {
        events: REBUILD_EVENTS,
        onError: (_err, state) => {
          setConnectionState(
            state === "reconnecting" ? "connected" : "disconnected",
          );
        },
      },
    );
    closeRef.current = close;
    return () => {
      close();
      closeRef.current = null;
    };
  }, [jobId, setConnectionState, setProgress]);

  const running =
    progress?.status === "running" || progress?.status === "pending";

  return {
    jobId,
    progress,
    connectionState,
    isRunning: running,
    isComplete: progress?.status === "complete",
    isCancelled: progress?.status === "cancelled",
    isError: progress?.status === "error",
    start: (id: string) => useCacheRebuildStore.getState().setActive(id),
    reset: clear,
  };
}
