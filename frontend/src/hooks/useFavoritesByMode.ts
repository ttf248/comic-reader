import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFavorites } from "./useFavorites";
import { useLibraryNodes } from "./useLibrary";
import {
  libraryApi,
  type AppMode,
  type LibraryNodeSummary,
  type LibraryTagSummary,
} from "../api/library";
import type { CardData } from "../components/album/AlbumGrid";
import { nodeSummaryToCard, tagSummaryToCard } from "../utils/libraryCard";

/**
 * 收藏按工作台拆开看。
 *
 * 收藏本身是一份全局数据（相册 / 集合 / smart:<标签> 混在一个列表里），
 * 但每个工作台只呈现属于自己这一侧的部分。关键是分清两件事：
 *
 *  - 「这个条目在当前侧看不到」——它属于另一侧，不是失效；
 *  - 「这个条目在库里根本不存在」——那才是失效，可以清理。
 *
 * 早期版本把两者混为一谈：只含漫画的标签收藏在照片工作台里查不到，
 * 被判成失效，用户点一次「清理失效收藏」就真的把它删了。
 */

/** 智能标签收藏的 ID 前缀。 */
const SMART_PREFIX = "smart:";

export interface FavoritesByMode {
  /** 当前侧可见的收藏卡片。 */
  cards: CardData[];
  /** 当前侧的收藏数量。 */
  count: number;
  /** 真失效的收藏 ID：库里已经没有这个资源了。 */
  missingIds: string[];
  isLoading: boolean;
  isError: boolean;
  /** 相册 / 集合摘要读取失败。 */
  nodesFailed: boolean;
  /** 智能标签摘要读取失败。 */
  tagsFailed: boolean;
  /** 摘要还在读：此时「空」只是没加载完，不是真的没有。 */
  detailsLoading: boolean;
  /** 重试失败的那一路读取。 */
  retry: () => void;
}

/** 按名批量解析标签摘要。查询键与模式无关：两侧的册数一次拿全。 */
export function useLibraryTagSummaries(names: string[]) {
  const unique = useMemo(
    () => Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))),
    [names],
  );
  return useQuery({
    queryKey: ["library", "tags", "summary", unique],
    queryFn: () => libraryApi.queryTags(unique),
    enabled: unique.length > 0,
    staleTime: 30_000,
  });
}

export function useFavoritesByMode(mode: AppMode): FavoritesByMode {
  const {
    favorites,
    isLoading: favLoading,
    isError: favError,
    refetch: refetchFavorites,
  } = useFavorites();

  const nodeIds = useMemo(
    () => favorites.filter((id) => !id.startsWith(SMART_PREFIX)),
    [favorites],
  );
  const smartNames = useMemo(
    () =>
      favorites
        .filter((id) => id.startsWith(SMART_PREFIX))
        .map((id) => id.slice(SMART_PREFIX.length)),
    [favorites],
  );

  const nodesQuery = useLibraryNodes(nodeIds);
  const tagsQuery = useLibraryTagSummaries(smartNames);

  const nodesById = useMemo(() => {
    const map = new Map<string, LibraryNodeSummary>();
    for (const node of nodesQuery.data?.items ?? []) map.set(node.id, node);
    return map;
  }, [nodesQuery.data]);

  const tagsByName = useMemo(() => {
    const map = new Map<string, LibraryTagSummary>();
    for (const tag of tagsQuery.data?.result.items ?? [])
      map.set(tag.tag, tag);
    return map;
  }, [tagsQuery.data]);

  const cards = useMemo(() => {
    const out: CardData[] = [];
    for (const id of favorites) {
      if (id.startsWith(SMART_PREFIX)) {
        const name = id.slice(SMART_PREFIX.length);
        const tag = tagsByName.get(name);
        // 标签在库里但当前侧没有作品：属于另一侧，不出现在这里。
        if (!tag) continue;
        const count =
          mode === "comic" ? (tag.comicAlbumCount ?? 0) : (tag.photoAlbumCount ?? 0);
        if (count <= 0) continue;
        out.push({ ...tagSummaryToCard(tag, mode), isFavorite: true });
        continue;
      }
      const node = nodesById.get(id);
      if (!node) continue;
      // 收藏是用户的显式选择，但工作台只呈现当前这一类：
      // 照片工作台里不该冒出一本漫画。
      if (node.contentKind !== mode) continue;
      out.push({ ...nodeSummaryToCard(node), isFavorite: true });
    }
    return out;
  }, [favorites, nodesById, tagsByName, mode]);

  const missingIds = useMemo(() => {
    if (nodesQuery.isLoading || tagsQuery.isLoading) return [];
    return favorites.filter((id) => {
      if (id.startsWith(SMART_PREFIX)) {
        // 只有库里根本没有的标签才算失效；只属于另一侧的标签不是。
        return !tagsByName.has(id.slice(SMART_PREFIX.length));
      }
      return !nodesById.has(id);
    });
  }, [favorites, nodesById, tagsByName, nodesQuery.isLoading, tagsQuery.isLoading]);

  const nodesFailed = nodeIds.length > 0 && nodesQuery.isError;
  const tagsFailed = smartNames.length > 0 && tagsQuery.isError;

  // 重试只打失败的那一路：收藏列表本身没问题就别再拉一遍。
  const retry = useCallback(() => {
    if (favError) void refetchFavorites();
    if (nodesFailed) void nodesQuery.refetch();
    if (tagsFailed) void tagsQuery.refetch();
  }, [favError, refetchFavorites, nodesFailed, nodesQuery, tagsFailed, tagsQuery]);

  return {
    cards,
    count: cards.length,
    missingIds,
    isLoading: favLoading || nodesQuery.isLoading || tagsQuery.isLoading,
    isError: favError || nodesQuery.isError || tagsQuery.isError,
    nodesFailed,
    tagsFailed,
    detailsLoading:
      (nodeIds.length > 0 && nodesQuery.isLoading) ||
      (smartNames.length > 0 && tagsQuery.isLoading),
    retry,
  };
}
