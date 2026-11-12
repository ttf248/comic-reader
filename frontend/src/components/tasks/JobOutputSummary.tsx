import { formatBytes } from "../../api/cache";
import { useJobOutput } from "../../hooks/useStorage";

interface Props {
  jobId: string;
  /** 只有展开时才拉取；折叠状态下一个请求都不发。 */
  enabled: boolean;
}

/**
 * 一条任务记录自己的产物：这次任务的结果落在哪、占了多少。
 *
 * 批次目录被清理过是正常状态（清人物分析会整目录删掉），所以「目录不
 * 存在」用灰字说明，不报红。
 */
export default function JobOutputSummary({ jobId, enabled }: Props) {
  const query = useJobOutput(jobId, enabled);

  if (!enabled) return null;

  if (query.isLoading) {
    return (
      <p className="mt-4 text-meta text-fg-subtle">读取产物信息…</p>
    );
  }

  if (query.isError) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-3 text-meta text-fg-subtle">
        <span>产物信息读取失败。</span>
        <button
          type="button"
          className="inline-flex h-7 items-center rounded-md border border-border-faint px-2.5 text-meta text-fg-muted transition-colors hover:bg-bg-subtle"
          onClick={() => void query.refetch()}
        >
          重试
        </button>
      </div>
    );
  }

  const output = query.data;
  if (!output) return null;

  return (
    <div className="mt-4">
      <p className="text-meta font-medium text-fg">本次产物</p>
      <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-meta">
        <span className="text-fg-muted">
          {output.available
            ? `${formatBytes(output.bytes)} · ${output.fileCount.toLocaleString()} 个批次文件`
            : "产物目录不存在（可能已被清理）"}
        </span>
        <span className="font-mono tabular-nums text-fg-subtle">
          每批 {output.batchSize} 张
        </span>
      </div>
      <p className="mt-1 break-all font-mono text-meta leading-relaxed text-fg-subtle">
        {output.path}
      </p>
    </div>
  );
}
