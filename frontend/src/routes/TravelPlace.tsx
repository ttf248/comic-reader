import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import ThumbImage from "../components/common/ThumbImage";
import TravelMap from "../components/travels/TravelMap";
import TravelPhotoWall from "../components/travels/TravelPhotoWall";
import TravelTimeAxis from "../components/travels/TravelTimeAxis";
import {
  useChinaOutline,
  useChinaRegionMedia,
  useChinaRegionVisits,
  useChinaRegions,
} from "../hooks/useChinaLocations";
import { travelPlaceRoute, travelsRoute } from "../utils/path";

/** 层级徽标的说法：省、市、区县。 */
const LEVEL_LABEL: Record<string, string> = {
  province: "省",
  city: "市",
  district: "区县",
};

/** 从查询参数里读月份（YYYY-MM）。 */
function parseMonth(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}$/.test(raw)) return null;
  return raw;
}

/**
 * 一个地方的照片。
 *
 * 页头用照片墙同款的身份条：代表照裱起来，旁边是名字与统计。下面是这个
 * 地方的照片墙、下级地点与到访记录 —— 从一个地方继续往下走，不必回到地图。
 *
 * 布局是通栏：照片是这一页的主角，不该被塞进一条窄栏里。
 */
export default function TravelPlace() {
  const { placeId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const from = parseMonth(searchParams.get("from"));
  const to = parseMonth(searchParams.get("to"));
  const level = searchParams.get("level");
  const timeRange = useMemo(() => ({ from, to }), [from, to]);
  const adcode = Number(placeId);
  const valid = Number.isInteger(adcode) && adcode > 0;

  const regionsQuery = useChinaRegions(valid ? adcode : null, timeRange);
  const visitsQuery = useChinaRegionVisits(valid ? adcode : null, timeRange);
  const region = regionsQuery.data?.region;

  // 回到总览时带着当前的筛选条件：时间区间是跨层级的一维，丢了它等于把
  // 「2019 年在杭州」这类叙事掐断在一次点击上。
  const backTo = useMemo(() => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (level) params.set("level", level);
    const query = params.toString();
    return `${travelsRoute()}${query ? `?${query}` : ""}`;
  }, [from, level, to]);

  const setRange = (nextFrom: string | null, nextTo: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (nextFrom && nextTo) {
      next.set("from", nextFrom);
      next.set("to", nextTo);
    } else {
      next.delete("from");
      next.delete("to");
    }
    setSearchParams(next, { replace: true });
  };

  // 位置图：这个地方在上级区划里的位置。
  //
  // 它回答「这是哪儿」，因此画的是上一级的一整层（省里的市、全国里的省），
  // 只把当前这个地方标出来；不裁到只剩它 —— 裁掉周围就看不出方位了。
  const parentFeatures = useChinaOutline(
    region?.parentAdcode ?? null,
    valid && region !== undefined,
  );
  const locatorRegions = useMemo(
    () =>
      (parentFeatures.data ?? []).map((feature) => ({
        adcode: feature.adcode,
        name: feature.name,
        level: feature.level,
        photoCount: feature.adcode === adcode ? 1 : 0,
        geometry: feature.geometry,
      })),
    [adcode, parentFeatures],
  );

  if (!valid) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div>
          <p className="text-body font-medium text-fg">这个地方不存在</p>
          <Link to={travelsRoute()} className="mt-2 inline-block text-brand-ink underline">
            回到足迹
          </Link>
        </div>
      </div>
    );
  }

  const covers = region?.coverResourceIds ?? [];
  const visits = visitsQuery.data?.visits ?? [];
  const months = regionsQuery.data?.months ?? [];

  return (
    <div className="h-full overflow-y-auto pb-12">
      <header className="border-b border-border-faint bg-bg">
        <div className="page-bleed">
          <div className="album-bar">
            <Link to={backTo} className="btn btn-sm btn-outline shrink-0">
              返回足迹
            </Link>
            <div className="min-w-0 flex-1">
              <p className="page-eyebrow">
                足迹 · {LEVEL_LABEL[region?.level ?? ""] ?? ""}
              </p>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="album-bar__title truncate">{region?.name ?? "…"}</h1>
                {region ? (
                  <span className="album-bar__meta tabular-nums">
                    {region.photoCount.toLocaleString()} 张 · {region.visitCount} 次到访
                    {region.firstAt && region.lastAt
                      ? ` · ${region.firstAt} – ${region.lastAt}`
                      : " · 拍摄时间未知"}
                  </span>
                ) : null}
              </div>
            </div>
            {locatorRegions.length > 0 ? (
              <span className="hidden w-[200px] shrink-0 lg:block">
                <TravelMap
                  regions={locatorRegions}
                  levelTotal={1}
                  scopeLabel={region?.name ?? "这个地方"}
                  legend={null}
                  cropToggle={false}
                  crop={false}
                />
              </span>
            ) : null}
            {covers.length > 0 ? (
              <span className="hidden h-[76px] w-[76px] shrink-0 overflow-hidden rounded-media shadow-xs sm:block">
                <ThumbImage
                  fileId={covers[0]}
                  alt=""
                  displayWidth={152}
                  className="h-full w-full object-cover"
                />
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <div className="page-bleed">
        {regionsQuery.isError ? (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-bg-elevated px-4 py-3 text-body text-danger">
            <span>这个地方的照片暂时读不出来。</span>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => void regionsQuery.refetch()}
            >
              重新加载
            </button>
          </div>
        ) : null}

        {months.length > 0 ? (
          <TravelTimeAxis
            months={months}
            from={from}
            to={to}
            onChange={setRange}
            untimedCount={regionsQuery.data?.untimedPhotoCount ?? 0}
          />
        ) : null}

        <section aria-label="这个地方的照片" className="mt-4">
          <TravelPhotoWall
            adcode={adcode}
            name={region?.name ?? ""}
            timeRange={timeRange}
          />
        </section>

        {regionsQuery.data && regionsQuery.data.regions.length > 0 ? (
          <section aria-label="下级地点" className="mt-8">
            <h2 className="font-display text-section font-medium text-fg">
              下级地点
            </h2>
            <ul className="mt-3 flex flex-wrap gap-2">
              {regionsQuery.data.regions.map((child) => (
                <li key={child.adcode}>
                  <Link
                    to={travelPlaceRoute(child.adcode)}
                    className="chip"
                    aria-label={`${child.name}，${child.photoCount.toLocaleString()} 张`}
                  >
                    <span>{child.name}</span>
                    <span className="tabular-nums text-meta opacity-70">
                      {child.photoCount.toLocaleString()}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {visits.length > 0 ? (
          <section aria-label="到访记录" className="mt-8">
            <h2 className="font-display text-section font-medium text-fg">
              到访记录
            </h2>
            <p className="mt-1.5 text-meta text-fg-muted">
              相邻两张照片隔不超过两天算同一次到访，跨夜的行程不会被切成两半。
              点一次到访看那几天拍的照片。
            </p>
            <ol className="mt-3 divide-y divide-border-faint rounded-2xl border border-border-faint bg-bg-elevated">
              {visits.map((visit, index) => (
                <VisitRow
                  key={`${visit.startedAt}-${visit.endedAt}`}
                  adcode={adcode}
                  visitIndex={index}
                  startedAt={visit.startedAt}
                  endedAt={visit.endedAt}
                  dayCount={visit.dayCount}
                  photoCount={visit.photoCount}
                  regions={visit.regions.map((region) => region.name)}
                />
              ))}
            </ol>
          </section>
        ) : null}
      </div>
    </div>
  );
}

interface VisitRowProps {
  adcode: number;
  visitIndex: number;
  startedAt: string;
  endedAt: string;
  dayCount: number;
  photoCount: number;
  regions: string[];
}

/**
 * 一次到访。
 *
 * 照片在展开时才去取：到访常常上百条，一次全取既慢又没人看。
 */
function VisitRow({
  adcode,
  visitIndex,
  startedAt,
  endedAt,
  dayCount,
  photoCount,
  regions,
}: VisitRowProps) {
  const [open, setOpen] = useState(false);
  const media = useChinaRegionMedia(open ? adcode : null, undefined, visitIndex);
  const items = useMemo(
    () => media.data?.pages.flatMap((page) => page.items) ?? [],
    [media.data],
  );

  return (
    <li className="px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 text-left"
      >
        <span className="font-mono text-meta tabular-nums text-fg">
          {startedAt}
          {endedAt !== startedAt ? ` – ${endedAt.slice(5)}` : ""}
        </span>
        <span className="text-meta text-fg-muted">
          {dayCount} 天 · {photoCount.toLocaleString()} 张
        </span>
        {regions.length > 0 ? (
          <span className="text-meta text-fg-subtle">
            期间还去了：{regions.join("、")}
          </span>
        ) : null}
        <span className="ml-auto text-meta text-brand-ink">
          {open ? "收起" : "看照片"}
        </span>
      </button>
      {open ? (
        <div className="mt-2">
          {media.isError ? (
            <p className="text-meta text-fg-muted">
              这几天的照片暂时读不出来。
            </p>
          ) : items.length === 0 && !media.isLoading ? (
            <p className="text-meta text-fg-muted">这几天没有照片。</p>
          ) : (
            <div className="flex gap-1">
              {items.slice(0, 12).map((item) => (
                <ThumbImage
                  key={item.id}
                  fileId={item.id}
                  alt=""
                  displayWidth={160}
                  className="h-20 w-28 rounded-md object-cover"
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}
