import {
  useInfiniteQuery,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { aiJobsApi } from "../api/aiJobs";
import type { ChinaLocationRegions, ChinaLocationSummary } from "../api/aiJobs";

/** 全国省级地图的查询键。 */
const chinaSummaryQueryKey = ["china-locations"] as const;

/** 某个区域的下一级地图的查询键。 */
function chinaRegionsQueryKey(adcode: number) {
  return ["china-locations", "regions", adcode] as const;
}

/** 某个区域的照片墙查询键。 */
function chinaRegionMediaQueryKey(adcode: number) {
  return ["china-locations", "region-media", adcode] as const;
}

/** 全国省级照片地图。 */
export function useChinaSummary(): UseQueryResult<ChinaLocationSummary> {
  return useQuery({
    queryKey: chinaSummaryQueryKey,
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
): UseQueryResult<ChinaLocationRegions> {
  return useQuery({
    queryKey: chinaRegionsQueryKey(adcode ?? 0),
    queryFn: () =>
      aiJobsApi.chinaRegions(adcode as number).then((result) => result.regions),
    enabled: adcode !== null,
  });
}

/** 某个区域的照片墙。 */
export function useChinaRegionMedia(adcode: number | null) {
  return useInfiniteQuery({
    queryKey: chinaRegionMediaQueryKey(adcode ?? 0),
    queryFn: ({ pageParam }) =>
      aiJobsApi
        .chinaRegionMedia(adcode as number, pageParam)
        .then((result) => result.page),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: adcode !== null,
  });
}
