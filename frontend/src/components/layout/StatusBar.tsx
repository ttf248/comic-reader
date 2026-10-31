import { useEffect, useState } from "react";
import { useScanSSE } from "../../hooks/useScanSSE";
import { useSearchStore } from "../../store/searchStore";
import { useLibraryManifest } from "../../hooks/useLibrary";

export default function StatusBar() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const manifest = useLibraryManifest().data?.manifest;
  const sse = useScanSSE();
  const query = useSearchStore((s) => s.query);
  const sortBy = useSearchStore((s) => s.sortBy);
  const view = useSearchStore((s) => s.view);

  // 进度详情（百分比 + 本数 + 阶段）已搬到顶部 ScanProgress 条；
  // 状态栏只在「正在扫描」时给一个极简提示，方便用户瞥一眼。
  let leftLabel = "就绪";
  if (sse.isRunning) {
    leftLabel =
      sse.connectionState === "reconnecting" ||
      sse.connectionState === "disconnected"
        ? "扫描进度连接中断 · 结果待确认"
        : sse.connectionState === "connecting"
          ? "正在连接扫描进度"
          : `扫描中 · 已发现 ${sse.progress?.albumsFound ?? 0} 个文件夹`;
  } else if (sse.isError) {
    leftLabel = "扫描失败";
  } else if (manifest) {
    leftLabel = `${manifest.statistics.albumCount} 个文件夹 · ${manifest.statistics.tagCount} 个标签`;
  }

  const sortLabel =
    sortBy === "name"
      ? "名称"
      : sortBy === "count"
        ? "张数"
        : sortBy === "viewed"
          ? "最近看"
          : "最近改";
  const viewLabel =
    view === "all"
      ? "全部"
      : view === "album"
        ? "文件夹"
        : view === "collection"
          ? "集合"
          : "标签";

  return (
    <footer className="h-7 px-4 flex items-center justify-between text-[11px] text-fg-subtle border-t border-border-faint glass">
      <div className="flex items-center gap-3 truncate">
        <span>{leftLabel}</span>
        {manifest && manifest.statistics.warningCount > 0 && (
          <span
            className="shrink-0 text-warning"
            title="扫描完成但有部分目录或媒体未能完整读取"
          >
            ⚠ {manifest.statistics.warningCount} 个扫描问题
          </span>
        )}
        {query && (
          <span className="px-1.5 py-0.5 rounded bg-bg-subtle text-fg-muted truncate">
            搜索: {query}
          </span>
        )}
        <span className="hidden md:inline">视图: {viewLabel}</span>
        <span className="hidden md:inline">排序: {sortLabel}</span>
      </div>
      <div className="flex items-center gap-3">
        {manifest?.scannedAt && (
          <span className="hidden md:inline">
            上次扫描 {new Date(manifest.scannedAt).toLocaleTimeString()}
          </span>
        )}
        <span className="tabular-nums">{now.toLocaleTimeString()}</span>
      </div>
    </footer>
  );
}
