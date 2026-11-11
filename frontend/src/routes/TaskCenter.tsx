import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeading from "../components/common/PageHeading";
import EmptyState from "../components/common/EmptyState";
import { sse } from "../api/client";
import {
  aiJobsApi,
  type AIJob,
  type AIJobSnapshot,
  type AnalysisMode,
} from "../api/aiJobs";
import { TasksIcon } from "../components/common/Icon";

const JOBS_KEY = ["ai-jobs"] as const;
const JOB_EVENTS = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
];

export default function TaskCenter() {
  const queryClient = useQueryClient();
  const jobsQuery = useQuery({
    queryKey: JOBS_KEY,
    queryFn: aiJobsApi.list,
    refetchInterval: (query) =>
      query.state.data?.snapshot.active ? 15_000 : false,
  });
  const snapshot = jobsQuery.data?.snapshot;
  const active = snapshot?.active;
  const activeId = active?.id;
  const [dailyEnabled, setDailyEnabled] = useState(true);
  const [dailyTime, setDailyTime] = useState("03:00");
  const [settingsInitialized, setSettingsInitialized] = useState(false);

  useEffect(() => {
    if (!snapshot || settingsInitialized) return;
    setDailyEnabled(snapshot.settings.dailyEnabled);
    setDailyTime(snapshot.settings.dailyTime || "03:00");
    setSettingsInitialized(true);
  }, [snapshot, settingsInitialized]);

  useEffect(() => {
    if (!activeId) return;
    const controller = new AbortController();
    sse(
      `/api/ai/jobs/${encodeURIComponent(activeId)}/events`,
      (_eventName, value) => {
        if (!isAIJob(value)) return;
        queryClient.setQueryData<{ ok: boolean; snapshot: AIJobSnapshot }>(
          JOBS_KEY,
          (current) => {
            if (!current) return current;
            const existing = current.snapshot.jobs.filter(
              (job) => job.id !== value.id,
            );
            const nextActive =
              value.status === "completed" ||
              value.status === "failed" ||
              value.status === "cancelled"
                ? undefined
                : value;
            return {
              ...current,
              snapshot: {
                ...current.snapshot,
                jobs: [value, ...existing],
                active: nextActive,
              },
            };
          },
        );
      },
      { events: JOB_EVENTS, signal: controller.signal },
    );
    return () => controller.abort();
  }, [activeId, queryClient]);

  const startMutation = useMutation({
    mutationFn: (mode: AnalysisMode) => aiJobsApi.start("metadata", mode),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });
  const actionMutation = useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: string;
      action: "pause" | "resume" | "cancel" | "retry";
    }) => aiJobsApi.action(id, action),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });
  const settingsMutation = useMutation({
    mutationFn: () => aiJobsApi.updateSettings({ dailyEnabled, dailyTime }),
    onSuccess: ({ settings }) => {
      setDailyEnabled(settings.dailyEnabled);
      setDailyTime(settings.dailyTime);
      queryClient.setQueryData<{ ok: boolean; snapshot: AIJobSnapshot }>(
        JOBS_KEY,
        (current) =>
          current
            ? { ...current, snapshot: { ...current.snapshot, settings } }
            : current,
      );
    },
  });

  const history = useMemo(
    () => snapshot?.jobs.filter((job) => job.id !== active?.id) ?? [],
    [active?.id, snapshot?.jobs],
  );

  return (
    <div className="h-full overflow-y-auto pb-12">
      <PageHeading
        eyebrow="后台分析"
        title="任务中心"
        description="查看照片元数据分析进度，安排每日增量更新，并在需要时暂停、继续或重试。分析完全在本机运行。"
        action={
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-outline"
              onClick={() => startMutation.mutate("incremental")}
              disabled={Boolean(active) || startMutation.isPending}
            >
              增量分析
            </button>
            <button
              className="btn btn-primary"
              onClick={() => startMutation.mutate("full")}
              disabled={Boolean(active) || startMutation.isPending}
            >
              全量分析
            </button>
          </div>
        }
      />

      {jobsQuery.isError ? (
        <div className="page-shell mt-6 rounded-xl border border-border-faint bg-bg-elevated p-5 text-body text-fg-muted">
          任务状态读取失败。请检查后端是否运行，然后刷新页面。
        </div>
      ) : null}

      <div className="page-shell mt-6 grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.8fr)]">
        <section className="rounded-xl border border-border-faint bg-bg-elevated p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="page-eyebrow">当前任务</p>
              <h2 className="mt-1 font-display text-page-sm font-semibold text-fg">
                {active ? "EXIF 与 GPS 元数据" : "队列空闲"}
              </h2>
            </div>
            {active && <StatusBadge status={active.status} />}
          </div>
          {active ? (
            <JobProgress job={active} />
          ) : (
            <p className="text-body leading-relaxed text-fg-muted">
              全量分析会检查当前媒体库中的照片；增量分析只处理新增、修改或解析器版本更新的文件。
            </p>
          )}
          {active && (
            <div className="mt-5 flex flex-wrap gap-2">
              {active.status === "running" && (
                <button
                  className="btn btn-outline"
                  onClick={() =>
                    actionMutation.mutate({ id: active.id, action: "pause" })
                  }
                  disabled={actionMutation.isPending}
                >
                  暂停
                </button>
              )}
              {(active.status === "paused" || active.status === "pending") && (
                <button
                  className="btn btn-primary"
                  onClick={() =>
                    actionMutation.mutate({ id: active.id, action: "resume" })
                  }
                  disabled={actionMutation.isPending}
                >
                  继续
                </button>
              )}
              <button
                className="btn btn-outline"
                onClick={() =>
                  actionMutation.mutate({ id: active.id, action: "cancel" })
                }
                disabled={actionMutation.isPending}
              >
                取消任务
              </button>
            </div>
          )}
          {startMutation.isError || actionMutation.isError ? (
            <p role="alert" className="mt-3 text-meta text-danger">
              操作未完成，请稍后重试。
            </p>
          ) : null}
        </section>

        <section className="rounded-xl border border-border-faint bg-bg-elevated p-5 sm:p-6">
          <p className="page-eyebrow">自动更新</p>
          <h2 className="mt-1 font-display text-page-sm font-semibold text-fg">
            每日增量计划
          </h2>
          <p className="mt-2 text-meta leading-relaxed text-fg-muted">
            按服务所在设备的本地时间运行。错过计划时间后，下次启动会补跑一次。
          </p>
          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              settingsMutation.mutate();
            }}
          >
            <label className="flex items-center gap-3 text-body text-fg">
              <input
                type="checkbox"
                checked={dailyEnabled}
                onChange={(event) => setDailyEnabled(event.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              每天自动检查变化
            </label>
            <label className="flex items-center justify-between gap-4 text-meta text-fg-muted">
              <span>开始时间</span>
              <input
                type="time"
                value={dailyTime}
                onChange={(event) => setDailyTime(event.target.value)}
                className="w-32 rounded-md border border-border bg-bg-elevated px-3 py-2 text-body text-fg"
                aria-label="每日分析开始时间"
              />
            </label>
            <button
              className="btn btn-outline"
              type="submit"
              disabled={settingsMutation.isPending || !settingsInitialized}
            >
              {settingsMutation.isPending ? "保存中…" : "保存计划"}
            </button>
            {settingsMutation.isSuccess && (
              <span className="ml-3 text-meta text-fg-muted">已保存</span>
            )}
            {settingsMutation.isError && (
              <p role="alert" className="text-meta text-danger">
                保存失败，请检查时间后重试。
              </p>
            )}
          </form>
          <div className="mt-6 border-t border-border-faint pt-4 text-meta text-fg-subtle">
            当前模块：照片 EXIF、相机信息与
            GPS。OCR、人脸识别和向量索引尚未安装分析器。
          </div>
        </section>
      </div>

      <section className="page-shell mt-8">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <p className="page-eyebrow">任务记录</p>
            <h2 className="mt-1 font-display text-page-sm font-semibold text-fg">
              历史与失败项
            </h2>
          </div>
          <span className="text-meta text-fg-subtle">{history.length} 项</span>
        </div>
        {history.length === 0 ? (
          <EmptyState
            title="还没有已结束的任务"
            description="运行一次全量或增量分析后，历史记录、耗时和失败原因会显示在这里。"
            icon={<TasksIcon size={28} />}
            dense
          />
        ) : (
          <div className="divide-y divide-border-faint rounded-xl border border-border-faint bg-bg-elevated">
            {history.map((job) => (
              <details key={job.id} className="group px-4 py-4 sm:px-5">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-2 [&::-webkit-details-marker]:hidden">
                  <span className="min-w-40 flex-1">
                    <span className="block font-medium text-fg">
                      {jobTitle(job)}
                    </span>
                    <span className="mt-1 block text-meta text-fg-subtle">
                      {formatDate(job.createdAt)} · {modeLabel(job.mode)}
                    </span>
                  </span>
                  <span className="text-meta tabular-nums text-fg-muted">
                    {job.processed} 完成 · {job.skipped} 跳过 · {job.failed}{" "}
                    失败
                  </span>
                  <StatusBadge status={job.status} />
                </summary>
                <div className="mt-4 grid gap-4 border-t border-border-faint pt-4 text-meta text-fg-muted sm:grid-cols-3">
                  <span>开始：{formatDate(job.startedAt)}</span>
                  <span>结束：{formatDate(job.finishedAt)}</span>
                  <span>速度：{formatSpeed(job.speedPerSecond)}</span>
                  {job.error && (
                    <span className="sm:col-span-3">任务原因：{job.error}</span>
                  )}
                  {job.errors && job.errors.length > 0 && (
                    <div className="sm:col-span-3">
                      <p className="mb-2 text-fg">失败文件（最多展示 20 项）</p>
                      <ul className="space-y-1">
                        {job.errors.slice(0, 20).map((failure, index) => (
                          <li
                            key={`${failure.resourceId}-${index}`}
                            className="grid gap-1"
                          >
                            <span>{failure.message}</span>
                            <span className="break-all font-mono text-fg-subtle">
                              图片路径：{failure.path || "当前媒体库中不可用"}
                            </span>
                            <span className="break-all text-fg-subtle">
                              资源 ID：{failure.resourceId}
                            </span>
                          </li>
                        ))}
                        {job.errors.length > 20 && (
                          <li>另有 {job.errors.length - 20} 项失败</li>
                        )}
                      </ul>
                    </div>
                  )}
                  {(job.status === "failed" || job.failed > 0) && (
                    <div className="sm:col-span-3">
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() =>
                          actionMutation.mutate({ id: job.id, action: "retry" })
                        }
                        disabled={Boolean(active) || actionMutation.isPending}
                      >
                        仅重试失败项
                      </button>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function JobProgress({ job }: { job: AIJob }) {
  const percent =
    job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  return (
    <>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-meta text-fg-muted">{stageLabel(job.stage)}</span>
        <span className="font-mono text-meta tabular-nums text-fg">
          {job.done.toLocaleString()} / {job.total.toLocaleString()} · {percent}
          %
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-bg-subtle"
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
      <div className="mt-4 grid grid-cols-2 gap-3 text-meta sm:grid-cols-4">
        <Metric label="已处理" value={job.processed} />
        <Metric label="已跳过" value={job.skipped} />
        <Metric label="失败" value={job.failed} />
        <Metric label="速度" value={formatSpeed(job.speedPerSecond)} />
      </div>
      <p className="mt-4 text-meta text-fg-subtle">
        {modeLabel(job.mode)} · 开始{" "}
        {formatDate(job.startedAt ?? job.createdAt)} · 已运行{" "}
        {formatDuration(job.elapsedMs)}
      </p>
    </>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg bg-bg-subtle px-3 py-2.5">
      <span className="block text-fg-subtle">{label}</span>
      <span className="mt-1 block font-mono font-medium tabular-nums text-fg">
        {typeof value === "number" ? value.toLocaleString() : value}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: AIJob["status"] }) {
  const color =
    status === "running"
      ? "text-accent"
      : status === "failed"
        ? "text-danger"
        : status === "completed"
          ? "text-success"
          : "text-fg-muted";
  return (
    <span
      className={`rounded-full border border-border-faint px-2.5 py-1 text-meta ${color}`}
    >
      {statusLabel(status)}
    </span>
  );
}

function isAIJob(value: unknown): value is AIJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.id === "string" &&
    typeof job.status === "string" &&
    typeof job.done === "number"
  );
}

function jobTitle(job: AIJob) {
  return `${job.scheduled ? "每日" : "手动"} ${jobTitleType(job.type)}`;
}

function jobTitleType(type: AIJob["type"]) {
  return type === "metadata"
    ? "元数据分析"
    : type === "embedding"
      ? "向量索引"
      : type === "ocr"
        ? "文字识别"
        : "人脸识别";
}

function modeLabel(mode: AIJob["mode"]) {
  return mode === "full" ? "全量" : "增量";
}

function stageLabel(stage: string) {
  if (stage === "pending") return "等待媒体库";
  if (stage === "enumerating") return "整理分析清单";
  if (stage === "metadata") return "读取照片元数据";
  if (stage === "complete") return "分析完成";
  return stage || "准备中";
}

function statusLabel(status: AIJob["status"]) {
  return status === "pending"
    ? "排队中"
    : status === "running"
      ? "运行中"
      : status === "paused"
        ? "已暂停"
        : status === "completed"
          ? "已完成"
          : status === "failed"
            ? "失败"
            : "已取消";
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function formatSpeed(value: number) {
  return Number.isFinite(value) && value > 0
    ? `${value.toFixed(1)} 张/秒`
    : "—";
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours} 小时 ${minutes} 分`
    : minutes > 0
      ? `${minutes} 分 ${seconds} 秒`
      : `${seconds} 秒`;
}
