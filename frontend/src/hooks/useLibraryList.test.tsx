import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { libraryApi, type LibraryListQuery } from "../api/library";
import { ApiError } from "../api/client";
import { useLibraryList } from "./useLibraryList";
import { listFixture } from "../test-library-list";

vi.mock("./useAppMode", () => ({ useAppMode: () => ({ ready: true }) }));
vi.mock("../api/library", async (original) => ({
  ...(await original<typeof import("../api/library")>()),
  libraryApi: { overview: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());
const node = (id: string) => ({
  id,
  kind: "album" as const,
  contentKind: "comic" as const,
  name: id,
  displayName: id,
  coverImages: [],
  imageCount: 3,
});
function page(id: string, nextCursor?: string) {
  return {
    ok: true,
    page: {
      ...listFixture({ data: { items: [node(id)] } }).summary!,
      nextCursor,
    },
  };
}
function setup(initial: LibraryListQuery) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(({ query }) => useLibraryList(query), {
    wrapper,
    initialProps: { query: initial },
  });
}

it("只加载首屏，追加分页失败保留内容，重试后再合并", async () => {
  vi.mocked(libraryApi.overview).mockResolvedValueOnce(page("a_first", "next"));
  const query: LibraryListQuery = { kind: "comic" };
  const { result } = setup(query);
  await waitFor(() => expect(result.current.cards).toHaveLength(1));
  expect(libraryApi.overview).toHaveBeenCalledTimes(1);
  vi.mocked(libraryApi.overview).mockRejectedValue(
    new ApiError(404, "missing"),
  );
  await act(async () => {
    await result.current.fetchNextPage();
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.cards[0].title).toBe("a_first");
  vi.mocked(libraryApi.overview).mockResolvedValueOnce(page("a_second"));
  await act(async () => {
    await result.current.fetchNextPage();
  });
  await waitFor(() =>
    expect(result.current.cards.map((card) => card.title)).toEqual([
      "a_first",
      "a_second",
    ]),
  );
});

it("筛选变化从第一页开始，过期游标丢弃旧分页链", async () => {
  vi.mocked(libraryApi.overview).mockResolvedValueOnce(page("old", "next"));
  const { result, rerender } = setup({ kind: "comic", sort: "name" });
  await waitFor(() => expect(result.current.cards[0]?.title).toBe("old"));
  vi.mocked(libraryApi.overview)
    .mockRejectedValueOnce(
      new ApiError(409, "changed", undefined, "stale_cursor"),
    )
    .mockResolvedValue(page("fresh"));
  await act(async () => {
    await result.current.fetchNextPage();
  });
  await waitFor(() =>
    expect(result.current.cards.map((card) => card.title)).toEqual(["fresh"]),
  );
  rerender({ query: { kind: "photo", q: "旅行" } });
  await waitFor(() =>
    expect(libraryApi.overview).toHaveBeenLastCalledWith(
      { kind: "photo", q: "旅行" },
      undefined,
      expect.any(AbortSignal),
    ),
  );
});
