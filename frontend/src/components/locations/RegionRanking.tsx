import { shareOf } from "../../utils/chinaMap";

export interface RankingRegion {
  adcode: number;
  name: string;
  level: string;
  photoCount: number;
}

interface RegionRankingProps {
  /** 本层的全部区域，含 0 张的区域。 */
  regions: RankingRegion[];
  /** 本层照片总数，作为占比的分母。 */
  levelTotal: number;
  /** 面板标题，例如「省份排行」。 */
  title: string;
  /** 点一行进入该区域。 */
  onSelect: (region: RankingRegion) => void;
}

/**
 * 当前层级的区域排行。
 *
 * 这不是地图的附属说明，而是地图的替代入口：形状对读屏与键盘用户
 * 不友好，这里每一行都是能按回车进入的按钮，而且列出本层全部区域
 * （含 0 张的），地图上不会出现一块进不去的地方。
 */
export default function RegionRanking({
  regions,
  levelTotal,
  title,
  onSelect,
}: RegionRankingProps) {
  const ordered = [...regions].sort((left, right) => {
    if (left.photoCount !== right.photoCount) {
      return right.photoCount - left.photoCount;
    }
    return left.name.localeCompare(right.name, "zh-CN");
  });
  return (
    <aside className="flex max-h-[min(72vh,720px)] min-h-[320px] min-w-0 flex-col overflow-hidden rounded-2xl border border-border-faint bg-bg-elevated">
      <div className="shrink-0 border-b border-border-faint px-5 py-4">
        <p className="page-eyebrow">当前层级</p>
        <h2 className="mt-1 font-display text-section font-medium text-fg">
          {title}
        </h2>
        <p className="mt-1 text-meta text-fg-muted">
          本层共 {levelTotal.toLocaleString()} 张 · 按照片数排序
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul aria-label={title}>
          {ordered.map((region) => {
            const share = shareOf(region.photoCount, levelTotal);
            const percent = `${(share * 100).toFixed(share > 0 && share < 0.01 ? 2 : 1)}%`;
            return (
              <li key={region.adcode}>
                <button
                  type="button"
                  aria-label={`${region.name}，${region.photoCount.toLocaleString()} 张照片，占本层 ${percent}，进入`}
                  onClick={() => onSelect(region)}
                  className="flex w-full items-center gap-3 border-b border-border-faint px-5 py-3 text-left transition-colors last:border-b-0 hover:bg-bg-subtle focus-visible:bg-bg-subtle focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1 truncate text-body text-fg">
                    {region.name}
                  </span>
                  <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-bg-subtle">
                    <span
                      className="block h-full rounded-full bg-brand"
                      style={{
                        width: `${Math.max(share * 100, region.photoCount > 0 ? 2 : 0)}%`,
                      }}
                    />
                  </span>
                  <span className="shrink-0 text-meta tabular-nums text-fg-muted">
                    {region.photoCount.toLocaleString()} 张
                  </span>
                  <span className="w-12 shrink-0 text-right text-meta tabular-nums text-fg-subtle">
                    {percent}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
