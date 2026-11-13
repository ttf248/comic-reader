import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import EmptyState from "../components/common/EmptyState";
import PhotoWall from "../components/wall/PhotoWall";
import PhotoViewer from "../components/wall/PhotoViewer";
import { aiJobsApi, type GPSLocationMedia } from "../api/aiJobs";
import ChinaLocations from "./ChinaLocations";
import { usePhotoStore, wallTargetHeight } from "../store/photoStore";
import { usePicks } from "../hooks/usePicks";
import { useUIStore } from "../store/uiStore";
import { albumRoute, homeRoute, locationsRoute } from "../utils/path";

export default function GPSLocations() {
  const { locationId } = useParams();
  return locationId ? (
    <GPSLocationMedia locationId={locationId} />
  ) : (
    <ChinaLocations />
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
