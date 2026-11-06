import { useMemo, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { useSearchStore } from "../../store/searchStore";
import { useAppMode } from "../../hooks/useAppMode";
import type { YearGroup } from "../../utils/albumGrouping";
import { collectionUnit } from "../../utils/workbench";
import { FilterIcon } from "../common/Icon";
import Timeline, { type TimelineEntry } from "./Timeline";

interface Props {
  groups: YearGroup[];
  gridRef?: RefObject<HTMLDivElement>;
}

/**
 * 年份索引。
 *
 * 点年份卡：只有一个相册时直接进去，多个则切换年份筛选并滚到网格。
 */
export default function YearTimeline({ groups, gridRef }: Props) {
  const navigate = useNavigate();
  const yearFilter = useSearchStore((s) => s.yearFilter);
  const toggleYear = useSearchStore((s) => s.toggleYearFilter);
  // 计数单位跟着工作台走：照片侧「本相册」，漫画侧「卷」。
  const { mode } = useAppMode();
  const unit = collectionUnit(mode);

  const entries = useMemo<TimelineEntry[]>(
    () =>
      groups.map((group) => {
        const filterValue = group.year ?? "other";
        const key = String(filterValue);
        const isActive = yearFilter === filterValue;
        const triggerFilter = () => {
          toggleYear(filterValue);
          requestAnimationFrame(() =>
            gridRef?.current?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            }),
          );
        };
        return {
          key,
          label: group.label,
          count: `${group.albums.length} ${unit}`,
          numeric: group.year !== null,
          coverPath: group.coverPreviewPaths.find(Boolean),
          active: isActive,
          onActivate: () =>
            group.albums.length === 1
              ? navigate(group.albums[0].to)
              : triggerFilter(),
          action: (
            <button
              type="button"
              onClick={triggerFilter}
              className="year-index__filter"
              aria-label={isActive ? "取消年份筛选" : "筛选该年份"}
              title={isActive ? "取消筛选" : "只筛选该年份"}
            >
              <FilterIcon size={12} />
            </button>
          ),
        };
      }),
    [groups, yearFilter, toggleYear, navigate, gridRef, unit],
  );

  return <Timeline entries={entries} testId="year-timeline" />;
}
