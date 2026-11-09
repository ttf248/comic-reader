import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityApi } from "../api/activity";
import { ApiError } from "../api/client";
import {
  useImageActivity,
  useImageActivities,
  useMarkAlbumsRead,
  useMarkAlbumRead,
} from "./useImageActivity";

vi.mock("../api/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/activity")>();
  return {
    ...actual,
    activityApi: {
      getImage: vi.fn(),
      setImage: vi.fn(),
      queryImages: vi.fn(),
      setBatch: vi.fn(),
    },
  };
});

const testQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={testQueryClient}>
      {children}
    </QueryClientProvider>
  );
}

beforeEach(() => testQueryClient.clear());

describe("useImageActivity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("只把明确的活动不存在响应映射为 null", async () => {
    vi.mocked(activityApi.getImage).mockRejectedValue(
      new ApiError(404, "not found", undefined, "activity_not_found"),
    );
    const { result } = renderHook(
      () => useImageActivity("a_0000000000000000000001"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("保留存储故障供页面显示或重试", async () => {
    vi.mocked(activityApi.getImage).mockRejectedValue(
      new ApiError(500, "unavailable", undefined, "activity_unavailable"),
    );
    const { result } = renderHook(
      () => useImageActivity("a_0000000000000000000001"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({
      status: 500,
      code: "activity_unavailable",
    });
  });
});

describe("useMarkAlbumsRead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(activityApi.setBatch).mockResolvedValue({ ok: true, updated: 2 });
  });

  it("整批只发送一次请求", async () => {
    const { result } = renderHook(() => useMarkAlbumsRead(), { wrapper });
    let response: { ok: number; failed: number; total: number } | undefined;
    await act(async () => {
      response = await result.current.mutateAsync([
        { albumId: "a_0000000000000000000001", total: 12 },
        { albumId: "a_0000000000000000000002", total: 20 },
      ]);
    });

    expect(activityApi.setBatch).toHaveBeenCalledTimes(1);
    expect(activityApi.setBatch).toHaveBeenCalledWith([
      {
        albumId: "a_0000000000000000000001",
        mediaKind: "image",
        pageIndex: 11,
        pageCount: 12,
      },
      {
        albumId: "a_0000000000000000000002",
        mediaKind: "image",
        pageIndex: 19,
        pageCount: 20,
      },
    ]);
    expect(activityApi.setImage).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: 2, failed: 0, total: 2 });
  });

  it("批量标记跳过没有图片的空相册", async () => {
    vi.mocked(activityApi.setBatch).mockResolvedValue({ ok: true, updated: 1 });
    const { result } = renderHook(() => useMarkAlbumsRead(), { wrapper });
    let response: { ok: number; failed: number; total: number } | undefined;
    await act(async () => {
      response = await result.current.mutateAsync([
        { albumId: "a_0000000000000000000001", total: 12 },
        { albumId: "a_0000000000000000000002", total: 0 },
      ]);
    });
    expect(response).toEqual({ ok: 1, failed: 1, total: 2 });
    expect(activityApi.setBatch).toHaveBeenCalledWith([
      {
        albumId: "a_0000000000000000000001",
        mediaKind: "image",
        pageIndex: 11,
        pageCount: 12,
      },
    ]);
  });
});

describe("useMarkAlbumRead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(activityApi.setImage).mockResolvedValue({
      albumId: "a_0000000000000000000001",
      mediaKind: "image",
      pageIndex: 11,
      pageCount: 12,
      status: "completed",
      updated: "",
    });
  });

  it("把完成位置写成最后一个 0-based 索引", async () => {
    const { result } = renderHook(() => useMarkAlbumRead(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        albumId: "a_0000000000000000000001",
        total: 12,
      });
    });

    expect(activityApi.setImage).toHaveBeenCalledWith(
      "a_0000000000000000000001",
      11,
      12,
      "explicit",
    );
  });

  it("拒绝把空相册伪造成一页已读活动", async () => {
    const { result } = renderHook(() => useMarkAlbumRead(), { wrapper });
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({
          albumId: "a_0000000000000000000001",
          total: 0,
        });
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("empty albums");
    expect(activityApi.setImage).not.toHaveBeenCalled();
  });
});

describe("useImageActivities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(activityApi.queryImages).mockImplementation(async (albumIds) => ({
      count: albumIds.length,
      activities: albumIds.map((albumId) => ({
        albumId,
        mediaKind: "image" as const,
        pageIndex: 1,
        pageCount: 10,
        status: "in_progress" as const,
        updated: "",
      })),
    }));
  });

  it("去重并分块读取大批量进度", async () => {
    const albumIds = Array.from(
      { length: 1_001 },
      (_, index) => `a_${index.toString().padStart(22, "0")}`,
    );
    albumIds.push(albumIds[0]);

    const { result } = renderHook(() => useImageActivities(albumIds), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(activityApi.queryImages).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(activityApi.queryImages).mock.calls.map(([ids]) => ids.length),
    ).toEqual([1_000, 1]);
    expect(Object.keys(result.current.data ?? {})).toHaveLength(1_001);
  });
});
