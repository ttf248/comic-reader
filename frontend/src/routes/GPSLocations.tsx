import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import PageHeading from "../components/common/PageHeading";
import EmptyState from "../components/common/EmptyState";
import PhotoWall from "../components/wall/PhotoWall";
import PhotoViewer from "../components/wall/PhotoViewer";
import RenditionImage from "../components/common/RenditionImage";
import { aiJobsApi, type GPSLocationMedia } from "../api/aiJobs";
import { usePhotoStore, wallTargetHeight } from "../store/photoStore";
import { usePicks } from "../hooks/usePicks";
import { useUIStore } from "../store/uiStore";
import { albumRoute, homeRoute, locationsRoute } from "../utils/path";
import { MapPinIcon } from "../components/common/Icon";

export default function GPSLocations() {
  const { locationId } = useParams();
  return locationId ? (
    <GPSLocationMedia locationId={locationId} />
  ) : (
    <GPSLocationList />
  );
}

function GPSLocationList() {
  const query = useInfiniteQuery({
    queryKey: ["gps-locations"],
    queryFn: ({ pageParam }) =>
      aiJobsApi.locations(pageParam).then((result) => result.page),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
  });
  const locations = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? locations.length;

  return (
    <div className="h-full overflow-y-auto pb-12">
      <PageHeading
        eyebrow="离线智能相册"
        title="拍摄地点"
        description="按照片中记录的 GPS 坐标聚合。地点以坐标显示，不请求在线地图或地理编码服务。"
      />
      {query.isError ? (
        <p role="alert" className="page-shell mt-5 text-meta text-danger">
          地点列表加载失败，请稍后重试。
        </p>
      ) : null}
      {locations.length === 0 && !query.isLoading ? (
        <EmptyState
          title="还没有可用的 GPS 地点"
          description="先到任务中心运行 EXIF 与 GPS 元数据分析。只有仍在当前媒体库中的照片会出现在这里。"
          icon={<MapPinIcon size={28} />}
          action={
            <Link className="btn btn-outline" to="/tasks">
              打开任务中心
            </Link>
          }
        />
      ) : (
        <section className="page-shell mt-6">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <p className="text-meta text-fg-muted">
              {total.toLocaleString()} 个地点
            </p>
            {query.isLoading && (
              <span className="text-meta text-fg-subtle">读取中…</span>
            )}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {locations.map((location) => (
              <Link
                key={location.id}
                to={locationsRoute(location.id)}
                className="group overflow-hidden rounded-xl border border-border-faint bg-bg-elevated transition-colors hover:border-border-strong"
              >
                <div className="relative aspect-[1.7/1] overflow-hidden bg-bg-subtle">
                  {location.coverResourceId ? (
                    <RenditionImage
                      fileId={location.coverResourceId}
                      alt=""
                      displayWidth={560}
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-fg-subtle">
                      <MapPinIcon size={32} />
                    </div>
                  )}
                  <span className="absolute bottom-3 left-3 rounded-full bg-black/65 px-2.5 py-1 text-meta text-white backdrop-blur-sm">
                    {location.fileCount.toLocaleString()} 张
                  </span>
                </div>
                <div className="flex items-start justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <h2 className="truncate font-display text-label font-medium text-fg">
                      {location.name}
                    </h2>
                    <p className="mt-1 text-meta text-fg-muted">
                      {location.latitude.toFixed(5)}°,{" "}
                      {location.longitude.toFixed(5)}°
                    </p>
                  </div>
                  <span className="shrink-0 text-meta text-fg-subtle">
                    {location.albumCount} 本相册
                  </span>
                </div>
              </Link>
            ))}
          </div>
          {query.hasNextPage && (
            <div className="mt-6 text-center">
              <button
                className="btn btn-outline"
                onClick={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? "加载中…" : "加载更多地点"}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function GPSLocationMedia({ locationId }: { locationId: string }) {
  const navigate = useNavigate();
  const density = usePhotoStore((state) => state.density);
  const picks = usePicks();
  const pushToast = useUIStore((state) => state.pushToast);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["gps-location-media", locationId],
    queryFn: ({ pageParam }) =>
      aiJobsApi
        .locationMedia(locationId, pageParam)
        .then((result) => result.page),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
  });
  const items = useMemo<GPSLocationMedia[]>(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? items.length;
  const location = query.data?.pages[0]?.location;
  const title = location?.name ?? "GPS 地点照片";
  const loadMore = () => void query.fetchNextPage({ cancelRefetch: false });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border-faint bg-bg">
        <div className="px-[clamp(20px,3vw,48px)]">
          <div className="album-bar">
            <div className="min-w-0 flex-1">
              <p className="page-eyebrow">拍摄地点 · 离线坐标</p>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="album-bar__title truncate">{title}</h1>
                {location && (
                  <span className="album-bar__meta tabular-nums">
                    {location.latitude.toFixed(5)}°,{" "}
                    {location.longitude.toFixed(5)}° · {total.toLocaleString()}{" "}
                    张 · {location.albumCount} 本相册
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => navigate(locationsRoute())}
            >
              全部地点
            </button>
          </div>
        </div>
      </header>
      {query.isError ? (
        <div className="flex flex-1 items-center justify-center text-body text-fg-muted">
          地点已失效或照片加载失败。
          <Link className="ml-1 underline" to={homeRoute("photo")}>
            回照片库
          </Link>
        </div>
      ) : items.length === 0 && !query.isLoading ? (
        <EmptyState
          title="这个地点暂时没有照片"
          description="媒体库更新后，地点相册会按当前扫描结果重新计算。"
          dense
        />
      ) : (
        <div className="min-h-0 flex-1 px-[clamp(20px,3vw,48px)] pb-2 pt-3">
          <PhotoWall
            items={items}
            total={total}
            targetHeight={wallTargetHeight(density)}
            hasNextPage={query.hasNextPage ?? false}
            isLoadingMore={query.isFetchingNextPage}
            onLoadMore={loadMore}
            onOpen={(_item, index) => setViewerIndex(index)}
            albumLabel={(item) => item.albumName}
            isPicked={picks.isPicked}
            onTogglePick={(item) => {
              void picks
                .toggle(item.id)
                .catch(() =>
                  pushToast({ kind: "error", message: "精选操作失败" }),
                );
            }}
          />
        </div>
      )}
      {viewerIndex !== null && items[viewerIndex] && (
        <PhotoViewer
          items={items}
          index={viewerIndex}
          albumName={items[viewerIndex].albumName}
          albumHref={albumRoute("photo", items[viewerIndex].albumId)}
          totalCount={total}
          hasNextPage={query.hasNextPage ?? false}
          isLoadingMore={query.isFetchingNextPage}
          loadMoreError={query.isFetchNextPageError}
          onLoadMore={loadMore}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          isPicked={picks.isPicked(items[viewerIndex].id)}
          onTogglePick={() => {
            void picks
              .toggle(items[viewerIndex].id)
              .catch(() =>
                pushToast({ kind: "error", message: "精选操作失败" }),
              );
          }}
        />
      )}
    </div>
  );
}
