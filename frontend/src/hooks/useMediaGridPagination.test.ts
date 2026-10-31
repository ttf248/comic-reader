import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useMediaGridPagination } from "./useMediaGridPagination";

function options() {
  return {
    loadedCount: 200,
    hasNextPage: true,
    isLoadingMore: false,
    onLoadMore: vi.fn(),
  };
}

describe("useMediaGridPagination", () => {
  it("首屏不预载整本，接近已加载边界后取下一页", () => {
    const props = options();
    const { result } = renderHook(() => useMediaGridPagination(props));
    expect(props.onLoadMore).not.toHaveBeenCalled();

    act(() => result.current({ startIndex: 0, endIndex: 35 }));
    expect(props.onLoadMore).not.toHaveBeenCalled();

    act(() => result.current({ startIndex: 160, endIndex: 190 }));
    expect(props.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("跳入远处占位区后逐页补齐，无需再次滚动", () => {
    const props = options();
    const { result, rerender } = renderHook(useMediaGridPagination, {
      initialProps: props,
    });
    act(() => result.current({ startIndex: 550, endIndex: 580 }));
    expect(props.onLoadMore).toHaveBeenCalledTimes(1);

    rerender({ ...props, isLoadingMore: true });
    expect(props.onLoadMore).toHaveBeenCalledTimes(1);
    rerender({ ...props, loadedCount: 400 });
    expect(props.onLoadMore).toHaveBeenCalledTimes(2);
    rerender({ ...props, loadedCount: 600 });
    expect(props.onLoadMore).toHaveBeenCalledTimes(3);
    rerender({ ...props, loadedCount: 800 });
    expect(props.onLoadMore).toHaveBeenCalledTimes(3);
  });

  it("加载期间和禁止继续分页时不发请求，恢复后重新检查视口", () => {
    const props = options();
    const { result, rerender } = renderHook(useMediaGridPagination, {
      initialProps: { ...props, isLoadingMore: true },
    });
    act(() => result.current({ startIndex: 200, endIndex: 230 }));
    expect(props.onLoadMore).not.toHaveBeenCalled();

    rerender({ ...props, hasNextPage: false });
    act(() => result.current({ startIndex: 400, endIndex: 430 }));
    expect(props.onLoadMore).not.toHaveBeenCalled();

    rerender(props);
    expect(props.onLoadMore).toHaveBeenCalledTimes(1);
  });
});
