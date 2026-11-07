import {
  ChevronLeftIcon,
  ChevronRightIcon,
  SinglePageIcon,
  ScrollPageIcon,
  DoublePageIcon,
  FitIcon,
  FitWidthIcon,
  FitHeightIcon,
  OriginalSizeIcon,
  MinusIcon,
  PlusIcon,
  RotateIcon,
} from "../common/Icon";
import {
  useGalleryStore,
  type FitMode,
  type ReaderMode,
} from "../../store/galleryStore";

// 当前图片阅读操作聚合在底部工具条，位置、外观与出现方式可重新设计。
// 重做时回归模式/适配切换、偏好写入、键盘路径，以及触摸翻页热区不被遮挡。

interface Props {
  onPrev: () => void;
  onNext: () => void;
  /** 当前是否第一页 / 最后一页（用于禁用翻页按钮）。 */
  atStart?: boolean;
  atEnd?: boolean;
  /**
   * 是否显示。
   *
   * 阅读时它压在画面上，常驻会一直挡着画。空闲后淡出，鼠标靠近底部
   * 或按下任意键就回来 —— 顶部条与底部页码进度条始终常驻，所以
   * 「现在在哪一页」这件事永远不需要先找到工具条。
   */
  visible?: boolean;
}

const MODE_OPTIONS: {
  value: ReaderMode;
  label: string;
  icon: typeof SinglePageIcon;
  key: string;
}[] = [
  { value: "single", label: "单页", icon: SinglePageIcon, key: "1" },
  { value: "continuous", label: "连续", icon: ScrollPageIcon, key: "2" },
  { value: "double", label: "双页", icon: DoublePageIcon, key: "3" },
];

const FIT_LABEL: Record<FitMode, string> = {
  fit: "适应",
  width: "按宽",
  height: "按高",
  original: "原始",
};

const FIT_ICON: Record<FitMode, React.ReactNode> = {
  fit: <FitIcon size={15} />,
  width: <FitWidthIcon size={15} />,
  height: <FitHeightIcon size={15} />,
  original: <OriginalSizeIcon size={15} />,
};

export default function GalleryToolbar({
  onPrev,
  onNext,
  atStart,
  atEnd,
  visible = true,
}: Props) {
  const mode = useGalleryStore((s) => s.mode);
  const setMode = useGalleryStore((s) => s.setMode);
  const fit = useGalleryStore((s) => s.fit);
  const cycleFit = useGalleryStore((s) => s.cycleFit);
  const zoom = useGalleryStore((s) => s.zoom);
  const zoomIn = useGalleryStore((s) => s.zoomIn);
  const zoomOut = useGalleryStore((s) => s.zoomOut);
  const zoomReset = useGalleryStore((s) => s.zoomReset);
  const rotation = useGalleryStore((s) => s.rotation);
  const rotate = useGalleryStore((s) => s.rotate);

  return (
    <div
      className={`absolute bottom-[52px] left-1/2 z-20 -translate-x-1/2 transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0 pointer-events-none"
      }`}
      role="toolbar"
      aria-label="阅读控制"
    >
      <div className="reader-control-panel flex items-center gap-0.5 p-1.5 shadow-2xl ring-1 ring-white/15 backdrop-blur-xl">
        <ToolButton
          onClick={onPrev}
          disabled={atStart}
          title="上一页 (←)"
          ariaLabel="上一页"
        >
          <ChevronLeftIcon size={16} />
        </ToolButton>

        <Divider />

        <div
          className="flex items-center gap-0.5"
          role="group"
          aria-label="阅读模式"
        >
          {MODE_OPTIONS.map((o) => (
            <ToolButton
              key={o.value}
              onClick={() => setMode(o.value)}
              active={mode === o.value}
              title={`${o.label} (${o.key})`}
              ariaLabel={o.label}
            >
              <o.icon size={15} />
            </ToolButton>
          ))}
        </div>

        <Divider />

        <ToolButton
          onClick={cycleFit}
          title={`适配方式：${FIT_LABEL[fit]}（F 循环）`}
          ariaLabel={`适配方式：${FIT_LABEL[fit]}`}
        >
          {FIT_ICON[fit]}
        </ToolButton>

        <Divider />

        <ToolButton onClick={zoomOut} title="缩小 (-)" ariaLabel="缩小">
          <MinusIcon size={15} />
        </ToolButton>
        <button
          type="button"
          onClick={zoomReset}
          title="实际大小 (0)"
          aria-label={`实际大小，当前 ${Math.round(zoom * 100)}%`}
          className="hidden sm:inline-flex h-8 min-w-[46px] items-center justify-center rounded-md px-1 text-meta tabular-nums text-white/80 transition-colors hover:bg-white/10 hover:text-white"
        >
          {Math.round(zoom * 100)}%
        </button>
        <ToolButton onClick={zoomIn} title="放大 (+)" ariaLabel="放大">
          <PlusIcon size={15} />
        </ToolButton>

        <Divider />

        <ToolButton
          onClick={() => rotate(90)}
          title={`旋转 90°（当前 ${rotation}°）`}
          ariaLabel={`旋转 90 度，当前 ${rotation} 度`}
        >
          <span className="inline-flex items-center gap-1">
            <RotateIcon size={15} />
            {/* 角度读数只在真的转过之后出现：平时一枚「0°」占着位置，
                读起来像一个待填的空读数。同一页的进度条也是这个规矩
                —— 空轨道不出现。 */}
            {rotation !== 0 && (
              <span className="text-meta tabular-nums">{rotation}°</span>
            )}
          </span>
        </ToolButton>

        <Divider />

        <ToolButton
          onClick={onNext}
          disabled={atEnd}
          title="下一页 (→)"
          ariaLabel="下一页"
        >
          <ChevronRightIcon size={16} />
        </ToolButton>
      </div>
    </div>
  );
}

function Divider() {
  return <span className="w-px h-5 mx-0.5 bg-white/15" aria-hidden />;
}

function ToolButton({
  children,
  onClick,
  disabled,
  title,
  ariaLabel,
  active,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title: string;
  ariaLabel: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
        active
          ? "bg-white/20 text-white"
          : "text-white/80 hover:bg-white/10 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
