import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ChinaTrip } from "../../api/aiJobs";
import {
  fillMonthRange,
  monthIndex,
  monthKey,
  type MonthCount,
} from "../../utils/travelMap";

interface TravelTimeRibbonProps {
  /** 全库的逐月照片数（不带时间区间）。这条轴是全局的那把尺子。 */
  months: MonthCount[];
  /** 全库的行程与停留（不带时间区间）。段的下标要能寻址到照片。 */
  trips: ChinaTrip[];
  /** 当前区间（左闭右闭，"YYYY-MM"）；null 表示全部时间。 */
  from: string | null;
  to: string | null;
  /** 改区间。 */
  onChange: (from: string | null, to: string | null) => void;
  /** 选中某一段。 */
  onSelectTrip?: (trip: ChinaTrip) => void;
  /** 当前选中的段。 */
  selectedTripId?: string | null;
}

/** 每个月至少占多少像素；再少就分不出是哪个月了。 */
const MIN_PIXELS_PER_MONTH = 4;

/** 默认每个月占多少像素（跨度太长时用它，条带随之横向滚动）。 */
const DEFAULT_PIXELS_PER_MONTH = 8;

/** 拖动模式：拖的是窗口的哪一部分。 */
type DragMode = "new" | "start" | "end" | "window" | null;

/**
 * 横向时间带。
 *
 * x 轴是真实时间：稀疏的年份自然拉开，密集的年份挤在一起，一眼看出
 * 哪几年在出门。段是切出来的行程，块按真实起止日期落位。
 *
 * 时间带不随时间区间变化 —— 它是全局的那把尺子，区间只是尺子上的一段
 * 高亮。一拖手柄尺子就缩的话，「我在整条历史的哪个位置」这件事反而
 * 丢了。
 */
export default function TravelTimeRibbon({
  months,
  trips,
  from,
  to,
  onChange,
  onSelectTrip,
  selectedTripId,
}: TravelTimeRibbonProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState(0);
  const [pixelsPerMonth, setPixelsPerMonth] = useState(DEFAULT_PIXELS_PER_MONTH);
  const [drag, setDrag] = useState<DragMode>(null);
  const dragAnchor = useRef<number | null>(null);

  // 空档的月份也要占位：少了它们，稀疏的那几年会被压扁。
  const filled = useMemo(() => fillMonthRange(months), [months]);

  const firstIndex = useMemo(
    () => (filled.length > 0 ? monthIndex(filled[0].month) : 0),
    [filled],
  );
  const lastIndex = useMemo(
    () => (filled.length > 0 ? monthIndex(filled[filled.length - 1].month) : 0),
    [filled],
  );
  const spanMonths = Math.max(lastIndex - firstIndex + 1, 1);

  const maxMonthCount = useMemo(
    () => filled.reduce((max, entry) => Math.max(max, entry.count), 0),
    [filled],
  );

  // 量出容器宽度，决定每个月占多少像素。
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    setMeasured(element.clientWidth);
    // 组件测试里没有 ResizeObserver：量一次就够了。
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setMeasured(element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 装得下就铺满；装不下就按固定宽度排，条带横向滚动。
  useEffect(() => {
    if (measured <= 0) return;
    const fit = Math.floor(measured / spanMonths);
    setPixelsPerMonth(fit >= MIN_PIXELS_PER_MONTH ? fit : DEFAULT_PIXELS_PER_MONTH);
  }, [measured, spanMonths]);

  const contentWidth = Math.max(spanMonths * pixelsPerMonth, measured);

  /** 月份序号 → 像素位置。 */
  const xOf = useCallback(
    (index: number) => (index - firstIndex) * pixelsPerMonth,
    [firstIndex, pixelsPerMonth],
  );

  /** 像素位置 → 月份序号。 */
  const monthAt = useCallback(
    (clientX: number) => {
      const element = scrollRef.current;
      if (!element) return firstIndex;
      const bounds = element.getBoundingClientRect();
      const offset = clientX - bounds.left + element.scrollLeft;
      return Math.min(
        Math.max(firstIndex + Math.round(offset / pixelsPerMonth), firstIndex),
        lastIndex,
      );
    },
    [firstIndex, lastIndex, pixelsPerMonth],
  );

  const fromIndex = from ? monthIndex(from) : firstIndex;
  const toIndex = to ? monthIndex(to) : lastIndex;
  const hasWindow = Boolean(from || to);

  const applyWindow = useCallback(
    (nextFrom: number, nextTo: number) => {
      const low = Math.min(nextFrom, nextTo);
      const high = Math.max(nextFrom, nextTo);
      onChange(monthKey(low), monthKey(high));
    },
    [onChange],
  );

  const handleTrackPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const month = monthAt(event.clientX);
      event.currentTarget.setPointerCapture(event.pointerId);
      dragAnchor.current = month;
      if (!hasWindow) {
        // 没有窗口时，从按下处起一个窗口，拖到哪里就圈到哪里。
        applyWindow(month, month);
        setDrag("new");
        return;
      }
      if (month < fromIndex) {
        applyWindow(month, toIndex);
        setDrag("start");
        return;
      }
      if (month > toIndex) {
        applyWindow(fromIndex, month);
        setDrag("end");
        return;
      }
      setDrag("window");
    },
    [applyWindow, fromIndex, hasWindow, monthAt, toIndex],
  );

  const handleTrackPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      const month = monthAt(event.clientX);
      const anchor = dragAnchor.current;
      if (anchor === null) return;
      if (drag === "new") {
        applyWindow(Math.min(anchor, month), Math.max(anchor, month));
        return;
      }
      if (drag === "start") {
        applyWindow(Math.min(month, toIndex), toIndex);
        return;
      }
      if (drag === "end") {
        applyWindow(fromIndex, Math.max(month, fromIndex));
        return;
      }
      // 整段平移：长度不变，只挪位置。
      const length = toIndex - fromIndex;
      const nextFrom = Math.min(
        Math.max(fromIndex + (month - anchor), firstIndex),
        lastIndex - length,
      );
      applyWindow(nextFrom, nextFrom + length);
    },
    [applyWindow, drag, firstIndex, fromIndex, lastIndex, monthAt, toIndex],
  );

  const endDrag = useCallback(() => {
    setDrag(null);
    dragAnchor.current = null;
  }, []);

  const moveHandle = useCallback(
    (handle: "start" | "end", step: number) => {
      if (handle === "start") {
        applyWindow(Math.min(fromIndex + step, toIndex), toIndex);
        return;
      }
      applyWindow(fromIndex, Math.max(toIndex + step, fromIndex));
    },
    [applyWindow, fromIndex, toIndex],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, handle: "start" | "end") => {
      const step = event.shiftKey ? 12 : 1;
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowDown":
          event.preventDefault();
          moveHandle(handle, -step);
          break;
        case "ArrowRight":
        case "ArrowUp":
          event.preventDefault();
          moveHandle(handle, step);
          break;
        case "Home":
          event.preventDefault();
          if (handle === "start") applyWindow(firstIndex, toIndex);
          else applyWindow(fromIndex, fromIndex);
          break;
        case "End":
          event.preventDefault();
          if (handle === "start") applyWindow(toIndex, toIndex);
          else applyWindow(fromIndex, lastIndex);
          break;
        case "Escape":
          event.preventDefault();
          onChange(null, null);
          break;
        default:
          break;
      }
    },
    [applyWindow, firstIndex, fromIndex, lastIndex, moveHandle, onChange, toIndex],
  );

  const years = useMemo(() => {
    const result: { year: string; index: number }[] = [];
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const key = monthKey(index);
      if (key.endsWith("-01")) result.push({ year: key.slice(0, 4), index });
    }
    return result;
  }, [firstIndex, lastIndex]);

  if (filled.length === 0) {
    return (
      <section aria-label="时间带" className="travel-ribbon">
        <p className="text-meta text-fg-muted">
          这些照片没有拍摄时间，暂时画不出时间带。
        </p>
      </section>
    );
  }

  const windowLeft = xOf(fromIndex);
  const windowWidth = Math.max(xOf(toIndex + 1) - windowLeft, 0);

  return (
    <section aria-label="时间带" className="travel-ribbon">
      <div className="travel-ribbon__head">
        <h2 className="font-display text-label font-medium text-fg">时间带</h2>
        <div className="flex items-center gap-3">
          <span className="text-meta tabular-nums text-fg-muted">
            {hasWindow ? `${from} – ${to}` : "全部时间"}
          </span>
          {hasWindow ? (
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

      <div className="travel-ribbon__scroll" ref={scrollRef}>
        <div className="travel-ribbon__content" style={{ width: contentWidth }}>
          <div className="travel-ribbon__hist" aria-hidden="true">
            {filled.map((entry) => {
              const index = monthIndex(entry.month);
              const height =
                entry.count > 0
                  ? Math.max(
                      3,
                      Math.round((entry.count / Math.max(maxMonthCount, 1)) * 52),
                    )
                  : 0;
              const inWindow = index >= fromIndex && index <= toIndex;
              return (
                <span
                  key={entry.month}
                  className={
                    inWindow
                      ? "travel-ribbon__bar travel-ribbon__bar--in"
                      : "travel-ribbon__bar"
                  }
                  style={{
                    left: xOf(index),
                    width: Math.max(pixelsPerMonth - 1, 1),
                    height,
                  }}
                />
              );
            })}
          </div>

          <div className="travel-ribbon__blocks">
            {trips.map((trip) => {
              const start = monthIndex(trip.startedAt.slice(0, 7));
              const end = monthIndex(trip.endedAt.slice(0, 7));
              const left = xOf(start);
              const width = Math.max(xOf(end + 1) - left, 4);
              const inWindow = end >= fromIndex && start <= toIndex;
              const selected = selectedTripId === trip.id;
              return (
                <button
                  key={trip.id}
                  type="button"
                  className={
                    selected
                      ? "travel-ribbon__block travel-ribbon__block--selected"
                      : inWindow
                        ? "travel-ribbon__block"
                        : "travel-ribbon__block travel-ribbon__block--outside"
                  }
                  style={{ left, width }}
                  aria-label={`时间带上的行程：${trip.startedAt} 至 ${trip.endedAt}，${trip.dayCount} 天，${trip.photoCount} 张照片`}
                  title={`${trip.startedAt} – ${trip.endedAt} · ${trip.stops.map((stop) => stop.name).join(" → ")} · ${trip.photoCount} 张`}
                  onClick={() => onSelectTrip?.(trip)}
                />
              );
            })}
          </div>

          <div
            className="travel-ribbon__track"
            onPointerDown={handleTrackPointerDown}
            onPointerMove={handleTrackPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <span
              className="travel-ribbon__dim"
              style={{ left: 0, width: windowLeft }}
            />
            <span
              className="travel-ribbon__dim"
              style={{ left: windowLeft + windowWidth, right: 0 }}
            />
            <span
              className="travel-ribbon__window"
              style={{ left: windowLeft, width: windowWidth }}
            />
            <div
              role="slider"
              tabIndex={0}
              aria-label="时间区间起点"
              aria-valuemin={firstIndex}
              aria-valuemax={lastIndex}
              aria-valuenow={fromIndex}
              aria-valuetext={monthKey(fromIndex)}
              className="travel-ribbon__handle"
              style={{ left: windowLeft }}
              onKeyDown={(event) => handleKeyDown(event, "start")}
            />
            <div
              role="slider"
              tabIndex={0}
              aria-label="时间区间终点"
              aria-valuemin={firstIndex}
              aria-valuemax={lastIndex}
              aria-valuenow={toIndex}
              aria-valuetext={monthKey(toIndex)}
              className="travel-ribbon__handle travel-ribbon__handle--end"
              style={{ left: windowLeft + windowWidth - 12 }}
              onKeyDown={(event) => handleKeyDown(event, "end")}
            />
          </div>

          <div className="travel-ribbon__ticks" aria-hidden="true">
            {years.map((entry) => (
              <span
                key={entry.year}
                className="travel-ribbon__tick"
                style={{ left: xOf(entry.index) }}
              >
                {entry.year}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
