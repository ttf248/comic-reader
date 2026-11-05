import { useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { thumbUrl } from "../../api/thumbs";
import { useSearchStore } from "../../store/searchStore";
import type { YearGroup } from "../../utils/albumGrouping";
import { FolderIcon, FilterIcon } from "../common/Icon";

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
  if (groups.length === 0) return null;
  return (
    <div className="year-index" data-testid="year-timeline">
      {groups.map((group) => (
        <YearCard key={group.year ?? "other"} group={group} gridRef={gridRef} />
      ))}
    </div>
  );
}

function YearCard({
  group,
  gridRef,
}: {
  group: YearGroup;
  gridRef?: RefObject<HTMLDivElement>;
}) {
  const navigate = useNavigate();
  const yearFilter = useSearchStore((s) => s.yearFilter);
  const toggleYear = useSearchStore((s) => s.toggleYearFilter);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const cover = group.coverPreviewPaths.find(Boolean);
  const isActive = yearFilter === (group.year ?? "other");
  const triggerFilter = () => {
    toggleYear(group.year ?? "other");
    requestAnimationFrame(() =>
      gridRef?.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };
  const activate = () =>
    group.albums.length === 1 ? navigate(group.albums[0].to) : triggerFilter();
  return (
    <div className="year-index__item group">
      <button
        type="button"
        onClick={activate}
        aria-pressed={isActive}
        className="year-index__open"
      >
        <span className="block w-12 h-14 shrink-0 rounded-md overflow-hidden bg-bg-subtle">
          {cover && cover !== failedSource ? (
            <img
              src={thumbUrl(cover)}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setFailedSource(cover)}
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="flex items-center justify-center w-full h-full text-fg-subtle">
              <FolderIcon size={18} />
            </span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block font-display text-[22px] font-semibold leading-tight tabular-nums text-fg">
            {group.label}
          </span>
          <span className="block text-[12.5px] text-fg-muted mt-1 tabular-nums">
            {group.albums.length} 本相册
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={triggerFilter}
        className="year-index__filter"
        aria-label={isActive ? "取消年份筛选" : "筛选该年份"}
        title={isActive ? "取消筛选" : "只筛选该年份"}
      >
        <FilterIcon size={12} />
      </button>
    </div>
  );
}
