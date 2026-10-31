import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressEvent } from "../api/scan";
import { useScanStore } from "../store/scanStore";
import { useScanSSE } from "./useScanSSE";

interface ConnectionOptions {
  signal?: AbortSignal;
  onError?: (event: Event, state: "reconnecting" | "closed") => void;
}
interface Connection {
  path: string;
  onEvent: (name: string, data: unknown) => void;
  options: ConnectionOptions;
  close: ReturnType<typeof vi.fn>;
}
const sseMock = vi.hoisted(() => ({ connections: [] as Connection[] }));
vi.mock("../api/client", () => ({
  sse: vi.fn(
    (
      path: string,
      onEvent: Connection["onEvent"],
      options: ConnectionOptions,
    ) => {
      const close = vi.fn();
      options.signal?.addEventListener("abort", close, { once: true });
      sseMock.connections.push({ path, onEvent, options, close });
      return close;
    },
  ),
}));
function progress(
  scanId: string,
  fields: Partial<ProgressEvent> = {},
): ProgressEvent {
  return {
    scanId,
    status: "running",
    progress: 37,
    albumsFound: 12,
    elapsedMs: 350,
    ...fields,
  };
}

describe("useScanSSE", () => {
  beforeEach(() => {
    act(() => useScanStore.getState().clear());
    sseMock.connections.length = 0;
    vi.clearAllMocks();
  });

  it("首次挂载前已选择的任务也会连接，多处订阅只创建一条连接", () => {
    act(() => useScanStore.getState().setActive("scan-1"));
    renderHook(() => useScanSSE());
    renderHook(() => useScanSSE());
    expect(sseMock.connections).toHaveLength(1);
    expect(sseMock.connections[0].path).toBe("/api/scans/scan-1/events");
  });

  it("保留终态直到显式 reset，并关闭完成的连接", () => {
    const { result, unmount } = renderHook(() => useScanSSE());
    act(() => result.current.startWith("scan-1"));
    const connection = sseMock.connections[0];
    const complete = progress("scan-1", { status: "complete", progress: 100 });
    act(() => connection.onEvent("complete", complete));
    expect(result.current.progress).toEqual(complete);
    expect(result.current.isComplete).toBe(true);
    expect(connection.options.signal?.aborted).toBe(true);
    expect(connection.close).toHaveBeenCalledOnce();
    act(() => connection.options.onError?.(new Event("error"), "closed"));
    expect(result.current.connectionState).toBe("idle");
    unmount();
    expect(useScanStore.getState().progress).toEqual(complete);
    act(() => useScanStore.getState().clear());
    expect(useScanStore.getState().progress).toBeNull();
  });

  it("连接失败保留最后进度，连续手动重连只请求一次同一任务", () => {
    const { result } = renderHook(() => useScanSSE());
    act(() => result.current.startWith("scan-1"));
    const first = sseMock.connections[0];
    const last = progress("scan-1");
    act(() => first.onEvent("running", last));
    act(() => first.options.onError?.(new Event("error"), "closed"));
    expect(result.current.progress).toEqual(last);
    expect(result.current.connectionState).toBe("disconnected");
    expect(result.current.isRunning).toBe(true);
    expect(result.current.isError).toBe(false);
    act(() => {
      result.current.reconnect();
      result.current.reconnect();
    });
    expect(sseMock.connections).toHaveLength(2);
    expect(sseMock.connections[1].path).toBe(first.path);
    expect(first.options.signal?.aborted).toBe(true);
    expect(result.current.progress).toEqual(last);
    expect(result.current.connectionState).toBe("connecting");
    act(() => first.onEvent("error", progress("scan-1", { status: "error" })));
    expect(result.current.isError).toBe(false);
    act(() =>
      sseMock.connections[1].onEvent(
        "complete",
        progress("scan-1", { status: "complete", progress: 100 }),
      ),
    );
    expect(result.current.isComplete).toBe(true);
  });

  it("原生自动重连恢复后更新进度，不创建额外连接", () => {
    const { result } = renderHook(() => useScanSSE());
    act(() => result.current.startWith("scan-1"));
    const connection = sseMock.connections[0];
    act(() => connection.onEvent("running", progress("scan-1")));
    act(() => connection.options.onError?.(new Event("error"), "reconnecting"));
    expect(result.current.connectionState).toBe("reconnecting");
    expect(result.current.progress?.progress).toBe(37);
    act(() =>
      connection.onEvent("running", progress("scan-1", { progress: 62 })),
    );
    expect(result.current.connectionState).toBe("connected");
    expect(result.current.progress?.progress).toBe(62);
    expect(sseMock.connections).toHaveLength(1);
  });

  it("离开后保留连接与失败状态，重新进入仍可重连", () => {
    const first = renderHook(() => useScanSSE());
    act(() => first.result.current.startWith("scan-1"));
    const connection = sseMock.connections[0];
    first.unmount();
    expect(connection.options.signal?.aborted).toBe(false);
    act(() => connection.options.onError?.(new Event("error"), "closed"));
    const next = renderHook(() => useScanSSE());
    expect(next.result.current.connectionState).toBe("disconnected");
    expect(sseMock.connections).toHaveLength(1);
    act(() => next.result.current.reconnect());
    expect(sseMock.connections).toHaveLength(2);
  });

  it("旧任务和畸形消息不能修改当前进度", () => {
    const { result } = renderHook(() => useScanSSE());
    act(() => result.current.startWith("old"));
    const old = sseMock.connections[0];
    act(() => result.current.startWith("current"));
    const current = sseMock.connections[1];
    const last = progress("current");
    act(() => current.onEvent("running", last));
    for (const data of [
      undefined,
      null,
      "raw",
      {},
      progress("other"),
      progress("current", { elapsedMs: NaN }),
      progress("current", { albumsFound: -1 }),
      progress("current", { error: 1 as unknown as string }),
    ]) {
      act(() => current.onEvent("running", data));
    }
    act(() => old.onEvent("complete", progress("old", { status: "complete" })));
    act(() => old.options.onError?.(new Event("error"), "closed"));
    expect(result.current.progress).toEqual(last);
    expect(result.current.connectionState).toBe("connected");
    expect(result.current.scanId).toBe("current");
  });

  it("重复跟随同一任务不回退已知进度，断开时可重新跟随", () => {
    const { result } = renderHook(() => useScanSSE());
    act(() => result.current.startWith("scan-1"));
    const connection = sseMock.connections[0];
    act(() => connection.onEvent("running", progress("scan-1")));
    act(() => result.current.startWith("scan-1"));
    expect(result.current.progress?.progress).toBe(37);
    expect(sseMock.connections).toHaveLength(1);
    act(() => connection.options.onError?.(new Event("error"), "closed"));
    act(() => result.current.startWith("scan-1"));
    expect(sseMock.connections).toHaveLength(2);
    expect(result.current.progress?.progress).toBe(37);
  });

  it("reset 关闭连接并忽略迟到进度，不能重连已清除的任务", () => {
    const { result } = renderHook(() => useScanSSE());
    act(() => result.current.startWith("scan-1"));
    const connection = sseMock.connections[0];
    act(() => result.current.reset());
    act(() => connection.onEvent("running", progress("scan-1")));
    act(() => result.current.reconnect());
    expect(result.current.scanId).toBeNull();
    expect(result.current.progress).toBeNull();
    expect(result.current.connectionState).toBe("idle");
    expect(connection.close).toHaveBeenCalledOnce();
    expect(sseMock.connections).toHaveLength(1);
  });
});
