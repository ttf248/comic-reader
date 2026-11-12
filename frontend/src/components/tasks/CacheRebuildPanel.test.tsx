import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CacheRebuildPanel from "./CacheRebuildPanel";
import { cacheApi } from "../../api/cache";

const sseMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, sse: sseMock };
});

vi.mock("../../api/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/cache")>();
  return {
    ...actual,
    cacheApi: {
      ...actual.cacheApi,
      stats: vi.fn(),
      clearCache: vi.fn(),
      startRebuild: vi.fn(),
      cancelRebuild: vi.fn(),
      rebuildStatus: vi.fn(),
    },
  };
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CacheRebuildPanel />
    </QueryClientProvider>,
  );
}

describe("CacheRebuildPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sseMock.mockReturnValue(() => {});
    vi.mocked(cacheApi.startRebuild).mockResolvedValue({
      ok: true,
      jobId: "job-1",
      reused: false,
      scopes: ["thumbs"],
      previewWidth: 0,
    });
    vi.mocked(cacheApi.clearCache).mockResolvedValue({
      scope: "thumbs",
      thumbs: { deleted: 1, freedBytes: 10 },
      totalDeleted: 1,
      totalFreedBytes: 10,
    });
  });

  it("按勾选的范围启动重建", async () => {
    renderPanel();
    // 默认两类都重建。
    fireEvent.click(screen.getByRole("button", { name: "重建缓存" }));

    await waitFor(() =>
      expect(cacheApi.startRebuild).toHaveBeenCalledWith(
        ["thumbs", "previews"],
        1280,
      ),
    );
  });

  it("取消勾选后只重建剩下的范围", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: "预览图" }));
    fireEvent.click(screen.getByRole("button", { name: "重建缓存" }));

    await waitFor(() =>
      expect(cacheApi.startRebuild).toHaveBeenCalledWith(["thumbs"], undefined),
    );
  });

  it("清空并重建会先清缓存再重建", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "清空并重建" }));

    await waitFor(() => expect(cacheApi.clearCache).toHaveBeenCalled());
    await waitFor(() => expect(cacheApi.startRebuild).toHaveBeenCalled());
    expect(
      vi.mocked(cacheApi.clearCache).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(cacheApi.startRebuild).mock.invocationCallOrder[0],
    );
  });

  it("没选范围时按钮不可用，不会误启动", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: "缩略图" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "预览图" }));

    expect(screen.getByRole("button", { name: "重建缓存" })).toBeDisabled();
    expect(cacheApi.startRebuild).not.toHaveBeenCalled();
  });
});
