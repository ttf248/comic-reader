import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { picksApi, type PicksList } from "../api/picks";

const EMPTY_PICKS: PicksList = { picks: [], total: 0, revision: 0 };

export const picksQueryKey = ["picks"] as const;

type PicksCache = PicksList;

/**
 * 精选的全局读写。
 *
 * 客户端只有一份真相：精选的文件 ID 集合。它跨相册、跨页面共享，
 * 因此在任意一处加入精选，照片墙、精选页与大图预览里的同一张照片
 * 会同时更新 —— 不必去改各个列表自己的缓存。
 */
export function usePicks() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: picksQueryKey,
    queryFn: () => picksApi.list(),
    staleTime: 30_000,
  });

  const ids = useMemo(
    () => new Set(query.data?.picks ?? []),
    [query.data?.picks],
  );

  const isPicked = useCallback((id: string) => ids.has(id), [ids]);

  /**
   * 把服务端在媒体项上标出的精选并进本地集合。
   *
   * 集合还没回来时，媒体项自带的 picked 标记能先把状态画出来，
   * 不用等两轮请求都落地。集合一旦就绪就以集合为准：它是最新的一份。
   */
  const mergeServerFlags = useCallback(
    (items: readonly { id: string; picked?: boolean }[]) => {
      if (!query.isLoading) return;
      const flagged = items.filter((item) => item.picked).map((item) => item.id);
      if (flagged.length === 0) return;
      qc.setQueryData<PicksCache>(picksQueryKey, (prev) => {
        const current = prev ?? EMPTY_PICKS;
        const next = new Set(current.picks);
        for (const id of flagged) next.add(id);
        return { ...current, picks: [...next], total: next.size };
      });
    },
    [qc, query.isLoading],
  );

  /**
   * 批量加入或移出精选。
   *
   * 先按本地集合改一次，界面立刻响应；服务端确认后再取一次权威结果。
   * 写失败就退回原样 —— 界面不能停在一个服务端并不认可的状态上。
   */
  const mutate = useCallback(
    async (targets: string[], action: "add" | "remove") => {
      if (targets.length === 0) return;
      const key = picksQueryKey;
      const before = qc.getQueryData<PicksCache>(key);
      qc.setQueryData<PicksCache>(key, (prev) => {
        const current = prev ?? EMPTY_PICKS;
        const next = new Set(current.picks);
        for (const id of targets) {
          if (action === "add") next.add(id);
          else next.delete(id);
        }
        return { ...current, picks: [...next], total: next.size };
      });
      try {
        await picksApi.batch(targets, action);
      } catch (error) {
        qc.setQueryData(key, before);
        throw error;
      }
      // 精选页的条目也在这个键的前缀下：移出的照片会从那一页消失。
      void qc.invalidateQueries({ queryKey: picksQueryKey });
    },
    [qc],
  );

  return {
    ids,
    total: query.data?.total ?? ids.size,
    isLoading: query.isLoading,
    isError: query.isError,
    isPicked,
    mergeServerFlags,
    add: (targets: string[]) => mutate(targets, "add"),
    remove: (targets: string[]) => mutate(targets, "remove"),
    toggle: (id: string) => mutate([id], ids.has(id) ? "remove" : "add"),
  };
}
