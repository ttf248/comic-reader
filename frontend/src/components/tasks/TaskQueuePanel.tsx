import type { AIJob } from "../../api/aiJobs";
import { formatDateTime } from "../../utils/date";
import { taskModeLabel, taskTitle } from "../../utils/taskFormat";
import { ChevronDownIcon, ChevronUpIcon, TrashIcon } from "../common/Icon";
import TaskStatusDot from "./TaskStatusDot";

interface Props {
  jobs: AIJob[];
  busy: boolean;
  loading: boolean;
  onMove: (id: string, direction: "up" | "down") => void;
  onCancel: (id: string) => void;
  onClear: () => void;
}

/**
 * 等待队列：可调整执行顺序，或取消单项/全部等待任务。
 *
 * 始终保留队列面板，让用户能在任务中心直接确认等待队列是否为空。
 */
export default function TaskQueuePanel({
  jobs,
  busy,
  loading,
  onMove,
  onCancel,
  onClear,
}: Props) {
  function clearQueue() {
    if (
      window.confirm(
        `取消队列中的 ${jobs.length} 项等待任务？当前任务不会受影响。`,
      )
    ) {
      onClear();
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-faint px-5 py-3 sm:px-6">
        <p className="text-label font-medium text-fg">
          等待队列 · {loading ? "…" : `${jobs.length} 项`}
        </p>
        <button
          type="button"
          className="btn btn-sm btn-outline"
          disabled={loading || busy || jobs.length === 0}
          onClick={clearQueue}
        >
          清空队列
        </button>
      </div>

      {loading ? (
        <p className="px-5 py-4 text-meta text-fg-subtle sm:px-6">
          正在读取等待队列…
        </p>
      ) : jobs.length === 0 ? (
        <p className="px-5 py-4 text-meta text-fg-subtle sm:px-6">
          当前没有等待中的任务。按序启动多个模块后，后续任务会显示在这里。
        </p>
      ) : (
        <ol className="divide-y divide-border-faint">
          {jobs.map((job, index) => (
            <li
              key={job.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3 sm:px-6"
              data-testid="task-queue-row"
            >
              <span className="w-7 shrink-0 text-right font-mono text-meta tabular-nums text-fg-subtle">
                {String(index + 1).padStart(2, "0")}
              </span>
              <TaskStatusDot status="pending" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-label font-medium text-fg">
                    {taskTitle(job)}
                  </span>
                  <span className="text-meta text-fg-muted">
                    {taskModeLabel(job.mode)}
                  </span>
                </div>
                <p className="mt-1 text-meta text-fg-subtle">
                  {job.scheduled ? "每日计划" : "手动加入"} ·{" "}
                  {formatDateTime(job.createdAt)}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="btn btn-sm btn-outline px-2"
                  aria-label={`上移 ${taskTitle(job)}`}
                  title="上移"
                  disabled={busy || index === 0}
                  onClick={() => onMove(job.id, "up")}
                >
                  <ChevronUpIcon size={16} />
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline px-2"
                  aria-label={`下移 ${taskTitle(job)}`}
                  title="下移"
                  disabled={busy || index === jobs.length - 1}
                  onClick={() => onMove(job.id, "down")}
                >
                  <ChevronDownIcon size={16} />
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline px-2 text-danger"
                  aria-label={`取消排队 ${taskTitle(job)}`}
                  title="取消排队"
                  disabled={busy}
                  onClick={() => onCancel(job.id)}
                >
                  <TrashIcon size={15} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
