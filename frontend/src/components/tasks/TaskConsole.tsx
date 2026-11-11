import type { AIJob, AnalysisMode } from "../../api/aiJobs";
import type { JobAction } from "../../hooks/useTaskCenter";
import { formatDateTime } from "../../utils/date";
import {
  formatCount,
  formatTaskDuration,
  formatTaskSpeed,
  jobProgressPercent,
  taskModeLabel,
  taskStageLabel,
  taskStatusLabel,
} from "../../utils/taskFormat";
import TaskStatusDot from "./TaskStatusDot";

interface Props {
  /** 当前活动任务；没有时是空闲态。 */
  active?: AIJob;
  /** 最近一次已结束的任务，用来给空闲态一点上下文。 */
  lastJob?: AIJob;
  loading: boolean;
  /** 启动或任务操作正在提交。 */
  busy: boolean;
  onStart: (mode: AnalysisMode) => void;
  onAction: (id: string, action: JobAction) => void;
}

/**
 * 状态面板：这一页的主角。
 *
 * 空闲时给出「开始一次分析」的入口，运行中给出进度、读数与控制。
 * 两种状态共用一块面板，用户不需要在页面里找按钮在哪。
 */
export default function TaskConsole({
  active,
  lastJob,
  loading,
  busy,
  onStart,
  onAction,
}: Props) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-bg-elevated px-5 py-6 sm:px-6">
        <div className="h-4 w-32 animate-pulse rounded-full bg-bg-subtle" />
        <div className="mt-4 h-3 w-2/3 animate-pulse rounded-full bg-bg-subtle" />
        <div className="mt-6 h-2 w-full animate-pulse rounded-full bg-bg-subtle" />
      </div>
    );
  }

  if (!active) {
    return (
      <div className="rounded-xl border border-border bg-bg-elevated px-5 py-6 shadow-xs sm:px-6">
        <div className="flex items-center gap-3">
          <TaskStatusDot status="idle" />
          <span className="text-label font-medium text-fg">队列空闲</span>
        </div>
        <p className="mt-3 max-w-2xl text-body leading-relaxed text-fg-muted">
          分析完全在本机运行：逐张读取照片元数据，产出拍摄时间、相机信息与 GPS
          坐标，结果只写进本机的派生缓存。
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            className="btn btn-outline"
            disabled={busy}
            onClick={() => onStart("incremental")}
          >
            增量分析
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => onStart("full")}
          >
            全量分析
          </button>
        </div>
        <p className="mt-3 text-meta leading-relaxed text-fg-subtle">
          增量只处理新增、修改或解析器更新的图片；全量重新解析当前媒体库的全部图片。
        </p>
        {lastJob ? (
          <p className="mt-5 border-t border-border-faint pt-4 text-meta text-fg-subtle">
            上次运行 {formatDateTime(lastJob.createdAt)} ·{" "}
            {taskModeLabel(lastJob.mode)} · 完成{" "}
            {formatCount(lastJob.completed ?? lastJob.processed)} 张
          </p>
        ) : null}
      </div>
    );
  }

  const percent = jobProgressPercent(active);
  const planned = active.planned ?? 0;
  const settled =
    active.status === "completed" ||
    active.status === "cancelled" ||
    active.status === "failed";

  return (
    <div className="rounded-xl border border-border bg-bg-elevated shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-faint px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <TaskStatusDot status={active.status} />
          <span className="text-label font-medium text-fg">
            {taskStatusLabel(active.status)}
          </span>
          <span className="text-meta text-fg-muted">
            {taskStageLabel(active.stage)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active.status === "running" ? (
            <button
              type="button"
              className="btn btn-sm btn-outline"
              disabled={busy}
              onClick={() => onAction(active.id, "pause")}
            >
              暂停
            </button>
          ) : null}
          {active.status === "paused" || active.status === "pending" ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => onAction(active.id, "resume")}
            >
              继续
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm btn-outline"
            disabled={busy}
            onClick={() => onAction(active.id, "cancel")}
          >
            取消任务
          </button>
        </div>
      </div>

      <div className="px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-page-sm font-medium tabular-nums text-fg">
              {percent}%
            </span>
            <span className="text-meta tabular-nums text-fg-muted">
              {planned > 0
                ? `${formatCount(active.completed)} / ${formatCount(planned)} 张`
                : settled
                  ? "本次没有需要处理的图片"
                  : "正在整理分析清单"}
            </span>
          </div>
          <span className="text-meta text-fg-subtle">
            {taskModeLabel(active.mode)} · 开始{" "}
            {formatDateTime(active.startedAt ?? active.createdAt)} · 已运行{" "}
            {formatTaskDuration(active.elapsedMs)}
          </span>
        </div>

        <div
          className="mt-3 h-2 overflow-hidden rounded-full bg-bg-subtle"
          role="progressbar"
          aria-label="任务进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border-faint bg-border-faint sm:grid-cols-3 lg:grid-cols-5">
          <Readout label="已处理" value={formatCount(active.processed)} />
          <Readout label="已跳过" value={formatCount(active.skipped)} />
          <Readout
            label="失败"
            value={formatCount(active.failed)}
            tone={active.failed > 0 ? "danger" : "default"}
          />
          <Readout
            label="速度"
            value={formatTaskSpeed(active.speedPerSecond)}
          />
          <Readout
            label="预计剩余"
            value={
              active.estimatedRemainingMs > 0
                ? formatTaskDuration(active.estimatedRemainingMs)
                : "—"
            }
          />
        </dl>
      </div>
    </div>
  );
}

function Readout({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "danger";
}) {
  return (
    <div className="bg-bg-elevated px-3.5 py-3">
      <dt className="text-meta text-fg-subtle">{label}</dt>
      <dd
        className={`mt-1 font-mono text-label font-medium tabular-nums ${
          tone === "danger" ? "text-danger" : "text-fg"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
