import { useEffect, useMemo } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import {
  libraryApi,
  type LibraryFeedAlbum,
  type LibraryFeedItem,
  type LibraryFeedSource,
  type MediaFeedQuery,
} from "../api/library";
import { useAppMode } from "./useAppMode";

/**
 * 跨相册的照片流。
 *
 * 首页的照片墙与年份墙都用它：照片来自不同的相册，条目自带相册信息，
 * 用户看得出出处、也回得去原来的位置。
 *
 * year / collection 两种取材会翻页，recent / random 一次给完整的一批。
 */
export function useMediaFeed(query: MediaFeedQuery, enabled = true) {
  const { ready } = useAppMode();
  const client = useQueryClient();
  const key = useMemo(
    () => ["library", "mode", query.kind, "feed", query] as const,
    [query],
  );
  const result = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      libraryApi.mediaFeed(query, pageParam, signal).then((r) => r.page),
    getNextPageParam: (page) => page.nextCursor || undefined,
    enabled: ready && enabled,
    retry: (count, error) =>
      !(
        error instanceof ApiError &&
        ["stale_cursor", "invalid_cursor"].includes(error.code ?? "")
      ) && count < 1,
  });
  // 游标失效说明库变了：清掉分页链重取首屏，而不是把整页判成失败。
  useEffect(() => {
    if (
      result.error instanceof ApiError &&
      ["stale_cursor", "invalid_cursor"].includes(result.error.code ?? "")
    ) {
      void client.resetQueries({ queryKey: key, exact: true });
    }
  }, [result.error, client, key]);

  const items = useMemo<LibraryFeedItem[]>(
    () => result.data?.pages.flatMap((page) => page.items) ?? [],
    [result.data],
  );
  // 相册清单取第一页：它描述的是整个取材范围，不随已加载页数变化。
  const albums = useMemo<LibraryFeedAlbum[]>(
    () => result.data?.pages[0]?.albums ?? [],
    [result.data],
  );
  // 取材范围里被选中的节点（年份对应的集合）。
  const sources = useMemo<LibraryFeedSource[]>(
    () => result.data?.pages[0]?.sources ?? [],
    [result.data],
  );
  const total = result.data?.pages[0]?.total ?? items.length;

  return {
    ...result,
    items,
    albums,
    sources,
    total,
    query,
  };
}
