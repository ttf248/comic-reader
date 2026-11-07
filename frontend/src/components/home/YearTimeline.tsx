import { useMemo, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { useSearchStore } from "../../store/searchStore";
import { useAppMode } from "../../hooks/useAppMode";
import type { YearGroup } from "../../utils/albumGrouping";
import { albumCountUnit } from "../../utils/workbench";
import { FilterIcon } from "../common/Icon";
import Timeline, { type TimelineEntry } from "./Timeline";

interface Props {
  groups: YearGroup[];
  gridRef?: RefObject<HTMLDivElement>;
}

/**
 * 年份索引。
 *
 * 点年份卡：进入那一年（通常是一个同名集合，其次是文件最多的那一本）。
 * 卡片右上角的漏斗才是「只筛这一年」—— 它筛的是下方网格。
 */
export default function YearTimeline({ groups, gridRef }: Props) {
  const navigate = useNavigate();
  const yearFilter = useSearchStore((s) => s.yearFilter);
  const toggleYear = useSearchStore((s) => s.toggleYearFilter);
  // 计数单位跟着工作台走：照片侧「张」，漫画侧「页」。
  const { mode } = useAppMode();
  const unit = mode === "comic" ? "页" : "张";

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
        // 年卡的主操作恒是「进入那一年」。年份多半对应一个同名集合
        // （首页上一年一个入口），没有集合时进文件最多的那一本。
        // 早先这里是两义的：一个节点时进入、多个节点时变成筛选器 ——
        // 同一张卡换个年份行为就不同，读起来像坏了。
        const enterTarget =
          group.albums.find((a) => a.variant === "collection") ??
          group.albums[0];
        // 年卡上的计数说的是「这一年有多少照片」，不是「这一年有几个
        // 直属子项」：首页的年份多半对应一个同名集合，直属子项恒为 1，
        // 「1 本」对谁都没有信息量。
        // 只报照片数：再加一段视频数，184px 宽的卡里会折行成两行。
        const total = group.imageTotal ?? 0;
        const count =
          total > 0
            ? `${total} ${unit}`
            : `${group.albums.length} ${albumCountUnit(mode)}`;
        return {
          key,
          label: group.label,
          count,
          numeric: group.year !== null,
          coverPath: group.coverPreviewPaths.find(Boolean),
          active: isActive,
          onActivate: () => {
            if (enterTarget) navigate(enterTarget.to);
            else triggerFilter();
          },
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
    [groups, yearFilter, toggleYear, navigate, gridRef, unit, mode],
  );

  return <Timeline entries={entries} testId="year-timeline" />;
}
