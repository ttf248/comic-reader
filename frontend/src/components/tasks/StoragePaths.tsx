import { ApiError } from "../../api/client";
import type {
  StorageAbsolutePaths,
  StorageModule,
  StorageRelativePaths,
} from "../../api/storage";

interface Props {
  relative?: StorageRelativePaths;
  /** 各分析模块的模型文件，用来给出相对路径。 */
  modules?: StorageModule[];
  absolute?: StorageAbsolutePaths;
  /** 绝对路径读取失败时的原因。 */
  absoluteError?: unknown;
  onRetryAbsolute?: () => void;
}

/**
 * 路径：相对缓存根目录的路径人人可见，绝对路径只在本机浏览器显示。
 *
 * 默认收起。路径是排查问题时的备查信息，不是每次都要看的东西 ——
 * 摊开十几行绝对路径会把这一段变成一堵墙。
 */
export default function StoragePaths({
  relative,
  modules,
  absolute,
  absoluteError,
  onRetryAbsolute,
}: Props) {
  const localOnly =
    absoluteError instanceof ApiError &&
    absoluteError.code === "local_access_required";

  return (
    <details className="group rounded-xl border border-border bg-bg-elevated shadow-xs">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-label font-medium text-fg transition-colors hover:bg-bg-subtle/60 [&::-webkit-details-marker]:hidden">
        <span>路径</span>
        <span className="text-meta font-normal text-fg-subtle group-open:hidden">
          相对缓存根目录 · 展开查看
        </span>
      </summary>

      <div className="border-t border-border-faint px-4 py-3">
        {relative ? (
          <dl className="grid gap-x-6 sm:grid-cols-2">
            <PathEntry label="状态目录" path={relative.stateDirectory} />
            <PathEntry label="任务状态文件" path={relative.jobsFile} />
            <PathEntry label="分析批次目录" path={relative.metadataDirectory} />
            <PathEntry label="AI 派生目录" path={relative.aiDerivedDirectory} />
            <PathEntry label="向量目录" path={relative.vectorDirectory} />
            <PathEntry label="模型目录" path={relative.modelDirectory} />
            {modules?.flatMap((module) =>
              module.modelFiles.map((file) => (
                <PathEntry
                  key={`${module.type}:${file.path}`}
                  label={`${module.name} · ${file.name}`}
                  path={file.path}
                />
              )),
            )}
          </dl>
        ) : null}

        <div className="mt-4 border-t border-border-faint pt-3">
          <h4 className="text-meta font-medium text-fg-muted">
            本机绝对路径
          </h4>
          {absolute ? (
            <dl className="mt-2 grid gap-x-6 sm:grid-cols-2">
              <PathEntry label="缓存根目录" path={absolute.cacheRoot} />
              <PathEntry label="工作目录" path={absolute.workingDirectory} />
              <PathEntry label="配置文件" path={absolute.configFile} />
              <PathEntry label="Python 环境" path={absolute.pythonEnvironment} />
              <PathEntry
                label="Python 启动器"
                path={absolute.pythonExecutable}
              />
              {absolute.modules.flatMap((module) =>
                module.modelFiles.map((file) => (
                  <PathEntry
                    key={`${module.type}:${file.path}`}
                    label={`${module.name} · ${file.name}`}
                    path={file.path}
                  />
                )),
              )}
            </dl>
          ) : localOnly ? (
            <p className="mt-2 text-meta leading-relaxed text-fg-subtle">
              完整路径只在运行服务的计算机上显示；此处列出的是相对缓存根目录的路径。
            </p>
          ) : absoluteError ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-meta text-fg-subtle">
              <span>本机绝对路径读取失败。</span>
              {onRetryAbsolute ? (
                <button
                  type="button"
                  className="inline-flex h-7 items-center rounded-md border border-border-faint px-2.5 text-meta text-fg-muted transition-colors hover:bg-bg-subtle"
                  onClick={onRetryAbsolute}
                >
                  重试
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </details>
  );
}

function PathEntry({ label, path }: { label: string; path: string }) {
  return (
    <div className="min-w-0 border-t border-border-faint py-2 first:border-0">
      <dt className="text-meta text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 break-all font-mono text-meta leading-relaxed text-fg">
        {path || "未配置"}
      </dd>
    </div>
  );
}
