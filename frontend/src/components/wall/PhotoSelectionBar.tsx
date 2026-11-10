import { useEffect } from "react";
import { hasOpenModal, shouldIgnoreShortcut } from "../../utils/shortcuts";
import type { PhotoSelectionEntry } from "../../store/photoSelectionStore";
import {
  CloseIcon,
  DoublePageIcon,
  PickIcon,
  UncheckIcon,
} from "../common/Icon";

interface Props {
  /** 当前选中的照片。 */
  selected: PhotoSelectionEntry[];
  /** 其中已经在精选里的张数。 */
  pickedCount: number;
  /** 把选中的照片加入精选。 */
  onAddPicks: () => void;
  /** 把选中的照片移出精选。 */
  onRemovePicks: () => void;
  /** 并排对比选中的两张。 */
  onCompare: () => void;
  /** 退出多选。 */
  onExit: () => void;
  busy?: boolean;
}

/**
 * 照片墙的多选操作条。
 *
 * 它浮在墙的下缘而不是把内容往下推：照片墙是浏览页，往下顶一截
 * 就等于把刚看到的照片挤走半屏 —— 那一屏正是用户挑东西的地方。
 *
 * 条上只放这一轮真正要做的动作：加精选、去精选、并排对比、退出。
 * 「选择已加载项」这类批量动作放在相册列表那边，照片墙不重复。
 */
export default function PhotoSelectionBar({
  selected,
  pickedCount,
  onAddPicks,
  onRemovePicks,
  onCompare,
  onExit,
  busy = false,
}: Props) {
  const count = selected.length;
  const allPicked = count > 0 && pickedCount === count;
  const nonePicked = pickedCount === 0;
  // 并排对比只看图片：视频没有可并排的画面，放进来只能给一块封面。
  const comparable =
    count === 2 && selected.every((item) => item.kind !== "video");
  // 两个动作按实际情况露出来：已经全在精选里时不必要求「加入精选」，
  // 一张都不在时也不必要求「移出精选」。
  const showAdd = !allPicked;
  const showRemove = !nonePicked;

  // Esc 退出多选：多选是浮在浏览上的一层，Esc 先收它。
  // 但大图预览或并排对比开着时，Esc 归那一层 —— 两层浮层不抢同一个键。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || shouldIgnoreShortcut(event)) return;
      if (hasOpenModal()) return;
      event.preventDefault();
      onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  return (
    <div
      role="toolbar"
      aria-label="照片多选操作"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3 sm:pb-5"
    >
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-1.5 rounded-xl border border-border bg-bg-elevated/95 px-2.5 py-2 shadow-lg backdrop-blur">
        <span role="status" className="px-1 text-body text-fg">
          已选 {count} 张
          {pickedCount > 0 && (
            <span className="text-fg-muted"> · {pickedCount} 张在精选</span>
          )}
        </span>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        {showAdd && (
          <button
            type="button"
            onClick={onAddPicks}
            disabled={busy}
            title="把选中的照片加入精选"
            aria-label="把选中的照片加入精选"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-body text-fg transition-colors hover:bg-bg-subtle disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <PickIcon size={14} />
            <span className="hidden sm:inline">加入精选</span>
          </button>
        )}
        {showRemove && (
          <button
            type="button"
            onClick={onRemovePicks}
            disabled={busy}
            title="把选中的照片移出精选"
            aria-label="把选中的照片移出精选"
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-body text-fg transition-colors hover:bg-bg-subtle disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <UncheckIcon size={13} />
            <span className="hidden sm:inline">移出精选</span>
          </button>
        )}
        <button
          type="button"
          onClick={onCompare}
          disabled={busy || !comparable}
          title={
            count === 2 && !comparable
              ? "并排对比只支持两张图片"
              : "并排对比选中的两张"
          }
          aria-label="并排对比选中的两张"
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-body text-fg transition-colors hover:bg-bg-subtle disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <DoublePageIcon size={13} />
          <span className="hidden sm:inline">并排对比</span>
        </button>
        <button
          type="button"
          onClick={onExit}
          disabled={busy}
          title="退出选择 (Esc)"
          aria-label="退出选择"
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-body text-fg transition-colors hover:bg-bg-subtle disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <CloseIcon size={13} />
          <span className="hidden sm:inline">退出</span>
        </button>
      </div>
    </div>
  );
}
