// 扫描进度卡：左下角浮动卡（v3，从「顶部 sticky」改为「左下浮动」）
//
// 设计动机：
//   - 之前 v2 是「顶部 sticky 36px 细条」，但因为挂在 <main>（overflow-auto）
//     内部，sticky 是相对 main 容器而不是 viewport，一旦用户在某个 route
//     滚到中部就完全看不到进度了。
//   - 用户实际行为是「点扫描 → 切去别处干别的 → 回来想看进度」，
//     进度必须常驻 viewport，不受 main 滚动影响。
//
// 视觉与交互：
//   - 位置：fixed bottom-4 left-56 sm:bottom-6 sm:left-60
//     （避开 208px 宽的侧边栏，从 224px 起；折叠态窄一些时可贴 left-4）
//   - 宽度：w-[400px] max-w-[calc(100vw-2rem)]
//   - z-index：50（在 toast z-60 下面，但不会跟 toast 重叠 — toast 在右下）
//   - 默认展开：标题 + 进度条 + 当前路径 + 统计 + 取消按钮
//   - 可折叠：点 ⌃ 变成药丸（状态 + 进度 + 百分比 + 耗时 + 展开按钮）
//   - 终态：5s 内继续可见（让用户看到「完成」反馈），然后滑出
//
// 显示策略：
//   - progress === null → 不渲染
//   - status === 'running' / 'pending' → 显示
//   - status === 'complete' / 'cancelled' / 'error' → 继续显示 FADE_DELAY_MS 后滑出
const FADE_DELAY_MS = 5000;

import { useEffect, useState } from "react";
import { ProgressEvent } from "../../api/scan";
import type { ScanConnectionState } from "../../store/scanStore";
import {
  CloseIcon,
  CheckIcon,
  AlertIcon,
  ScanIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  RefreshIcon,
} from "../common/Icon";

interface Props {
  progress: ProgressEvent | null;
  onCancel?: () => void;
  isCancelling?: boolean;
  connectionState?: ScanConnectionState;
  onReconnect?: () => void;
  onStopTracking?: () => void;
  /** 强制展开（例如首次出现时；之后交由用户折叠） */
  defaultExpanded?: boolean;
}

export default function ScanProgress({
  progress,
  onCancel,
  isCancelling = false,
  defaultExpanded = true,
  connectionState = "connected",
  onReconnect,
  onStopTracking,
}: Props) {
  const [collapsed, setCollapsed] = useState(!defaultExpanded);
  const [phase, setPhase] = useState<"in" | "visible" | "out">("in");

  // 终态后短暂保留显示，再滑出
  const [showTerminal, setShowTerminal] = useState(false);

  useEffect(() => {
    if (!progress) {
      setShowTerminal(false);
      setPhase("out");
      return;
    }
    if (
      progress.status === "complete" ||
      progress.status === "cancelled" ||
      progress.status === "error"
    ) {
      setShowTerminal(true);
      setPhase("visible");
      const id = window.setTimeout(() => setPhase("out"), FADE_DELAY_MS);
      return () => window.clearTimeout(id);
    }
    setShowTerminal(false);
    setPhase("visible");
  }, [progress, connectionState]);

  if (!progress) return null;
  if (phase === "out") return null;

  // 合法渲染窗口：
  //   - 扫描中（pending/running） + 没有终态保持标志 → 渲染
  //   - 终态（complete/cancelled/error） + 处于 showTerminal 保持期 → 渲染
  // 其他组合（如刚切到 complete 但 useEffect 还没把 showTerminal 置 true）
  // 短暂返回 null，等下一帧 useEffect 跑完再渲染。
  const isScanActive =
    progress.status === "pending" || progress.status === "running";
  const isTerminal =
    progress.status === "complete" ||
    progress.status === "cancelled" ||
    progress.status === "error";

  if (isScanActive && showTerminal) {
    // race：刚切回 running 时不要继续显示终态
    return null;
  }
  if (isScanActive && !showTerminal) {
    // 正常进行中 — 渲染
  } else if (isTerminal && showTerminal) {
    // 终态保持中 — 渲染
  } else {
    // 其他组合（刚切到 complete / 刚清空 progress）— 短暂隐藏
    return null;
  }

  const isRunning =
    progress.status === "running" || progress.status === "pending";
  const isComplete = progress.status === "complete";
  const connectionLost =
    isRunning &&
    (connectionState === "reconnecting" || connectionState === "disconnected");
  const isConnecting = isRunning && connectionState === "connecting";
  const isError =
    progress.status === "error" || progress.status === "cancelled";
  const pct = Math.max(0, Math.min(100, progress.progress));
  const elapsedSec = (progress.elapsedMs / 1000).toFixed(1);
  const fileName =
    progress.currentPath?.split(/[\\/]/).filter(Boolean).pop() ?? "";

  // 状态条
  const barColor = isComplete
    ? "bg-success"
    : isError
      ? "bg-danger"
      : "bg-accent";

  // 状态文案 + 图标
  const StatusIcon = isComplete
    ? CheckIcon
    : isError || connectionLost
      ? AlertIcon
      : ScanIcon;
  const statusText = isComplete
    ? "扫描完成"
    : progress.status === "cancelled"
      ? "已取消"
      : progress.status === "error"
        ? "扫描失败"
        : connectionLost
          ? "进度连接中断"
          : isConnecting
            ? "正在连接进度"
            : "扫描中";
  const statusColor = isComplete
    ? "text-success"
    : isError
      ? "text-danger"
      : connectionLost
        ? "text-warning"
        : "text-fg";

  const phaseLabel =
    progress.phase === "smart-grouping"
      ? "聚合标签中"
      : progress.phase === "done"
        ? "收尾中"
        : "扫描目录";

  return (
    <div
      // 左下角浮动卡 — fixed 到 viewport（不挂 main 内部，避开 main 滚动影响）
      className="fixed bottom-4 left-4 sm:bottom-6 sm:left-60 z-50 w-[400px] max-w-[calc(100vw-2rem)] rounded-xl border border-border shadow-2xl glass-strong fade-up"
      role="status"
      aria-live="polite"
      data-testid="scan-progress"
    >
      {/* 折叠态 pill：单行（status + 进度条 + 百分比 + 耗时 + 展开 + 取消） */}
      {collapsed ? (
        <div className="flex items-center h-10 rounded-xl">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="flex-1 min-w-0 flex items-center gap-2.5 px-3.5 h-full text-[12px] text-left hover:bg-bg-subtle/30 transition-colors rounded-l-xl"
            aria-expanded={false}
            aria-label="展开扫描详情"
          >
            <StatusIcon size={13} className={statusColor} />
            <span className={`font-medium ${statusColor} shrink-0`}>
              {statusText}
            </span>

            {/* 进度条（accent 渐变） — flex-1 占据中间最大空间 */}
            <span className="flex-1 relative h-1 rounded-full bg-bg-subtle overflow-hidden min-w-0">
              <span
                className={`absolute inset-y-0 left-0 ${barColor} transition-[width] duration-200 ease-out`}
                style={{ width: `${isComplete ? 100 : pct}%` }}
              />
            </span>

            {/* 百分比 + 耗时 */}
            {isRunning && (
              <span className="tabular-nums text-fg-muted shrink-0">
                {pct}%
              </span>
            )}
            {!isRunning && (
              <span className="tabular-nums text-fg-subtle shrink-0">
                {elapsedSec}s
              </span>
            )}

            <ChevronUpIcon size={12} className="text-fg-subtle shrink-0" />
          </button>

          {connectionLost && onReconnect && (
            <button
              type="button"
              onClick={onReconnect}
              aria-label="重新连接进度"
              title="重新连接进度"
              className="mr-2 p-1 rounded text-warning hover:bg-bg-subtle shrink-0"
            >
              <RefreshIcon size={12} />
            </button>
          )}
          {isRunning && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isCancelling}
              className="mr-2 p-1 rounded text-fg-muted hover:text-fg hover:bg-bg-subtle transition-colors disabled:cursor-wait disabled:opacity-50 shrink-0"
              title={isCancelling ? "正在取消扫描" : "取消扫描"}
              aria-label="取消扫描"
              aria-busy={isCancelling}
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>
      ) : (
        // 展开态：完整详情
        <div>
          {/* Header：icon + status + 百分比 + 耗时 + collapse + 关闭 */}
          <div className="flex items-center gap-2.5 px-3.5 h-10 border-b border-border-faint">
            <StatusIcon size={13} className={statusColor} />
            <span
              className={`font-medium ${statusColor} text-[12px] flex-1 min-w-0`}
            >
              {statusText}
            </span>

            {isRunning && (
              <span className="tabular-nums text-fg-muted text-[12px] shrink-0">
                {pct}%
              </span>
            )}
            <span className="tabular-nums text-fg-subtle text-[12px] shrink-0">
              {elapsedSec}s
            </span>

            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className="p-1 rounded text-fg-muted hover:text-fg hover:bg-bg-subtle transition-colors"
              title="折叠为药丸"
              aria-label="折叠扫描详情"
            >
              <ChevronDownIcon size={12} />
            </button>
            {!isRunning && (
              <button
                type="button"
                onClick={() => setPhase("out")}
                className="p-1 rounded text-fg-muted hover:text-fg hover:bg-bg-subtle transition-colors"
                title="关闭"
                aria-label="关闭扫描卡片"
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>

          {/* 进度条 */}
          <div className="px-3.5 pt-3">
            <div className="relative h-1.5 rounded-full bg-bg-subtle overflow-hidden">
              <div
                className={`absolute inset-y-0 left-0 ${barColor} transition-[width] duration-200 ease-out`}
                style={{ width: `${isComplete ? 100 : pct}%` }}
              />
            </div>
          </div>

          {/* 详情：阶段 + 统计 */}
          <div className="px-3.5 py-2.5 text-[11px] text-fg-muted space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                阶段 <span className="text-fg">{phaseLabel}</span>
              </span>
              <span>
                已发现{" "}
                <span className="text-fg tabular-nums">
                  {progress.albumsFound}
                </span>{" "}
                个文件夹
              </span>
              {isError && progress.error && (
                <span className="text-danger truncate max-w-[40ch]">
                  {progress.error}
                </span>
              )}
            </div>

            {/* 当前路径 */}
            {progress.currentPath && (
              <div
                className="truncate text-fg-subtle font-mono"
                title={progress.currentPath}
              >
                <span className="text-fg-subtle/70 mr-1">↳</span>
                {progress.currentPath}
              </div>
            )}
            {!progress.currentPath && fileName && (
              <div className="truncate text-fg-subtle">{fileName}</div>
            )}
          </div>

          {connectionLost && (
            <div
              className="px-3.5 pb-3 space-y-2 text-[11px] text-warning"
              role="alert"
            >
              <p>
                {connectionState === "reconnecting"
                  ? "正在自动重连，扫描结果尚未确认。"
                  : "扫描结果尚未确认，请重新连接进度。"}
              </p>
              <div className="flex flex-wrap gap-2">
                {onReconnect && (
                  <button
                    type="button"
                    onClick={onReconnect}
                    className="h-8 px-3 rounded-md border border-warning/40 hover:bg-bg-subtle text-warning"
                  >
                    重新连接进度
                  </button>
                )}
                {onStopTracking && (
                  <button
                    type="button"
                    onClick={onStopTracking}
                    className="h-8 px-3 rounded-md border border-border text-fg-muted hover:bg-bg-subtle"
                  >
                    停止跟踪
                  </button>
                )}
              </div>
              {onStopTracking && (
                <p className="text-fg-muted">停止跟踪不会取消后台扫描。</p>
              )}
            </div>
          )}
          {/* 取消按钮（running 态时） */}
          {isRunning && onCancel && (
            <div className="px-3.5 pb-3">
              <button
                type="button"
                onClick={onCancel}
                disabled={isCancelling}
                aria-label="取消扫描"
                aria-busy={isCancelling}
                className="w-full h-8 rounded-md border border-border bg-bg-subtle/40 hover:bg-bg-subtle text-fg-muted hover:text-fg text-[12px] transition-colors disabled:cursor-wait disabled:opacity-50"
              >
                {isCancelling ? "正在取消…" : "取消扫描"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
