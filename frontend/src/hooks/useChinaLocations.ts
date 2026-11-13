import { useMemo } from "react";
import {
  keepPreviousData,
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
  ChinaPoints,
  ChinaTimeRange,
} from "../api/aiJobs";

/** 全国省级地图的查询键。 */
function chinaSummaryQueryKey(
  scope: "window" | "all",
  from: string | null,
  to: string | null,
) {
  return ["china-locations", "summary", scope, from, to] as const;
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
    queryKey: chinaSummaryQueryKey("window", from, to),
    queryFn: () =>
      aiJobsApi.chinaLocations(timeRange).then((result) => result.locations),
  });
}

/**
 * 全库的月度分布与照片数，不带时间区间。
 *
 * 时间带要靠它画出那把尺子：窗口只是尺子上的一段高亮，尺子本身不能随
 * 窗口变。查询键与带区间的那个分开，否则两者会互相顶掉。
 */
export function useChinaSummaryAll(): UseQueryResult<ChinaLocationSummary> {
  return useQuery({
    queryKey: chinaSummaryQueryKey("all", null, null),
    queryFn: () =>
      aiJobsApi.chinaLocations().then((result) => result.locations),
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
  scope: "window" | "all",
  level: string,
  parent: number | null,
  from: string | null,
  to: string | null,
) {
  return ["china-locations", "places", scope, level, parent, from, to] as const;
}

/** 行程的查询键。 */
function chinaTripsQueryKey(
  scope: "window" | "all",
  granularity: string,
  gapDays: number,
  from: string | null,
  to: string | null,
) {
  return [
    "china-locations",
    "trips",
    scope,
    granularity,
    gapDays,
    from,
    to,
  ] as const;
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
    queryKey: chinaPlacesQueryKey("window", level, parent, from, to),
    queryFn: () =>
      aiJobsApi
        .chinaPlaces(level, parent, timeRange)
        .then((result) => result.places.items),
  });
}

/**
 * 去过的所有地方，不带时间区间。
 *
 * 地图上的形状取这一份：拖时间区间时地图不该重画 —— 位置稳定的图比
 * 每次都换一张的图好读。区间里的张数另取一份。
 */
export function useChinaPlacesAll(level: string, parent: number | null) {
  return useQuery({
    queryKey: chinaPlacesQueryKey("all", level, parent, null, null),
    queryFn: () =>
      aiJobsApi
        .chinaPlaces(level, parent, undefined)
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
    queryKey: chinaTripsQueryKey("window", granularity, gapDays ?? 0, from, to),
    queryFn: () =>
      aiJobsApi
        .chinaTrips(granularity, timeRange, gapDays)
        .then((result) => result.trips.items),
  });
}

/**
 * 全库的行程与停留，不带时间区间。
 *
 * 行程不随时间区间重切：段是按「粒度 + 间隔」切出来的，照片端点按段
 * 的下标寻址，两边必须同一套口径。带区间的行程会随区间重排，段的
 * 下标就再也指不到同一段照片了。
 *
 * 因此时间带画的是全量行程，区间只决定哪些段被点亮。
 */
export function useChinaTripsAll(granularity: string, gapDays?: number) {
  return useQuery({
    queryKey: chinaTripsQueryKey("all", granularity, gapDays ?? 0, null, null),
    queryFn: () =>
      aiJobsApi
        .chinaTrips(granularity, undefined, gapDays)
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

/** 点位聚合的查询键。 */
function chinaPointsQueryKey(from: string | null, to: string | null, cell: number) {
  return ["china-locations", "points", from, to, cell] as const;
}

/** 按区划码取轮廓的查询键。 */
function chinaFeaturesQueryKey(adcodes: number[]) {
  return ["china-locations", "features", adcodes.join(",")] as const;
}

/** 一批区划码的上限：URL 放不下更多，轮廓本身也不小。 */
const CHINA_FEATURE_BATCH = 200;

/**
 * 照片位置的网格聚合。
 *
 * 点位是地图的密度来源：行政区只说「落在哪个市」，点位才画得出城市
 * 的样子。坐标只以网格下发。
 */
export function useChinaPoints(
  timeRange?: ChinaTimeRange,
  cell = 0.02,
): UseQueryResult<ChinaPoints> {
  const from = timeRange?.from ?? null;
  const to = timeRange?.to ?? null;
  return useQuery({
    queryKey: chinaPointsQueryKey(from, to, cell),
    queryFn: () =>
      aiJobsApi.chinaPoints(timeRange, cell).then((result) => result.points),
    // 换区间时先留着上一批点：地图不该闪一下空白。
    placeholderData: keepPreviousData,
  });
}

/**
 * 按区划码取绘图轮廓。
 *
 * 地图画的单元就是「去过的地方」本身，按各自的区划码取形状 —— 直辖市、
 * 省直辖县级市这些层级不齐的地方，前端推不出父级。
 */
export function useChinaFeatures(adcodes: number[]) {
  const key = useMemo(
    () => [...new Set(adcodes)].sort((left, right) => left - right),
    [adcodes],
  );
  const batches = useMemo(() => {
    const result: number[][] = [];
    for (let index = 0; index < key.length; index += CHINA_FEATURE_BATCH) {
      result.push(key.slice(index, index + CHINA_FEATURE_BATCH));
    }
    return result;
  }, [key]);
  const results = useQueries({
    queries: batches.map((batch) => ({
      queryKey: chinaFeaturesQueryKey(batch),
      queryFn: () =>
        aiJobsApi.chinaFeatures(batch).then((result) => result.features),
      staleTime: Infinity,
    })),
  });
  return useMemo(
    () => results.flatMap((result) => result.data ?? []),
    [results],
  );
}

/**
 * 全国省级轮廓。
 *
 * 现有的 useChinaOutline 走的是「取上级的下级」，而上级必须是正整数，
 * 拿全国省图要用 geometry/province。
 */
export function useChinaProvinceOutline() {
  return useQuery({
    queryKey: ["china-locations", "outline", "province"] as const,
    queryFn: () =>
      aiJobsApi.chinaGeometry("province").then((result) => result.features),
    staleTime: Infinity,
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
