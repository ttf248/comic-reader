import { useMemo } from "react";
import type { ChinaGeometryFeature } from "../../api/aiJobs";
import { createMapProjection, regionPath } from "../../utils/travelMap";

interface TravelLocatorMapProps {
  /** 上级区划的全部轮廓要素。 */
  features: ChinaGeometryFeature[];
  /** 当前地点的区划码。 */
  adcode: number;
  /** 当前地点的名字。 */
  name: string;
}

/**
 * 位置图：这个地方在上级区划里的位置。
 *
 * 它不是分布图 —— 分布图回答「哪里拍得多」，这里回答「这是哪儿」。
 * 所以只有当前这一个地方着色，其余全是中性底；也不给交互：
 * 点旁边那块灰的省级轮廓跳去那个省，是一件读者不会期待的事。
 *
 * 画全幅而不是裁到内容：裁了就只剩下这一个省，失去「在哪儿」的意义。
 */
export default function TravelLocatorMap({
  features,
  adcode,
  name,
}: TravelLocatorMapProps) {
  const projection = useMemo(
    () =>
      createMapProjection(
        features.map((feature) => ({
          adcode: feature.adcode,
          name: feature.name,
          level: feature.level,
          photoCount: 0,
          geometry: feature.geometry,
        })),
      ),
    [features],
  );

  if (features.length === 0) return null;

  return (
    <div>
      <div className="travel-map">
        <svg
          role="img"
          aria-label={`${name}在上级区划中的位置`}
          viewBox={projection.viewBox}
        >
          {features.map((feature) => (
            <path
              key={feature.adcode}
              d={regionPath(feature.geometry, projection.project)}
              className={feature.adcode === adcode ? "fill-brand" : "fill-bg-strong"}
              stroke="var(--border-strong)"
              strokeWidth={1.4}
              strokeLinejoin="round"
              fillRule="evenodd"
            />
          ))}
        </svg>
      </div>
      <p className="mt-2 flex items-center gap-2 text-meta text-fg-muted">
        <span className="h-2.5 w-4 shrink-0 rounded-sm bg-brand" aria-hidden="true" />
        {name}
      </p>
    </div>
  );
}
