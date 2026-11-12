import { formatBytes } from "../../api/cache";

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
 */
export default function StorageUsage({
  mediaBytes,
  mediaFileCount,
  outputBytes,
  outputFileCount,
  modelBytes,
  modelFileCount,
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
    <div className="rounded-xl border border-border bg-bg-elevated p-4 shadow-xs">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-section font-medium tabular-nums text-fg">
          {formatBytes(totalBytes)}
        </span>
        <span className="text-meta tabular-nums text-fg-subtle">
          合计 · {totalFiles.toLocaleString()} 个文件
        </span>
      </div>

      <div
        className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-bg-subtle"
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

      <dl className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-3">
        {segments.map((segment) => (
          <div
            key={segment.label}
            className="flex items-baseline justify-between gap-3"
          >
            <dt className="flex items-center gap-2 text-meta text-fg-muted">
              <span
                aria-hidden="true"
                className={`h-2 w-2 shrink-0 rounded-full ${segment.shade}`}
              />
              {segment.label}
            </dt>
            <dd className="flex items-baseline gap-2 text-meta">
              <span className="font-mono tabular-nums text-fg">
                {formatBytes(segment.bytes)}
              </span>
              <span className="tabular-nums text-fg-subtle">{segment.count}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
