import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useHistoryCards } from "./useHistory";
import { historyApi } from "../api/prefs";
import { libraryApi } from "../api/library";
import type { LibraryNodeSummary } from "../api/library";

vi.mock("../api/prefs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/prefs")>();
  return { ...actual, historyApi: { ...actual.historyApi, list: vi.fn() } };
});

vi.mock("../api/library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/library")>();
  return { ...actual, libraryApi: { ...actual.libraryApi, queryNodes: vi.fn() } };
});

function node(
  id: string,
  contentKind: "photo" | "comic",
): LibraryNodeSummary {
  return {
    id,
    kind: "album",
    name: `相册 ${id}`,
    displayName: `相册 ${id}`,
    imageCount: 12,
    coverImages: [],
    contentKind,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

describe("useHistoryCards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(historyApi.list).mockResolvedValue({
      history: [
        { albumId: "a_photo", name: "相册 a_photo", imageCount: 12, openedAt: "2024-05-02T00:00:00Z" },
        { albumId: "a_comic", name: "相册 a_comic", imageCount: 30, openedAt: "2024-05-01T00:00:00Z" },
      ],
    });
    vi.mocked(libraryApi.queryNodes).mockResolvedValue({
      revision: 1,
      items: [node("a_photo", "photo"), node("a_comic", "comic")],
      missing: [],
    });
  });

  it("只返回当前工作台那一侧的相册，并保留最近在前", async () => {
    const { result } = renderHook(() => useHistoryCards("photo"), { wrapper });

    await waitFor(() => expect(result.current.cards).toHaveLength(1));
    expect(result.current.cards[0].id).toBe("a:a_photo");
    expect(result.current.cards[0].lastSeenAt).toBe("2024-05-02T00:00:00Z");
  });

  it("漫画侧只拿到漫画相册", async () => {
    const { result } = renderHook(() => useHistoryCards("comic"), { wrapper });

    await waitFor(() => expect(result.current.cards).toHaveLength(1));
    expect(result.current.cards[0].id).toBe("a:a_comic");
  });

  it("另一侧的访问记录仍然算「已解析」，不算相册失效", async () => {
    const { result } = renderHook(() => useHistoryCards("photo"), { wrapper });

    await waitFor(() => expect(result.current.cards).toHaveLength(1));
    // 两条记录都还指向库里的相册，只有一条属于另一侧。
    expect(result.current.resolvedCount).toBe(2);
  });

  it("相册确实不在库里时不算已解析", async () => {
    vi.mocked(libraryApi.queryNodes).mockResolvedValue({
      revision: 1,
      items: [],
      missing: ["a_photo", "a_comic"],
    });
    const { result } = renderHook(() => useHistoryCards("photo"), { wrapper });

    await waitFor(() => expect(result.current.resolvedCount).toBe(0));
    expect(result.current.cards).toHaveLength(0);
  });
});
