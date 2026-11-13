import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  aiJobsApi,
  type ChinaLocationPoint,
  type ChinaLocationProvince,
} from "../api/aiJobs";
import PageHeading from "../components/common/PageHeading";
import { MapPinIcon } from "../components/common/Icon";

export default function ChinaLocationMap() {
  const [selectedCode, setSelectedCode] = useState<number | null>(null);
  const query = useQuery({
    queryKey: ["china-locations"],
    queryFn: () =>
      aiJobsApi.chinaLocations().then((result) => result.locations),
  });
  const locations = query.data;
  const projection = useMemo(
    () => createChinaMapProjection(locations?.provinces ?? []),
    [locations?.provinces],
  );
  const provincePaths = useMemo(
    () =>
      locations?.provinces.map((province) => ({
        province,
        path: chinaProvincePath(province, projection),
      })) ?? [],
    [locations?.provinces, projection],
  );
  const selectedProvince =
    locations?.provinces.find((province) => province.adcode === selectedCode) ??
    locations?.provinces.reduce<ChinaLocationProvince | null>(
      (highest, province) =>
        province.photoCount > (highest?.photoCount ?? 0) ? province : highest,
      null,
    ) ??
    null;
  const selectedAreas = useMemo(
    () =>
      (locations?.areas ?? [])
        .filter((area) => area.provinceAdcode === selectedProvince?.adcode)
        .sort((left, right) => {
          if (left.photoCount !== right.photoCount) {
            return right.photoCount - left.photoCount;
          }
          return left.name.localeCompare(right.name, "zh-CN");
        }),
    [locations?.areas, selectedProvince?.adcode],
  );

  return (
    <div className="h-full overflow-y-auto pb-12">
      <PageHeading
        eyebrow="离线地点图谱"
        title="拍摄地点"
        description="照片坐标在本机匹配到省份与市区边界，点选省份即可查看具体地点和照片数量。"
      />
      <section className="page-shell mt-5 space-y-4">
        {query.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-bg-elevated px-4 py-3 text-body text-danger"
          >
            <span>离线地点地图加载失败，请稍后重试。</span>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => void query.refetch()}
            >
              重新加载
            </button>
          </div>
        ) : null}

        {locations ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <LocationStat
                label="带 GPS 照片"
                value={locations.gpsPhotoCount}
              />
              <LocationStat
                label="匹配到省份"
                value={locations.chinaPhotoCount}
              />
              <LocationStat
                label="未匹配省份"
                value={locations.unassignedPhotoCount}
              />
            </div>
            {locations.gpsPhotoCount === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-faint bg-bg-elevated px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-fg-muted">
                    <MapPinIcon size={17} />
                  </span>
                  <p className="text-body text-fg-muted">
                    当前没有可用的 GPS 照片。地图仍可浏览省份；运行 EXIF 与 GPS
                    元数据分析后会出现照片统计。
                  </p>
                </div>
                <Link className="btn btn-outline" to="/tasks">
                  打开任务中心
                </Link>
              </div>
            ) : null}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.8fr)]">
              <section
                aria-label="中国省级照片地图"
                className="min-w-0 overflow-hidden rounded-2xl border border-border-faint bg-bg-elevated"
              >
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-faint px-4 py-4 sm:px-5">
                  <div>
                    <h2 className="font-display text-label font-medium text-fg">
                      中国省级地图
                    </h2>
                    <p className="mt-1 text-meta text-fg-muted">
                      {locations.provinces.length} 个省级区域 ·
                      点击地图查看市区照片数
                    </p>
                  </div>
                  <div
                    className="flex items-center gap-2 text-meta text-fg-muted"
                    aria-label="颜色深浅表示照片数量"
                  >
                    <span>少</span>
                    <span className="h-2.5 w-12 rounded-full bg-gradient-to-r from-brand-soft to-brand" />
                    <span>多</span>
                  </div>
                </div>
                {query.isLoading ? (
                  <div className="flex min-h-[420px] items-center justify-center text-body text-fg-muted">
                    正在读取离线地图…
                  </div>
                ) : (
                  <div className="px-2 py-3 sm:px-4">
                    <svg
                      role="group"
                      aria-label="中国省份地图，可用键盘选择省份"
                      viewBox="0 0 1000 760"
                      className="mx-auto block h-auto w-full max-w-[920px]"
                    >
                      {provincePaths.map(({ province, path }) => {
                        const selected =
                          province.adcode === selectedProvince?.adcode;
                        const opacity =
                          province.photoCount === 0
                            ? 1
                            : 0.3 +
                              0.66 *
                                Math.sqrt(
                                  province.photoCount /
                                    Math.max(locations.chinaPhotoCount, 1),
                                );
                        return (
                          <path
                            key={province.adcode}
                            d={path}
                            role="button"
                            tabIndex={0}
                            aria-pressed={selected}
                            aria-label={`${province.name}，${province.photoCount.toLocaleString()} 张照片`}
                            className={`cursor-pointer outline-none transition-colors hover:fill-brand focus-visible:stroke-brand ${province.photoCount === 0 ? "fill-bg-subtle" : "fill-brand"} ${selected ? "stroke-brand" : "stroke-border-strong"}`}
                            fillOpacity={opacity}
                            strokeWidth={selected ? 2.5 : 1.4}
                            strokeLinejoin="round"
                            fillRule="evenodd"
                            onClick={() => setSelectedCode(province.adcode)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setSelectedCode(province.adcode);
                              }
                            }}
                          >
                            <title>
                              {province.name} ·{" "}
                              {province.photoCount.toLocaleString()} 张
                            </title>
                          </path>
                        );
                      })}
                    </svg>
                    <p className="px-2 text-center text-meta text-fg-subtle">
                      省内已匹配照片{" "}
                      {locations.chinaPhotoCount.toLocaleString()} 张
                      {selectedProvince
                        ? ` · 当前查看 ${selectedProvince.name}`
                        : " · 点击任一省份查看详情"}
                    </p>
                  </div>
                )}
              </section>

              <aside className="flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-2xl border border-border-faint bg-bg-elevated">
                {selectedProvince ? (
                  <>
                    <div className="shrink-0 border-b border-border-faint px-5 py-4">
                      <p className="page-eyebrow">省内地点</p>
                      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <h2 className="font-display text-section font-medium text-fg">
                          {selectedProvince.name}
                        </h2>
                        <span className="text-label font-medium tabular-nums text-brand-ink">
                          {selectedProvince.photoCount.toLocaleString()} 张
                        </span>
                      </div>
                      {selectedProvince.unmatchedAreaPhotoCount > 0 ? (
                        <p className="mt-2 text-meta text-fg-muted">
                          省内未细分{" "}
                          {selectedProvince.unmatchedAreaPhotoCount.toLocaleString()}{" "}
                          张
                        </p>
                      ) : null}
                    </div>
                    {selectedAreas.length > 0 ? (
                      <div className="min-h-0 flex-1 overflow-y-auto">
                        <ul
                          aria-label={`${selectedProvince.name}城市与区县照片数量`}
                        >
                          {selectedAreas.map((area) => (
                            <li
                              key={area.adcode}
                              className="flex items-center justify-between gap-3 border-b border-border-faint px-5 py-3 last:border-b-0"
                            >
                              <span className="min-w-0 truncate text-body text-fg">
                                {area.name}
                                <span className="ml-2 text-meta text-fg-subtle">
                                  {area.level === "district" ? "区县" : "城市"}
                                </span>
                              </span>
                              <span className="shrink-0 text-meta tabular-nums text-fg-muted">
                                {area.photoCount.toLocaleString()} 张
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 text-center">
                        <p className="text-body font-medium text-fg">
                          暂无省内城市与区县边界
                        </p>
                        <p className="mt-2 max-w-sm text-meta leading-relaxed text-fg-muted">
                          该省份仍显示在地图上；定位到的照片会计入省级总数，并标记为省内未细分。
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-fg-muted">
                      <MapPinIcon size={22} />
                    </span>
                    <h2 className="mt-4 font-display text-section font-medium text-fg">
                      选择一个省份
                    </h2>
                    <p className="mt-2 max-w-sm text-body leading-relaxed text-fg-muted">
                      点选地图中的区域，查看省内城市与区县的照片数量。
                    </p>
                  </div>
                )}
              </aside>
            </div>
            <p className="px-1 text-meta leading-relaxed text-fg-subtle">
              坐标与边界均在本机处理。离线边界数据来自阿里云 DataV
              GeoAtlas（areas_v3，2021.5）；官方说明为学习交流用途，商业使用请先联系数据权利方。
            </p>
          </>
        ) : query.isLoading ? (
          <div className="flex min-h-64 items-center justify-center rounded-2xl border border-border-faint bg-bg-elevated text-body text-fg-muted">
            正在载入省级地图…
          </div>
        ) : null}
      </section>
    </div>
  );
}

function LocationStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border-faint bg-bg-elevated px-4 py-3">
      <p className="text-meta text-fg-muted">{label}</p>
      <p className="mt-1 font-display text-section tabular-nums text-fg">
        {value.toLocaleString()}
        <span className="ml-1 text-meta font-normal">张</span>
      </p>
    </div>
  );
}

type ChinaProjection = (point: ChinaLocationPoint) => [number, number];
type ChinaPolygonRings = ChinaLocationPoint[][];

function createChinaMapProjection(
  provinces: ChinaLocationProvince[],
): ChinaProjection {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const longitudeScale = Math.cos((35 * Math.PI) / 180);

  for (const province of provinces) {
    for (const polygon of provincePolygons(province)) {
      if (polygonMaximumLatitude(polygon) < 15) continue;
      for (const ring of polygon) {
        for (const [longitude, latitude] of ring) {
          const x = longitude * longitudeScale;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, latitude);
          maxY = Math.max(maxY, latitude);
        }
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return () => [0, 0];
  }
  const width = 910;
  const height = 680;
  const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
  const drawnWidth = (maxX - minX) * scale;
  const drawnHeight = (maxY - minY) * scale;
  const offsetX = (1000 - drawnWidth) / 2;
  const offsetY = (760 - drawnHeight) / 2;
  return ([longitude, latitude]) => [
    offsetX + (longitude * longitudeScale - minX) * scale,
    offsetY + (maxY - latitude) * scale,
  ];
}

function provincePolygons(
  province: ChinaLocationProvince,
): ChinaPolygonRings[] {
  return province.geometry.type === "Polygon"
    ? [province.geometry.coordinates]
    : province.geometry.coordinates;
}

function polygonMaximumLatitude(polygon: ChinaPolygonRings) {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const ring of polygon) {
    for (const [, latitude] of ring) maximum = Math.max(maximum, latitude);
  }
  return maximum;
}

function chinaProvincePath(
  province: ChinaLocationProvince,
  project: ChinaProjection,
) {
  return provincePolygons(province)
    .filter((polygon) => polygonMaximumLatitude(polygon) >= 15)
    .flatMap((polygon) =>
      polygon.map((ring) => {
        if (ring.length === 0) return "";
        const [first, ...rest] = ring.map(project);
        return `M${first[0].toFixed(2)},${first[1].toFixed(2)}${rest
          .map(([x, y]) => `L${x.toFixed(2)},${y.toFixed(2)}`)
          .join("")}Z`;
      }),
    )
    .join("");
}
