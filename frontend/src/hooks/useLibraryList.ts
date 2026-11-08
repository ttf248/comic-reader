import { useEffect, useMemo } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import {
  libraryApi,
  type LibraryListQuery,
  type LibraryListItem,
} from "../api/library";
import { useAppMode } from "./useAppMode";
import { nodeSummaryToCard, tagSummaryToCard } from "../utils/libraryCard";

export function listItemToCard(item: LibraryListItem, query: LibraryListQuery) {
  const card =
    item.kind === "smart"
      ? tagSummaryToCard(item.tag, query.kind)
      : nodeSummaryToCard(item.node);
  if (query.parent && item.kind !== "smart" && item.node.virtual) {
    return { ...card, title: "散图", subtitle: "" };
  }
  return card;
}

export function useLibraryList(query: LibraryListQuery, enabled = true) {
  const { ready } = useAppMode();
  const client = useQueryClient();
  const key = useMemo(
    () => ["library", "mode", query.kind, "list", query] as const,
    [query],
  );
  const result = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      libraryApi.overview(query, pageParam, signal).then((r) => r.page),
    getNextPageParam: (page) => page.nextCursor || undefined,
    enabled: ready && enabled,
    retry: (count, error) =>
      !(
        error instanceof ApiError &&
        ["stale_cursor", "invalid_cursor"].includes(error.code ?? "")
      ) && count < 1,
  });
  useEffect(() => {
    if (
      result.error instanceof ApiError &&
      ["stale_cursor", "invalid_cursor"].includes(result.error.code ?? "")
    ) {
      void client.resetQueries({ queryKey: key, exact: true });
    }
  }, [result.error, client, key]);
  const cards = useMemo(
    () =>
      result.data?.pages.flatMap((page) =>
        page.items.map((item) => listItemToCard(item, query)),
      ) ?? [],
    [result.data, query],
  );
  return {
    ...result,
    cards,
    summary: result.data?.pages[0],
    query,
    nextCursor: result.data?.pages.at(-1)?.nextCursor,
  };
}

export function listYearGroups(
  page: import("../api/library").LibraryListPage | undefined,
  query: LibraryListQuery,
): import("../utils/albumGrouping").YearGroup[] {
  return (page?.years ?? []).map((group) => ({
    year: group.year,
    label: group.year === null ? "其他" : String(group.year),
    albums: [listItemToCard(group.target, query)],
    count: group.count,
    imageTotal: group.imageTotal,
    videoTotal: group.videoTotal,
    totalFiles: group.imageTotal + group.videoTotal,
    coverPreviewPaths: group.coverImage ? [group.coverImage] : [],
  }));
}
