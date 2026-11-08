import type { QueryClient } from "@tanstack/react-query";
import type { Prefs } from "../api/prefs";

// 写入已确认的历史快照，再刷新，避免读取失败时回显操作前的列表。
export function syncHistoryCache(
  client: QueryClient,
  history: Prefs["history"],
) {
  client.setQueryData(["history"], { history });
  client.setQueryData<Prefs>(["prefs"], (previous) =>
    previous ? { ...previous, history } : undefined,
  );
  void client.invalidateQueries({ queryKey: ["history"] });
  void client.invalidateQueries({
    predicate: (query) =>
      query.queryKey.includes("list") &&
      JSON.stringify(query.queryKey).includes('"viewed"'),
  });
}
