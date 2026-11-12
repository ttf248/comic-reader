import { formatBytes } from "../../api/cache";
import type { StorageModule } from "../../api/storage";

interface Props {
  modules: StorageModule[];
}

/**
 * AI 模型与产物：每个分析模块一张卡。
 *
 * 卡片回答两个问题 —— 这个模块用哪个模型、模型多大；它跑完留下什么、
 * 落在哪、占多少。模型文件缺失时写「未找到」而不是把条目藏起来，
 * 用户要知道自己少装了什么。
 */
export default function StorageModuleGrid({ modules }: Props) {
  if (modules.length === 0) return null;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {modules.map((module) => (
        <article
          key={module.type}
          className="min-w-0 rounded-xl border border-border bg-bg-elevated p-5 shadow-xs sm:p-6"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-label font-medium text-fg">{module.name}</h3>
            <span className="font-mono text-meta tabular-nums text-fg-muted">
              模型 {formatBytes(module.modelBytes)} · 产物{" "}
              {formatBytes(module.outputBytes)}
            </span>
          </div>

          <div className="mt-4">
            <h4 className="text-meta font-medium text-fg-muted">模型文件</h4>
            {module.modelFiles.length > 0 ? (
              <ul className="mt-2 space-y-3">
                {module.modelFiles.map((file) => (
                  <li key={`${file.location}:${file.path}`} className="min-w-0">
                    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-meta">
                      <span className="text-fg">{file.name}</span>
                      <span className="font-mono tabular-nums text-fg-muted">
                        {file.exists ? formatBytes(file.sizeBytes) : "未找到"}
                      </span>
                    </div>
                    <p className="mt-1 break-all font-mono text-meta leading-relaxed text-fg-subtle">
                      {file.path}
                    </p>
                    {file.location === "python" ? (
                      <p className="mt-0.5 text-meta text-fg-subtle">
                        位于 Python 环境内，路径相对该环境
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : module.modelLocation === "none" ? (
              <p className="mt-2 text-meta leading-relaxed text-fg-subtle">
                使用 Go 内置 EXIF/GPS 解析器，无需额外模型文件。
              </p>
            ) : (
              <div className="mt-2">
                {module.modelDirectory ? (
                  <p className="break-all font-mono text-meta leading-relaxed text-fg-subtle">
                    {module.modelDirectory}
                  </p>
                ) : null}
                <p className="mt-1 text-meta text-warning">未发现模型文件</p>
              </div>
            )}
          </div>

          <div className="mt-4 border-t border-border-faint pt-4">
            <h4 className="text-meta font-medium text-fg-muted">分析产物</h4>
            <ul className="mt-2 space-y-3">
              {module.outputs.map((output) => (
                <li key={`${output.kind}:${output.path}`} className="min-w-0">
                  <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-meta">
                    <span className="text-fg">{output.label}</span>
                    <span className="font-mono tabular-nums text-fg-muted">
                      {output.available
                        ? `${formatBytes(output.bytes)} · ${output.fileCount.toLocaleString()} 个文件`
                        : "尚未产生"}
                    </span>
                  </div>
                  <p className="mt-1 break-all font-mono text-meta leading-relaxed text-fg-subtle">
                    {output.path}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </article>
      ))}
    </div>
  );
}
