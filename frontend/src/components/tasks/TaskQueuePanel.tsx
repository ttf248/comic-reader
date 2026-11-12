import type { AIJob } from "../../api/aiJobs";
import { formatDateTime } from "../../utils/date";
import { taskModeLabel, taskTitle } from "../../utils/taskFormat";
import { ChevronDownIcon, ChevronUpIcon, TrashIcon } from "../common/Icon";
import TaskStatusDot from "./TaskStatusDot";

interface Props {
  jobs: AIJob[];
  busy: boolean;
  onMove: (id: string, direction: "up" | "down") => void;
  onCancel: (id: string) => void;
  onClear: () => void;
}

/**
 * 等待队列：可调整执行顺序，或取消单项/全部等待任务。
 *
 * 队列为空时不渲染任何东西 —— 「没有等待任务」不值得占一整块版面，
 * 空队列的状态由状态面板自己带一句话说明。
 */
export default function TaskQueuePanel({
  jobs,
  busy,
  onMove,
  onCancel,
  onClear,
}: Props) {
  if (jobs.length === 0) return null;

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
        <p className="text-label font-medium text-fg">接下来 · {jobs.length} 项</p>
        <button
          type="button"
          className="btn btn-sm btn-outline"
          disabled={busy}
          onClick={clearQueue}
        >
          清空队列
        </button>
      </div>

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
    </div>
  );
}
