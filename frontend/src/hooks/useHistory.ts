import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { historyApi } from "../api/prefs";
import { compareDatesDesc } from "../utils/date";

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
