import { useEffect, useMemo, useState } from "react";
import type { ChinaTrip, ChinaTimeRange } from "../../api/aiJobs";
import { useChinaTripMedia } from "../../hooks/useChinaLocations";
import { usePicks } from "../../hooks/usePicks";
import { usePhotoStore, wallTargetHeight } from "../../store/photoStore";
import { useUIStore } from "../../store/uiStore";
import PhotoViewer from "../wall/PhotoViewer";
import PhotoWall from "../wall/PhotoWall";
import { ChevronRightIcon } from "../common/Icon";
import ThumbImage from "../common/ThumbImage";

interface TravelJournalProps {
  /** 行程与停留，按开始时间升序。 */
  trips: ChinaTrip[];
  /** 当前选中的段（序号）；null 表示没有选中。 */
  selectedIndex: number | null;
  /** 选中或取消选中某一段。 */
  onSelect: (index: number | null) => void;
  /** 归并粒度。取照片时必须带上，否则取到的不是这一段。 */
  granularity: string;
  /** 时间区间。取照片时必须带上。 */
  timeRange?: ChinaTimeRange;
  /** 打开某个地点的详情页。 */
  onOpenPlace: (adcode: number) => void;
}

/**
 * 段流：一条按时间排的照片流，被行程切成段。
 *
 * 页面上的主角是照片，行程是照片之间的分段理由。因此每一段都由一张
 * 照片带撑着 —— 只有文字的行程读不出「那几天是什么样」。
 */
export default function TravelJournal({
  trips,
  selectedIndex,
  onSelect,
  granularity,
  timeRange,
  onOpenPlace,
}: TravelJournalProps) {
  if (trips.length === 0) {
    return (
      <p className="py-12 text-center text-body text-fg-muted">
        这段时间还没有拍出带位置的行程。
      </p>
    );
  }
  return (
    <div className="travel-journal">
      {trips.map((trip) => (
        <TravelSegment
          key={trip.id}
          trip={trip}
          selected={selectedIndex === trip.index}
          onSelect={() =>
            onSelect(selectedIndex === trip.index ? null : trip.index)
          }
          granularity={granularity}
          timeRange={timeRange}
          onOpenPlace={onOpenPlace}
        />
      ))}
    </div>
  );
}

interface TravelSegmentProps {
  trip: ChinaTrip;
  selected: boolean;
  onSelect: () => void;
  granularity: string;
  timeRange?: ChinaTimeRange;
  onOpenPlace: (adcode: number) => void;
}

/**
 * 一段行程。
 *
 * 照片带是这一段的门面；点它就打开这一段的照片。整段的照片在需要时
 * 才去取 —— 一次读回三十多段的全量照片既慢又没必要。
 */
function TravelSegment({
  trip,
  selected,
  onSelect,
  granularity,
  timeRange,
  onOpenPlace,
}: TravelSegmentProps) {
  const [expanded, setExpanded] = useState(false);
  const [viewerResourceId, setViewerResourceId] = useState<string | null>(null);
  const density = usePhotoStore((state) => state.density);
  const picks = usePicks();
  const pushToast = useUIStore((state) => state.pushToast);

  // 只有这一段被展开或被点开时才去取照片。
  const media = useChinaTripMedia(
    expanded || viewerResourceId !== null ? trip.index : null,
    granularity,
    timeRange,
  );
  const items = useMemo(
    () => media.data?.pages.flatMap((page) => page.items) ?? [],
    [media.data],
  );
  const total = media.data?.pages[0]?.total ?? items.length;
  const viewerIndex =
    viewerResourceId === null
      ? null
      : items.findIndex((item) => item.id === viewerResourceId);

  // 照片带是整段均匀取样的，可能落在第一页之外：还没取到就继续取下一页，
  // 否则点后半段的照片会毫无反应。
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = media;
  useEffect(() => {
    if (viewerResourceId === null || (viewerIndex ?? -1) >= 0) return;
    if (!hasNextPage || isFetchingNextPage) return;
    void fetchNextPage({ cancelRefetch: false });
  }, [
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    viewerIndex,
    viewerResourceId,
  ]);

  return (
    <section
      className="travel-segment"
      data-selected={selected ? "true" : undefined}
      aria-label={`${trip.startedAt} 至 ${trip.endedAt}`}
    >
      <div className="travel-segment__head">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          className="travel-segment__date"
          aria-label={`${trip.startedAt} 至 ${trip.endedAt}，${trip.dayCount} 天，${
            selected ? "收起这段的说明" : "看这段去了哪儿"
          }`}
        >
          <span className="travel-segment__range">
            {trip.startedAt}
            {trip.endedAt !== trip.startedAt ? ` – ${trip.endedAt.slice(5)}` : ""}
          </span>
          <span className="travel-segment__days">{trip.dayCount} 天</span>
        </button>

        <span className="travel-segment__route">
          {trip.stops.map((stop, index) => (
            <span key={`${stop.adcode}-${stop.at}`} className="flex items-center gap-1">
              {index > 0 ? (
                <ChevronRightIcon size={12} className="travel-segment__arrow" />
              ) : null}
              <button
                type="button"
                onClick={() => onOpenPlace(stop.adcode)}
                className="travel-segment__stop"
                title={`${stop.name} · ${stop.photoCount} 张`}
              >
                {stop.name}
                <span className="travel-segment__stop-count">
                  {stop.photoCount.toLocaleString()}
                </span>
              </button>
            </span>
          ))}
        </span>

        <span className="travel-segment__meta">
          <span
            className={
              trip.kind === "stay"
                ? "travel-segment__kind travel-segment__kind--stay"
                : "travel-segment__kind"
            }
          >
            {trip.kind === "stay" ? "停留" : "行程"}
          </span>
          <span className="tabular-nums text-fg-muted">
            {trip.photoCount.toLocaleString()} 张
          </span>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起照片" : `看这 ${trip.photoCount.toLocaleString()} 张`}
          </button>
        </span>
      </div>

      {trip.bandResourceIds.length > 0 ? (
        <div className="travel-segment__band">
          {trip.bandResourceIds.map((id) => (
            <button
              key={id}
              type="button"
              className="travel-segment__photo"
              onClick={() => setViewerResourceId(id)}
              aria-label="看这一段的照片"
            >
              <ThumbImage
                fileId={id}
                alt=""
                displayWidth={240}
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      ) : null}

      {expanded ? (
        <div className="travel-segment__grid">
          {media.isError ? (
            <p className="py-8 text-center text-body text-fg-muted">
              这一段的照片暂时读不出来。
            </p>
          ) : items.length === 0 && !media.isLoading ? (
            <p className="py-8 text-center text-body text-fg-muted">
              这一段没有照片。
            </p>
          ) : (
            <PhotoWall
              items={items}
              total={total}
              targetHeight={wallTargetHeight(density)}
              hasNextPage={media.hasNextPage ?? false}
              isLoadingMore={media.isFetchingNextPage}
              onLoadMore={() => void media.fetchNextPage({ cancelRefetch: false })}
              onOpen={(_item, index) => setViewerResourceId(items[index]?.id ?? null)}
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
          )}
        </div>
      ) : null}

      {viewerIndex !== null && viewerIndex >= 0 ? (
        <PhotoViewer
          items={items}
          index={viewerIndex}
          albumName={items[viewerIndex].albumName}
          totalCount={total}
          hasNextPage={media.hasNextPage ?? false}
          isLoadingMore={media.isFetchingNextPage}
          loadMoreError={media.isFetchNextPageError}
          onLoadMore={() => void media.fetchNextPage({ cancelRefetch: false })}
          onIndexChange={(index) => setViewerResourceId(items[index]?.id ?? null)}
          onClose={() => setViewerResourceId(null)}
          isPicked={picks.isPicked(items[viewerIndex].id)}
          onTogglePick={() => {
            void picks
              .toggle(items[viewerIndex].id)
              .catch(() =>
                pushToast({ kind: "error", message: "精选操作失败" }),
              );
          }}
        />
      ) : null}
    </section>
  );
}
