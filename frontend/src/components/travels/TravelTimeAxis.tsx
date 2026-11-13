import { useMemo } from "react";
import { monthBuckets, type MonthCount } from "../../utils/travelMap";

interface TravelTimeAxisProps {
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
 * 时间轴：横在整页上的一条轴。
 *
 * 年份柱从基线长上来 —— 高度是这个年的照片数，一眼看出哪几年拍得多；
 * 点一个年就是看那一年，再点月份就收到那一个月。点起点 + Shift+点终点
 * 选区间。
 *
 * 它跟着当前层级走：全国层级是全国分布，进到浙江省就是浙江自己的分布。
 */
export default function TravelTimeAxis({
  months,
  from,
  to,
  onChange,
  untimedCount,
}: TravelTimeAxisProps) {
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
      <section aria-label="时间轴" className="travel-axis">
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
  const maxMonth = monthList.reduce((max, item) => Math.max(max, item.count), 0);

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
    <section aria-label="时间轴" className="travel-axis">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="font-display text-label font-medium text-fg">时间轴</h2>
        <div className="flex items-center gap-3">
          <span className="text-meta text-fg-muted">
            {isAll ? "全部时间" : `${from} – ${to}`}
          </span>
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
      </div>
      <div className="travel-axis__track">
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
              className="travel-axis__year"
            >
              <span className="travel-axis__count tabular-nums">
                {bucket.count.toLocaleString()}
              </span>
              <span
                aria-hidden="true"
                className="travel-axis__bar"
                style={{
                  height: `${Math.max(
                    4,
                    Math.round((bucket.count / Math.max(maxYear, 1)) * 60),
                  )}px`,
                }}
              />
              <span className="text-meta tabular-nums text-fg-subtle">
                {bucket.year}
              </span>
            </button>
          );
        })}
      </div>
      {monthList.length > 0 ? (
        <div className="travel-axis__months">
          {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => {
            const key = `${singleYear}-${String(month).padStart(2, "0")}`;
            const entry = monthList.find((item) => item.month === key);
            const count = entry?.count ?? 0;
            const selected = !isAll && from === key && to === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={selected}
                aria-label={`${singleYear} 年 ${month} 月，${count.toLocaleString()} 张照片`}
                onClick={(event) => pick(key, key, event.shiftKey)}
                className="travel-axis__month"
              >
                <span
                  aria-hidden="true"
                  className="travel-axis__bar"
                  style={{
                    height: `${Math.max(
                      3,
                      Math.round((count / Math.max(maxMonth, 1)) * 34),
                    )}px`,
                  }}
                />
                <span className="text-meta tabular-nums text-fg-subtle">
                  {String(month).padStart(2, "0")}
                </span>
              </button>
            );
          })}
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
