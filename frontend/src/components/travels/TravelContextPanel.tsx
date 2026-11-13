import { useMemo } from "react";
import type { ChinaPlace, ChinaTrip } from "../../api/aiJobs";
import { useChinaOutlines } from "../../hooks/useChinaLocations";
import ThumbImage from "../common/ThumbImage";
import TravelMap from "./TravelMap";
import type { MapRegion } from "../../utils/travelMap";

interface TravelContextPanelProps {
  /** 选中的行程；null 时面板显示地点清单。 */
  trip: ChinaTrip | null;
  /** 地点索引：面板的第二种形态。 */
  places: ChinaPlace[];
  /** 关闭面板。 */
  onClose: () => void;
  /** 打开某个地点。 */
  onOpenPlace: (adcode: number) => void;
}

/** 层级徽标的说法：省、市、区县。 */
const LEVEL_LABEL: Record<string, string> = {
  province: "省",
  city: "市",
  district: "区县",
};

/**
 * 右栏上下文面板。
 *
 * 它平时不存在：地图是一件按需出现的配图，常驻右栏只会占着版面却答不了
 * 任何问题。选中某一段行程，这里回答「这段去了哪儿」；打开「地方」，这里
 * 回答「我去过哪些地方」。
 */
export default function TravelContextPanel({
  trip,
  places,
  onClose,
  onOpenPlace,
}: TravelContextPanelProps) {
  return (
    <aside className="travel-context" aria-label="上下文">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-label font-medium text-fg">
          {trip ? "这段行程" : "去过的地方"}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="btn btn-sm btn-ghost"
          aria-label="收起面板"
        >
          收起
        </button>
      </div>
      {trip ? (
        <TripContext trip={trip} onOpenPlace={onOpenPlace} onClose={onClose} />
      ) : (
        <PlaceContext places={places} onOpenPlace={onOpenPlace} />
      )}
    </aside>
  );
}

/** 一段行程的说明：去了哪儿、每处待了多久。 */
function TripContext({
  trip,
  onOpenPlace,
  onClose,
}: {
  trip: ChinaTrip;
  onOpenPlace: (adcode: number) => void;
  onClose: () => void;
}) {
  // 轮廓按「停留点的直接上级」取：停留点是市，上级是省，轮廓就是该省的
  // 城市；停留点是省，上级为空，轮廓就是全国各省。
  const parents = useMemo(
    () => trip.stops.map((stop) => stop.parentAdcode ?? 0),
    [trip],
  );
  const features = useChinaOutlines(parents);
  const regions: MapRegion[] = useMemo(() => {
    const counts = new Map<number, number>();
    for (const stop of trip.stops) {
      counts.set(stop.adcode, (counts.get(stop.adcode) ?? 0) + stop.photoCount);
    }
    return features.map((feature) => ({
      adcode: feature.adcode,
      name: feature.name,
      level: feature.level,
      photoCount: counts.get(feature.adcode) ?? 0,
      geometry: feature.geometry,
    }));
  }, [features, trip]);

  return (
    <>
      <p className="mt-1.5 text-meta text-fg-muted">
        {trip.startedAt}
        {trip.endedAt !== trip.startedAt ? ` – ${trip.endedAt}` : ""} ·{" "}
        {trip.dayCount} 天 · {trip.photoCount.toLocaleString()} 张
      </p>
      {regions.length > 0 ? (
        <div className="mt-3">
          <TravelMap
            regions={regions}
            levelTotal={trip.photoCount}
            scopeLabel="这段行程"
            legend={`这段行程去过 ${trip.stops.length} 个地方`}
            cropToggle={false}
            onSelect={(region) => onOpenPlace(region.adcode)}
            onLevelUp={onClose}
          />
        </div>
      ) : null}
      <ul className="travel-context__stops">
        {trip.stops.map((stop) => (
          <li key={`${stop.adcode}-${stop.at}`}>
            <button
              type="button"
              onClick={() => onOpenPlace(stop.adcode)}
              className="travel-context__stop"
            >
              <span className="min-w-0 flex-1 truncate text-body text-fg">
                {stop.name}
              </span>
              <span className="badge shrink-0 text-meta">
                {LEVEL_LABEL[stop.level] ?? stop.level}
              </span>
              <span className="shrink-0 text-meta tabular-nums text-fg-muted">
                {stop.photoCount.toLocaleString()} 张
              </span>
            </button>
            <p className="mt-0.5 pl-1 text-meta tabular-nums text-fg-subtle">
              {stop.at}
              {stop.until !== stop.at ? ` – ${stop.until}` : ""} · {stop.dayCount} 天
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

/** 地点清单：去过哪些地方。 */
function PlaceContext({
  places,
  onOpenPlace,
}: {
  places: ChinaPlace[];
  onOpenPlace: (adcode: number) => void;
}) {
  if (places.length === 0) {
    return (
      <p className="mt-3 text-body text-fg-muted">
        这段时间还没有去过什么地方。
      </p>
    );
  }
  return (
    <>
      <p className="mt-1.5 text-meta text-fg-muted">
        只列有照片的地方；照片数含下级。
      </p>
      <ul className="travel-context__places">
        {places.map((place) => (
          <li key={place.adcode}>
            <button
              type="button"
              onClick={() => onOpenPlace(place.adcode)}
              className="travel-context__place"
            >
              <span className="travel-context__mosaic">
                {place.coverResourceIds.slice(0, 3).map((id) => (
                  <ThumbImage
                    key={id}
                    fileId={id}
                    alt=""
                    displayWidth={120}
                    className="h-full w-full object-cover"
                  />
                ))}
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span className="flex items-center gap-2">
                  <span className="truncate text-body text-fg">{place.name}</span>
                  <span className="badge shrink-0 text-meta">
                    {LEVEL_LABEL[place.level] ?? place.level}
                  </span>
                </span>
                <span className="mt-0.5 block text-meta tabular-nums text-fg-muted">
                  {place.photoCount.toLocaleString()} 张 · {place.visitCount} 次到访
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
