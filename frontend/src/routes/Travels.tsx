import { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Segmented from "../components/common/Segmented";
import TravelMiniMap from "../components/travels/TravelMiniMap";
import TravelPlaceList from "../components/travels/TravelPlaceList";
import TravelStats from "../components/travels/TravelStats";
import TravelTimeline from "../components/travels/TravelTimeline";
import type { TravelSpan } from "../components/travels/TravelTimeline";
import TravelTrips from "../components/travels/TravelTrips";
import {
  useChinaFeatures,
  useChinaPlaces,
  useChinaPlacesAll,
  useChinaPoints,
  useChinaProvinceOutline,
  useChinaSummaryAll,
  useChinaTripsAll,
} from "../hooks/useChinaLocations";
import { travelPlaceRoute } from "../utils/path";
import { monthIndex, monthKey } from "../utils/travelMap";
import type { MapRegion } from "../utils/travelMap";

/** 归并粒度：地方与行程都按哪一层分组。 */
type PlaceLevel = "province" | "city" | "district";

/** 从查询参数里读月份（YYYY-MM）。 */
function parseMonth(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}$/.test(raw)) return null;
  return raw;
}

/**
 * 时间轴的跨度。
 *
 * 缺省是最近五年：十几年的历史一次铺开，格子会细到读不出来；想看更早
 * 的再按按钮。
 */
function parseSpan(raw: string | null): TravelSpan {
  return raw === "1y" || raw === "3y" || raw === "10y" || raw === "all"
    ? raw
    : "5y";
}

/** 各跨度对应的年数。 */
const SPAN_YEARS: Record<Exclude<TravelSpan, "all">, number> = {
  "1y": 1,
  "3y": 3,
  "5y": 5,
  "10y": 10,
};

/**
 * 地图上照片位置的网格边长。
 *
 * 地图只有几百像素宽，照片位置按几公里一格聚合根本看不见 —— 一格在
 * 全国范围里还不到一个像素。这里用二十公里一格：格子够大才画得出，
 * 又不至于把同城不同角落的照片并成一坨。
 */
const MINI_MAP_CELL = 0.2;

/**
 * 足迹：我去过哪些地方，什么时候去的。
 *
 * 抬头只说两件事：这是哪个页面、这个库有多大。真正的内容分两栏：左边是
 * 一条按真实时间比例铺开的月格带（拖两端可以圈出一段时间）和这段时间
 * 里的行程；右边是地图，占着一条竖直的窄栏，滚动时一直跟着 ——
 * 去过的地方按张数深浅着色，照片真正的位置泛成一层光。
 */
export default function Travels() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const from = parseMonth(searchParams.get("from"));
  const to = parseMonth(searchParams.get("to"));
  const span = parseSpan(searchParams.get("span"));
  const level = (searchParams.get("level") as PlaceLevel | null) ?? "city";
  const selectedTripId = searchParams.get("trip");
  const [placeListOpen, setPlaceListOpen] = useState(false);

  // 两份汇总：一份不带区间（时间轴要知道整条历史有多长，才画得出那把
  // 尺子），一份带区间（数字台用）。
  const wholeQuery = useChinaSummaryAll();
  const whole = wholeQuery.data;

  // 跨度锚在有照片的最后一月：最近五年是从那一刻往回数的五年。
  const spanFrom = useMemo(() => {
    const months = whole?.months ?? [];
    if (months.length === 0 || span === "all") return null;
    const last = months[months.length - 1].month;
    return monthKey(monthIndex(last) - SPAN_YEARS[span] * 12 + 1);
  }, [span, whole?.months]);

  // 生效的区间：刷手圈的优先，没圈就用跨度。
  const timeRange = useMemo(
    () => ({ from: from ?? spanFrom, to }),
    [from, spanFrom, to],
  );


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

  const setSpan = useCallback(
    (next: TravelSpan) => {
      const nextParams = new URLSearchParams(searchParams);
      // 缺省就是最近五年，不写进地址。
      if (next === "5y") nextParams.delete("span");
      else nextParams.set("span", next);
      // 换跨度等于换了一个范围：刷手圈出的区间留在里面会打架。
      nextParams.delete("from");
      nextParams.delete("to");
      setSearchParams(nextParams, { replace: true });
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

  // 生效区间内与行程有交集的段。
  const windowTrips = useMemo(
    () =>
      trips.filter(
        (trip) =>
          (!timeRange.to || trip.startedAt <= timeRange.to) &&
          (!timeRange.from || trip.endedAt >= timeRange.from),
      ),
    [timeRange.from, timeRange.to, trips],
  );

  const untimedCount = whole?.untimedPhotoCount ?? 0;

  const error =
    wholeQuery.isError || tripsQuery.isError;

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
            </div>

            {/* 规模：说的是这个库的事实，不随区间变。 */}
            <TravelStats
              totalPhotos={whole?.totalPhotoCount ?? null}
              gpsPhotos={whole?.gpsPhotoCount ?? 0}
              provinces={whole?.provinceCount ?? 0}
              cities={whole?.cityCount ?? 0}
              untimed={untimedCount}
            />

            {/* 粒度是整页的：地图上的区划与行程的切法都跟着它变。 */}
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
            </div>
          </div>
        </div>
      </header>

      {error ? (
        <div className="page-bleed">
          <div
            role="alert"
            className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-bg-elevated px-4 py-3 text-body text-danger"
          >
            <span>足迹数据加载失败，请稍后重试。</span>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => {
                void wholeQuery.refetch();
                void tripsQuery.refetch();
              }}
            >
              重新加载
            </button>
          </div>
        </div>
      ) : null}

      <div className="page-bleed travel-layout">
        <div className="travel-layout__timeline">
          {whole ? (
            <TravelTimeline
              months={whole.months}
              trips={windowTrips}
              span={span}
              from={from}
              to={to}
              onChange={setRange}
              onChangeSpan={setSpan}
              onSelectTrip={(trip) => selectTrip(trip.id)}
              selectedTripId={selectedTripId}
            />
          ) : null}
        </div>

        {/* 地图占着右栏，滚动时一直跟着 —— 读行程的时候手边得有个方位。 */}
        <aside className="travel-layout__aside">
          <div className="travel-aside__bar">
            <span className="travel-aside__label">足迹地图</span>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              aria-pressed={placeListOpen}
              onClick={() => setPlaceListOpen((value) => !value)}
            >
              地方
            </button>
            {placeListOpen ? (
              <TravelPlaceList
                places={places}
                anchor="menu"
                onClose={() => setPlaceListOpen(false)}
                onOpenPlace={openPlace}
              />
            ) : null}
          </div>
          <div className="travel-aside__map">
            <TravelMiniMap
              regions={regions}
              backdrop={backdrop}
              points={points}
              levelTotal={levelTotal}
              scopeLabel="足迹"
            />
          </div>
        </aside>

        <div className="travel-layout__trips">
          {whole ? (
            <TravelTrips
              trips={windowTrips}
              selectedTripId={selectedTripId}
              onSelect={(trip) => selectTrip(trip?.id ?? null)}
              granularity={level}
              onOpenPlace={openPlace}
              regions={regions}
              backdrop={backdrop}
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
    </div>
  );
}
