import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import ScanProgress from "./ScanProgress";
import type { ProgressEvent } from "../../api/scan";

// 进度事件构造助手
function makeProgress(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    scanId: "scan-1",
    progress: 42,
    status: "running",
    phase: "scanning",
    currentPath: "E:\\存照\\2024年",
    albumsFound: 7,
    elapsedMs: 1500,
    ...overrides,
  };
}

describe("ScanProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when progress is null", () => {
    const { container } = render(<ScanProgress progress={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders running state with status text and progress percent", () => {
    render(<ScanProgress progress={makeProgress({ progress: 35 })} />);
    // 默认展开：直接看到状态、百分比、耗时
    expect(screen.getByText("扫描中")).toBeInTheDocument();
    expect(screen.getByText("35%")).toBeInTheDocument();
    expect(screen.getByText("1.5s")).toBeInTheDocument();
  });

  it("renders expanded details: phase, current path, albums found", () => {
    render(
      <ScanProgress
        progress={makeProgress({
          phase: "smart-grouping",
          currentPath: "E:\\存照\\some\\deep\\folder",
        })}
      />,
    );
    // 默认展开：阶段 + 完整路径 + 已发现本数
    expect(screen.getByText("聚合标签中")).toBeInTheDocument();
    expect(
      screen.getByText("E:\\存照\\some\\deep\\folder"),
    ).toBeInTheDocument();
    expect(screen.getByText(/7/)).toBeInTheDocument(); // albumsFound=7
  });

  it("shows full-width 取消扫描 button in expanded running view", () => {
    const onCancel = vi.fn();
    render(<ScanProgress progress={makeProgress()} onCancel={onCancel} />);
    const cancelBtn = screen.getByRole("button", { name: "取消扫描" });
    expect(cancelBtn).toBeInTheDocument();
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("can collapse to pill mode and re-expand", () => {
    render(
      <ScanProgress progress={makeProgress({ phase: "smart-grouping" })} />,
    );
    // 默认展开：阶段文案 "聚合标签中" 应可见
    expect(screen.getByText("聚合标签中")).toBeInTheDocument();
    // 点折叠按钮
    const collapseBtn = screen.getByRole("button", { name: "折叠扫描详情" });
    fireEvent.click(collapseBtn);
    // 现在应该看到 "展开扫描详情" 按钮（pill 模式）
    expect(
      screen.getByRole("button", { name: "展开扫描详情" }),
    ).toBeInTheDocument();
    // 折叠后阶段详情不再可见（pill 模式不显示 details）
    expect(screen.queryByText("聚合标签中")).toBeNull();
    // pill 模式下仍有百分比
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("keeps collapsed cancel action separate from the expand button", () => {
    const onCancel = vi.fn();
    render(
      <ScanProgress
        progress={makeProgress()}
        onCancel={onCancel}
        defaultExpanded={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "取消扫描" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "展开扫描详情" }),
    ).toBeInTheDocument();
  });

  it("disables cancellation while the request is pending", () => {
    const onCancel = vi.fn();
    render(
      <ScanProgress
        progress={makeProgress()}
        onCancel={onCancel}
        isCancelling
      />,
    );

    const cancelButton = screen.getByRole("button", { name: "取消扫描" });
    expect(cancelButton).toBeDisabled();
    expect(screen.getByText("正在取消…")).toBeInTheDocument();
  });

  it("keeps terminal state visible for 5s then auto-hides", () => {
    const { rerender, container } = render(
      <ScanProgress progress={makeProgress({ status: "running" })} />,
    );
    expect(screen.getByText("扫描中")).toBeInTheDocument();
    // 切到 complete
    rerender(
      <ScanProgress
        progress={makeProgress({
          status: "complete",
          progress: 100,
          elapsedMs: 3200,
        })}
      />,
    );
    expect(screen.getByText("扫描完成")).toBeInTheDocument();
    expect(screen.getByText("3.2s")).toBeInTheDocument();
    // 5s 后滑出（FADE_DELAY_MS = 5000）
    act(() => {
      vi.advanceTimersByTime(5100);
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders error state with the error message visible immediately", () => {
    render(
      <ScanProgress
        progress={makeProgress({
          status: "error",
          error: "媒体根不存在: E:\\nope",
        })}
      />,
    );
    expect(screen.getByText("扫描失败")).toBeInTheDocument();
    // error 默认展开时直接显示
    expect(screen.getByText("媒体根不存在: E:\\nope")).toBeInTheDocument();
  });

  it("renders cancelled state", () => {
    render(
      <ScanProgress
        progress={makeProgress({ status: "cancelled", elapsedMs: 800 })}
      />,
    );
    expect(screen.getByText("已取消")).toBeInTheDocument();
    expect(screen.getByText("0.8s")).toBeInTheDocument();
  });

  it("clamps progress width to 100% even when value exceeds 100", () => {
    render(<ScanProgress progress={makeProgress({ progress: 150 })} />);
    // 找到所有带 width style 的元素，验证至少有一个被 clamp 到 100%
    const bars = Array.from(
      document.querySelectorAll<HTMLElement>('[style*="width"]'),
    );
    expect(bars.length).toBeGreaterThan(0);
    const clamped = bars.some((b) => b.style.width === "100%");
    expect(clamped).toBe(true);
  });

  it("has accessible role=status for screen readers", () => {
    render(<ScanProgress progress={makeProgress()} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("连接中断保留进度并持续提供重连，不能误显示扫描失败", () => {
    const reconnect = vi.fn();
    const { rerender } = render(
      <ScanProgress
        progress={makeProgress()}
        connectionState="reconnecting"
        onReconnect={reconnect}
      />,
    );
    expect(screen.getByText("进度连接中断")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(
      screen.getByText("正在自动重连，扫描结果尚未确认。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("扫描失败")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "关闭扫描卡片" }),
    ).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(6000));
    fireEvent.click(screen.getByRole("button", { name: "重新连接进度" }));
    expect(reconnect).toHaveBeenCalledOnce();
    rerender(
      <ScanProgress
        progress={makeProgress()}
        connectionState="disconnected"
        onReconnect={reconnect}
      />,
    );
    expect(
      screen.getByText("扫描结果尚未确认，请重新连接进度。"),
    ).toBeInTheDocument();
  });

  it("折叠后重连和取消仍是独立按钮", () => {
    const reconnect = vi.fn();
    const cancel = vi.fn();
    render(
      <ScanProgress
        progress={makeProgress()}
        connectionState="disconnected"
        onReconnect={reconnect}
        onCancel={cancel}
        defaultExpanded={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重新连接进度" }));
    expect(reconnect).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "展开扫描详情" }),
    ).toBeInTheDocument();
  });

  it("无法恢复连接时可停止跟踪，与取消后台任务相互独立", () => {
    const stop = vi.fn();
    const cancel = vi.fn();
    render(
      <ScanProgress
        progress={makeProgress()}
        connectionState="disconnected"
        onStopTracking={stop}
        onCancel={cancel}
      />,
    );
    expect(screen.getByText("停止跟踪不会取消后台扫描。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止跟踪" }));
    expect(stop).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("等待重新连接时保留最后数值，收到终态后再按原规则隐藏", () => {
    const { rerender, container } = render(
      <ScanProgress progress={makeProgress()} connectionState="connecting" />,
    );
    expect(screen.getByText("正在连接进度")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    rerender(
      <ScanProgress
        progress={makeProgress({ status: "complete", progress: 100 })}
        connectionState="idle"
      />,
    );
    expect(screen.getByText("扫描完成")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5100));
    expect(container.firstChild).toBeNull();
  });
});
