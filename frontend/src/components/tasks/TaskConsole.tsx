import { useEffect, useState } from "react";
import type {
  AIJob,
  AIJobModule,
  AIWorkerStatus,
  AnalysisMode,
  AnalysisType,
} from "../../api/aiJobs";
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
  modules: AIJobModule[];
  embeddingStatus?: AIWorkerStatus;
  embeddingStatusLoading: boolean;
  onStart: (type: AnalysisType, mode: AnalysisMode) => void;
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
  modules,
  embeddingStatus,
  embeddingStatusLoading,
  onStart,
  onAction,
}: Props) {
  const installedModules = modules.filter((module) => module.installed);
  const [selectedModule, setSelectedModule] =
    useState<AnalysisType>("metadata");
  useEffect(() => {
    if (!installedModules.some((module) => module.type === selectedModule)) {
      setSelectedModule(installedModules[0]?.type ?? "metadata");
    }
  }, [installedModules, selectedModule]);

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
    const isEmbedding = selectedModule === "embedding";
    const embeddingReady = Boolean(
      embeddingStatus?.runtimeReady && embeddingStatus.modelValid,
    );
    const selectedName =
      installedModules.find((module) => module.type === selectedModule)?.name ??
      "照片元数据";
    return (
      <div className="rounded-xl border border-border bg-bg-elevated px-5 py-6 shadow-xs sm:px-6">
        <div className="flex items-center gap-3">
          <TaskStatusDot status="idle" />
          <span className="text-label font-medium text-fg">队列空闲</span>
        </div>
        <p className="mt-3 max-w-2xl text-body leading-relaxed text-fg-muted">
          {isEmbedding
            ? "使用本机 Chinese-CLIP 为照片建立中文语义向量，可按描述搜索，也能按照片查找相似画面。向量只写入本机派生索引。"
            : "分析完全在本机运行：读取照片拍摄时间、相机信息与 GPS 坐标，结果只写进本机的派生缓存。"}
        </p>
        <label className="mt-5 flex flex-wrap items-center gap-3 text-meta text-fg-muted">
          <span>分析模块</span>
          <select
            aria-label="分析模块"
            value={selectedModule}
            disabled={busy || installedModules.length < 2}
            onChange={(event) =>
              setSelectedModule(event.target.value as AnalysisType)
            }
            className="rounded-md border border-border bg-bg-elevated px-3 py-2 text-body text-fg disabled:opacity-60"
          >
            {installedModules.map((module) => (
              <option key={module.type} value={module.type}>
                {module.name}
              </option>
            ))}
          </select>
          {isEmbedding && embeddingStatus?.gpuName ? (
            <span className="text-fg-subtle">{embeddingStatus.gpuName}</span>
          ) : null}
        </label>
        <EmbeddingRuntimeStatus
          status={embeddingStatus}
          loading={embeddingStatusLoading}
        />
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            className="btn btn-outline"
            disabled={busy || (isEmbedding && !embeddingReady)}
            onClick={() => onStart(selectedModule, "incremental")}
          >
            {isEmbedding ? "增量更新向量" : "增量分析"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || (isEmbedding && !embeddingReady)}
            onClick={() => onStart(selectedModule, "full")}
          >
            {isEmbedding ? "全量生成向量" : "全量分析"}
          </button>
        </div>
        <p className="mt-3 text-meta leading-relaxed text-fg-subtle">
          {isEmbedding
            ? `增量更新只处理新增、修改或模型版本变化的图片；全量会重新生成当前媒体库的${selectedName}结果。`
            : "增量只处理新增、修改或解析器更新的图片；全量重新解析当前媒体库的全部图片。"}
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
            {taskStatusLabel(active.status)} ·{" "}
            {jobModuleName(active.type, modules)}
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

function jobModuleName(type: AnalysisType, modules: AIJobModule[]): string {
  return modules.find((module) => module.type === type)?.name ?? type;
}

function EmbeddingRuntimeStatus({
  status,
  loading,
}: {
  status?: AIWorkerStatus;
  loading: boolean;
}) {
  if (loading) {
    return (
      <p className="mt-3 text-meta text-fg-subtle">正在读取本机 AI 状态…</p>
    );
  }
  if (!status) {
    return (
      <p role="status" className="mt-3 text-meta text-warning">
        本机 AI 状态暂不可读；元数据分析仍可使用。
      </p>
    );
  }
  const coverage =
    status.coverage.total > 0
      ? `${status.coverage.indexed.toLocaleString()} / ${status.coverage.total.toLocaleString()} 张已建向量`
      : "尚无可索引图片";
  return (
    <div className="mt-4 grid gap-2 rounded-lg border border-border-faint bg-bg-subtle px-4 py-3 text-meta sm:grid-cols-2">
      <p className="text-fg-muted">
        运行设备：
        <span className="text-fg">
          {status.device === "cuda"
            ? `${status.gpuName ?? "NVIDIA GPU"} · CUDA ${status.cudaVersion ?? "可用"}`
            : status.runtimeReady
              ? "CPU 回退"
              : "运行环境未就绪"}
        </span>
      </p>
      <p className="text-fg-muted">
        索引覆盖：<span className="text-fg tabular-nums">{coverage}</span>
      </p>
      <p className="text-fg-muted sm:col-span-2">
        模型：
        <span className="text-fg">
          {!status.runtimeReady
            ? "Python 运行环境未安装，请运行 backend/aiworker/setup.ps1。"
            : !status.modelAvailable || !status.modelValid
              ? "权重缺失或校验失败；请将官方 clip_cn_vit-b-16.pt 放入 cacheDir/derived/ai/models/。"
              : `${status.modelLoaded ? "已载入" : "已校验，首次推理时载入"} · ${status.modelVersion}`}
        </span>
      </p>
    </div>
  );
}
