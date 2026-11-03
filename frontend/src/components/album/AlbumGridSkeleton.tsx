import type { ViewMode } from "../../store/uiStore";

interface Props {
  /** 网格视图下渲染几张骨架卡。 */
  count?: number;
  /** 列表视图下渲染几行骨架。 */
  rows?: number;
  variant?: ViewMode;
  /**
   * 调用方已经提供了 page-shell 容器时置 true，避免左右留白叠加两次。
   */
  bare?: boolean;
  /**
   * 状态提示的文案。骨架是通用组件，但"正在加载什么"由页面决定，
   * 各页原有的措辞不要因为换成骨架就丢掉。
   */
  label?: string;
}

/**
 * 网格 / 列表的加载骨架。
 *
 * 之前加载态是一行「加载中…」文字或者一个转圈：内容到达后整块内容
 * 从零变成满屏，视线要重新找一遍位置（闪烁 + 跳动），而且转圈对"还要
 * 等多久"没有任何信息量。
 *
 * 骨架按真实卡片的尺寸与排版画：网格用同样的横幅封面块 + 标题行 +
 * 元信息行，列表用同样的 56×70 缩略图 + 两行文字。数据到达时卡片落
 * 在原来的位置上，视觉上是"填满"而不是"重排"。
 *
 * 骨架在虚拟列表之外渲染，不参与 Virtuoso 的高度计算，因此不会影响
 * 虚拟滚动与图片懒加载。
 */
export default function AlbumGridSkeleton({
  count = 10,
  rows = 8,
  variant = "grid",
  bare = false,
  label,
}: Props) {
  const shell = bare ? "" : "page-shell";
  const text =
    label ?? (variant === "list" ? "正在加载列表…" : "正在加载图像…");
  if (variant === "list") {
    return (
      <div className={shell} role="status" aria-live="polite" aria-label={text}>
        <span className="sr-only">{text}</span>
        <div aria-hidden="true" data-testid="album-skeleton-rows">
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3.5 border-b border-border-faint h-[86px]"
            >
              <div className="w-14 h-[70px] rounded-md bg-bg-subtle shrink-0" />
              <div className="flex-1 min-w-0 space-y-2">
                <div className="h-3.5 w-2/5 rounded bg-bg-subtle" />
                <div className="h-3 w-1/4 rounded bg-bg-subtle" />
              </div>
              <div className="shrink-0 w-24 sm:w-32 space-y-2">
                <div className="ml-auto h-3 w-16 rounded bg-bg-subtle" />
                <div className="ml-auto h-3 w-20 rounded bg-bg-subtle" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={shell} role="status" aria-live="polite" aria-label={text}>
      <span className="sr-only">{text}</span>
      <div
        aria-hidden="true"
        data-testid="album-skeleton-cards"
        className="library-grid gap-x-5 gap-y-8"
      >
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="album-tile min-w-0">
            <div className="relative aspect-[4/3] rounded-lg bg-bg-subtle border border-border" />
            <div className="pt-3 space-y-2">
              <div className="h-3.5 w-3/4 rounded bg-bg-subtle" />
              <div className="h-3 w-1/3 rounded bg-bg-subtle" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
