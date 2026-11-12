import { formatBytes } from "../../api/cache";
import { TrashIcon } from "./Icon";

interface Props {
  label: string;
  sub: { path: string; bytes: number; fileCount: number; available: boolean };
  onClear?: () => void;
  clearPending?: boolean;
}

/**
 * 缓存细分 badge：展示单个子目录的占用，并提供只清这一类的按钮。
 *
 * 子目录还没产生时整块灰显显示「—」；字节数为 0 时不给清空按钮 ——
 * 后端此时也是空操作，按钮只是让人多点一次。
 */
export default function SubUsageBadge({
  label,
  sub,
  onClear,
  clearPending,
}: Props) {
  const showClear = !!onClear && sub.available && sub.bytes > 0;
  return (
    <div className="flex flex-col gap-0.5 rounded border border-border-faint bg-bg-subtle/40 px-2.5 py-1.5">
      <div className="flex items-center justify-between gap-1.5">
        <span className="text-meta text-fg-muted">{label}</span>
        {showClear ? (
          <button
            onClick={onClear}
            disabled={clearPending}
            className="-mr-1 inline-flex h-7 w-7 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
            title={`清空 ${label} 缓存`}
            aria-label={`清空 ${label} 缓存`}
          >
            {clearPending ? (
              <span className="inline-block h-2 w-2 animate-spin rounded-full border-2 border-fg-muted border-t-transparent" />
            ) : (
              <TrashIcon size={9} />
            )}
          </button>
        ) : null}
      </div>
      {sub.available ? (
        <div className="flex items-baseline gap-1.5">
          <span className="font-medium tabular-nums text-fg">
            {formatBytes(sub.bytes)}
          </span>
          <span className="tabular-nums text-fg-subtle">{sub.fileCount} 个</span>
        </div>
      ) : (
        <span className="text-fg-subtle">—</span>
      )}
    </div>
  );
}
