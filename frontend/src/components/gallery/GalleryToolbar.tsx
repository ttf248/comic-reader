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

// 阅读器底部浮动工具条。
//
// 设计决策（取代原先「顶栏塞一堆按钮 + 右侧竖排浮层」的双簇布局）：
//
// 1. **控制面唯一** —— 所有"看图"相关的操作（翻页 / 阅读模式 / 适配 /
//    缩放 / 旋转）集中到画面底部的一枚药丸里。原来的右侧竖排浮层
//    会在鼠标静止 2.5 秒后整组淡出，用户根本不知道它存在；而顶栏
//    同时塞着模式、适配、收藏、全屏、设置、更多六组控件，1440px 下
//    也挤成一团。合并成一个底部工具条后，"控件在哪"不再有第二个答案。
//
// 2. **顶栏只回答"这是哪里 / 我要做什么"** —— 返回、相册名、页码，
//    加收藏、全屏与溢出菜单（内容级操作：图片信息、设为封面、跨卷跳转）。
//
// 3. **不遮画面** —— 药丸居中悬浮在底部画布留白处，不再压在图片右缘，
//    「点击右侧三分之一翻到下一张」的热区完整可用（这是窄屏唯一可靠的
//    翻页方式）。
//
// 4. **触控友好** —— 按钮 32px（窄屏 34px），底部位置在拇指可达区；
//    原来的右侧竖排控件在平板横屏时离拇指最远。
//
// 药丸常驻显示（不做 idle 淡出）：淡出虽然更"沉浸"，但等于把功能藏起来，
// 违背"常用操作一步可达"。页面进度条仍然按 idle 淡出 —— 它是被动信息，
// 不需要一直占位。

interface Props {
  onPrev: () => void;
  onNext: () => void;
  /** 当前是否第一张 / 最后一张（用于禁用翻页按钮）。 */
  atStart?: boolean;
  atEnd?: boolean;
}

const MODE_OPTIONS: {
  value: ReaderMode;
  label: string;
  icon: typeof SinglePageIcon;
  key: string;
}[] = [
  { value: "single", label: "单张", icon: SinglePageIcon, key: "1" },
  { value: "continuous", label: "连续", icon: ScrollPageIcon, key: "2" },
  { value: "double", label: "并排", icon: DoublePageIcon, key: "3" },
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
      className="absolute bottom-[52px] left-1/2 z-20 -translate-x-1/2"
      role="toolbar"
      aria-label="阅读控制"
    >
      <div className="flex items-center gap-0.5 rounded-xl bg-neutral-900/80 p-1 shadow-2xl ring-1 ring-white/10 backdrop-blur-xl">
        <ToolButton
          onClick={onPrev}
          disabled={atStart}
          title="上一张 (←)"
          ariaLabel="上一张"
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
          className="hidden sm:inline-flex h-8 min-w-[46px] items-center justify-center rounded-md px-1 text-[12.5px] tabular-nums text-white/80 transition-colors hover:bg-white/10 hover:text-white"
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
            <span className="text-[12.5px] tabular-nums">{rotation}°</span>
          </span>
        </ToolButton>

        <Divider />

        <ToolButton
          onClick={onNext}
          disabled={atEnd}
          title="下一张 (→)"
          ariaLabel="下一张"
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
