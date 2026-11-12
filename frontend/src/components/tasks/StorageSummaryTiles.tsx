import { formatBytes } from "../../api/cache";

export interface StorageSummaryTilesProps {
  /** 媒体派生缓存（缩略图 / 预览图 / 转换图 / 视频产物）的占用。 */
  mediaBytes: number;
  mediaFileCount: number;
  /** AI 分析产物（各模块批次结果与索引）的占用。 */
  outputBytes: number;
  outputFileCount: number;
  /** 模型权重文件的占用。 */
  modelBytes: number;
  modelFileCount: number;
}

interface Tile {
  label: string;
  value: string;
  detail: string;
}

/**
 * 本机存储的四张汇总卡：合计、媒体派生缓存、AI 分析产物、AI 模型权重。
 *
 * 合计只把「可回收的」三块加起来，不含 derived/ 下少量其它派生文件
 * （媒体尺寸缓存之类），所以数字比磁盘实际占用略小 —— 脚注里说明这一点，
 * 免得用户拿两边的数对不上。
 */
export default function StorageSummaryTiles({
  mediaBytes,
  mediaFileCount,
  outputBytes,
  outputFileCount,
  modelBytes,
  modelFileCount,
}: StorageSummaryTilesProps) {
  const totalBytes = mediaBytes + outputBytes + modelBytes;
  const totalFiles = mediaFileCount + outputFileCount + modelFileCount;
  const tiles: Tile[] = [
    {
      label: "合计",
      value: formatBytes(totalBytes),
      detail: `${totalFiles.toLocaleString()} 个文件`,
    },
    {
      label: "媒体派生缓存",
      value: formatBytes(mediaBytes),
      detail: `${mediaFileCount.toLocaleString()} 个文件`,
    },
    {
      label: "AI 分析产物",
      value: formatBytes(outputBytes),
      detail: `${outputFileCount.toLocaleString()} 个文件`,
    },
    {
      label: "AI 模型权重",
      value: formatBytes(modelBytes),
      detail: `${modelFileCount} 个权重文件`,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="rounded-xl border border-border bg-bg-elevated p-4 shadow-xs"
        >
          <div className="text-meta text-fg-muted">{tile.label}</div>
          <div className="mt-1 font-mono text-section font-medium tabular-nums text-fg">
            {tile.value}
          </div>
          <div className="mt-1 text-meta text-fg-subtle">{tile.detail}</div>
        </div>
      ))}
    </div>
  );
}
