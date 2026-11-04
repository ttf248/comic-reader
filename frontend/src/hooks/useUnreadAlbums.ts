import { useMemo } from "react";
import { useFavorites } from "./useFavorites";
import { useLibraryManifest, useLibraryUnreadAlbums } from "./useLibrary";
import { useAppMode } from "./useAppMode";
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
  const { mode } = useAppMode();
  const unreadItems = unreadQuery.data?.items;

  const cards = useMemo(
    () =>
      (unreadItems ?? []).map((album) => ({
        ...nodeSummaryToCard(album, "u:"),
        isFavorite: favSet.has(album.id),
      })),
    [unreadItems, favSet],
  );

  // 分母是当前工作台下的相册总数：拿全库总数会让「还有 3 本没看 / 全库 200 本」
  // 在照片工作台里变成一句误导的话。
  const statistics = manifestQuery.data?.manifest.statistics;
  const total =
    mode === "comic"
      ? (statistics?.comicAlbumCount ?? 0)
      : mode === "photo"
        ? (statistics?.photoAlbumCount ?? 0)
        : (statistics?.albumCount ?? 0);

  return {
    cards,
    count: unreadQuery.data?.total ?? 0,
    total,
    isLoading:
      (unreadQuery.isLoading || manifestQuery.isLoading) && cards.length === 0,
  };
}
