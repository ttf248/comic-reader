import { useEffect } from "react";
import { useScanStore } from "../store/scanStore";
import { sse } from "../api/client";
import type { ProgressEvent } from "../api/scan";

// 后端用 `event: <status>` 推送，所以前端必须显式列出要监听的 event 名称。
// 与 backend/services 里的 ScanStatus 对齐。
const SCAN_EVENTS = ["pending", "running", "complete", "cancelled", "error"];

// 扫描进度订阅（模块级单 EventSource + 共享 store）。
//
// 设计要点：
//   - 全局只维护一个 EventSource：避免 N 个组件挂载产生 N 个连接占用后端。
//   - 订阅触发来自 useScanStore.scanId：任何组件调
//     useScanStore.getState().setActive(id) 启动扫描后，全局所有读 useScanStore
//     的视图都能看到 progress（修复了之前每个 hook 实例独立持 scanId 的 bug）。
//   - 连接生命周期跟随 scanId，而不是任一组件的挂载生命周期；路由切换不会
//     丢失正在进行的扫描或刚收到的终态。
//   - 首个 hook 挂载时注册持久的 store watcher；此后 store.setActive() 触发的
//     进度会立刻被推送到所有读取 useScanStore 的视图。

let currentAbort: AbortController | null = null;
let storeUnsub: (() => void) | null = null;

function ensureStoreWatch() {
  if (storeUnsub) return;
  storeUnsub = useScanStore.subscribe((state, prev) => {
    if (state.scanId === prev.scanId) return;
    if (state.scanId) startSubscription(state.scanId);
    else closeConnection();
  });
  const { scanId, progress } = useScanStore.getState();
  if (
    scanId &&
    (progress?.status === "pending" || progress?.status === "running")
  )
    startSubscription(scanId);
}

function isProgressEvent(
  data: unknown,
  scanId: string,
  eventName: string,
): data is ProgressEvent {
  if (!data || typeof data !== "object") return false;
  const event = data as Record<string, unknown>;
  return (
    event.scanId === scanId &&
    event.status === eventName &&
    SCAN_EVENTS.includes(eventName) &&
    typeof event.progress === "number" &&
    Number.isFinite(event.progress) &&
    typeof event.albumsFound === "number" &&
    Number.isFinite(event.albumsFound) &&
    event.albumsFound >= 0 &&
    typeof event.elapsedMs === "number" &&
    Number.isFinite(event.elapsedMs) &&
    event.elapsedMs >= 0 &&
    ["phase", "currentPath", "error"].every(
      (key) => event[key] === undefined || typeof event[key] === "string",
    )
  );
}

function startSubscription(scanId: string) {
  closeConnection();
  const ac = new AbortController();
  currentAbort = ac;
  useScanStore.getState().setConnectionState("connecting");
  const isCurrent = () =>
    !ac.signal.aborted &&
    currentAbort === ac &&
    useScanStore.getState().scanId === scanId;

  sse(
    `/api/scans/${encodeURIComponent(scanId)}/events`,
    (eventName, data) => {
      if (!isCurrent() || !isProgressEvent(data, scanId, eventName)) return;
      const ev = data;
      useScanStore.getState().setProgress(ev);
      if (
        ev.status === "complete" ||
        ev.status === "cancelled" ||
        ev.status === "error"
      ) {
        // 终态：只关连接，保留 scanId + progress，让调用方
        // 仍能用 scanId 拉取本次扫描结果。显式 reset 才清掉终态。
        if (currentAbort === ac) {
          currentAbort = null;
        }
        ac.abort();
      }
    },
    {
      events: SCAN_EVENTS,
      signal: ac.signal,
      onError: (_event, state) => {
        if (isCurrent())
          useScanStore
            .getState()
            .setConnectionState(
              state === "closed" ? "disconnected" : "reconnecting",
            );
      },
    },
  );
}

function closeConnection() {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }
}

export function useScanSSE() {
  // 第一次渲染时确保模块级 watcher 已挂上。卸载组件不会关闭连接或清空终态；
  // 只有扫描终止/显式 reset/切换 scanId 才改变全局连接。
  useEffect(() => {
    ensureStoreWatch();
  }, []);

  // 直接读 zustand store（reactive：scanId/progress 变化自动 re-render 调用方）
  const scanId = useScanStore((s) => s.scanId);
  const progress = useScanStore((s) => s.progress);
  const connectionState = useScanStore((s) => s.connectionState);

  return {
    scanId,
    progress,
    connectionState,
    isRunning: progress?.status === "running" || progress?.status === "pending",
    isComplete: progress?.status === "complete",
    isCancelled: progress?.status === "cancelled",
    isError: progress?.status === "error",
    // 启动扫描：写 store.scanId，模块级 watcher 自动开 EventSource。
    startWith: (id: string) => {
      const state = useScanStore.getState();
      if (state.scanId === id) {
        if (
          state.connectionState === "disconnected" ||
          state.connectionState === "reconnecting"
        )
          startSubscription(id);
        return;
      }
      state.setActive(id);
    },
    reset: () => useScanStore.getState().clear(),
    reconnect: () => {
      const state = useScanStore.getState();
      if (
        !state.scanId ||
        (state.progress?.status !== "pending" &&
          state.progress?.status !== "running")
      )
        return;
      if (
        state.connectionState !== "disconnected" &&
        state.connectionState !== "reconnecting"
      )
        return;
      startSubscription(state.scanId);
    },
  };
}
