import { useMemo, useState } from "react";
import type { ScanWarning } from "../../api/library";
import { AlertIcon, ChevronDownIcon, ChevronUpIcon } from "./Icon";

interface Props {
  warnings?: ScanWarning[];
  total: number;
}

const WARNING_LABELS: Record<string, string> = {
  directory_unreadable: "目录无法读取",
  symlink_skipped: "跳过符号链接",
  metadata_unavailable: "媒体元数据不可用",
  max_depth_reached: "达到扫描深度上限",
};

/** 扫描告警摘要：默认折叠，展开后展示脱敏的根别名/相对路径。 */
export default function ScanWarnings({ warnings = [], total }: Props) {
  const [open, setOpen] = useState(false);
  const grouped = useMemo(() => {
    const counts = new Map<string, number>();
    for (const warning of warnings) {
      counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1);
    }
    return Array.from(counts.entries());
  }, [warnings]);

  if (total <= 0) return null;

  return (
    <div className="mt-3 w-full">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 text-xs text-warning hover:text-warning/80 transition-colors"
        aria-expanded={open}
        aria-controls="scan-warning-details"
      >
        <AlertIcon size={12} />
        <span>扫描发现 {total} 个问题</span>
        {open ? <ChevronUpIcon size={11} /> : <ChevronDownIcon size={11} />}
      </button>

      {open && (
        <div
          id="scan-warning-details"
          className="mt-2 rounded-md border border-warning/25 bg-warning/5 p-3 text-xs"
          role="region"
          aria-label="扫描问题详情"
        >
          {grouped.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-warning/90">
              {grouped.map(([code, count]) => (
                <span key={code}>
                  {WARNING_LABELS[code] ?? code} {count}
                </span>
              ))}
            </div>
          )}
          {warnings.length > 0 ? (
            <ul className="max-h-40 space-y-1 overflow-auto text-fg-muted">
              {warnings.map((warning, index) => (
                <li key={`${warning.code}-${warning.path ?? ""}-${index}`}>
                  <span className="text-fg">{warning.message}</span>
                  {warning.path && (
                    <span className="ml-2 font-mono text-fg-subtle">
                      {warning.path}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-fg-muted">当前扫描未返回可展开的详情。</p>
          )}
          {total > warnings.length && (
            <p className="mt-2 text-fg-subtle">
              仅展示前 {warnings.length} 条，完整数量为 {total} 条。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
