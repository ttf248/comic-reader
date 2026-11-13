import { useMemo } from "react";
import { monthBuckets, type MonthCount } from "../../utils/chinaMap";

interface TimeAxisProps {
  /** 逐月的照片数，按时间升序。 */
  months: MonthCount[];
  /** 当前区间（左闭右闭，"YYYY-MM"）；null 表示全部时间。 */
  from: string | null;
  to: string | null;
  /** 改区间。 */
  onChange: (from: string | null, to: string | null) => void;
  /** 有位置但没有可信拍摄时间的照片数。 */
  untimedCount: number;
}

/**
 * 时间轴：地图上方的一根按年分格的刷子。
 *
 * 年格的高度是这个年的照片数，一眼看出哪几年拍得多；点一个年就是
 * 看那一年，再点月份就收到那一个月。点起点 + Shift+点终点选区间。
 *
 * 时间是跨层级的一维：全国层级显示全国的照片分布，下钻后显示那个
 * 区域自己的分布。
 */
export default function TimeAxis({
  months,
  from,
  to,
  onChange,
  untimedCount,
}: TimeAxisProps) {
  const years = useMemo(() => monthBuckets(months), [months]);
  const maxYear = useMemo(
    () => years.reduce((max, bucket) => Math.max(max, bucket.count), 0),
    [years],
  );
  const monthsByYear = useMemo(() => {
    const grouped = new Map<string, MonthCount[]>();
    for (const entry of months) {
      const year = entry.month.slice(0, 4);
      const list = grouped.get(year) ?? [];
      list.push(entry);
      grouped.set(year, list);
    }
    return grouped;
  }, [months]);

  if (years.length === 0) {
    return (
      <section
        aria-label="时间轴"
        className="rounded-2xl border border-border-faint bg-bg-elevated px-4 py-3"
      >
        <p className="text-meta text-fg-muted">
          这些照片没有拍摄时间，暂时画不出时间轴。
        </p>
      </section>
    );
  }

  // 区间落在同一年时展开那个年的月份。
  const singleYear =
    from && to && from.slice(0, 4) === to.slice(0, 4) ? from.slice(0, 4) : null;
  const monthList = singleYear ? (monthsByYear.get(singleYear) ?? []) : [];

  const isAll = !from && !to;

  // Shift+点击把点中的那一项并进已有区间；没有区间就只看这一项。
  const pick = (start: string, end: string, shiftKey: boolean) => {
    if (shiftKey && from && to && from !== to) {
      onChange(from <= start ? from : start, to >= end ? to : end);
      return;
    }
    if (from && to && from === to && from === start) {
      onChange(null, null);
      return;
    }
    onChange(start, end);
  };

  return (
    <section
      aria-label="时间轴"
      className="rounded-2xl border border-border-faint bg-bg-elevated px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2">
          <h2 className="font-display text-label font-medium text-fg">
            时间轴
          </h2>
          <span className="text-meta text-fg-muted">
            {isAll ? "全部时间" : `${from} – ${to}`}
          </span>
        </div>
        {!isAll ? (
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={() => onChange(null, null)}
          >
            看全部时间
          </button>
        ) : null}
      </div>
      <div className="mt-3 flex items-end gap-1 overflow-x-auto pb-1">
        {years.map((bucket) => {
          const yearStart = `${bucket.year}-01`;
          const yearEnd = `${bucket.year}-12`;
          const selected =
            !isAll &&
            from !== null &&
            to !== null &&
            from.slice(0, 4) <= bucket.year &&
            bucket.year <= to.slice(0, 4);
          return (
            <button
              key={bucket.year}
              type="button"
              aria-pressed={selected}
              aria-label={`${bucket.year} 年，${bucket.count.toLocaleString()} 张照片`}
              onClick={(event) => pick(yearStart, yearEnd, event.shiftKey)}
              className={`flex min-w-[46px] flex-1 flex-col items-center gap-1 rounded-lg px-1 py-1 transition-colors ${
                selected
                  ? "bg-accent-soft text-fg"
                  : "text-fg-muted hover:bg-bg-subtle"
              }`}
            >
              <span className="text-meta tabular-nums">{bucket.year}</span>
              <span
                aria-hidden="true"
                className={`w-8 rounded-sm ${
                  selected ? "bg-brand" : "bg-brand-soft"
                }`}
                style={{
                  height: `${Math.max(
                    4,
                    Math.round((bucket.count / Math.max(maxYear, 1)) * 34),
                  )}px`,
                }}
              />
              <span className="text-meta tabular-nums text-fg-subtle">
                {bucket.count.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>
      {monthList.length > 0 ? (
        <div className="mt-3 border-t border-border-faint pt-3">
          <div className="flex items-end gap-1 overflow-x-auto">
            {Array.from({ length: 12 }, (_, index) => index + 1).map(
              (month) => {
                const key = `${singleYear}-${String(month).padStart(2, "0")}`;
                const entry = monthList.find((item) => item.month === key);
                const count = entry?.count ?? 0;
                const maxMonth = monthList.reduce(
                  (max, item) => Math.max(max, item.count),
                  0,
                );
                const selected = !isAll && from === key && to === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`${singleYear} 年 ${month} 月，${count.toLocaleString()} 张照片`}
                    onClick={(event) => pick(key, key, event.shiftKey)}
                    className={`flex min-w-[40px] flex-1 flex-col items-center gap-1 rounded-lg px-1 py-1 transition-colors ${
                      selected
                        ? "bg-accent-soft text-fg"
                        : "text-fg-muted hover:bg-bg-subtle"
                    }`}
                  >
                    <span className="text-meta tabular-nums">
                      {String(month).padStart(2, "0")}
                    </span>
                    <span
                      aria-hidden="true"
                      className={`w-6 rounded-sm ${
                        selected ? "bg-brand" : "bg-brand-soft"
                      }`}
                      style={{
                        height: `${Math.max(
                          3,
                          Math.round((count / Math.max(maxMonth, 1)) * 24),
                        )}px`,
                      }}
                    />
                  </button>
                );
              },
            )}
          </div>
        </div>
      ) : null}
      {untimedCount > 0 ? (
        <p className="mt-2 text-meta text-fg-subtle">
          {untimedCount.toLocaleString()} 张照片没有拍摄时间，未计入时间轴。
        </p>
      ) : null}
    </section>
  );
}
