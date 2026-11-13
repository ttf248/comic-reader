import { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import PageHeading from "../components/common/PageHeading";
import Segmented from "../components/common/Segmented";
import TravelMapCanvas from "../components/travels/TravelMapCanvas";
import TravelPlaceList from "../components/travels/TravelPlaceList";
import TravelStatLedger from "../components/travels/TravelStatLedger";
import TravelTimeRibbon from "../components/travels/TravelTimeRibbon";
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
 * 缩放倍数 → 照片位置的网格边长。
 *
 * 地图铺满全国时，几公里的一格小得看不见；推到一座城市里，同样的格子
 * 又太粗。格子跟着缩放走：放得越大，画得越细。
 */
function cellForZoom(zoom: number): number {
  if (zoom < 1.6) return 0.1;
  if (zoom < 3) return 0.05;
  if (zoom < 6) return 0.02;
  return 0.01;
}

/**
 * 足迹：我去过哪些地方，什么时候去的。
 *
 * 页面先给一张地图：照片的真实位置浮在离线行政边界上，一眼看出去过
 * 哪些城市、在城市里拍了多少。下面是一条按真实时间比例铺开的时间带，
 * 拖两端可以圈出一段时间；再下面是这段时间里的行程，一段一段读。
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
  const [cell, setCell] = useState(0.02);

  // 两份汇总：一份带区间（数字台用），一份不带（时间带要知道整条历史
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
  const pointsQuery = useChinaPoints(timeRange, cell);
  const points = useMemo(() => pointsQuery.data?.items ?? [], [pointsQuery.data]);

  // 地图放得越大，照片位置就要画得越细。
  const handleZoomChange = useCallback((zoom: number) => {
    setCell(cellForZoom(zoom));
  }, []);

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

  const selectedTrip = useMemo(
    () => trips.find((trip) => trip.id === selectedTripId) ?? null,
    [selectedTripId, trips],
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

  const ledger = useMemo(() => {
    const placeCount = summary
      ? `${summary.provinceCount} 个省 · ${summary.cityCount} 个市`
      : "—";
    return [
      { value: tripCount.toLocaleString(), label: "段足迹" },
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
  }, [summary, tripCount, untimedCount]);

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

  const highlightedAdcodes = useMemo(
    () => selectedTrip?.stops.map((stop) => stop.adcode) ?? [],
    [selectedTrip],
  );

  return (
    <div className="h-full overflow-y-auto pb-12">
      <div className="page-bleed">
        <PageHeading
          contained
          eyebrow="离线解析"
          title="足迹"
          description="照片坐标在本机匹配到行政区边界，并聚成网格画在这张地图上。这里按时间讲一遍：你去过哪些地方，是什么时候去的。"
          action={
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn btn-sm btn-outline"
                aria-pressed={placeListOpen}
                onClick={() => setPlaceListOpen((value) => !value)}
              >
                地方
              </button>
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
          }
        />

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
                void wholeQuery.refetch();
                void tripsQuery.refetch();
              }}
            >
              重新加载
            </button>
          </div>
        ) : null}

        {summary ? <TravelStatLedger items={ledger} /> : null}
      </div>

      <div className="page-bleed travel-world">
        <TravelMapCanvas
          regions={regions}
          backdrop={backdrop}
          points={points}
          highlightedAdcodes={highlightedAdcodes}
          highlightedRange={
            selectedTrip
              ? { from: selectedTrip.startedAt, to: selectedTrip.endedAt }
              : null
          }
          levelTotal={levelTotal}
          scopeLabel="足迹"
          onSelect={(region) => openPlace(region.adcode)}
          onZoomChange={handleZoomChange}
        />
        {placeListOpen ? (
          <TravelPlaceList
            places={places}
            onClose={() => setPlaceListOpen(false)}
            onOpenPlace={openPlace}
          />
        ) : null}
      </div>

      <div className="page-bleed">
        {whole ? (
          <TravelTimeRibbon
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
          GCJ-02；不含乡镇边界。地图上的点按网格聚合（最细约一公里一格），
          不还原到单张照片的坐标；库里约四分之三的坐标来自基站与网络而非
          GPS 芯片，行政区归属可能有百米量级的偏差。
        </p>
      </div>
    </div>
  );
}
