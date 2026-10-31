import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useVideoCover } from "./useVideoCover";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL() {
        return "blob:cover-test";
      }
      static revokeObjectURL() {}
    },
  );

  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
    const element = createElement(tag, options);
    if (tag === "video") {
      Object.defineProperties(element, {
        duration: { value: 2 },
        videoWidth: { value: 16 },
        videoHeight: { value: 16 },
        src: {
          set: () =>
            queueMicrotask(() =>
              element.dispatchEvent(new Event("loadedmetadata")),
            ),
        },
        currentTime: {
          set: () =>
            queueMicrotask(() => element.dispatchEvent(new Event("seeked"))),
        },
      });
    }
    if (tag === "canvas") {
      Object.defineProperties(element, {
        getContext: { value: () => ({ drawImage: vi.fn() }) },
        toBlob: {
          value: (callback: BlobCallback) =>
            callback(new Blob(["jpeg"], { type: "image/jpeg" })),
        },
      });
    }
    return element;
  });

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
