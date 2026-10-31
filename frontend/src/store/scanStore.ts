import { create } from "zustand";
import type { ProgressEvent } from "../api/scan";

// 扫描状态共享 store：
//   - 单一来源：所有「当前扫描进度 / 状态」走这里
//   - 单 SSE 连接：模块层管理一个 EventSource（hooks/useScanSSE.ts）
//   - 写：setActive(id) 启动 / clear() 结束（订阅自动跟随）
//
// 调用方不直接订阅 SSE,只读写 store 即可：
//   const { progress, isRunning } = useScanStore()
//   useScanStore.getState().setActive(scanId)

export type ScanStatus = ProgressEvent["status"];
export type ScanConnectionState =
  "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

interface ScanState {
  scanId: string | null;
  progress: ProgressEvent | null;
  connectionState: ScanConnectionState;
  setActive: (id: string) => void;
  setProgress: (p: ProgressEvent) => void;
  setConnectionState: (state: ScanConnectionState) => void;
  clear: () => void;
}

// 起始 placeholder：用户点「重新扫描」后，UI 立即能看到「扫描中」卡片
// （不必等到第一个 SSE 事件 — 缓存命中时整个 scan < 50ms，UI 根本来不及响应）
function makePending(id: string): ProgressEvent {
  return {
    scanId: id,
    progress: 0,
    status: "pending",
    albumsFound: 0,
    elapsedMs: 0,
  };
}

export const useScanStore = create<ScanState>((set) => ({
  scanId: null,
  progress: null,
  connectionState: "idle",
  setActive: (id) =>
    set({
      scanId: id,
      progress: makePending(id),
      connectionState: "connecting",
    }),
  setProgress: (p) =>
    set({
      progress: p,
      connectionState:
        p.status === "pending" || p.status === "running" ? "connected" : "idle",
    }),
  setConnectionState: (connectionState) => set({ connectionState }),
  clear: () => set({ scanId: null, progress: null, connectionState: "idle" }),
}));
