import { useMemo, useState } from "react";
import { trajectoryPath, type TrajectoryStop } from "../../utils/chinaMap";

interface TrajectoryLayerProps {
  /** 停靠序列，按时间升序。 */
  stops: TrajectoryStop[];
  /** 取区域在 SVG 里的坐标（由行政区几何的质心投影而来）。 */
  centroidOf: (adcode: number) => [number, number] | null;
  /** 相邻停靠之间超过这个间隔（天）就不连线。 */
  maxGapDays?: number;
}

/**
 * 地图上的轨迹层。
 *
 * 折线连的是行政区的质心，不碰照片的坐标：响应里没有照片经纬度，
 * 而「我在杭州，后来到了上海」这件事，行政区级别已经说得清。
 *
 * 相邻停靠隔太久就不连线 —— 否则相隔两年的两次出行会被画成一条
 * 横跨半张图的假路径。
 */
export default function TrajectoryLayer({
  stops,
  centroidOf,
  maxGapDays = 2,
}: TrajectoryLayerProps) {
  const [active, setActive] = useState<TrajectoryStop | null>(null);
  const path = useMemo(
    () => trajectoryPath(stops, centroidOf, maxGapDays),
    [stops, centroidOf, maxGapDays],
  );
  const nodes = useMemo(
    () =>
      stops
        .map((stop) => ({ stop, point: centroidOf(stop.adcode) }))
        .filter(
          (entry): entry is { stop: TrajectoryStop; point: [number, number] } =>
            entry.point !== null,
        ),
    [stops, centroidOf],
  );

  if (stops.length === 0 || nodes.length === 0) return null;

  return (
    <g aria-label="拍摄轨迹" role="img">
      {path ? (
        <path
          d={path}
          fill="none"
          className="stroke-brand-ink"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="6 5"
          opacity={0.75}
        />
      ) : null}
      {nodes.map(({ stop, point }) => (
        <g
          key={`${stop.adcode}-${stop.at}`}
          role="img"
          aria-label={`${stop.name}，${stop.at} 起 ${stop.photoCount.toLocaleString()} 张照片`}
          onMouseEnter={() => setActive(stop)}
          onMouseLeave={() => setActive(null)}
        >
          <circle
            cx={point[0]}
            cy={point[1]}
            r={5}
            className="fill-brand stroke-bg-elevated"
            strokeWidth={1.5}
          />
          <circle cx={point[0]} cy={point[1]} r={11} fill="transparent" />
        </g>
      ))}
      {active
        ? (() => {
            const point = centroidOf(active.adcode);
            if (!point) return null;
            return (
              <g aria-hidden="true" pointerEvents="none">
                <circle
                  cx={point[0]}
                  cy={point[1]}
                  r={8}
                  className="fill-brand-ink"
                  opacity={0.9}
                />
              </g>
            );
          })()
        : null}
    </g>
  );
}
