import { useCallback, useEffect, useState } from "react";
import type { ListRange } from "react-virtuoso";

interface Options {
  loadedCount: number;
  hasNextPage: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}

/** 保留完整滚动长度，同时在视口接近已加载媒体边界时预取下一页。 */
export function useMediaGridPagination({
  loadedCount,
  hasNextPage,
  isLoadingMore,
  onLoadMore,
}: Options) {
  const [endIndex, setEndIndex] = useState(-1);
  const rangeChanged = useCallback((range: ListRange) => {
    setEndIndex(range.endIndex);
  }, []);

  useEffect(() => {
    // 占位槽已覆盖整本相册，endReached 只会在整本末尾触发。
    // 跳到远处占位区时，每页完成后也要重新检查，直到覆盖当前视口。
    if (
      endIndex >= 0 &&
      endIndex >= loadedCount - 24 &&
      hasNextPage &&
      !isLoadingMore
    ) {
      onLoadMore();
    }
  }, [endIndex, loadedCount, hasNextPage, isLoadingMore, onLoadMore]);

  return rangeChanged;
}
