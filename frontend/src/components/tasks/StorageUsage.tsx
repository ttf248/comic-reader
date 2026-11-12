import { formatBytes } from "../../api/cache";
import { RefreshIcon } from "../common/Icon";

export interface StorageUsageProps {
  /** 媒体派生缓存（缩略图 / 预览图 / 转换图 / 视频产物）。 */
  mediaBytes: number;
  mediaFileCount: number;
  /** AI 分析产物（各模块批次结果与索引）。 */
  outputBytes: number;
  outputFileCount: number;
  /** 模型权重文件。 */
  modelBytes: number;
  modelFileCount: number;
  onRefresh?: () => void;
  refreshing?: boolean;
}

interface Segment {
  label: string;
  bytes: number;
  count: string;
  /** 无彩灰阶的三档深浅 —— 外壳不做彩色，照片才是唯一的彩色。 */
  shade: string;
}

/**
 * 占用概览：一个总数、一条堆叠条、三行分类。
 *
 * 之前是四张等大的数字卡，四张卡并排却分不出主次，用户得自己算哪个大。
 * 堆叠条一眼看出大头，分类行给出具体数字。
 *
 * 分类是竖着排的：名字一行、数字一行。横排时名字和数字会被拉到一屏
 * 的两头，宽屏上更是隔着一整块空白，谁对不上号全靠猜。
 */
export default function StorageUsage({
  mediaBytes,
  mediaFileCount,
  outputBytes,
  outputFileCount,
  modelBytes,
  modelFileCount,
  onRefresh,
  refreshing = false,
}: StorageUsageProps) {
  const totalBytes = mediaBytes + outputBytes + modelBytes;
  const totalFiles = mediaFileCount + outputFileCount + modelFileCount;
  const segments: Segment[] = [
    {
      label: "媒体派生缓存",
      bytes: mediaBytes,
      count: `${mediaFileCount.toLocaleString()} 个文件`,
      shade: "bg-fg/70",
    },
    {
      label: "AI 分析产物",
      bytes: outputBytes,
      count: `${outputFileCount.toLocaleString()} 个文件`,
      shade: "bg-fg/45",
    },
    {
      label: "AI 模型权重",
      bytes: modelBytes,
      count: `${modelFileCount} 个权重文件`,
      shade: "bg-fg/25",
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-faint px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-section font-medium tabular-nums text-fg">
            {formatBytes(totalBytes)}
          </span>
          <span className="text-meta tabular-nums text-fg-subtle">
            合计 · {totalFiles.toLocaleString()} 个文件
          </span>
        </div>
        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border-faint px-2.5 text-meta text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg disabled:opacity-50"
            title="重新扫描磁盘计算占用"
          >
            {refreshing ? (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-fg-muted border-t-transparent" />
            ) : (
              <RefreshIcon size={11} />
            )}
            <span>刷新占用</span>
          </button>
        ) : null}
      </div>

      <div className="px-4 py-3">
        <div
          className="flex h-1.5 overflow-hidden rounded-full bg-bg-subtle"
          role="img"
          aria-label={segments
            .map((segment) => `${segment.label} ${formatBytes(segment.bytes)}`)
            .join("，")}
        >
          {segments.map((segment) => (
            <div
              key={segment.label}
              className={segment.shade}
              style={{
                width: `${totalBytes > 0 ? (segment.bytes / totalBytes) * 100 : 0}%`,
              }}
            />
          ))}
        </div>

        <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-3">
          {segments.map((segment) => (
            <div key={segment.label}>
              <dt className="flex items-center gap-2 text-meta text-fg-muted">
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 shrink-0 rounded-full ${segment.shade}`}
                />
                {segment.label}
              </dt>
              <dd className="mt-1 flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-label tabular-nums text-fg">
                  {formatBytes(segment.bytes)}
                </span>
                <span className="text-meta tabular-nums text-fg-subtle">
                  {segment.count}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
