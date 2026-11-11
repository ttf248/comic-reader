import type { AIJob } from "../../api/aiJobs";
import { formatDateTime } from "../../utils/date";
import {
  formatCount,
  formatTaskDuration,
  formatTaskSpeed,
  taskFieldLabel,
  taskModeLabel,
  taskResultLabel,
  taskStatusLabel,
  taskTitle,
} from "../../utils/taskFormat";
import EmptyState from "../common/EmptyState";
import { ChevronDownIcon, TasksIcon } from "../common/Icon";
import FailureGroupList from "./FailureGroupList";
import TaskStatusDot from "./TaskStatusDot";

interface Props {
  jobs: AIJob[];
  /** 有任务在跑时不能重试：后端同一时间只允许一个活动任务。 */
  retryDisabled: boolean;
  onRetry: (id: string) => void;
}

/** 任务记录：每一行一次任务，展开后是它的规格、产出与失败项。 */
export default function JobHistoryPanel({
  jobs,
  retryDisabled,
  onRetry,
}: Props) {
  if (jobs.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg-elevated shadow-xs">
        <EmptyState
          title="还没有已结束的任务"
          description="运行一次全量或增量分析后，历史记录、耗时和失败原因会显示在这里。"
          icon={<TasksIcon size={28} />}
          dense
        />
      </div>
    );
  }

  return (
    <div className="divide-y divide-border-faint rounded-lg border border-border bg-bg-elevated shadow-xs">
      {jobs.map((job) => (
        <details
          key={job.id}
          className="group px-5 py-4"
          data-testid="task-history-row"
        >
          <summary className="flex cursor-pointer list-none items-start gap-3 [&::-webkit-details-marker]:hidden">
            <TaskStatusDot status={job.status} className="mt-2" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-label font-medium text-fg">
                  {taskTitle(job)}
                </span>
                <span className="text-meta text-fg-muted">
                  {taskModeLabel(job.mode)}
                </span>
                <span className="text-meta text-fg-subtle">
                  {taskStatusLabel(job.status)}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-meta text-fg-subtle">
                <span>{formatDateTime(job.createdAt)}</span>
                <span>耗时 {formatTaskDuration(job.elapsedMs)}</span>
                <span className="tabular-nums">
                  完成 {formatCount(job.completed)}
                </span>
                <span className="tabular-nums">
                  跳过 {formatCount(job.skipped)}
                </span>
                <span
                  className={`tabular-nums ${
                    job.failed > 0 ? "text-danger" : ""
                  }`}
                >
                  失败 {formatCount(job.failed)}
                </span>
              </div>
            </div>
            <ChevronDownIcon
              size={16}
              className="mt-1 shrink-0 text-fg-subtle transition-transform group-open:rotate-180"
            />
          </summary>

          <div className="mt-4 border-t border-border-faint pt-4">
            <dl className="grid max-w-2xl gap-x-8 sm:grid-cols-2">
              <SpecRow label="开始" value={formatDateTime(job.startedAt)} />
              <SpecRow label="结束" value={formatDateTime(job.finishedAt)} />
              <SpecRow label="耗时" value={formatTaskDuration(job.elapsedMs)} />
              <SpecRow
                label="速度"
                value={formatTaskSpeed(job.speedPerSecond)}
              />
              <SpecRow label="模块版本" value={job.moduleVersion || "—"} />
            </dl>

            {job.error ? (
              <p className="mt-3 text-meta text-danger">
                任务原因：{job.error}
              </p>
            ) : null}

            <OutputBreakdown job={job} />

            {job.errors && job.errors.length > 0 ? (
              <div className="mt-4">
                <p className="mb-2 text-meta font-medium text-fg">失败文件</p>
                <FailureGroupList errors={job.errors} />
              </div>
            ) : null}

            {job.status === "failed" || job.failed > 0 ? (
              <div className="mt-4">
                <button
                  className="btn btn-sm btn-outline"
                  disabled={retryDisabled}
                  onClick={() => onRetry(job.id)}
                >
                  仅重试失败项
                </button>
              </div>
            ) : null}
          </div>
        </details>
      ))}
    </div>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-faint py-1.5">
      <dt className="text-meta text-fg-subtle">{label}</dt>
      <dd className="font-mono text-meta tabular-nums text-fg">{value}</dd>
    </div>
  );
}

/** 这次任务的产出：解析结果分类与字段产出。 */
function OutputBreakdown({ job }: { job: AIJob }) {
  // 计数多的排前面；后端给的是无序表，顺序不能靠运气。
  const fields = Object.entries(job.fields ?? {}).sort(
    (left, right) => right[1] - left[1],
  );
  const results = Object.entries(job.results ?? {}).sort(
    (left, right) => right[1] - left[1],
  );
  if (results.length === 0 && fields.length === 0) return null;

  return (
    <div className="mt-4">
      <p className="text-meta font-medium text-fg">产出明细</p>
      <div className="mt-2 space-y-1.5">
        {results.length > 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
            <span className="text-meta text-fg-subtle">解析结果</span>
            {results.map(([key, value]) => (
              <CountChip
                key={`result-${key}`}
                label={taskResultLabel(key)}
                value={value}
              />
            ))}
          </div>
        ) : null}
        {fields.length > 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
            <span className="text-meta text-fg-subtle">提取字段</span>
            {fields.map(([key, value]) => (
              <CountChip
                key={`field-${key}`}
                label={taskFieldLabel(key)}
                value={value}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CountChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-faint px-2.5 py-1 text-meta">
      <span className="text-fg-subtle">{label}</span>
      <span className="font-mono tabular-nums text-fg">
        {formatCount(value)}
      </span>
    </span>
  );
}
