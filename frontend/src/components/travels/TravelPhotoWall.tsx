import { useMemo, useState } from "react";
import PhotoWall from "../wall/PhotoWall";
import PhotoViewer from "../wall/PhotoViewer";
import type { ChinaTimeRange } from "../../api/aiJobs";
import type { LibraryFeedItem } from "../../api/library";
import { useChinaRegionMedia } from "../../hooks/useChinaLocations";
import { usePicks } from "../../hooks/usePicks";
import { usePhotoStore, wallTargetHeight } from "../../store/photoStore";
import { useUIStore } from "../../store/uiStore";
import { albumRoute } from "../../utils/path";

interface TravelPhotoWallProps {
  /** 当前叶子的区划码。 */
  adcode: number;
  /** 区域名称。 */
  name: string;
  /** 只看某一次到访的照片（到访清单里的序号）。 */
  visit?: number | null;
  /** 时间区间：只显示这段时间里的照片。 */
  timeRange?: ChinaTimeRange;
}

/**
 * 某个行政区的照片墙。
 *
 * 地图的最后一层就是照片本身：看完分布就落到照片，而不是停在数字上。
 */
export default function TravelPhotoWall({
  adcode,
  name,
  visit = null,
  timeRange,
}: TravelPhotoWallProps) {
  const density = usePhotoStore((state) => state.density);
  const picks = usePicks();
  const pushToast = useUIStore((state) => state.pushToast);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const query = useChinaRegionMedia(adcode, timeRange, visit);

  const items = useMemo<LibraryFeedItem[]>(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? items.length;
  const loadMore = () => void query.fetchNextPage({ cancelRefetch: false });

  return (
    <div className="flex h-[min(84vh,980px)] min-h-[460px] flex-col">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border-faint px-5 py-4">
        <h2 className="font-display text-section font-medium text-fg">
          {name}
        </h2>
        <span className="text-label font-medium tabular-nums text-brand-ink">
          {total.toLocaleString()} 张
        </span>
      </div>
      {query.isError ? (
        <div className="flex flex-1 items-center justify-center px-6 py-12 text-center text-body text-fg-muted">
          这个区域的照片暂时读不出来。
        </div>
      ) : items.length === 0 && !query.isLoading ? (
        <div className="flex flex-1 items-center justify-center px-6 py-12 text-center text-body text-fg-muted">
          这个区域暂时没有照片。
        </div>
      ) : (
        <div className="min-h-0 flex-1 px-2 pb-2 pt-3">
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
