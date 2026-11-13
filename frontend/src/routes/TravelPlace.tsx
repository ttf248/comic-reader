import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ChevronRightIcon } from "../components/common/Icon";
import ThumbImage from "../components/common/ThumbImage";
import TravelLocatorMap from "../components/travels/TravelLocatorMap";
import TravelPhotoWall from "../components/travels/TravelPhotoWall";
import {
  useChinaOutline,
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

/** 到访记录先给这么多条，剩下的收在「展开全部」后面。 */
const VISIT_PREVIEW = 24;


/** 从查询参数里读月份（YYYY-MM）。 */
function parseMonth(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}$/.test(raw)) return null;
  return raw;
}

/**
 * 一个地方的照片。
 *
 * 页头用照片墙同款的身份条：代表照裱起来，旁边是名字与统计。下面是
 * 照片本身、下级地点与到访记录 —— 从一个地方继续往下走，不必回到地图。
 */
export default function TravelPlace() {
  const { placeId } = useParams();
  const [searchParams] = useSearchParams();
  const from = parseMonth(searchParams.get("from"));
  const to = parseMonth(searchParams.get("to"));
  const timeRange = useMemo(() => ({ from, to }), [from, to]);
  const adcode = Number(placeId);
  const valid = Number.isInteger(adcode) && adcode > 0;

  const regionsQuery = useChinaRegions(valid ? adcode : null, timeRange);
  const visitsQuery = useChinaRegionVisits(valid ? adcode : null, timeRange);
  const region = regionsQuery.data?.region;
  const parentAdcode = region?.parentAdcode ?? null;
  const outlineQuery = useChinaOutline(parentAdcode);

  const [showAllVisits, setShowAllVisits] = useState(false);

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
  // 到访记录常常上百条，先给前面一段；剩下的收在一个按钮后面，
  // 免得整页被一堵同形的行淹没。
  const visibleVisits = showAllVisits
    ? visits
    : visits.slice(0, VISIT_PREVIEW);

  return (
    <div className="h-full overflow-y-auto pb-12">
      <header className="border-b border-border-faint bg-bg">
        <div className="px-[clamp(20px,3vw,48px)]">
          <div className="album-bar">
            <Link
              to={travelsRoute()}
              className="btn btn-sm btn-outline shrink-0"
            >
              返回足迹
            </Link>
            <div className="min-w-0 flex-1">
              <p className="page-eyebrow">足迹 · {LEVEL_LABEL[region?.level ?? ""] ?? ""}</p>
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

      <section className="page-shell mt-6 space-y-8">
        {regionsQuery.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-bg-elevated px-4 py-3 text-body text-danger">
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

        <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-8">
            <section aria-label="这个地方的照片">
              <TravelPhotoWall
                adcode={adcode}
                name={region?.name ?? ""}
                timeRange={timeRange}
              />
            </section>

            {regionsQuery.data && regionsQuery.data.regions.length > 0 ? (
              <section aria-label="下级地点">
                <h2 className="font-display text-section font-medium text-fg">
                  下级地点
                </h2>
                <ul className="mt-3 divide-y divide-border-faint rounded-2xl border border-border-faint bg-bg-elevated">
                  {regionsQuery.data.regions.map((child) => (
                    <li key={child.adcode}>
                      <Link
                        to={travelPlaceRoute(child.adcode)}
                        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-bg-subtle"
                      >
                        <span className="min-w-0 flex-1 truncate text-body text-fg">
                          {child.name}
                        </span>
                        <span className="badge shrink-0 text-meta">
                          {LEVEL_LABEL[child.level] ?? child.level}
                        </span>
                        <span className="shrink-0 text-meta tabular-nums text-fg-muted">
                          {child.photoCount.toLocaleString()} 张
                        </span>
                        <ChevronRightIcon size={14} className="shrink-0 text-fg-subtle" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {visits.length > 0 ? (
              <section aria-label="到访记录">
                <h2 className="font-display text-section font-medium text-fg">
                  到访记录
                </h2>
                <p className="mt-1.5 text-meta text-fg-muted">
                  相邻两张照片隔不超过两天算同一次到访，跨夜的行程不会被切成两半。
                </p>
                <ol className="mt-3 divide-y divide-border-faint rounded-2xl border border-border-faint bg-bg-elevated">
                  {visibleVisits.map((visit) => (
                    <li
                      key={`${visit.startedAt}-${visit.endedAt}`}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3"
                    >
                      <span className="font-mono text-meta tabular-nums text-fg">
                        {visit.startedAt}
                        {visit.endedAt !== visit.startedAt
                          ? ` – ${visit.endedAt.slice(5)}`
                          : ""}
                      </span>
                      <span className="text-meta text-fg-muted">
                        {visit.dayCount} 天 · {visit.photoCount.toLocaleString()} 张
                      </span>
                      {visit.regions.length > 0 ? (
                        <span className="text-meta text-fg-subtle">
                          期间还去了：{visit.regions.map((r) => r.name).join("、")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
                {visits.length > VISIT_PREVIEW ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline mt-3"
                    onClick={() => setShowAllVisits((value) => !value)}
                  >
                    {showAllVisits
                      ? `只看前 ${VISIT_PREVIEW} 次到访`
                      : `展开全部 ${visits.length} 次到访`}
                  </button>
                ) : null}
              </section>
            ) : null}
          </div>

          <aside className="min-w-0 space-y-4 xl:sticky xl:top-4">
            {(outlineQuery.data ?? []).length > 0 ? (
              <section
                aria-label="位置图"
                className="rounded-2xl border border-border-faint bg-bg-elevated p-4"
              >
                <h2 className="mb-2 font-display text-label font-medium text-fg">
                  位置
                </h2>
                <TravelLocatorMap
                  features={outlineQuery.data ?? []}
                  adcode={adcode}
                  name={region?.name ?? ""}
                />
              </section>
            ) : null}
          </aside>
        </div>
      </section>
    </div>
  );
}
