import type { AIWorkerStatus } from "../../api/aiJobs";

interface Props {
  gpuEnabled: boolean;
  disabled: boolean;
  saving: boolean;
  saveError: boolean;
  status?: AIWorkerStatus;
  statusLoading: boolean;
  onChange: (enabled: boolean) => void;
}

export default function ComputeHardwarePanel({
  gpuEnabled,
  disabled,
  saving,
  saveError,
  status,
  statusLoading,
  onChange,
}: Props) {
  const gpuReady = Boolean(
    status?.cudaAvailable && status.cudaExecutionProviderAvailable,
  );

  return (
    <section className="mt-4 rounded-xl border border-border bg-bg-elevated px-5 py-4 shadow-xs sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-label font-medium text-fg">硬件方案</h3>
          <p className="mt-1 max-w-3xl text-meta leading-relaxed text-fg-muted">
            {gpuEnabled
              ? "新建的向量、文字识别和人脸分析任务强制使用 NVIDIA GPU；GPU 不可用或推理失败时，任务会失败并记录原因，不会转用 CPU。已排队任务保留创建时的设备选择。照片元数据解析始终由 CPU 处理。"
              : "新建的向量、文字识别和人脸分析任务使用 CPU 推理。已排队任务保留创建时的设备选择；照片元数据解析始终由 CPU 处理。"}
          </p>
          <p className="mt-2 text-meta text-fg-subtle" role="status">
            {statusLoading
              ? "正在检查本机 GPU 运行环境…"
              : gpuReady
                ? `${status?.gpuName ?? "NVIDIA GPU"} · CUDA ${status?.cudaVersion ?? "可用"} · ONNX GPU 运行时可用`
                : status?.cudaAvailable
                  ? "已检测到 NVIDIA GPU；ONNX GPU 运行时未就绪，OCR 与人脸 GPU 任务将记录错误。"
                  : "未检测到可用的 NVIDIA CUDA 运行环境；GPU 模式下的模型任务会记录错误。"}
          </p>
          {saveError ? (
            <p role="alert" className="mt-2 text-meta text-danger">
              硬件方案保存失败，请重试。
            </p>
          ) : null}
        </div>
        <label
          className={`inline-flex shrink-0 items-center gap-3 rounded-lg border border-border-faint bg-bg-subtle px-4 py-3 text-label text-fg ${
            disabled || saving
              ? "cursor-not-allowed opacity-60"
              : "cursor-pointer"
          }`}
        >
          <input
            type="checkbox"
            className="size-4 accent-brand"
            checked={gpuEnabled}
            disabled={disabled || saving}
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
          <span>{saving ? "保存中…" : "强制使用 GPU"}</span>
        </label>
      </div>
    </section>
  );
}
