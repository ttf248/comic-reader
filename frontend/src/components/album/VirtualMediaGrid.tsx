import { useCallback, useMemo, type Key, type ReactNode } from "react";
import { Virtuoso, type ListRange } from "react-virtuoso";
import { useMediaQuery } from "../../hooks/useMediaQuery";

export type MediaGridSize = "sm" | "md" | "lg";

const COLUMNS = {
  sm: [4, 6, 8, 10],
  md: [3, 4, 5, 6],
  lg: [2, 3, 4, 5],
} as const;

interface Props<T> {
  data: T[];
  size?: MediaGridSize;
  computeItemKey: (index: number, item: T) => Key;
  itemContent: (index: number, item: T) => ReactNode;
  rangeChanged: (range: ListRange) => void;
}

/** 按行虚拟化媒体：列数由断点决定，避免网格自行反复估算列数与窗口。 */
export default function VirtualMediaGrid<T>({
  data,
  size = "md",
  computeItemKey,
  itemContent,
  rangeChanged,
}: Props<T>) {
  const small = useMediaQuery("(min-width: 640px)");
  const medium = useMediaQuery("(min-width: 768px)");
  const large = useMediaQuery("(min-width: 1024px)");
  const columns = COLUMNS[size][large ? 3 : medium ? 2 : small ? 1 : 0];
  const rows = useMemo(
    () =>
      Array.from({ length: Math.ceil(data.length / columns) }, (_, index) => ({
        startIndex: index * columns,
        items: data.slice(index * columns, (index + 1) * columns),
      })),
    [data, columns],
  );
  const onRangeChanged = useCallback(
    ({ startIndex, endIndex }: ListRange) =>
      rangeChanged({
        startIndex: startIndex * columns,
        endIndex: Math.min(data.length - 1, (endIndex + 1) * columns - 1),
      }),
    [columns, data.length, rangeChanged],
  );

  return (
    <Virtuoso
      key={columns}
      style={{ height: "100%" }}
      data={rows}
      overscan={720}
      increaseViewportBy={{ top: 720, bottom: 720 }}
      computeItemKey={(_, row) => computeItemKey(row.startIndex, row.items[0])}
      rangeChanged={onRangeChanged}
      itemContent={(_, row) => (
        <div
          className="grid gap-2 pb-2"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {row.items.map((item, offset) => {
            const index = row.startIndex + offset;
            return (
              <div key={computeItemKey(index, item)} className="min-w-0">
                {itemContent(index, item)}
              </div>
            );
          })}
        </div>
      )}
    />
  );
}
