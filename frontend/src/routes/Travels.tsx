import { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Segmented from "../components/common/Segmented";
import TravelMiniMap from "../components/travels/TravelMiniMap";
import TravelPlaceList from "../components/travels/TravelPlaceList";
import TravelTimeline from "../components/travels/TravelTimeline";
import TravelTrips from "../components/travels/TravelTrips";
import {
  useChinaFeatures,
  useChinaPlaces,
  useChinaPlacesAll,
  useChinaPoints,
  useChinaProvinceOutline,
  useChinaSummary,
  useChinaSummaryAll,
  useChinaTripsAll,
} from "../hooks/useChinaLocations";
import { travelPlaceRoute } from "../utils/path";
import type { MapRegion } from "../utils/travelMap";

/** 归并粒度：地方与行程都按哪一层分组。 */
type PlaceLevel = "province" | "city" | "district";

/** 从查询参数里读月份（YYYY-MM）。 */
function parseMonth(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}$/.test(raw)) return null;
  return raw;
}

/**
 * 小地图上照片位置的网格边长。
 *
 * 地图只有 288 像素宽，照片位置按几公里一格聚合根本看不见 —— 一格在
 * 全国范围里还不到一个像素。这里用二十公里一格：格子够大才画得出，
 * 又不至于把同城不同角落的照片并成一坨。
 */
const MINI_MAP_CELL = 0.2;

/**
 * 足迹：我去过哪些地方，什么时候去的。
 *
 * 抬头分两栏：左边是标题、一行数字摘要与控件，右边是一块小地图 ——
 * 去过的地方按张数深浅着色，照片真正的位置泛成一层光。下面是一条按真实
 * 时间比例铺开的月格带，拖两端可以圈出一段时间；最下面是这段时间里的
 * 行程，一段一段读。
 */
export default function Travels() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const from = parseMonth(searchParams.get("from"));
  const to = parseMonth(searchParams.get("to"));
  const timeRange = useMemo(() => ({ from, to }), [from, to]);
  const level = (searchParams.get("level") as PlaceLevel | null) ?? "city";
  const selectedTripId = searchParams.get("trip");
  const [placeListOpen, setPlaceListOpen] = useState(false);

  // 两份汇总：一份带区间（数字台用），一份不带（时间轴要知道整条历史
  // 有多长，才画得出那把尺子）。
  const summaryQuery = useChinaSummary(timeRange);
  const summary = summaryQuery.data;
  const wholeQuery = useChinaSummaryAll();
  const whole = wholeQuery.data;

  // 行程不随时间区间重切：段的下标要能寻址到照片，两边必须同一套口径。
  const tripsQuery = useChinaTripsAll(level);
  const trips = useMemo(() => tripsQuery.data ?? [], [tripsQuery.data]);

  // 地方索引也是两份：形状取全部去过的（拖区间时地图不重画），计数取
  // 区间内的。
  const placesQuery = useChinaPlaces(level, null, timeRange);
  const places = useMemo(() => placesQuery.data ?? [], [placesQuery.data]);
  const wholePlacesQuery = useChinaPlacesAll(level, null);
  const wholePlaces = useMemo(
    () => wholePlacesQuery.data ?? [],
    [wholePlacesQuery.data],
  );

  const provinceOutline = useChinaProvinceOutline();
  const placeAdcodes = useMemo(
    // 省这一层用全国省图当底图，不必再按区划码取一遍。
    () =>
      level === "province"
        ? []
        : wholePlaces.map((place) => place.adcode),
    [level, wholePlaces],
  );
  const placeFeatures = useChinaFeatures(placeAdcodes);
  const pointsQuery = useChinaPoints(timeRange, MINI_MAP_CELL);
  const points = useMemo(() => pointsQuery.data?.items ?? [], [pointsQuery.data]);

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
      // 换粒度就是换一套行程，段的下标不再指向同一段。
      nextParams.delete("trip");
      setSearchParams(nextParams, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const selectTrip = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (id) next.set("trip", id);
      else next.delete("trip");
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // 打开地点时带着当前的筛选条件回去：时间区间是跨层级的一维，丢了它
  // 等于把「2019 年在杭州」这类叙事掐断在一次点击上。
  const openPlace = useCallback(
    (adcode: number) => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      params.set("level", level);
      const query = params.toString();
      navigate(`${travelPlaceRoute(adcode)}${query ? `?${query}` : ""}`);
    },
    [from, level, navigate, to],
  );

  // 区间内与行程有交集的段。
  const windowTrips = useMemo(
    () =>
      trips.filter(
        (trip) =>
          (!to || trip.startedAt <= to) && (!from || trip.endedAt >= from),
      ),
    [from, to, trips],
  );

  const tripCount = windowTrips.length;

  const untimedCount = summary?.untimedPhotoCount ?? 0;

  const error =
    summaryQuery.isError || wholeQuery.isError || tripsQuery.isError;

  // 地图上的单元：去过的那些地方，各自的形状与区间内的张数。
  const counts = useMemo(() => {
    const map = new Map<number, number>();
    for (const place of places) map.set(place.adcode, place.photoCount);
    return map;
  }, [places]);

  const provinceFeatures = useMemo(
    () => provinceOutline.data ?? [],
    [provinceOutline.data],
  );

  const regions = useMemo<MapRegion[]>(() => {
    if (level === "province") {
      // 省这一层：全国 34 个省都在图上，去过的按张数深浅着色。
      return provinceFeatures.map((feature) => ({
        adcode: feature.adcode,
        name: feature.name,
        level: feature.level,
        photoCount: counts.get(feature.adcode) ?? 0,
        geometry: feature.geometry,
      }));
    }
    return placeFeatures.map((feature) => ({
      adcode: feature.adcode,
      name: feature.name,
      level: feature.level,
      photoCount: counts.get(feature.adcode) ?? 0,
      geometry: feature.geometry,
    }));
  }, [counts, level, placeFeatures, provinceFeatures]);

  const backdrop = useMemo<MapRegion[] | undefined>(() => {
    if (level === "province") return undefined;
    return provinceFeatures.map((feature) => ({
      adcode: feature.adcode,
      name: feature.name,
      level: feature.level,
      photoCount: 0,
      geometry: feature.geometry,
    }));
  }, [level, provinceFeatures]);

  const levelTotal = useMemo(
    () => regions.reduce((sum, region) => sum + region.photoCount, 0),
    [regions],
  );

  return (
    <div className="h-full overflow-y-auto pb-12">
      <header className="border-b border-border-faint bg-bg">
        <div className="page-bleed">
          <div className="travel-head">
            <div className="min-w-0">
              <p className="page-eyebrow">离线解析</p>
              <h1 className="travel-head__title">足迹</h1>

              {/* 规模并成一句话，不拆成四个各自占一格的大数字。 */}
              <p className="travel-head__meta">
                <span>
                  <span className="travel-head__value">{tripCount}</span> 段足迹
                </span>
                <span>
                  <span className="travel-head__value">
                    {summary?.provinceCount ?? "—"}
                  </span>{" "}
                  个省
                  <span className="travel-head__value ml-3">
                    {summary?.cityCount ?? "—"}
                  </span>{" "}
                  个市
                </span>
                <span>
                  <span className="travel-head__value">
                    {(summary?.gpsPhotoCount ?? 0).toLocaleString()}
                  </span>{" "}
                  张带位置
                </span>
                <span>
                  <span className="travel-head__value">
                    {untimedCount.toLocaleString()}
                  </span>{" "}
                  张没有拍摄时间
                </span>
              </p>

              <div className="travel-head__actions">
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
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  aria-pressed={placeListOpen}
                  onClick={() => setPlaceListOpen((value) => !value)}
                >
                  地方
                </button>
              </div>
            </div>

            {/* 右栏是地图：抬头的一半，不是一条贴在边上的窄带。 */}
            <div className="travel-head__map">
              <TravelMiniMap
                regions={regions}
                backdrop={backdrop}
                points={points}
                levelTotal={levelTotal}
                scopeLabel="足迹"
              />
              {placeListOpen ? (
                <TravelPlaceList
                  places={places}
                  anchor="menu"
                  onClose={() => setPlaceListOpen(false)}
                  onOpenPlace={openPlace}
                />
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <div className="page-bleed">
        {error ? (
          <div
            role="alert"
            className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-bg-elevated px-4 py-3 text-body text-danger"
          >
            <span>足迹数据加载失败，请稍后重试。</span>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => {
                void summaryQuery.refetch();
                void wholeQuery.refetch();
                void tripsQuery.refetch();
              }}
            >
              重新加载
            </button>
          </div>
        ) : null}

        {whole ? (
          <TravelTimeline
            months={whole.months}
            trips={trips}
            from={from}
            to={to}
            onChange={setRange}
            onSelectTrip={(trip) => selectTrip(trip.id)}
            selectedTripId={selectedTripId}
          />
        ) : null}

        {summary ? (
          <TravelTrips
            trips={windowTrips}
            selectedTripId={selectedTripId}
            onSelect={(trip) => selectTrip(trip?.id ?? null)}
            granularity={level}
            onOpenPlace={openPlace}
          />
        ) : (
          <div className="flex min-h-64 items-center justify-center text-body text-fg-muted">
            正在载入足迹…
          </div>
        )}

        <p className="travel-footnote">
          坐标与边界均在本机处理；时间按 EXIF
          拍摄时间的日历日计算，跨时区旅行按拍摄地的当地日期。 离线边界采用
          AreaCity 2026 年 4
          月版省市区县数据，边界以高德为主并整合行政区划信息，坐标系为
          GCJ-02；不含乡镇边界。地图上的点按网格聚合（约二十公里一格），
          不还原到单张照片的坐标；库里约四分之三的坐标来自基站与网络而非
          GPS 芯片，行政区归属可能有百米量级的偏差。
        </p>
      </div>
    </div>
  );
}
