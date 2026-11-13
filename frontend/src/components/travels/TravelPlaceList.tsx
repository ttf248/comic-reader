import type { ChinaPlace } from "../../api/aiJobs";
import ThumbImage from "../common/ThumbImage";

interface TravelPlaceListProps {
  /** 地点索引：去过哪些地方。 */
  places: ChinaPlace[];
  /**
   * 挂在哪里。
   *
   * map 是浮在大地图左上角的一层；menu 是从地图上方那条窄栏里往左展开
   * 的菜单 —— 地图留在原地不遮。
   */
  anchor?: "map" | "menu";
  /** 收起清单。 */
  onClose: () => void;
  /** 打开某个地点的详情页。 */
  onOpenPlace: (adcode: number) => void;
}

/** 层级徽标的说法：省、市、区县。 */
const LEVEL_LABEL: Record<string, string> = {
  province: "省",
  city: "市",
  district: "区县",
};

/**
 * 去过的地方。
 *
 * 它浮在地图上：地图回答「在哪儿」，清单回答「叫什么名字」—— 地图上的
 * 形状认不出是杭州还是绍兴，得有一份带名字的清单。
 */
export default function TravelPlaceList({
  places,
  anchor = "map",
  onClose,
  onOpenPlace,
}: TravelPlaceListProps) {
  return (
    <div
      className={
        anchor === "menu"
          ? "travel-place-list travel-place-list--menu"
          : "travel-place-list"
      }
      role="complementary"
      aria-label="去过的地方"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-label font-medium text-fg">
          去过的地方
        </h2>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
          收起
        </button>
      </div>
      {places.length === 0 ? (
        <p className="mt-3 text-body text-fg-muted">
          这段时间还没有去过什么地方。
        </p>
      ) : (
        <>
          <p className="mt-1 text-meta text-fg-muted">
            只列有照片的地方；照片数含下级。
          </p>
          <ul className="travel-place-list__items">
            {places.map((place) => (
              <li key={place.adcode}>
                <button
                  type="button"
                  onClick={() => onOpenPlace(place.adcode)}
                  className="travel-place-list__item"
                >
                  <span className="travel-place-list__mosaic">
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
      )}
    </div>
  );
}
