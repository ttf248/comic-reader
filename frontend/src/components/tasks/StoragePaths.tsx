import { ApiError } from "../../api/client";
import type {
  StorageAbsolutePaths,
  StorageRelativePaths,
} from "../../api/storage";

interface Props {
  relative?: StorageRelativePaths;
  absolute?: StorageAbsolutePaths;
  /** 绝对路径读取失败时的原因。 */
  absoluteError?: unknown;
  onRetryAbsolute?: () => void;
}

/**
 * 路径：相对缓存根目录的路径人人可见，绝对路径只在本机浏览器显示。
 *
 * 局域网客户端拿绝对路径接口会得到 403，那是预期结果而不是故障 ——
 * 所以这里给一行中性说明，不报红。
 */
export default function StoragePaths({
  relative,
  absolute,
  absoluteError,
  onRetryAbsolute,
}: Props) {
  const localOnly =
    absoluteError instanceof ApiError &&
    absoluteError.code === "local_access_required";

  return (
    <section className="rounded-xl border border-border bg-bg-elevated shadow-xs">
      <div className="border-b border-border-faint px-5 py-4 sm:px-6">
        <h3 className="text-label font-medium text-fg">路径</h3>
        <p className="mt-1 text-meta text-fg-subtle">
          相对路径对所有设备可见；完整路径只在运行服务的这台计算机上显示。
        </p>
      </div>

      <div className="px-5 py-4 sm:px-6">
        {relative ? (
          <dl className="grid gap-x-8 sm:grid-cols-2">
            <PathEntry label="状态目录" path={relative.stateDirectory} />
            <PathEntry label="任务状态文件" path={relative.jobsFile} />
            <PathEntry label="分析批次目录" path={relative.metadataDirectory} />
            <PathEntry label="AI 派生目录" path={relative.aiDerivedDirectory} />
            <PathEntry label="向量目录" path={relative.vectorDirectory} />
            <PathEntry label="模型目录" path={relative.modelDirectory} />
          </dl>
        ) : null}

        <div className="mt-5 border-t border-border-faint pt-4">
          <h4 className="text-meta font-medium text-fg-muted">
            本机绝对路径
          </h4>
          {absolute ? (
            <dl className="mt-3 grid gap-x-8 sm:grid-cols-2">
              <PathEntry label="缓存根目录" path={absolute.cacheRoot} />
              <PathEntry label="工作目录" path={absolute.workingDirectory} />
              <PathEntry label="配置文件" path={absolute.configFile} />
              <PathEntry label="状态目录" path={absolute.stateDirectory} />
              <PathEntry label="任务状态文件" path={absolute.jobsFile} />
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
    </section>
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
