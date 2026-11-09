import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { SeriesGroup } from "../../utils/albumGrouping";
import Timeline, { type TimelineEntry } from "./Timeline";

interface Props {
  groups: SeriesGroup[];
}

/**
 * 漫画的作品索引。
 *
 * 漫画通常不以年份命名：一部作品几十卷，横跨好几年。按年份分组会把
 * 同一作品拆散在好几处，因此漫画侧改按「作品」索引 —— 集合就是作品。
 *
 * 照片侧不分组：照片的天然维度是时间，年份索引在那里。
 */
export default function SeriesTimeline({ groups }: Props) {
  const navigate = useNavigate();

  const entries = useMemo<TimelineEntry[]>(
    () =>
      groups.map((group) => ({
        key: group.key || "loose",
        label: group.label,
        count: `${group.count} 卷`,
        coverPath: group.coverPath,
        coverVersion: group.coverVersion,
        onActivate: () => navigate(group.to),
      })),
    [groups, navigate],
  );

  return <Timeline entries={entries} testId="series-timeline" />;
}
