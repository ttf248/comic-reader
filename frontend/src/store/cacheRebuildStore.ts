import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CacheRebuildProgress } from "../api/cache";

// 缓存重建状态共享 store：
//   - 单一来源：面板、其它页面看到的都是同一份进度
//   - jobId 跨页面保留：重建要跑几分钟，用户不能因为切走页面就看不到进度
//   - 写：setActive(id) 启动 / clear() 结束
//
// 只持久化 jobId：进度与连接状态每次连接都会重新拿到，存下来只会
// 在刷新瞬间闪一个过期的数字。
export type CacheRebuildConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected";

interface CacheRebuildState {
  jobId: string | null;
  progress: CacheRebuildProgress | null;
  connectionState: CacheRebuildConnectionState;
  setActive: (id: string) => void;
  setProgress: (p: CacheRebuildProgress) => void;
  setConnectionState: (state: CacheRebuildConnectionState) => void;
  clear: () => void;
}

export const useCacheRebuildStore = create<CacheRebuildState>()(
  persist(
    (set) => ({
      jobId: null,
      progress: null,
      connectionState: "idle",
      setActive: (id) =>
        set({ jobId: id, progress: null, connectionState: "connecting" }),
      setProgress: (p) =>
        set({
          progress: p,
          connectionState:
            p.status === "pending" || p.status === "running" ? "connected" : "idle",
        }),
      setConnectionState: (connectionState) => set({ connectionState }),
      clear: () => set({ jobId: null, progress: null, connectionState: "idle" }),
    }),
    {
      name: "local-gallery-cache-rebuild",
      partialize: (state) => ({ jobId: state.jobId }),
    },
  ),
);
