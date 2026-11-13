import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ChinaTrip } from "../../api/aiJobs";
import {
  fillMonthRange,
  monthIndex,
  monthKey,
  type MonthCount,
} from "../../utils/travelMap";

interface TravelTimelineProps {
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

/** 默认每个月占多少像素（跨度太长时用它，轴随之横向滚动）。 */
const DEFAULT_PIXELS_PER_MONTH = 8;

/** 行程钉那一层的高。 */
const PIN_ROW = 16;

/** 钉层与格子带之间的缝。 */
const PIN_GAP = 3;

/** 格子带的高。 */
const CELL_ROW = 22;

/** 整条带子（钉 + 格子）的高。 */
const STRIP_HEIGHT = PIN_ROW + PIN_GAP + CELL_ROW;

/** 钉的命中区半径：28px 是布局审计给交互控件的下限。 */
const PIN_HIT_RADIUS = 14;

/** 相邻格之间留的缝（表面色分隔，不描边）。 */
const CELL_GAP = 2;

/** 拖动模式：拖的是窗口的哪一部分。 */
type DragMode = "new" | "start" | "end" | "window" | null;

/**
 * 格子颜色：单色渐层，深浅 = 这个月的张数。
 *
 * 没有照片的月份给一层极淡的底 —— 空档的那几年在带子上明显更浅，
 * 一眼看得见那几年其实没怎么出门。
 */
function cellFill(count: number, maxCount: number): string {
  if (count <= 0) return "color-mix(in srgb, var(--brand) 6%, var(--bg))";
  const ratio = maxCount > 0 ? Math.sqrt(count / maxCount) : 0;
  const percent = Math.round(14 + 74 * ratio);
  return `color-mix(in srgb, var(--brand) ${percent}%, var(--bg))`;
}

/**
 * 时间轴：一条月格纹理带。
 *
 * 逐月的张数画成一排格子，一格一个月，深浅是那一个月的张数 —— 格子是
 * 离散的，读得出确切是多少，也读得出空档；曲线把这些抹平了。
 *
 * 行程是格子上方的一颗颗钉，落在它开始的那个月。点钉选中那一次出行。
 *
 * 只此一件东西。此前那版把密度直方图、行程块、刷手轨道分作三层叠着，
 * 每层各说各的，读起来像三张图表拼在一起。
 */
export default function TravelTimeline({
  months,
  trips,
  from,
  to,
  onChange,
  onSelectTrip,
  selectedTripId,
}: TravelTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState(0);
  const [pixelsPerMonth, setPixelsPerMonth] = useState(DEFAULT_PIXELS_PER_MONTH);
  const [drag, setDrag] = useState<DragMode>(null);
  const [hoverTrip, setHoverTrip] = useState<string | null>(null);
  const [hoverMonth, setHoverMonth] = useState<string | null>(null);
  const dragAnchor = useRef<number | null>(null);
  /** 手柄按下的那一端。手指落在手柄上时，拖的是那一端，不是整段。 */
  const grabbedEnd = useRef<"start" | "end" | null>(null);

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
    const measure = () => setMeasured(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 装得下就铺满；装不下就按固定宽度排，轴随之横向滚动。
  useEffect(() => {
    if (measured <= 0) return;
    const fit = Math.floor(measured / spanMonths);
    setPixelsPerMonth(fit >= MIN_PIXELS_PER_MONTH ? fit : DEFAULT_PIXELS_PER_MONTH);
  }, [measured, spanMonths]);

  const contentWidth = Math.max(spanMonths * pixelsPerMonth, measured);

  /** 月份序号 → 像素位置（该月的左缘）。 */
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

  // 同一个月里的几段行程要错开，否则钉会叠在一起。
  const tripsByMonth = useMemo(() => {
    const map = new Map<number, ChinaTrip[]>();
    for (const trip of trips) {
      const index = monthIndex(trip.startedAt.slice(0, 7));
      const list = map.get(index);
      if (list) list.push(trip);
      else map.set(index, [trip]);
    }
    return map;
  }, [trips]);

  const maxTripCount = useMemo(
    () => trips.reduce((max, trip) => Math.max(max, trip.photoCount), 0),
    [trips],
  );

  const applyWindow = useCallback(
    (nextFrom: number, nextTo: number) => {
      const low = Math.min(nextFrom, nextTo);
      const high = Math.max(nextFrom, nextTo);
      onChange(monthKey(low), monthKey(high));
    },
    [onChange],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const month = monthAt(event.clientX);
      event.currentTarget.setPointerCapture(event.pointerId);
      dragAnchor.current = month;

      // 手指落在手柄上：拖的是那一端。
      const grabbed = grabbedEnd.current;
      grabbedEnd.current = null;
      if (grabbed === "start") {
        setDrag("start");
        return;
      }
      if (grabbed === "end") {
        setDrag("end");
        return;
      }

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

  const handlePointerMove = useCallback(
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
    grabbedEnd.current = null;
  }, []);

  const years = useMemo(() => {
    const result: { year: string; index: number }[] = [];
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const key = monthKey(index);
      if (key.endsWith("-01")) result.push({ year: key.slice(0, 4), index });
    }
    return result;
  }, [firstIndex, lastIndex]);

  const hoverTripData = useMemo(
    () => trips.find((trip) => trip.id === hoverTrip) ?? null,
    [hoverTrip, trips],
  );

  // 读数带：悬停什么就报什么，平时报当前区间。
  const readout = hoverTripData
    ? `${hoverTripData.startedAt}${
        hoverTripData.endedAt !== hoverTripData.startedAt
          ? ` – ${hoverTripData.endedAt.slice(5)}`
          : ""
      } · ${hoverTripData.stops.map((stop) => stop.name).join(" → ")} · ${hoverTripData.photoCount} 张`
    : hoverMonth
      ? hoverMonth
      : hasWindow
        ? `${from} – ${to}`
        : "全部时间";

  if (filled.length === 0) {
    return (
      <section aria-label="时间轴" className="travel-timeline">
        <p className="text-meta text-fg-muted">
          这些照片没有拍摄时间，暂时画不出时间轴。
        </p>
      </section>
    );
  }

  const windowLeft = xOf(fromIndex);
  const windowWidth = Math.max(xOf(toIndex + 1) - windowLeft, 0);
  const cellWidth = Math.max(pixelsPerMonth - CELL_GAP, 1);

  return (
    <section aria-label="时间轴" className="travel-timeline">
      <div className="travel-timeline__head">
        <h2 className="font-display text-label font-medium text-fg">时间轴</h2>
        <div className="travel-timeline__legend">
          <span className="travel-timeline__legend-item">
            <span className="travel-timeline__swatch" />
            每月张数
          </span>
          <span className="travel-timeline__legend-item">
            <span className="travel-timeline__legend-pin" />
            行程
          </span>
        </div>
        <div className="travel-timeline__readout-group">
          <span className="travel-timeline__readout tabular-nums">
            {readout}
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

      <div
        className="travel-timeline__scroll"
        ref={scrollRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="travel-timeline__content" style={{ width: contentWidth }}>
          <svg
            className="travel-timeline__strip"
            viewBox={`0 0 ${contentWidth} ${STRIP_HEIGHT}`}
            height={STRIP_HEIGHT}
            role="group"
            aria-label={`按月的照片分布与行程，共 ${trips.length} 段`}
          >
            <defs>
              {/*
                区间之外压到一半亮，不是删掉 —— 位置得留着，读者才知道
                「我在整条历史的哪个位置」。
              */}
              <mask id="travel-timeline-window">
                <rect
                  x={0}
                  y={0}
                  width={contentWidth}
                  height={STRIP_HEIGHT}
                  fill="#8a8a8a"
                />
                <rect
                  x={windowLeft}
                  y={0}
                  width={windowWidth}
                  height={STRIP_HEIGHT}
                  fill="#ffffff"
                />
              </mask>
            </defs>

            <g mask="url(#travel-timeline-window)">
              {/* 格子带：一格一个月，深浅是那一个月的张数。 */}
              <g>
                {filled.map((entry) => {
                  const index = monthIndex(entry.month);
                  return (
                    <rect
                      key={entry.month}
                      x={xOf(index)}
                      y={PIN_ROW + PIN_GAP}
                      width={cellWidth}
                      height={CELL_ROW}
                      rx={2}
                      fill={cellFill(entry.count, maxMonthCount)}
                      className={
                        hoverMonth === entry.month
                          ? "travel-timeline__cell travel-timeline__cell--hover"
                          : "travel-timeline__cell"
                      }
                      onMouseEnter={() => setHoverMonth(entry.month)}
                      onMouseLeave={() =>
                        setHoverMonth((current) =>
                          current === entry.month ? null : current,
                        )
                      }
                    >
                      <title>
                        {entry.count > 0
                          ? `${entry.month} · ${entry.count} 张`
                          : `${entry.month} · 没有照片`}
                      </title>
                    </rect>
                  );
                })}
              </g>
              {/* 行程钉：落在开始的那个月。 */}
              <g>
                {trips.map((trip) => {
                  const index = monthIndex(trip.startedAt.slice(0, 7));
                  const sameMonth = tripsByMonth.get(index) ?? [];
                  const position = sameMonth.indexOf(trip);
                  const spread = sameMonth.length > 1 ? (position - (sameMonth.length - 1) / 2) * 9 : 0;
                  const x = xOf(index) + pixelsPerMonth / 2 + spread;
                  const selected = selectedTripId === trip.id;
                  const radius = Math.min(
                    5,
                    3 + 2 * Math.sqrt(trip.photoCount / Math.max(maxTripCount, 1)),
                  );
                  return (
                    <g
                      key={trip.id}
                      tabIndex={0}
                      role="button"
                      aria-label={`${trip.startedAt} 至 ${trip.endedAt}，${trip.dayCount} 天，${trip.photoCount} 张照片`}
                      onMouseEnter={() => setHoverTrip(trip.id)}
                      onMouseLeave={() =>
                        setHoverTrip((current) =>
                          current === trip.id ? null : current,
                        )
                      }
                      onFocus={() => setHoverTrip(trip.id)}
                      onBlur={() =>
                        setHoverTrip((current) =>
                          current === trip.id ? null : current,
                        )
                      }
                      onClick={() => onSelectTrip?.(trip)}
                      onKeyDown={(event) => {
                        // SVG 里的 g 不是真的按钮，回车与空格得自己接。
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelectTrip?.(trip);
                        }
                      }}
                    >
                      {/* 看得见的钉只有几像素大；命中区给足手指与键盘的尺寸。 */}
                      <circle
                        cx={x}
                        cy={PIN_ROW / 2}
                        r={PIN_HIT_RADIUS}
                        fill="transparent"
                        pointerEvents="all"
                      />
                      <circle
                        cx={x}
                        cy={PIN_ROW / 2}
                        r={selected ? radius + 2 : radius}
                        className={
                          selected
                            ? "travel-timeline__pin travel-timeline__pin--selected"
                            : "travel-timeline__pin"
                        }
                        pointerEvents="none"
                      />
                    </g>
                  );
                })}
              </g>
            </g>
          </svg>

          <div className="travel-timeline__scale" aria-hidden="true">
            {years.map((entry) => (
              <span
                key={entry.year}
                className="travel-timeline__tick"
                style={{ left: xOf(entry.index) }}
              >
                {entry.year}
              </span>
            ))}
          </div>

          {/* 选中的区间：一层很淡的底色，两端各一个抓手。
              没圈区间时不画这一层 —— 满屏的底色说明不了任何事。 */}
          {hasWindow ? (
            <div
              className="travel-timeline__window"
              aria-hidden="true"
              style={{ left: windowLeft, width: windowWidth }}
            />
          ) : null}

          {/* 刷手：区间两端。 */}
          <div
            role="slider"
            tabIndex={0}
            aria-label="时间区间起点"
            aria-valuemin={firstIndex}
            aria-valuemax={lastIndex}
            aria-valuenow={fromIndex}
            aria-valuetext={monthKey(fromIndex)}
            className="travel-timeline__handle"
            style={{ left: windowLeft }}
            onPointerDown={() => {
              grabbedEnd.current = "start";
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 12 : 1;
              if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
                event.preventDefault();
                applyWindow(Math.min(fromIndex - step, toIndex), toIndex);
              } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
                event.preventDefault();
                applyWindow(Math.min(fromIndex + step, toIndex), toIndex);
              } else if (event.key === "Home") {
                event.preventDefault();
                applyWindow(firstIndex, toIndex);
              } else if (event.key === "End") {
                event.preventDefault();
                applyWindow(toIndex, toIndex);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onChange(null, null);
              }
            }}
          />
          <div
            role="slider"
            tabIndex={0}
            aria-label="时间区间终点"
            aria-valuemin={firstIndex}
            aria-valuemax={lastIndex}
            aria-valuenow={toIndex}
            aria-valuetext={monthKey(toIndex)}
            className="travel-timeline__handle travel-timeline__handle--end"
            style={{ left: windowLeft + windowWidth }}
            onPointerDown={() => {
              grabbedEnd.current = "end";
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 12 : 1;
              if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
                event.preventDefault();
                applyWindow(fromIndex, Math.max(toIndex - step, fromIndex));
              } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
                event.preventDefault();
                applyWindow(fromIndex, Math.max(toIndex + step, fromIndex));
              } else if (event.key === "Home") {
                event.preventDefault();
                applyWindow(fromIndex, fromIndex);
              } else if (event.key === "End") {
                event.preventDefault();
                applyWindow(fromIndex, lastIndex);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onChange(null, null);
              }
            }}
          />
        </div>
      </div>
    </section>
  );
}
