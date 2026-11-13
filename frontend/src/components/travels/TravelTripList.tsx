import type { ChinaTrip } from "../../api/aiJobs";
import { ChevronRightIcon } from "../common/Icon";
import ThumbImage from "../common/ThumbImage";

interface TravelTripListProps {
  /** 行程与停留，按开始时间升序。 */
  trips: ChinaTrip[];
  /** 打开一次行程。 */
  onOpen: (trip: ChinaTrip) => void;
}

/**
 * 行程清单：什么时候去了哪些地方。
 *
 * 一行读下来是一份出行日记：左边是日子，中间是节点，右边是去过的
 * 地方。只有一个地方的那段是「停留」——「2011 年到 2014 年都在江西」
 * 是一句实话，写成「行程」就成了假的移动。
 */
export default function TravelTripList({ trips, onOpen }: TravelTripListProps) {
  if (trips.length === 0) {
    return (
      <p className="text-body text-fg-muted">
        这段时间没有可用的拍摄时间，切不出行程。
      </p>
    );
  }
  return (
    <ol className="travel-trips">
      {trips.map((trip) => {
        const isStay = trip.kind === "stay";
        const covers = trip.coverResourceIds.slice(0, 4);
        return (
          <li key={trip.id}>
            <button
              type="button"
              onClick={() => onOpen(trip)}
              className="travel-trip w-full text-left transition-colors hover:bg-bg-subtle focus-visible:bg-bg-subtle focus-visible:outline-none"
              aria-label={`${trip.startedAt} 至 ${trip.endedAt}，${trip.dayCount} 天，${trip.photoCount} 张照片，${trip.stops.map((stop) => stop.name).join("、")}`}
            >
              <span className="travel-trip__stamp">
                <span className="block font-mono text-meta tabular-nums text-fg-subtle">
                  {trip.startedAt}
                </span>
                <span className="block font-mono text-meta tabular-nums text-fg-subtle">
                  {trip.endedAt}
                </span>
                <span className="mt-0.5 block text-meta text-fg-subtle">
                  {trip.dayCount} 天
                </span>
              </span>
              <span className="travel-trip__node" aria-hidden="true" />
              <span className="travel-trip__content">
                <span className="travel-trip__route">
                  {trip.stops.map((stop, index) => (
                    <span key={`${stop.adcode}-${stop.at}`} className="flex items-center gap-1">
                      {index > 0 ? (
                        <ChevronRightIcon size={12} className="travel-trip__arrow" />
                      ) : null}
                      {/* 停留只有一个地方：用药丸把它和「走过多个地方」分开，
                          不然一行里两种语义长得一样。 */}
                      {isStay ? (
                        <span className="travel-trip__stop travel-trip__stop--stay">
                          {stop.name}
                          <span className="travel-trip__count">
                            {stop.photoCount.toLocaleString()}
                          </span>
                        </span>
                      ) : (
                        <span className="travel-trip__stop">
                          {stop.name}
                          <span className="travel-trip__count">
                            {stop.photoCount.toLocaleString()}
                          </span>
                        </span>
                      )}
                    </span>
                  ))}
                </span>
                <span className="mt-1 flex items-center gap-3">
                  <span className="travel-trip__kind">
                    {isStay ? "停留" : "行程"}
                  </span>
                  <span className="text-meta tabular-nums text-fg-muted">
                    {trip.photoCount.toLocaleString()} 张
                  </span>
                  {covers.length > 0 ? (
                    <span className="flex gap-1">
                      {covers.map((id) => (
                        <ThumbImage
                          key={id}
                          fileId={id}
                          alt=""
                          loading="lazy"
                          displayWidth={72}
                          className="h-9 w-12 rounded object-cover"
                        />
                      ))}
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
