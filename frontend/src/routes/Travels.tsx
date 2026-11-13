import { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import PageHeading from "../components/common/PageHeading";
import Segmented from "../components/common/Segmented";
import { MapPinIcon } from "../components/common/Icon";
import TravelMap from "../components/travels/TravelMap";
import TravelPhotoWall from "../components/travels/TravelPhotoWall";
import TravelPlaceCard from "../components/travels/TravelPlaceCard";
import TravelStatLedger from "../components/travels/TravelStatLedger";
import TravelTimeAxis from "../components/travels/TravelTimeAxis";
import TravelTripList from "../components/travels/TravelTripList";
import {
  useChinaOutline,
  useChinaPlaces,
  useChinaSummary,
  useChinaTrips,
} from "../hooks/useChinaLocations";
import { travelPlaceRoute } from "../utils/path";
import type { MapRegion } from "../utils/travelMap";

/**
 * 行程的间隔上限（天）。
 *
 * 两天的口径是「回来算又一次到访」，把出门一趟切成好几段；两周之内
 * 还连着拍的地方算同一段出行。
 */
const TRAVEL_TRIP_GAP_DAYS = 14;

/** 归并粒度：地点索引按哪一层分组。 */
type PlaceLevel = "province" | "city" | "district";

/** 从查询参数里读月份（YYYY-MM）。 */
function parseMonth(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}$/.test(raw)) return null;
  return raw;
}

/**
 * 足迹：我去过哪些地方，什么时候去的。
 *
 * 页面按任务分三段：先给规模（数字台），再给时间（时间轴），最后是
 * 地点索引与行程 —— 地点与行程是主角，地图是右栏里的一件配图。
 */
export default function Travels() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const from = parseMonth(searchParams.get("from"));
  const to = parseMonth(searchParams.get("to"));
  const timeRange = useMemo(() => ({ from, to }), [from, to]);
  const level = (searchParams.get("level") as PlaceLevel | null) ?? "province";
  const [openTrip, setOpenTrip] = useState<string | null>(null);

  const summaryQuery = useChinaSummary(timeRange);
  const summary = summaryQuery.data;
  const placesQuery = useChinaPlaces(level, null, timeRange);
  const tripsQuery = useChinaTrips("city", timeRange, TRAVEL_TRIP_GAP_DAYS);
  const outlineQuery = useChinaOutline(null);

  const geometryByAdcode = useMemo(() => {
    const map = new Map<number, MapRegion["geometry"]>();
    for (const feature of outlineQuery.data ?? []) {
      map.set(feature.adcode, feature.geometry);
    }
    return map;
  }, [outlineQuery.data]);

  // 全国层级的地图：省。统计来自汇总，几何来自轮廓端点。
  const regions: MapRegion[] = useMemo(() => {
    return (summary?.provinces ?? []).map((province) => ({
      adcode: province.adcode,
      name: province.name,
      level: "province",
      photoCount: province.photoCount,
      geometry: geometryByAdcode.get(province.adcode) ?? null,
    }));
  }, [geometryByAdcode, summary?.provinces]);

  const levelTotal = summary?.chinaPhotoCount ?? 0;

  const setRange = useCallback(
    (nextFrom: string | null, nextTo: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (nextFrom && nextTo) {
        next.set("from", nextFrom);
        next.set("to", nextTo);
      } else {
        next.delete("from");
        next.delete("to");
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setLevel = useCallback(
    (next: string) => {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("level", next);
      setSearchParams(nextParams, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const places = useMemo(() => placesQuery.data ?? [], [placesQuery.data]);
  const trips = useMemo(() => tripsQuery.data ?? [], [tripsQuery.data]);
  const untimedCount = summary?.untimedPhotoCount ?? 0;

  const ledger = useMemo(() => {
    const placeCount = summary
      ? `${summary.provinceCount} 个省 · ${summary.cityCount} 个市`
      : "—";
    return [
      { value: trips.length.toLocaleString(), label: "段足迹" },
      { value: placeCount, label: "去过的地方" },
      {
        value: (summary?.gpsPhotoCount ?? 0).toLocaleString(),
        label: "张带位置的照片",
      },
      {
        value: untimedCount.toLocaleString(),
        label: "张没有拍摄时间",
      },
    ];
  }, [summary, trips.length, untimedCount]);

  const loading =
    summaryQuery.isLoading ||
    placesQuery.isLoading ||
    tripsQuery.isLoading ||
    outlineQuery.isLoading;
  const error =
    summaryQuery.isError ||
    placesQuery.isError ||
    tripsQuery.isError ||
    outlineQuery.isError;

  const activeTrip = trips.find((trip) => trip.id === openTrip) ?? null;

  return (
    <div className="h-full overflow-y-auto pb-12">
      <PageHeading
        eyebrow="离线解析"
        title="足迹"
        description="照片坐标在本机匹配到行政区边界。这里按时间讲一遍：你去过哪些地方，是什么时候去的。"
      />
      <section className="page-shell mt-5 space-y-8">
        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-bg-elevated px-4 py-3 text-body text-danger"
          >
            <span>足迹数据加载失败，请稍后重试。</span>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => {
                void summaryQuery.refetch();
                void placesQuery.refetch();
                void tripsQuery.refetch();
                void outlineQuery.refetch();
              }}
            >
              重新加载
            </button>
          </div>
        ) : null}

        {summary ? (
          <>
            <TravelStatLedger items={ledger} />

            <TravelTimeAxis
              months={summary.months}
              from={from}
              to={to}
              onChange={setRange}
              untimedCount={untimedCount}
            />

            <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,1fr)_380px]">
              <div className="min-w-0 space-y-10">
                <section aria-label="去过的地方">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="font-display text-section font-medium text-fg">
                      去过的地方
                    </h2>
                    <Segmented
                      label="归并粒度"
                      value={level}
                      onChange={setLevel}
                      options={[
                        { value: "province", label: "省" },
                        { value: "city", label: "市" },
                        { value: "district", label: "区县" },
                      ]}
                    />
                  </div>
                  <p className="mt-1.5 text-meta text-fg-muted">
                    只列有照片的地方；照片数含下级。没有照片的省仍然完整地画在右边的地图上。
                  </p>
                  {places.length === 0 ? (
                    <div className="mt-4 flex flex-col items-center justify-center gap-2 rounded-2xl border border-border-faint bg-bg-elevated px-6 py-12 text-center">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-fg-muted">
                        <MapPinIcon size={17} />
                      </span>
                      <p className="text-body font-medium text-fg">
                        这段时间还没有去过什么地方
                      </p>
                      <p className="max-w-md text-meta leading-relaxed text-fg-muted">
                        运行 EXIF 与 GPS 元数据分析后，这里会列出照片落在的行政区。
                      </p>
                    </div>
                  ) : (
                    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {places.map((place) => (
                        <TravelPlaceCard
                          key={place.adcode}
                          place={place}
                          levelTotal={levelTotal}
                          to={travelPlaceRoute(place.adcode)}
                        />
                      ))}
                    </div>
                  )}
                </section>

                <section aria-label="行程">
                  <h2 className="font-display text-section font-medium text-fg">
                    行程
                  </h2>
                  <p className="mt-1.5 text-meta text-fg-muted">
                    一次行程是一段连续的拍摄：两周之内还连着拍的地方算同一段，
                    只有一个地方的那段记作「停留」。
                  </p>
                  <div className="mt-3">
                    <TravelTripList
                      trips={trips}
                      onOpen={(trip) =>
                        setOpenTrip((current) =>
                          current === trip.id ? null : trip.id,
                        )
                      }
                    />
                  </div>
                  {activeTrip ? (
                    <div className="mt-4 overflow-hidden rounded-2xl border border-border-faint bg-bg-elevated">
                      <TravelPhotoWall
                        adcode={activeTrip.stops[0]?.adcode ?? 0}
                        name={activeTrip.stops.map((stop) => stop.name).join(" → ")}
                        timeRange={timeRange}
                      />
                    </div>
                  ) : null}
                </section>
              </div>

              <aside className="min-w-0 space-y-4 xl:sticky xl:top-4">
                <section
                  aria-label="行政区照片地图"
                  className="rounded-2xl border border-border-faint bg-bg-elevated p-4"
                >
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <h2 className="font-display text-label font-medium text-fg">
                      分布
                    </h2>
                    <span className="text-meta text-fg-muted">
                      {regions.filter((region) => region.photoCount > 0).length} 个省有照片
                    </span>
                  </div>
                  {loading ? (
                    <div className="flex min-h-[220px] items-center justify-center text-body text-fg-muted">
                      正在载入全国地图…
                    </div>
                  ) : (
                    <TravelMap
                      regions={regions}
                      levelTotal={levelTotal}
                      levelName="省级区域"
                      levelLabel="全国"
                      showLabels={false}
                      onSelect={(region) =>
                        navigate(travelPlaceRoute(region.adcode))
                      }
                      // 总览就是最上面一层，没有上一级可回。
                      onLevelUp={() => undefined}
                    />
                  )}
                </section>
              </aside>
            </div>

            <p className="px-1 text-meta leading-relaxed text-fg-subtle">
              坐标与边界均在本机处理；时间按 EXIF
              拍摄时间的日历日计算，跨时区旅行按拍摄地的当地日期。 离线边界采用
              AreaCity 2026 年 4
              月版省市区县数据，边界以高德为主并整合行政区划信息，坐标系为
              GCJ-02；不含乡镇边界。库里约四分之三的坐标来自基站与网络而非
              GPS 芯片，行政区归属可能有百米量级的偏差。
            </p>
          </>
        ) : loading ? (
          <div className="flex min-h-64 items-center justify-center rounded-2xl border border-border-faint bg-bg-elevated text-body text-fg-muted">
            正在载入足迹…
          </div>
        ) : null}
      </section>
    </div>
  );
}
