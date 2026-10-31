import { useMemo } from "react";
import { useFavorites } from "./useFavorites";
import { useLibraryManifest, useLibraryUnreadAlbums } from "./useLibrary";
import type { CardData } from "../components/album/AlbumGrid";
import { nodeSummaryToCard } from "../utils/libraryCard";

// useUnreadAlbums 只装配服务端已经筛好的未读摘要与本地收藏状态。
// 已读相册及其图片活动不会再下载到浏览器；完整列表仍保持现有网格交互。
export function useUnreadAlbums(): {
  cards: CardData[];
  count: number;
  total: number;
  isLoading: boolean;
} {
  const { favorites } = useFavorites();
  const favSet = useMemo(() => new Set(favorites), [favorites]);
  const unreadQuery = useLibraryUnreadAlbums();
  const manifestQuery = useLibraryManifest();
  const unreadItems = unreadQuery.data?.items;

  const cards = useMemo<CardData[]>(
    () =>
      (unreadItems ?? []).map((album) => ({
        ...nodeSummaryToCard(album, "u:"),
        isFavorite: favSet.has(album.id),
      })),
    [unreadItems, favSet],
  );

  return {
    cards,
    count: unreadQuery.data?.total ?? 0,
    total: manifestQuery.data?.manifest.statistics.albumCount ?? 0,
    isLoading:
      (unreadQuery.isLoading || manifestQuery.isLoading) && cards.length === 0,
  };
}
