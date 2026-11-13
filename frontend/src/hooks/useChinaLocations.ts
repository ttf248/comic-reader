import { useMemo } from "react";
import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { aiJobsApi } from "../api/aiJobs";
import type {
  ChinaLocationRegions,
  ChinaLocationSummary,
  ChinaLocationVisits,
  ChinaTimeRange,
} from "../api/aiJobs";

/** 全国省级地图的查询键。 */
function chinaSummaryQueryKey(from: string | null, to: string | null) {
  return ["china-locations", "summary", from, to] as const;
}

/** 绘图轮廓的查询键。 */
function chinaOutlineQueryKey(parent: number) {
  return ["china-locations", "outline", parent] as const;
}

/**
 * 若干个上级区划的下级轮廓。
 *
 * 一段行程可能同时经过几个上级（省或市），地图要把它们画在同一张图上，
 * 因此一次取回多份轮廓再合并。上级为 0 表示全国（各省）。
 */
export function useChinaOutlines(parents: number[]) {
  const key = useMemo(
    () => [...new Set(parents)].sort((left, right) => left - right),
    [parents],
  );
  const results = useQueries({
    queries: key.map((parent) => ({
      queryKey: chinaOutlineQueryKey(parent),
      queryFn: () =>
        aiJobsApi
          .chinaGeometry("children", parent)
          .then((result) => result.features),
      staleTime: Infinity,
    })),
  });
  return useMemo(
    () => results.flatMap((result) => result.data ?? []),
    [results],
  );
}

/** 某个区域的下一级地图的查询键。 */
function chinaRegionsQueryKey(
  adcode: number,
  from: string | null,
  to: string | null,
) {
  return ["china-locations", "regions", adcode, from, to] as const;
}

/** 某个区域的照片墙查询键。 */
function chinaRegionMediaQueryKey(
  adcode: number,
  from: string | null,
  to: string | null,
  visit: number | null,
) {
  return ["china-locations", "region-media", adcode, from, to, visit] as const;
}

/** 某个区域的到访记录查询键。 */
function chinaRegionVisitsQueryKey(
  adcode: number,
  from: string | null,
  to: string | null,
) {
  return ["china-locations", "visits", adcode, from, to] as const;
}

/** 全国省级照片地图。 */
export function useChinaSummary(
  timeRange?: ChinaTimeRange,
): UseQueryResult<ChinaLocationSummary> {
  const from = timeRange?.from ?? null;
  const to = timeRange?.to ?? null;
  return useQuery({
    queryKey: chinaSummaryQueryKey(from, to),
    queryFn: () =>
      aiJobsApi.chinaLocations(timeRange).then((result) => result.locations),
  });
}

/**
 * 某个区域的下一级地图。
 *
 * 没有聚焦区域时不发请求：全国层级的地图由汇总接口直接给出。
 */
export function useChinaRegions(
  adcode: number | null,
  timeRange?: ChinaTimeRange,
): UseQueryResult<ChinaLocationRegions> {
  const from = timeRange?.from ?? null;
  const to = timeRange?.to ?? null;
  return useQuery({
    queryKey: chinaRegionsQueryKey(adcode ?? 0, from, to),
    queryFn: () =>
      aiJobsApi
        .chinaRegions(adcode as number, timeRange)
        .then((result) => result.regions),
    enabled: adcode !== null,
  });
}

/**
 * 当前层级的绘图轮廓。
 *
 * parent 为 null 表示全国。几何只随边界数据变化，不随媒体库或时间区间
 * 变化，因此不进统计接口的缓存键，也不随筛选失效。
 *
 * enabled 用来在页面还拿不到该画哪一层时先不发请求。
 */
export function useChinaOutline(parent: number | null, enabled = true) {
  return useQuery({
    queryKey: chinaOutlineQueryKey(parent ?? 0),
    queryFn: () =>
      aiJobsApi
        .chinaGeometry("children", parent)
        .then((result) => result.features),
    staleTime: Infinity,
    enabled,
  });
}

/** 地点索引的查询键。 */
function chinaPlacesQueryKey(
  level: string,
  parent: number | null,
  from: string | null,
  to: string | null,
) {
  return ["china-locations", "places", level, parent, from, to] as const;
}

/** 行程的查询键。 */
function chinaTripsQueryKey(
  granularity: string,
  gapDays: number,
  from: string | null,
  to: string | null,
) {
  return ["china-locations", "trips", granularity, gapDays, from, to] as const;
}

/**
 * 地点索引：去过哪些地方。
 *
 * level 是归并粒度（省 / 市 / 区县），parent 限定在某个上级之下。
 */
export function useChinaPlaces(
  level: string,
  parent: number | null,
  timeRange?: ChinaTimeRange,
) {
  const from = timeRange?.from ?? null;
  const to = timeRange?.to ?? null;
  return useQuery({
    queryKey: chinaPlacesQueryKey(level, parent, from, to),
    queryFn: () =>
      aiJobsApi
        .chinaPlaces(level, parent, timeRange)
        .then((result) => result.places.items),
  });
}

/** 某一段行程的照片的查询键。 */
function chinaTripMediaQueryKey(
  index: number,
  granularity: string,
  from: string | null,
  to: string | null,
) {
  return [
    "china-locations",
    "trip-media",
    index,
    granularity,
    from,
    to,
  ] as const;
}

/** 行程与停留：什么时候去了哪些地方。 */
export function useChinaTrips(
  granularity: string,
  timeRange?: ChinaTimeRange,
  gapDays?: number,
) {
  const from = timeRange?.from ?? null;
  const to = timeRange?.to ?? null;
  return useQuery({
    queryKey: chinaTripsQueryKey(granularity, gapDays ?? 0, from, to),
    queryFn: () =>
      aiJobsApi
        .chinaTrips(granularity, timeRange, gapDays)
        .then((result) => result.trips.items),
  });
}

/**
 * 某一段行程的照片。
 *
 * 段是按「粒度 + 间隔 + 时间区间」切出来的，因此取照片必须带上同样的
 * 粒度与时间区间，否则按下标取到的不是这一段。
 */
export function useChinaTripMedia(
  index: number | null,
  granularity: string,
  timeRange?: ChinaTimeRange,
) {
  const from = timeRange?.from ?? null;
  const to = timeRange?.to ?? null;
  return useInfiniteQuery({
    queryKey: chinaTripMediaQueryKey(index ?? -1, granularity, from, to),
    queryFn: ({ pageParam }) =>
      aiJobsApi
        .chinaTripMedia(
          index as number,
          granularity,
          timeRange,
          pageParam,
        )
        .then((result) => result.page),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: index !== null,
  });
}

/** 某个区域的到访记录。 */
export function useChinaRegionVisits(
  adcode: number | null,
  timeRange?: ChinaTimeRange,
): UseQueryResult<ChinaLocationVisits> {
  const from = timeRange?.from ?? null;
  const to = timeRange?.to ?? null;
  return useQuery({
    queryKey: chinaRegionVisitsQueryKey(adcode ?? 0, from, to),
    queryFn: () =>
      aiJobsApi
        .chinaRegionVisits(adcode as number, timeRange)
        .then((result) => result.visits),
    enabled: adcode !== null,
  });
}

/** 某个区域的照片墙。 */
export function useChinaRegionMedia(
  adcode: number | null,
  timeRange?: ChinaTimeRange,
  visit: number | null = null,
) {
  const from = timeRange?.from ?? null;
  const to = timeRange?.to ?? null;
  return useInfiniteQuery({
    queryKey: chinaRegionMediaQueryKey(adcode ?? 0, from, to, visit),
    queryFn: ({ pageParam }) =>
      aiJobsApi
        .chinaRegionMedia(
          adcode as number,
          pageParam,
          timeRange,
          visit ?? undefined,
        )
        .then((result) => result.page),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: adcode !== null,
  });
}
