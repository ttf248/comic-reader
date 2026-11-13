import { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import PageHeading from "../components/common/PageHeading";
import Segmented from "../components/common/Segmented";
import TravelContextPanel from "../components/travels/TravelContextPanel";
import TravelJournal from "../components/travels/TravelJournal";
import TravelStatLedger from "../components/travels/TravelStatLedger";
import TravelTimeAxis from "../components/travels/TravelTimeAxis";
import {
  useChinaPlaces,
  useChinaSummary,
  useChinaTrips,
} from "../hooks/useChinaLocations";
import { travelPlaceRoute } from "../utils/path";

/** 归并粒度：地方与行程都按哪一层分组。 */
type PlaceLevel = "province" | "city" | "district";

/** 面板的两种形态：某一段行程，或地点清单。 */
type Context =
  | { kind: "trip"; index: number }
  | { kind: "places" }
  | null;

/** 从查询参数里读月份（YYYY-MM）。 */
function parseMonth(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}$/.test(raw)) return null;
  return raw;
}

/**
 * 足迹：我去过哪些地方，什么时候去的。
 *
 * 页面按时间讲一遍：年份带选时间，下面是一条照片流，被行程切成段。
 * 地方退成段标题与一个入口，地图只在选中某段时才出现。
 *
 * 布局是单栏通栏 —— 一张 27 寸显示器上，内容不该被夹在中间、左右各空
 * 出一大片。
 */
export default function Travels() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const from = parseMonth(searchParams.get("from"));
  const to = parseMonth(searchParams.get("to"));
  const timeRange = useMemo(() => ({ from, to }), [from, to]);
  const level = (searchParams.get("level") as PlaceLevel | null) ?? "city";
  const [context, setContext] = useState<Context>(null);

  const summaryQuery = useChinaSummary(timeRange);
  const summary = summaryQuery.data;
  const placesQuery = useChinaPlaces(level, null, timeRange);
  // 间隔用服务端的缺省值：前后端各写一份，切分口径迟早会漂。
  const tripsQuery = useChinaTrips(level, timeRange);

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

  const error =
    summaryQuery.isError || placesQuery.isError || tripsQuery.isError;

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

  const selectedTrip =
    context?.kind === "trip"
      ? (trips.find((trip) => trip.index === context.index) ?? null)
      : null;

  return (
    <div className="h-full overflow-y-auto pb-12">
      <div className="page-bleed">
        <PageHeading
          contained
          eyebrow="离线解析"
          title="足迹"
          description="照片坐标在本机匹配到行政区边界。这里按时间讲一遍：你去过哪些地方，是什么时候去的。"
          action={
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn btn-sm btn-outline"
                aria-pressed={context?.kind === "places"}
                onClick={() =>
                  setContext((current) =>
                    current?.kind === "places" ? null : { kind: "places" },
                  )
                }
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
                void placesQuery.refetch();
                void tripsQuery.refetch();
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
          </>
        ) : null}
      </div>

      <div className="travel-layout" data-context={context ? "true" : undefined}>
        <div className="travel-layout__main">
          {summary ? (
            <>
              <TravelJournal
                trips={trips}
                selectedIndex={context?.kind === "trip" ? context.index : null}
                onSelect={(index) =>
                  setContext((current) =>
                    current?.kind === "trip" && current.index === index
                      ? null
                      : index === null
                        ? null
                        : { kind: "trip", index },
                  )
                }
                granularity={level}
                timeRange={timeRange}
                onOpenPlace={openPlace}
              />
              <p className="travel-footnote">
                坐标与边界均在本机处理；时间按 EXIF
                拍摄时间的日历日计算，跨时区旅行按拍摄地的当地日期。 离线边界采用
                AreaCity 2026 年 4
                月版省市区县数据，边界以高德为主并整合行政区划信息，坐标系为
                GCJ-02；不含乡镇边界。库里约四分之三的坐标来自基站与网络而非
                GPS 芯片，行政区归属可能有百米量级的偏差。
              </p>
            </>
          ) : (
            <div className="flex min-h-64 items-center justify-center text-body text-fg-muted">
              正在载入足迹…
            </div>
          )}
        </div>

        {context ? (
          <div className="travel-layout__aside">
            <TravelContextPanel
              trip={selectedTrip}
              places={places}
              onClose={() => setContext(null)}
              onOpenPlace={openPlace}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
