import type { ChinaLocationVisit } from "../../api/aiJobs";

interface VisitTimelineProps {
  visits: ChinaLocationVisit[];
  /** 打开某一次到访（左边换成那几天的照片）。 */
  onOpen: (visit: ChinaLocationVisit, index: number) => void;
  /** 当前打开的是第几次到访。 */
  activeIndex: number | null;
}

/**
 * 到访清单：同一个区域里，一段一段的拍摄。
 *
 * 「到访」按日历日切分 —— 相邻两张照片隔不超过两天算同一次，隔久了
 * 算另一次。跨夜的行程不会被切成两半。
 */
export default function VisitTimeline({
  visits,
  onOpen,
  activeIndex,
}: VisitTimelineProps) {
  return (
    <aside className="flex max-h-[min(72vh,720px)] min-h-[320px] min-w-0 flex-col overflow-hidden rounded-2xl border border-border-faint bg-bg-elevated">
      <div className="shrink-0 border-b border-border-faint px-5 py-4">
        <p className="page-eyebrow">当前层级</p>
        <h2 className="mt-1 font-display text-section font-medium text-fg">
          到访记录
        </h2>
        <p className="mt-1 text-meta text-fg-muted">
          {visits.length.toLocaleString()} 次到访 · 按拍摄时间切分
        </p>
      </div>
      {visits.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 text-center">
          <p className="text-body font-medium text-fg">这段时间没有到访记录</p>
          <p className="mt-2 max-w-sm text-meta leading-relaxed text-fg-muted">
            到访按拍摄时间切分：相邻两张照片隔不超过两天算同一次，隔久了算另一次。
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul aria-label="到访记录">
            {visits.map((visit, index) => {
              const active = activeIndex === index;
              const otherRegions = visit.regions ?? [];
              return (
                <li key={`${visit.startedAt}-${index}`}>
                  <button
                    type="button"
                    aria-pressed={active}
                    aria-label={`${visit.startedAt} 至 ${visit.endedAt}，${visit.dayCount} 天，${visit.photoCount} 张照片${otherRegions.length > 0 ? `，期间还去了 ${otherRegions.map((region) => region.name).join("、")}` : ""}`}
                    onClick={() => onOpen(visit, index)}
                    className={`flex w-full flex-col gap-1 border-b border-border-faint px-5 py-3 text-left transition-colors last:border-b-0 ${
                      active
                        ? "bg-accent-soft"
                        : "hover:bg-bg-subtle focus-visible:bg-bg-subtle"
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="text-body tabular-nums text-fg">
                        {visit.startedAt}
                        {visit.endedAt !== visit.startedAt
                          ? ` – ${visit.endedAt.slice(5)}`
                          : ""}
                      </span>
                      <span className="shrink-0 text-meta tabular-nums text-fg-muted">
                        {visit.dayCount} 天 ·{" "}
                        {visit.photoCount.toLocaleString()} 张
                      </span>
                    </span>
                    {otherRegions.length > 0 ? (
                      <span className="text-meta text-fg-subtle">
                        期间还去了：
                        {otherRegions.map((region) => region.name).join("、")}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </aside>
  );
}
