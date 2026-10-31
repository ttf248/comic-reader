import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useVideoCover } from "./useVideoCover";
import { captureVideoFrame } from "../utils/videoFrame";

vi.mock("../utils/videoFrame", () => ({ captureVideoFrame: vi.fn() }));
beforeEach(() => {
  vi.mocked(captureVideoFrame).mockReset();
  vi.mocked(captureVideoFrame).mockResolvedValue(
    new Blob(["jpeg"], { type: "image/jpeg" }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("封面探测断网后显示失败，手动重试可以恢复", async () => {
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useVideoCover("f_network"));
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(fetchMock).toHaveBeenCalledTimes(1);

  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([401, 403, 500])("HTTP %s 不轮询或下载整段视频", async (status) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status }));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useVideoCover("f_denied"));
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("组件卸载会中止尚未完成的封面探测并清理计时器", async () => {
  vi.useFakeTimers();
  let requestSignal: AbortSignal | undefined;
  const fetchMock = vi.fn(
    (_url: string, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = options?.signal ?? undefined;
        requestSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const onStatusChange = vi.fn();
  const { unmount } = renderHook(() =>
    useVideoCover("f_pending", { onStatusChange }),
  );
  expect(requestSignal?.aborted).toBe(false);
  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(requestSignal?.aborted).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(onStatusChange).not.toHaveBeenCalledWith("error");
  expect(vi.getTimerCount()).toBe(0);
});

it("探测请求一直无响应也会超时中止并进入浏览器回退", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  let probeSignal: AbortSignal | undefined;
  const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
    if (options?.method === "HEAD") {
      probeSignal = options.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        probeSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }
    return Promise.resolve(new Response(null, { status: 400 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useVideoCover("f_timeout"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(probeSignal?.aborted).toBe(true);
  expect(captureVideoFrame).toHaveBeenCalledWith(
    "f_timeout",
    expect.any(AbortSignal),
  );
  expect(result.current.status).toBe("error");
  expect(vi.getTimerCount()).toBe(0);
});

it("浏览器抽帧上传后用原资源 URL 显示封面，不把刷新参数写进资源 ID", async () => {
  vi.useFakeTimers();
  let uploaded = false;
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "HEAD") {
      return new Response(null, { status: uploaded ? 200 : 404 });
    }
    if (url.endsWith("/cover")) {
      uploaded = true;
      return new Response(null, { status: 200 });
    }
    return new Response(new Blob(["video"]), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  const { result } = renderHook(() => useVideoCover("f_cover_test"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(23_000);
  });

  expect(uploaded).toBe(true);
  expect(result.current.status).toBe("ready");
  expect(result.current.url).toBe("/api/thumbs/f_cover_test");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/thumbs/f_cover_test/cover",
    expect.objectContaining({ method: "POST" }),
  );
});

it("切换资源后取消旧抽帧，不上传迟到结果或覆盖新封面状态", async () => {
  vi.useFakeTimers();
  let resolveOld: (blob: Blob) => void = () => {};
  vi.mocked(captureVideoFrame).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const fetchMock = vi.fn(
    async (url: string) =>
      new Response(null, { status: url.includes("f_old") ? 404 : 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { result, rerender } = renderHook(useVideoCover, {
    initialProps: "f_old",
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(result.current.status).toBe("extracting");
  const oldSignal = vi.mocked(captureVideoFrame).mock.calls[0][1];

  rerender("f_new");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => {
    resolveOld(new Blob(["late"]));
  });
  expect(result.current.status).toBe("ready");
  expect(result.current.url).toBe("/api/thumbs/f_new");
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/cover"))).toBe(
    false,
  );
});

it("卸载时也会取消正在上传的封面", async () => {
  vi.useFakeTimers();
  let uploadSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        uploadSignal = options.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          uploadSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
  const { unmount } = renderHook(() => useVideoCover("f_upload"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(uploadSignal?.aborted).toBe(false);
  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(uploadSignal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
