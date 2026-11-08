import { vi } from "vitest";
import type {
  LibraryNodeSummary,
  LibraryListQuery,
  LibraryListPage,
} from "./api/library";
import { listItemToCard } from "./hooks/useLibraryList";
import { groupLibraryNodesByYear } from "./utils/albumGrouping";

// 路由测试使用服务端已分页结果；筛选排序规则由后端测试覆盖。
export function listFixture(
  fixture: {
    data?: { items: LibraryNodeSummary[]; total?: number; revision?: number };
    isLoading?: boolean;
  },
  query: LibraryListQuery = { kind: "photo", parent: "fixture" },
) {
  const nodes = fixture.data?.items ?? [];
  const items = nodes.map((node) => ({ kind: node.kind, node }));
  const counts = {
    all: nodes.length,
    album: nodes.filter((n) => n.kind === "album").length,
    collection: nodes.filter((n) => n.kind === "collection").length,
    smart: 0,
  };
  const summary: LibraryListPage | undefined = fixture.data
    ? {
        revision: fixture.data.revision ?? 1,
        items,
        total: fixture.data.total ?? nodes.length,
        counts,
        years: groupLibraryNodesByYear(nodes).map((group) => ({
          year: group.year,
          count: group.albums.length,
          imageTotal: group.imageTotal,
          videoTotal: group.videoTotal,
          target:
            items.find((i) => i.node.id === group.albums[0]?.id.slice(2)) ??
            items[0],
        })),
        series: [],
        imageTotal: nodes.reduce((sum, n) => sum + (n.imageCount ?? 0), 0),
        videoTotal: nodes.reduce((sum, n) => sum + (n.videoCount ?? 0), 0),
      }
    : undefined;
  return {
    ...fixture,
    summary,
    cards: items.map((item) => listItemToCard(item, query)),
    query,
    data: summary ? { pages: [summary], pageParams: [undefined] } : undefined,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetching: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    nextCursor: undefined,
  };
}
