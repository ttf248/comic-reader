import { formatBytes } from "../../api/cache";
import type { StorageModule } from "../../api/storage";

interface Props {
  modules: StorageModule[];
}

/**
 * AI 模型与产物：每个分析模块一块。
 *
 * 之前每个模块是一张满宽大卡，模型文件路径、产物路径各占一行，四个模块
 * 就是一千多像素的滚动条。这里压成三行：模块名与两个数字一行、模型文件
 * 一行、产物路径一行 —— 要查的细节还在，但不占版面。
 *
 * 侧栏只有 360 像素，文件名再长也不断词：超出的部分用省略号收掉，
 * 完整内容留在 title 里，断词断在 "onnx" 中间比省略号更难读。
 */
export default function StorageModuleGrid({ modules }: Props) {
  if (modules.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-xs">
      <h3 className="border-b border-border-faint px-4 py-3 text-label font-medium text-fg">
        AI 模型与产物
      </h3>
      <ul className="divide-y divide-border-faint">
        {modules.map((module) => {
          const modelNames = module.modelFiles
            .map((file) => file.name)
            .join("、");
          const outputPaths = module.outputs
            .map((output) => output.path)
            .join("、");
          return (
            <li key={module.type} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-label font-medium text-fg">{module.name}</span>
                <span className="font-mono text-meta tabular-nums text-fg-muted">
                  模型 {formatBytes(module.modelBytes)} · 产物{" "}
                  {formatBytes(module.outputBytes)}
                </span>
              </div>

              {module.modelFiles.length > 0 ? (
                <p
                  className="mt-1 truncate font-mono text-meta text-fg-subtle"
                  title={
                    module.modelLocation === "python"
                      ? `${modelNames}（位于 Python 环境内）`
                      : modelNames
                  }
                >
                  {modelNames}
                  {module.modelLocation === "python" ? "（位于 Python 环境内）" : ""}
                </p>
              ) : module.modelLocation === "none" ? (
                <p className="mt-1 text-meta text-fg-subtle">
                  使用 Go 内置 EXIF/GPS 解析器，无需权重。
                </p>
              ) : (
                <p className="mt-1 text-meta text-warning">未发现模型文件</p>
              )}

              <p
                className="mt-1 truncate font-mono text-meta text-fg-subtle"
                title={outputPaths}
              >
                {outputPaths}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
