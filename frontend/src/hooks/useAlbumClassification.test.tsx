import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { albumsApi } from "../api/albums";
import { useAlbumClassification } from "./useAlbumClassification";
import { useUIStore } from "../store/uiStore";

vi.mock("../api/albums", () => ({
  albumsApi: {
    setContentKind: vi.fn(),
    clearContentKind: vi.fn(),
  },
}));

vi.mock("./useLibrary", () => ({
  libraryQueryKeys: { root: ["library"] },
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useAlbumClassification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ toasts: [] });
  });

  it("归类会写服务端并给出提示", async () => {
    vi.mocked(albumsApi.setContentKind).mockResolvedValue({
      ok: true,
      contentKind: "comic",
      contentKindDefault: "photo",
      contentKindOverridden: true,
    });
    const { result } = renderHook(() => useAlbumClassification("a_1"), { wrapper });
    await result.current.moveTo.mutateAsync("comic");
    expect(albumsApi.setContentKind).toHaveBeenCalledWith("a_1", "comic");
    await waitFor(() =>
      expect(
        useUIStore.getState().toasts.some((t) => t.message === "已移到漫画库"),
      ).toBe(true),
    );
  });

  it("恢复默认类型会清掉相册级覆盖", async () => {
    vi.mocked(albumsApi.clearContentKind).mockResolvedValue({
      ok: true,
      contentKind: "photo",
      contentKindDefault: "photo",
      contentKindOverridden: false,
    });
    const { result } = renderHook(() => useAlbumClassification("a_1"), { wrapper });
    await result.current.resetToDefault.mutateAsync();
    expect(albumsApi.clearContentKind).toHaveBeenCalledWith("a_1");
    await waitFor(() =>
      expect(
        useUIStore
          .getState()
          .toasts.some((t) => t.message === "已恢复为照片相册"),
      ).toBe(true),
    );
  });

  it("归类失败时提示错误", async () => {
    vi.mocked(albumsApi.setContentKind).mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useAlbumClassification("a_1"), { wrapper });
    await expect(result.current.moveTo.mutateAsync("comic")).rejects.toThrow();
    await waitFor(() =>
      expect(
        useUIStore.getState().toasts.some((t) => t.kind === "error"),
      ).toBe(true),
    );
  });
});
