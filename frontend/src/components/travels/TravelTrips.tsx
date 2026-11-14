import { useEffect, useMemo, useRef, useState } from "react";
import type { ChinaTrip } from "../../api/aiJobs";
import { useChinaTripMedia } from "../../hooks/useChinaLocations";
import { usePicks } from "../../hooks/usePicks";
import { usePhotoStore, wallTargetHeight } from "../../store/photoStore";
import { useUIStore } from "../../store/uiStore";
import PhotoViewer from "../wall/PhotoViewer";
import PhotoWall from "../wall/PhotoWall";
import { ChevronRightIcon } from "../common/Icon";
import ThumbImage from "../common/ThumbImage";
import TravelTripPreview from "./TravelTripPreview";
import type { MapRegion } from "../../utils/travelMap";

interface TravelTripsProps {
  /** 行程与停留，按时间倒序读。 */
  trips: ChinaTrip[];
  /** 当前选中的段。 */
  selectedTripId: string | null;
  /** 选中某一段。 */
  onSelect: (trip: ChinaTrip | null) => void;
  /** 归并粒度。取照片时必须带上，否则取到的不是这一段。 */
  granularity: string;
  /** 打开某个地点的详情页。 */
  onOpenPlace: (adcode: number) => void;
  /** 各地点的形状：预览里的轨迹图靠它画。 */
  regions: MapRegion[];
  /** 参照层：全国省界。 */
  backdrop?: MapRegion[];
}

/**
 * 卡片上最多摆几个地点。
 *
 * 一次出行能串十几个地方，全摆出来卡片就高得读不成一行。收起的时候只
 * 摆前几个，末尾报一句「还有 N 处」；展开时整条地点链都摆出来。
 */
const MAX_STOPS = 4;

/**
 * 浮层往下展开时至少要留出的高度。
 *
 * 浮层有一张地图加一张站点表，比卡片高得多。卡片靠下时往下展开会掉出
 * 视口 —— 那时候翻到卡片上方去。
 */
const PREVIEW_MIN_SPACE = 460;

/**
 * 行程目录：按时间倒序读的一段段行程。
 *
 * 每一段是一张卡片：日期与张数一行，地点链一行。两列并排 —— 一段行程
 * 本身只有一行高，一列排下来整页读起来是空的。
 *
 * 点开才就地展开照片 —— 一次读回几十段的全量照片既慢又没人看。
 *
 * 同时只展开一段：每段都能各自展开的话，整页长度不可控，几百段就是
 * 几万像素的滚动条。展开的那张卡片横跨两列，照片带与照片墙才有地方摆。
 */
export default function TravelTrips({
  trips,
  selectedTripId,
  onSelect,
  granularity,
  onOpenPlace,
  regions,
  backdrop,
}: TravelTripsProps) {
  const groups = useMemo(() => {
    // 倒序：最近的出行排在最前面。年份由行程的开始时间决定，所以排好
    // 行程，年份自然也是倒序。
    const sorted = [...trips].sort((a, b) =>
      a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0,
    );
    const result: { year: string; trips: ChinaTrip[] }[] = [];
    for (const trip of sorted) {
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
              <li
                key={trip.id}
                data-selected={selectedTripId === trip.id ? "true" : undefined}
              >
                <TravelTripCard
                  trip={trip}
                  selected={selectedTripId === trip.id}
                  onSelect={() =>
                    onSelect(selectedTripId === trip.id ? null : trip)
                  }
                  granularity={granularity}
                  onOpenPlace={onOpenPlace}
                  regions={regions}
                  backdrop={backdrop}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface TravelTripCardProps {
  trip: ChinaTrip;
  selected: boolean;
  onSelect: () => void;
  granularity: string;
  onOpenPlace: (adcode: number) => void;
  regions: MapRegion[];
  backdrop?: MapRegion[];
}

/**
 * 一段行程。
 *
 * 收着的时候是一张卡片：日期与张数一行，地点链一行。展开后是这一段的
 * 照片：一条照片带，再往下是整段的照片墙。
 *
 * 悬停（或焦点落进来）时，底下浮出一张轨迹图：这一段去过的地方按次序
 * 连成一条带箭头的线，每一站标着序号。
 */
function TravelTripCard({
  trip,
  selected,
  onSelect,
  granularity,
  onOpenPlace,
  regions,
  backdrop,
}: TravelTripCardProps) {
  const [viewerResourceId, setViewerResourceId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewAbove, setPreviewAbove] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const density = usePhotoStore((state) => state.density);
  const picks = usePicks();
  const pushToast = useUIStore((state) => state.pushToast);

  // 浮层往下展开还是往上翻：卡片靠下时往下会掉出视口。
  const openPreview = () => {
    const element = cardRef.current;
    if (element) {
      const rect = element.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom;
      setPreviewAbove(below < PREVIEW_MIN_SPACE && rect.top > below);
    }
    setPreviewOpen(true);
  };

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

  // 收起时只摆前几个地点；展开后整条链都摆出来。
  const stops = selected ? trip.stops : trip.stops.slice(0, MAX_STOPS);
  const hiddenStops = trip.stops.length - stops.length;

  return (
    <section
      className="travel-trip-card"
      ref={cardRef}
      data-selected={selected ? "true" : undefined}
      aria-label={`${trip.startedAt} 至 ${trip.endedAt}`}
      onMouseEnter={openPreview}
      onMouseLeave={() => setPreviewOpen(false)}
      onFocus={openPreview}
      onBlur={(event) => {
        // 焦点还在这张卡里就别收：地点链上的按钮挨个 Tab 时预览要留着。
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setPreviewOpen(false);
        }
      }}
    >
      <div className="travel-trip-card__head">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          className="travel-trip-card__date"
          aria-label={`${trip.startedAt} 至 ${trip.endedAt}，${trip.dayCount} 天，${
            selected ? "收起这段的照片" : "看这段去了哪儿"
          }`}
        >
          <span className="travel-trip-card__range">
            {trip.startedAt}
            {trip.endedAt !== trip.startedAt ? ` – ${trip.endedAt.slice(5)}` : ""}
          </span>
        </button>

        <span className="travel-trip-card__meta">
          <span
            className={
              trip.kind === "stay"
                ? "travel-trip-card__kind travel-trip-card__kind--stay"
                : "travel-trip-card__kind"
            }
          >
            {trip.kind === "stay" ? "停留" : "行程"}
          </span>
          <span className="tabular-nums">{trip.dayCount} 天</span>
          <span className="tabular-nums">{trip.photoCount.toLocaleString()} 张</span>
        </span>
      </div>

      <div className="travel-trip-card__route">
        {stops.map((stop, index) => (
          <span key={`${stop.adcode}-${stop.at}`} className="flex items-center gap-1">
            {index > 0 ? (
              <ChevronRightIcon size={12} className="travel-trip-card__arrow" />
            ) : null}
            <button
              type="button"
              onClick={() => onOpenPlace(stop.adcode)}
              className="travel-trip-card__stop"
              title={`${stop.name} · ${stop.photoCount} 张`}
            >
              {stop.name}
              <span className="travel-trip-card__stop-count">
                {stop.photoCount.toLocaleString()}
              </span>
            </button>
          </span>
        ))}
        {hiddenStops > 0 ? (
          <span className="travel-trip-card__more">还有 {hiddenStops} 处</span>
        ) : null}
      </div>

      {/* 悬停时浮出来的轨迹图：这一段按次序走过哪些地方。 */}
      {previewOpen ? (
        <div
          className={
            previewAbove
              ? "travel-trip-card__preview travel-trip-card__preview--above"
              : "travel-trip-card__preview"
          }
          role="group"
          aria-label="这一段的行程轨迹"
        >
          <TravelTripPreview
            trip={trip}
            regions={regions}
            backdrop={backdrop}
          />
        </div>
      ) : null}

      {selected ? (
        <>
          {trip.bandResourceIds.length > 0 ? (
            <div className="travel-trip-card__band">
              {trip.bandResourceIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="travel-trip-card__photo"
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

          <div className="travel-trip-card__grid">
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
