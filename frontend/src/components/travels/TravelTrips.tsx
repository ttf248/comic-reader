import { useEffect, useMemo, useState } from "react";
import type { ChinaTrip } from "../../api/aiJobs";
import { useChinaTripMedia } from "../../hooks/useChinaLocations";
import { usePicks } from "../../hooks/usePicks";
import { usePhotoStore, wallTargetHeight } from "../../store/photoStore";
import { useUIStore } from "../../store/uiStore";
import PhotoViewer from "../wall/PhotoViewer";
import PhotoWall from "../wall/PhotoWall";
import { ChevronRightIcon } from "../common/Icon";
import ThumbImage from "../common/ThumbImage";

interface TravelTripsProps {
  /** 行程与停留，按开始时间升序。 */
  trips: ChinaTrip[];
  /** 当前选中的段。 */
  selectedTripId: string | null;
  /** 选中某一段。 */
  onSelect: (trip: ChinaTrip | null) => void;
  /** 归并粒度。取照片时必须带上，否则取到的不是这一段。 */
  granularity: string;
  /** 打开某个地点的详情页。 */
  onOpenPlace: (adcode: number) => void;
}

/**
 * 行程目录：按时间读的一段段行程。
 *
 * 每一段默认收成一行（约 44px）：日期、天数、地点链、张数。点开才就地
 * 展开照片 —— 一次读回几十段的全量照片既慢又没人看。
 *
 * 同时只展开一段：每段都能各自展开的话，整页长度不可控，几百段就是
 * 几万像素的滚动条。
 */
export default function TravelTrips({
  trips,
  selectedTripId,
  onSelect,
  granularity,
  onOpenPlace,
}: TravelTripsProps) {
  const groups = useMemo(() => {
    const result: { year: string; trips: ChinaTrip[] }[] = [];
    for (const trip of trips) {
      const year = trip.startedAt.slice(0, 4);
      const last = result[result.length - 1];
      if (last && last.year === year) last.trips.push(trip);
      else result.push({ year, trips: [trip] });
    }
    return result;
  }, [trips]);

  if (trips.length === 0) {
    return (
      <p className="py-12 text-center text-body text-fg-muted">
        这段时间还没有拍出带位置的行程。
      </p>
    );
  }

  return (
    <div className="travel-trips">
      {groups.map((group) => (
        <section key={group.year} className="travel-trips__group">
          <h3 className="travel-trips__year">{group.year}</h3>
          <ul className="travel-trips__list">
            {group.trips.map((trip) => (
              <li key={trip.id}>
                <TravelTripRow
                  trip={trip}
                  selected={selectedTripId === trip.id}
                  onSelect={() =>
                    onSelect(selectedTripId === trip.id ? null : trip)
                  }
                  granularity={granularity}
                  onOpenPlace={onOpenPlace}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface TravelTripRowProps {
  trip: ChinaTrip;
  selected: boolean;
  onSelect: () => void;
  granularity: string;
  onOpenPlace: (adcode: number) => void;
}

/**
 * 一段行程。
 *
 * 收着的时候是一行：日期、天数、地点链、类型与张数。展开后是这一段的
 * 照片：一条照片带，再往下是整段的照片墙。
 */
function TravelTripRow({
  trip,
  selected,
  onSelect,
  granularity,
  onOpenPlace,
}: TravelTripRowProps) {
  const [viewerResourceId, setViewerResourceId] = useState<string | null>(null);
  const density = usePhotoStore((state) => state.density);
  const picks = usePicks();
  const pushToast = useUIStore((state) => state.pushToast);

  // 只有这一段被展开或被点开时才去取照片。
  //
  // 取照片不能带时间区间：段是按「粒度 + 间隔」切出来的，列表与照片
  // 端点必须用同一套口径，否则按下标取到的不是这一段。
  const media = useChinaTripMedia(
    selected || viewerResourceId !== null ? trip.index : null,
    granularity,
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
            selected ? "收起这段的照片" : "看这段去了哪儿"
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
        </span>
      </div>

      {selected ? (
        <>
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
        </>
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
