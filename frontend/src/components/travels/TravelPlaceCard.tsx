import { Link } from "react-router-dom";
import type { ChinaPlace } from "../../api/aiJobs";
import ThumbImage from "../common/ThumbImage";
import { shareOf } from "../../utils/travelMap";

interface TravelPlaceCardProps {
  /** 地点索引里的一项。 */
  place: ChinaPlace;
  /** 本层照片总数，作为占比条的分母。 */
  levelTotal: number;
  /** 打开这个地点。 */
  to: string;
}

/** 层级徽标的说法：省、市、区县。 */
const LEVEL_LABEL: Record<string, string> = {
  province: "省",
  city: "市",
  district: "区县",
};

/**
 * 地点卡：一张照片拼贴 + 一个名字 + 几个数。
 *
 * 代表照是这张卡存在的理由：只有数字的地点没法认出是哪个地方，
 * 拼上几张照片就认得了。
 */
export default function TravelPlaceCard({
  place,
  levelTotal,
  to,
}: TravelPlaceCardProps) {
  const share = shareOf(place.photoCount, levelTotal);
  const covers = place.coverResourceIds.slice(0, 3);
  return (
    <Link
      to={to}
      className="travel-place focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      aria-label={`${place.name}，${place.photoCount.toLocaleString()} 张照片，${place.visitCount} 次到访`}
    >
      {covers.length > 0 ? (
        <span className="travel-place__mosaic">
          {covers.map((id) => (
            <ThumbImage
              key={id}
              fileId={id}
              alt=""
              loading="lazy"
              displayWidth={160}
              className="h-full w-full object-cover"
            />
          ))}
        </span>
      ) : (
        <span className="travel-place__mosaic travel-place__mosaic--empty">
          没有代表照
        </span>
      )}
      <span className="travel-place__body">
        <span className="travel-place__name">
          <span className="travel-place__title">{place.name}</span>
          <span className="badge shrink-0 text-meta">
            {LEVEL_LABEL[place.level] ?? place.level}
          </span>
        </span>
        <span className="travel-place__meta">
          {place.photoCount.toLocaleString()} 张 · {place.visitCount} 次到访
        </span>
        <span className="travel-place__span">
          {place.firstAt && place.lastAt
            ? `${place.firstAt} – ${place.lastAt}`
            : "拍摄时间未知"}
        </span>
        <span className="travel-place__bar" aria-hidden="true">
          <span style={{ width: `${Math.max(share * 100, 2)}%` }} />
        </span>
      </span>
    </Link>
  );
}
