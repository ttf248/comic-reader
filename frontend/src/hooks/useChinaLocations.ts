import {
  useInfiniteQuery,
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
 */
export function useChinaOutline(parent: number | null) {
  return useQuery({
    queryKey: chinaOutlineQueryKey(parent ?? 0),
    queryFn: () =>
      aiJobsApi
        .chinaGeometry("children", parent)
        .then((result) => result.features),
    staleTime: Infinity,
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
  from: string | null,
  to: string | null,
) {
  return ["china-locations", "trips", granularity, from, to] as const;
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
        .then((result) => result.places),
  });
}

/** 行程与停留：什么时候去了哪些地方。 */
export function useChinaTrips(
  granularity: string,
  timeRange?: ChinaTimeRange,
) {
  const from = timeRange?.from ?? null;
  const to = timeRange?.to ?? null;
  return useQuery({
    queryKey: chinaTripsQueryKey(granularity, from, to),
    queryFn: () =>
      aiJobsApi
        .chinaTrips(granularity, timeRange)
        .then((result) => result.trips),
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
