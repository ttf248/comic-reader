import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { historyApi, type Prefs } from "../api/prefs";
import type { AppMode } from "../api/library";
import { compareDatesDesc } from "../utils/date";
import { useLibraryNodes } from "./useLibrary";
import { nodeSummaryToCard } from "../utils/libraryCard";
import type { CardData } from "../components/album/AlbumCard";

const EMPTY_HISTORY: Prefs["history"] = [];

export function useHistory(enabled = true) {
  return useQuery({
    queryKey: ["history"],
    queryFn: () => historyApi.list(),
    staleTime: 30_000,
    enabled,
  });
}

export function useViewedSort(enabled: boolean) {
  const query = useHistory(enabled);
  const compareViewed = useMemo(() => {
    const times = new Map(
      (query.data?.history ?? []).map((entry) => [
        entry.albumId,
        entry.openedAt,
      ]),
    );
    return (firstId: string, secondId: string) =>
      compareDatesDesc(times.get(firstId), times.get(secondId));
  }, [query.data]);
  return { query, compareViewed };
}

/**
 * 最近访问过的相册，按当前工作台收敛成卡片。
 *
 * 访问历史是全局一份数据（照片与漫画的相册混在一起），但每个工作台只
 * 呈现属于自己这一侧的部分：照片工作台里不该冒出一本漫画，反过来也一样。
 * 收敛靠相册自身的 contentKind，而不是「最近打开的是哪一侧」——那是巧合，
 * 不能当规则。
 *
 * 顺序沿用服务端按 openedAt 倒序的访问记录：最近看过的排在最前。
 */
export function useHistoryCards(mode: AppMode, enabled = true) {
  const historyQuery = useHistory(enabled);
  const history = historyQuery.data?.history ?? EMPTY_HISTORY;
  const historyIds = useMemo(
    () => history.map((entry) => entry.albumId),
    [history],
  );
  const nodesQuery = useLibraryNodes(historyIds);
  const nodesById = useMemo(
    () =>
      new Map((nodesQuery.data?.items ?? []).map((node) => [node.id, node])),
    [nodesQuery.data],
  );

  const cards = useMemo<CardData[]>(() => {
    const out: CardData[] = [];
    for (const entry of history) {
      const node = nodesById.get(entry.albumId);
      if (!node || node.kind !== "album") continue;
      // 最近访问是用户的真实足迹，但工作台只呈现当前这一类：
      // 照片工作台里不该冒出一本漫画。
      if (node.contentKind !== mode) continue;
      out.push({ ...nodeSummaryToCard(node), lastSeenAt: entry.openedAt });
    }
    return out;
  }, [history, nodesById, mode]);

  // 仍然存在于媒体库里的访问记录条数（不分侧）。
  //
  // 它用来区分两种「这一侧没有记录」：访问过的相册全被移出媒体库了，
  // 还是这些记录都属于另一侧。前者要说「相册可能已移动」，后者只说
  // 「还没有记录」——照片侧不该知道漫画那边有人翻过书。
  const resolvedCount = useMemo(() => {
    let count = 0;
    for (const entry of history) {
      const node = nodesById.get(entry.albumId);
      if (node && node.kind === "album") count += 1;
    }
    return count;
  }, [history, nodesById]);

  return { history, cards, resolvedCount, historyQuery, nodesQuery };
}
