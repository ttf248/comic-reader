import type {
  AIJob,
  AIJobEstimate,
  AIJobModule,
  AIWorkerStatus,
  AnalysisMode,
  AnalysisType,
} from "../../api/aiJobs";
import type { JobAction, TaskCenterSelection } from "../../hooks/useTaskCenter";
import { formatDateTime } from "../../utils/date";
import {
  formatCount,
  formatEstimateDuration,
  formatTaskDuration,
  formatTaskSpeed,
  jobProgressPercent,
  taskModeLabel,
  taskStageLabel,
  taskStatusLabel,
} from "../../utils/taskFormat";
import ModuleChips from "./ModuleChips";
import Segmented from "../common/Segmented";
import TaskEstimatePanel from "./TaskEstimatePanel";
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
  peopleEnabled: boolean;
  /** 队列里等待的任务数；为空时是真正的空闲。 */
  queuedCount: number;
  embeddingStatus?: AIWorkerStatus;
  embeddingStatusLoading: boolean;
  /** 选中的模块与处理方式。 */
  selection: TaskCenterSelection;
  /** 空闲时的规模与耗时核算。 */
  estimate?: AIJobEstimate;
  estimateLoading: boolean;
  estimateError: boolean;
  onStart: (type: AnalysisType, mode: AnalysisMode) => void;
  onStartAll: (mode: AnalysisMode) => void;
  onAction: (id: string, action: JobAction) => void;
  onRefreshEstimate: () => void;
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
  peopleEnabled,
  queuedCount,
  embeddingStatus,
  embeddingStatusLoading,
  selection,
  estimate,
  estimateLoading,
  estimateError,
  onStart,
  onStartAll,
  onAction,
  onRefreshEstimate,
}: Props) {
  const { module: selectedModule, mode } = selection;
  const installedModules = modules.filter((module) => module.installed);

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
    const selectedModuleVersion =
      installedModules.find((module) => module.type === selectedModule)
        ?.version ?? "";
    const canStart =
      !busy &&
      !(isEmbedding && !embeddingReady) &&
      !(selectedModule === "face" && !peopleEnabled);
    // 这次要干的活：选中模块在当前模式下的张数，以及按序启动全部的合计。
    const estimateEntry = estimate?.modules.find(
      (item) => item.type === selectedModule,
    );
    const currentEstimate =
      estimateEntry && estimateEntry.available
        ? mode === "incremental"
          ? estimateEntry.incremental
          : estimateEntry.full
        : null;
    const sequence = estimate ? estimate.sequence[mode] : null;
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-faint px-5 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <TaskStatusDot status={queuedCount > 0 ? "pending" : "idle"} />
            <span className="text-label font-medium text-fg">
              {queuedCount > 0 ? `队列等待中 · ${queuedCount} 项` : "队列空闲"}
            </span>
          </div>
          {lastJob ? (
            <span className="text-meta text-fg-subtle">
              上次运行 {formatDateTime(lastJob.createdAt)} ·{" "}
              {taskModeLabel(lastJob.mode)} · 完成{" "}
              {formatCount(lastJob.completed ?? lastJob.processed)} 张
            </span>
          ) : null}
        </div>

        <div className="border-b border-border-faint px-5 py-4 sm:px-6">
          <TaskEstimatePanel
            estimate={estimate}
            loading={estimateLoading}
            error={estimateError}
            module={selectedModule}
            mode={mode}
            onRefresh={onRefreshEstimate}
          />
        </div>

        <div className="grid gap-5 px-5 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-10">
          <div className="min-w-0">
            <p className="max-w-2xl text-body leading-relaxed text-fg-muted">
              {moduleDescription(selectedModule)}
            </p>

            <div className="mt-5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-meta text-fg-subtle">分析模块</p>
                {selectedModuleVersion ? (
                  <p className="break-all font-mono text-meta text-fg-subtle">
                    {selectedModuleVersion}
                  </p>
                ) : null}
              </div>
              <div className="mt-2">
                <ModuleChips
                  modules={modules}
                  selected={[selectedModule]}
                  onToggle={(type) => selection.setModule(type)}
                  disabled={busy}
                  locked={peopleEnabled ? [] : ["face"]}
                />
              </div>
            </div>

            <p className="mt-4 text-meta text-fg-subtle">
              {modeHint(selectedModule, mode, selectedName)}
            </p>

            {isEmbedding ? (
              <EmbeddingRuntimeStatus
                status={embeddingStatus}
                loading={embeddingStatusLoading}
              />
            ) : selectedModule === "ocr" || selectedModule === "face" ? (
              <ImageModuleRuntimeStatus
                moduleType={selectedModule}
                status={embeddingStatus}
                loading={embeddingStatusLoading}
              />
            ) : null}
          </div>

          <div className="flex flex-wrap items-start gap-x-4 gap-y-3 lg:justify-end lg:border-l lg:border-border-faint lg:pl-10">
            <Segmented
              label="处理方式"
              value={mode}
              onChange={selection.setMode}
              disabled={busy}
              options={[
                { value: "incremental", label: "增量" },
                { value: "full", label: "全量" },
              ]}
            />
            <div className="flex flex-col items-start gap-1">
              <button
                type="button"
                className="btn btn-primary"
                disabled={canStart === false}
                onClick={() => onStart(selectedModule, mode)}
              >
                开始分析
                {currentEstimate
                  ? ` · ${formatCount(currentEstimate.count)} 张`
                  : ""}
              </button>
              {currentEstimate ? (
                <span className="text-meta text-fg-subtle">
                  {formatEstimateDuration(currentEstimate.estimatedDurationMs)}
                </span>
              ) : null}
            </div>
            <div className="flex flex-col items-start gap-1">
              <button
                type="button"
                className="btn btn-outline"
                disabled={busy || installedModules.length === 0}
                onClick={() => onStartAll(mode)}
              >
                按序启动全部任务
              </button>
              {sequence && sequence.modules.length > 0 ? (
                <>
                  <span className="text-meta text-fg-subtle">
                    {`${sequence.modules.length} 个模块 · ${formatCount(sequence.count)} 张`}
                  </span>
                  <span className="text-meta text-fg-subtle">
                    {formatEstimateDuration(sequence.estimatedDurationMs)}
                  </span>
                </>
              ) : null}
            </div>
          </div>
        </div>
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
    <div className="overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-border-faint px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <TaskStatusDot status={active.status} />
          <span className="text-label font-medium text-fg">
            {taskStatusLabel(active.status)} ·{" "}
            {jobModuleName(active.type, modules)}
          </span>
          <span className="text-meta text-fg-muted">
            {taskStageLabel(active.stage)}
          </span>
          <span className="text-meta text-fg-muted">
            设备：{active.computeDevice === "gpu" ? "NVIDIA GPU" : "CPU"}
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

function moduleDescription(type: AnalysisType): string {
  switch (type) {
    case "embedding":
      return "用本机 Chinese-CLIP 为照片建立中文语义向量，可按描述搜索，也能按照片查找相似画面。";
    case "ocr":
      return "用本机 OCR 识别照片中的文字，结果可在图片详情中查看。";
    case "face":
      return "检测照片中的人脸并生成本机特征向量，可查找相似人脸；不会推断或标注真实姓名。";
    default:
      return "读取照片拍摄时间、相机信息与 GPS 坐标，结果只写进本机的派生缓存。";
  }
}

/** 一句话说明这次会处理多少 —— 不另起一段解释文字。 */
function modeHint(
  type: AnalysisType,
  mode: AnalysisMode,
  moduleName: string,
): string {
  if (mode === "full") {
    return type === "metadata"
      ? "重新解析当前媒体库的全部图片"
      : `重新运行${moduleName}分析`;
  }
  return type === "metadata"
    ? "只处理新增、修改或解析器更新的图片"
    : "只处理新增或变更的图片";
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
        本机语义模型状态暂不可读，请检查 AI Worker 运行环境。
      </p>
    );
  }
  const coverage =
    status.coverage.total > 0
      ? `${status.coverage.indexed.toLocaleString()} / ${status.coverage.total.toLocaleString()} 张已建向量`
      : "尚无可索引图片";
  return (
    <div className="mt-3 grid gap-2 rounded-lg border border-border-faint bg-bg-subtle px-4 py-3 text-meta sm:grid-cols-2">
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

function ImageModuleRuntimeStatus({
  moduleType,
  status,
  loading,
}: {
  moduleType: "ocr" | "face";
  status?: AIWorkerStatus;
  loading: boolean;
}) {
  const label = moduleType === "ocr" ? "文字识别" : "人脸识别";
  if (loading) {
    return (
      <p className="mt-3 text-meta text-fg-subtle">正在检查{label}运行环境…</p>
    );
  }
  if (!status) {
    return (
      <p role="status" className="mt-3 text-meta text-warning">
        本机 AI 状态暂不可读，无法确认{label}环境。
      </p>
    );
  }
  const module = status.modules?.[moduleType];
  if (module?.ready) {
    return (
      <p role="status" className="mt-3 text-meta text-success">
        {label}已就绪 · {module.version}
      </p>
    );
  }
  return (
    <p role="status" className="mt-3 text-meta text-warning">
      {moduleUnavailableMessage(module?.error)}
    </p>
  );
}

function moduleUnavailableMessage(code?: string): string {
  switch (code) {
    case "python_runtime_unavailable":
      return "Python 3.11 环境不可用，请运行 backend/aiworker/setup.ps1。";
    case "ocr_dependencies_missing":
      return "OCR 依赖未安装，请运行 backend/aiworker/setup.ps1 并重启应用。";
    case "ocr_dependency_version_mismatch":
      return "OCR 依赖版本不匹配，请重新运行 backend/aiworker/setup.ps1。";
    case "ocr_model_load_failed":
      return "OCR 模型加载失败，请重新运行安装脚本并查看终端错误。";
    case "face_dependencies_missing":
      return "人脸识别依赖未安装，请运行 backend/aiworker/setup.ps1。";
    case "face_model_missing_or_checksum_invalid":
      return "人脸权重缺失或校验失败，请运行 backend/aiworker/download-model.ps1。";
    case "face_model_load_failed":
      return "人脸模型加载失败，请运行 backend/aiworker/setup.ps1 并重启应用。";
    default:
      return "本机识别运行环境未就绪，请运行 backend/aiworker/setup.ps1 并重启应用。";
  }
}
