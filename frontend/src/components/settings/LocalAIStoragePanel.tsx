import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { aiStorageApi, type AIStorageTask } from "../../api/aiStorage";
import { formatBytes } from "../../api/cache";

const PATH_LABELS = [
  ["workingDirectory", "服务工作目录"],
  ["configFile", "当前配置文件"],
  ["cacheRoot", "缓存根目录"],
  ["stateDirectory", "持久状态目录"],
  ["jobsFile", "任务状态文件"],
  ["metadataDirectory", "分析批次与结果缓存目录"],
  ["modelDirectory", "AI 模型目录"],
  ["vectorDirectory", "语义向量目录"],
  ["pythonEnvironment", "本机 Python 环境目录"],
  ["pythonExecutable", "实际 Python 启动器"],
] as const;

const TASK_LABELS: Record<AIStorageTask["type"], string> = {
  metadata: "照片元数据",
  embedding: "向量索引",
  ocr: "文字识别",
  face: "人脸识别",
};

export default function LocalAIStoragePanel() {
  const query = useQuery({
    queryKey: ["ai-storage"],
    queryFn: aiStorageApi.get,
    staleTime: 15_000,
  });
  const storage = query.data?.storage;

  useEffect(() => {
    if (window.location.hash !== "#ai-storage") return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("ai-storage")?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <section id="ai-storage" className="mt-8 scroll-mt-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="page-eyebrow">本机 AI 与存储</p>
          <h2 className="section-title">模型与缓存路径</h2>
          <p className="mt-2 text-meta text-fg-muted">
            路径来自当前运行配置；占用量按本机实际文件统计。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? "正在刷新…" : "刷新占用"}
        </button>
      </div>

      {query.isLoading ? (
        <div
          role="status"
          className="rounded-xl border border-border bg-bg-elevated p-5 text-body text-fg-muted"
        >
          正在读取本机模型与缓存信息…
        </div>
      ) : query.isError ? (
        <div
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger/5 p-5 text-body text-fg-muted"
        >
          本机存储信息读取失败。此接口只允许从运行服务的本机浏览器访问，请重试或检查后端状态。
        </div>
      ) : storage ? (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard
              label="模型文件"
              value={formatBytes(storage.summary.modelBytes)}
              detail="Chinese-CLIP、RapidOCR、YuNet/SFace；元数据无需权重"
            />
            <SummaryCard
              label="分析结果缓存"
              value={formatBytes(storage.summary.metadataBytes)}
              detail={`${storage.summary.metadataFileCount.toLocaleString()} 个元数据、OCR、人脸与向量任务批次文件`}
            />
            <SummaryCard
              label="语义向量索引"
              value={formatBytes(storage.summary.vectorBytes)}
              detail={`${storage.summary.vectorFileCount.toLocaleString()} 个文件`}
            />
          </div>

          <div className="rounded-xl border border-border bg-bg-elevated p-5 shadow-xs sm:p-6">
            <h3 className="text-label font-medium text-fg">当前生效路径</h3>
            <dl className="mt-4 grid gap-x-8 sm:grid-cols-2">
              {PATH_LABELS.map(([key, label]) => (
                <PathEntry key={key} label={label} path={storage.paths[key]} />
              ))}
            </dl>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {storage.tasks.map((task) => (
              <TaskStorageCard key={task.type} task={task} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SummaryCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-bg-elevated p-4 shadow-xs">
      <div className="text-meta text-fg-muted">{label}</div>
      <div className="mt-1 font-mono text-page-sm font-medium tabular-nums text-fg">
        {value}
      </div>
      <div className="mt-1 text-meta text-fg-subtle">{detail}</div>
    </div>
  );
}

function PathEntry({ label, path }: { label: string; path: string }) {
  return (
    <div className="min-w-0 border-t border-border-faint py-3 first:border-0 sm:[&:nth-child(2)]:border-0">
      <dt className="text-meta text-fg-subtle">{label}</dt>
      <dd className="mt-1 break-all font-mono text-meta leading-relaxed text-fg">
        {path || "未配置"}
      </dd>
    </div>
  );
}

function TaskStorageCard({ task }: { task: AIStorageTask }) {
  return (
    <article className="min-w-0 rounded-xl border border-border bg-bg-elevated p-5 shadow-xs sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-label font-medium text-fg">
          {TASK_LABELS[task.type]}
        </h3>
        <span className="font-mono text-meta tabular-nums text-fg-muted">
          模型 {formatBytes(task.modelBytes)} · 结果{" "}
          {formatBytes(task.results.bytes)}
        </span>
      </div>

      <div className="mt-4">
        <h4 className="text-meta font-medium text-fg-muted">模型文件</h4>
        {task.modelFiles.length > 0 ? (
          <ul className="mt-2 space-y-3">
            {task.modelFiles.map((file) => (
              <li key={file.path} className="min-w-0">
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-meta">
                  <span className="text-fg">{file.name}</span>
                  <span className="font-mono tabular-nums text-fg-muted">
                    {file.exists ? formatBytes(file.sizeBytes) : "未找到"}
                  </span>
                </div>
                <p className="mt-1 break-all font-mono text-meta leading-relaxed text-fg-subtle">
                  {file.path}
                </p>
              </li>
            ))}
          </ul>
        ) : task.type === "metadata" ? (
          <p className="mt-2 text-meta leading-relaxed text-fg-subtle">
            使用 Go 内置 EXIF/GPS 解析器，无需额外模型文件。
          </p>
        ) : (
          <div className="mt-2">
            {task.modelDirectory ? (
              <p className="break-all font-mono text-meta leading-relaxed text-fg-subtle">
                {task.modelDirectory}
              </p>
            ) : null}
            <p className="mt-1 text-meta text-warning">未发现模型文件</p>
          </div>
        )}
      </div>

      <div className="mt-4 border-t border-border-faint pt-4">
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
          <h4 className="text-meta font-medium text-fg-muted">
            该模块的分析结果缓存
          </h4>
          <span className="font-mono text-meta tabular-nums text-fg-muted">
            {formatBytes(task.results.bytes)} ·{" "}
            {task.results.fileCount.toLocaleString()} 个文件
          </span>
        </div>
        <p className="mt-2 break-all font-mono text-meta leading-relaxed text-fg-subtle">
          {task.results.path}
        </p>
      </div>
    </article>
  );
}
