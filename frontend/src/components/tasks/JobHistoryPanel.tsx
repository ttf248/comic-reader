import { useState } from "react";
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
import { ChevronDownIcon } from "../common/Icon";
import FailureGroupList from "./FailureGroupList";
import JobOutputSummary from "./JobOutputSummary";
import TaskStatusDot from "./TaskStatusDot";

interface Props {
  jobs: AIJob[];
  /** 有任务在跑时不能重试：后端同一时间只允许一个活动任务。 */
  retryDisabled: boolean;
  busy: boolean;
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}

/** 任务记录：每一行一次任务，展开后是它的规格、产出与失败项。 */
export default function JobHistoryPanel({
  jobs,
  retryDisabled,
  busy,
  onRetry,
  onDelete,
  onClear,
}: Props) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  // 展开态：只有展开的记录才去取它的产物占用。details 本身仍由浏览器
  // 控制（受控写法会让展开延迟到 React 状态回写，用户点下去要等一拍
  // 才看到内容），这里只监听 toggle 事件记住谁开着。
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  function handleToggle(jobId: string, open: boolean) {
    setExpandedIds((current) => {
      if (current.has(jobId) === open) return current;
      const next = new Set(current);
      if (open) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  }
  const counts: Record<HistoryFilter, number> = {
    all: jobs.length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: jobs.filter((job) => job.status === "failed").length,
    cancelled: jobs.filter((job) => job.status === "cancelled").length,
  };
  const visibleJobs =
    filter === "all" ? jobs : jobs.filter((job) => job.status === filter);

  function clearHistory() {
    if (
      jobs.length > 0 &&
      window.confirm(
        `删除全部 ${jobs.length} 条已结束任务记录？分析结果和索引数据会保留。`,
      )
    ) {
      onClear();
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-faint px-5 py-4 sm:px-6">
        <p className="min-w-0 text-meta text-fg-subtle">
          删除记录只清理任务日志，不会删除已生成的元数据、向量、文字或人脸结果。
        </p>
        {jobs.length > 0 ? (
          <button
            type="button"
            className="btn btn-sm btn-outline"
            disabled={busy}
            onClick={clearHistory}
          >
            清理已结束记录
          </button>
        ) : null}
      </div>

      {jobs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border-faint px-5 py-3 sm:px-6">
          {HISTORY_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`btn btn-sm ${filter === value ? "btn-primary" : "btn-outline"}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}{" "}
              <span className="ml-1 font-mono tabular-nums">{counts[value]}</span>
            </button>
          ))}
        </div>
      ) : null}

      {visibleJobs.length === 0 ? (
        <EmptyState
          inline
          title={
            jobs.length === 0 ? "还没有已结束的任务" : "没有符合条件的记录"
          }
          description={
            jobs.length === 0
              ? "运行一次分析后，耗时、产出和失败原因会显示在这里。"
              : "选择其他状态查看任务记录。"
          }
        />
      ) : (
        <div className="divide-y divide-border-faint">
          {visibleJobs.map((job) => (
            <details
              key={job.id}
              onToggle={(event) =>
                handleToggle(job.id, event.currentTarget.open)
              }
              className="group px-5 py-4"
              data-testid="task-history-row"
              data-job-id={job.id}
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
                  <SpecRow
                    label="结束"
                    value={formatDateTime(job.finishedAt)}
                  />
                  <SpecRow
                    label="耗时"
                    value={formatTaskDuration(job.elapsedMs)}
                  />
                  <SpecRow
                    label="速度"
                    value={formatTaskSpeed(job.speedPerSecond)}
                  />
                  <SpecRow
                    label="模块版本"
                    value={job.moduleVersion || "—"}
                    fullWidth
                  />
                </dl>

                {job.error ? (
                  <p className="mt-3 text-meta text-danger">
                    任务原因：{job.error}
                  </p>
                ) : null}

                <JobOutputSummary
                  jobId={job.id}
                  enabled={expandedIds.has(job.id)}
                />

                <OutputBreakdown job={job} />

                {job.errors && job.errors.length > 0 ? (
                  <div className="mt-4">
                    <p className="mb-2 text-meta font-medium text-fg">
                      失败文件
                    </p>
                    <FailureGroupList errors={job.errors} />
                  </div>
                ) : null}

                {job.status === "failed" ||
                job.status === "cancelled" ||
                job.failed > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn btn-sm btn-outline"
                      disabled={retryDisabled}
                      onClick={() => onRetry(job.id)}
                    >
                      {job.status === "cancelled"
                        ? "重新运行未完成项"
                        : "仅重试失败项"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline text-danger"
                      disabled={busy}
                      onClick={() => deleteJob(job.id, onDelete)}
                    >
                      删除任务记录
                    </button>
                  </div>
                ) : (
                  <div className="mt-4">
                    <button
                      type="button"
                      className="btn btn-sm btn-outline text-danger"
                      disabled={busy}
                      onClick={() => deleteJob(job.id, onDelete)}
                    >
                      删除任务记录
                    </button>
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

type HistoryFilter = "all" | "completed" | "failed" | "cancelled";

const HISTORY_FILTERS: { value: HistoryFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "completed", label: "已完成" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" },
];

function deleteJob(id: string, onDelete: (id: string) => void) {
  if (window.confirm("删除这条任务记录？已生成的分析结果会保留。")) {
    onDelete(id);
  }
}

function SpecRow({
  label,
  value,
  fullWidth = false,
}: {
  label: string;
  value: string;
  fullWidth?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 border-b border-border-faint py-1.5 ${fullWidth ? "sm:col-span-2" : ""}`}
    >
      <dt className="shrink-0 whitespace-nowrap text-meta text-fg-subtle">
        {label}
      </dt>
      <dd
        className={`min-w-0 font-mono text-meta tabular-nums text-fg ${fullWidth ? "break-all text-right" : ""}`}
      >
        {value}
      </dd>
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
            <span className="text-meta text-fg-subtle">
              {job.type === "metadata" ? "解析结果" : "处理结果"}
            </span>
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
