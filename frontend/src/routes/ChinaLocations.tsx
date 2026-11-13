import { useCallback, useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import PageHeading from "../components/common/PageHeading";
import { MapPinIcon } from "../components/common/Icon";
import LocationBreadcrumb, {
  type LocationCrumb,
} from "../components/locations/LocationBreadcrumb";
import RegionMap from "../components/locations/RegionMap";
import RegionPhotoWall from "../components/locations/RegionPhotoWall";
import RegionRanking, {
  type RankingRegion,
} from "../components/locations/RegionRanking";
import { useChinaRegions, useChinaSummary } from "../hooks/useChinaLocations";
import type { MapRegion } from "../utils/chinaMap";
import { locationRegionRoute, locationsRoute } from "../utils/path";

/** 从查询参数里读区划码。 */
function parseAdcode(raw: string | null): number | null {
  if (!raw || !/^\d{6}$/.test(raw)) return null;
  return Number(raw);
}

export default function ChinaLocations() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const adcode = parseAdcode(searchParams.get("adcode"));

  const summaryQuery = useChinaSummary();
  const summary = summaryQuery.data;
  const regionsQuery = useChinaRegions(adcode);
  const regionInfo = regionsQuery.data?.region;
  const childRegions = regionsQuery.data?.regions ?? [];

  const gotoRegion = useCallback(
    (next: number | null) => {
      navigate(next === null ? locationsRoute() : locationRegionRoute(next));
    },
    [navigate],
  );

  // 全国层级用汇总里的省级数据；下钻后用区域接口给出的下一级。
  const isNationLevel = adcode === null;
  const regions: MapRegion[] = useMemo(() => {
    if (isNationLevel) {
      return (summary?.provinces ?? []).map((province) => ({
        adcode: province.adcode,
        name: province.name,
        level: "province",
        photoCount: province.photoCount,
        geometry: province.geometry,
      }));
    }
    return childRegions.map((region) => ({
      adcode: region.adcode,
      name: region.name,
      level: region.level,
      photoCount: region.photoCount,
      geometry: region.geometry,
    }));
  }, [childRegions, isNationLevel, summary?.provinces]);

  // 色阶与占比的分母：本层的照片总数。全国是匹配到省份的总数，
  // 省内是该省的照片总数（含省内未细分的那部分）。
  const levelTotal = isNationLevel
    ? (summary?.chinaPhotoCount ?? 0)
    : (regionInfo?.photoCount ?? 0);

  const levelName = useMemo(() => {
    if (isNationLevel) return "省级区域";
    const level = childRegions[0]?.level;
    return level === "district" ? "区县" : "地级区域";
  }, [childRegions, isNationLevel]);

  const levelLabel = isNationLevel ? "全国" : (regionInfo?.name ?? "全国");

  const chain = useMemo<LocationCrumb[]>(() => {
    if (!regionInfo) return [{ adcode: null, name: "全国" }];
    if (regionInfo.parentAdcode === null) {
      return [
        { adcode: null, name: "全国" },
        { adcode: regionInfo.adcode, name: regionInfo.name },
      ];
    }
    const parent = summary?.provinces.find(
      (province) => province.adcode === regionInfo.parentAdcode,
    );
    return [
      { adcode: null, name: "全国" },
      {
        adcode: regionInfo.parentAdcode,
        name: parent?.name ?? "上级区域",
      },
      { adcode: regionInfo.adcode, name: regionInfo.name },
    ];
  }, [regionInfo, summary?.provinces]);

  const rankingRegions: RankingRegion[] = useMemo(
    () =>
      regions.map((region) => ({
        adcode: region.adcode,
        name: region.name,
        level: region.level,
        photoCount: region.photoCount,
      })),
    [regions],
  );

  // 叶子区域没有下一级边界，直接落到它的照片墙。
  const isLeaf =
    !isNationLevel && regionsQuery.isSuccess && childRegions.length === 0;

  const levelUp = useCallback(() => {
    if (isNationLevel) return;
    const parent = chain[chain.length - 2];
    gotoRegion(parent?.adcode ?? null);
  }, [chain, gotoRegion, isNationLevel]);

  const handleSelect = useCallback(
    (region: { adcode: number }) => {
      gotoRegion(region.adcode);
    },
    [gotoRegion],
  );

  const loading = isNationLevel
    ? summaryQuery.isLoading
    : regionsQuery.isLoading;
  const error = isNationLevel ? summaryQuery.isError : regionsQuery.isError;

  return (
    <div className="h-full overflow-y-auto pb-12">
      <PageHeading
        eyebrow="离线地点图谱"
        title="拍摄地点"
        description="照片坐标在本机匹配到行政区边界，逐级下钻查看各地的照片分布。"
      />
      <section className="page-shell mt-5 space-y-4">
        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-bg-elevated px-4 py-3 text-body text-danger"
          >
            <span>离线地点地图加载失败，请稍后重试。</span>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() =>
                void (isNationLevel
                  ? summaryQuery.refetch()
                  : regionsQuery.refetch())
              }
            >
              重新加载
            </button>
          </div>
        ) : null}

        {summary ? (
          <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl border border-border-faint bg-bg-elevated px-4 py-2.5 text-meta text-fg-muted">
              <span>
                带 GPS 照片{" "}
                <span className="tabular-nums text-fg">
                  {summary.gpsPhotoCount.toLocaleString()}
                </span>{" "}
                张
              </span>
              <span>
                匹配到省份{" "}
                <span className="tabular-nums text-fg">
                  {summary.chinaPhotoCount.toLocaleString()}
                </span>{" "}
                张
              </span>
              <span>
                未匹配省份{" "}
                <span className="tabular-nums text-fg">
                  {summary.unassignedPhotoCount.toLocaleString()}
                </span>{" "}
                张
              </span>
            </div>
            {summary.gpsPhotoCount === 0 ? (
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
            {/* 全国层级没有上级，面包屑只剩一个词，没有信息量。 */}
            {chain.length > 1 ? (
              <LocationBreadcrumb chain={chain} onNavigate={gotoRegion} />
            ) : null}
            <div
              className={`grid grid-cols-1 items-start gap-4 ${
                isLeaf
                  ? ""
                  : "xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.75fr)]"
              }`}
            >
              <section
                aria-label="行政区照片地图"
                className="min-w-0 overflow-hidden rounded-2xl border border-border-faint bg-bg-elevated"
              >
                {isLeaf ? (
                  <RegionPhotoWall
                    adcode={regionInfo?.adcode ?? adcode ?? 0}
                    name={regionInfo?.name ?? ""}
                  />
                ) : (
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-faint px-4 py-4 sm:px-5">
                      <div className="min-w-0">
                        <h2 className="font-display text-label font-medium text-fg">
                          {isNationLevel
                            ? "全国省级照片地图"
                            : `${levelLabel}地图`}
                        </h2>
                        <p className="mt-1 text-meta text-fg-muted">
                          {isNationLevel
                            ? `${regions.length} 个省级区域 · 点击省份进入该省地图`
                            : `${regions.length} 个${levelName} · 点击区域下钻`}
                          {regionInfo && regionInfo.unmatchedAreaPhotoCount > 0
                            ? ` · 省内未细分 ${regionInfo.unmatchedAreaPhotoCount.toLocaleString()} 张`
                            : ""}
                        </p>
                      </div>
                      <div
                        className="flex items-center gap-2 text-meta text-fg-muted"
                        aria-label="颜色深浅表示照片数量"
                      >
                        <span>少</span>
                        <span className="h-2.5 w-12 rounded-full bg-gradient-to-r from-brand-soft to-brand" />
                        <span>多</span>
                        <span className="ml-1 text-fg-subtle">
                          基准：{levelLabel} · {levelTotal.toLocaleString()} 张
                        </span>
                      </div>
                    </div>
                    {loading ? (
                      <div className="flex min-h-[420px] items-center justify-center text-body text-fg-muted">
                        正在载入{levelLabel}地图…
                      </div>
                    ) : (
                      <RegionMap
                        regions={regions}
                        levelTotal={levelTotal}
                        levelName={levelName}
                        levelLabel={levelLabel}
                        showLabels={!isNationLevel}
                        onSelect={handleSelect}
                        onLevelUp={levelUp}
                      />
                    )}
                  </>
                )}
              </section>
              {!isLeaf ? (
                <RegionRanking
                  regions={rankingRegions}
                  levelTotal={levelTotal}
                  title={
                    isNationLevel ? "省份排行" : `${levelLabel}${levelName}排行`
                  }
                  onSelect={handleSelect}
                />
              ) : null}
            </div>
            <p className="px-1 text-meta leading-relaxed text-fg-subtle">
              坐标与边界均在本机处理。离线边界数据来自阿里云 DataV
              GeoAtlas（areas_v3，2021.5）；官方说明为学习交流用途，商业使用请先联系数据权利方。
            </p>
          </>
        ) : loading ? (
          <div className="flex min-h-64 items-center justify-center rounded-2xl border border-border-faint bg-bg-elevated text-body text-fg-muted">
            正在载入全国地图…
          </div>
        ) : null}
      </section>
    </div>
  );
}
