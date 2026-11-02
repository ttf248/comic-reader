import {
  ChevronLeftIcon,
  ChevronRightIcon,
  StarIcon,
  FullscreenIcon,
  InfoIcon,
  MoreHorizontalIcon,
  KeyboardIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ImageIcon,
  RefreshIcon,
  SinglePageIcon,
  ScrollPageIcon,
  DoublePageIcon,
  FitIcon,
  FitWidthIcon,
  FitHeightIcon,
  OriginalSizeIcon,
} from "../common/Icon";
import Popover, {
  PopoverItem,
  PopoverSeparator,
  PopoverLabel,
} from "../common/Popover";
import GalleryDisplayMenu from "./GalleryDisplayMenu";
import {
  useGalleryStore,
  type ReaderMode,
  type FitMode,
} from "../../store/galleryStore";
import { toggleFullscreen as toggleFullscreenImpl } from "../../utils/fullscreen";

interface Props {
  name: string;
  /**
   * 图片阅读器 store 中的 0-based 页码。视频模式不复用这份状态。
   * 推荐在视频模式传 `itemIndex`；不传时回退到 `index`。
   */
  index: number;
  /**
   * 当前 item 在列表中的 0-based 索引（用于头部计数 + 翻页禁用判断）。
   * 视频模式下 Gallery.tsx 必须显式传这个，避免把视频项序号写入图片 store。
   */
  itemIndex?: number;
  total: number;
  isFavorite: boolean;
  onBack: () => void;
  onToggleFavorite: () => void;
  onToggleInfo: () => void;
  onToggleHelp: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** 上一本/下一本（来自当前列表）。可选：没有上下文时不显示。 */
  onPrevAlbum?: () => void;
  onNextAlbum?: () => void;
  /** 跳到列表首/尾（视频模式下需要走 URL 切视频，不能用 setIndex）。 */
  onJumpToFirst?: () => void;
  onJumpToLast?: () => void;
  /** 把当前图片/视频设为本相册的封面。 */
  onSetCover?: () => void;
  /** 清除本相册的自定义封面（回到扫描器默认）。 */
  onClearCover?: () => void;
  /** 当前相册是否已有自定义封面（决定 Popover 显示哪种文案）。 */
  hasCustomCover?: boolean;
}

// 画廊顶部常驻条：返回 / 名称 / 页码 / 阅读模式 / 收藏 / 全屏 / 菜单
//
// 设计要点：
// - 始终可见（不被 chromeVisible 影响）
// - 顶部加渐变遮罩 + 背景模糊：明亮照片上按钮依然可读
// - 阅读模式（单张 / 连续 / 并排）直接摆在顶栏，不再只藏在"…"里；
//   缩放、旋转、方向等低频操作留在右侧悬浮控件与"…"菜单
// - 菜单里收纳：图片信息 / 快捷键帮助 / 上一本/下一本 / 第一张/最后张
//   （视频模式下不显示图片信息面板，跳转项也改用"视频"的说法）
export default function GalleryHeader({
  name,
  index,
  itemIndex,
  total,
  isFavorite,
  onBack,
  onToggleFavorite,
  onToggleInfo,
  onToggleHelp,
  onPrev,
  onNext,
  onPrevAlbum,
  onNextAlbum,
  onSetCover,
  onClearCover,
  hasCustomCover,
  onJumpToFirst,
  onJumpToLast,
}: Props) {
  const mode = useGalleryStore((s) => s.mode);
  const setMode = useGalleryStore((s) => s.setMode);
  const fit = useGalleryStore((s) => s.fit);
  const cycleFit = useGalleryStore((s) => s.cycleFit);
  const setIndex = useGalleryStore((s) => s.setIndex);
  // 全屏走 utils/fullscreen.toggFullscreen() 直接调浏览器 API,不再
  // 走 store(老 store.toggleFullscreen 是空 set action,已删除)。
  const toggleFullscreen = () => {
    toggleFullscreenImpl();
  };

  // 显示 / 翻页禁用都用 item index；未传时回退到 index（仅图库模式安全）
  const displayIndex = itemIndex !== undefined ? itemIndex : Math.floor(index);
  const isVideo = itemIndex !== undefined;

  // 双页模式显示「L-R / total」；否则「N / total」
  const counterText = (() => {
    if (!isVideo && mode === "double") {
      const hi = Math.min(displayIndex + 2, total);
      return `${displayIndex + 1}–${hi} / ${total}`;
    }
    return `${displayIndex + 1} / ${total}`;
  })();

  // 跳到首/尾（菜单里的快捷入口）。视频模式必须用父组件传的
  // onJumpToFirst/Last（基于 URL 切视频）；图片模式回退到 setIndex。
  const jumpToFirst = onJumpToFirst ?? (() => setIndex(0));
  const jumpToLast = onJumpToLast ?? (() => setIndex(Math.max(0, total - 1)));

  const hasAlbumNav = !!(onPrevAlbum || onNextAlbum);

  return (
    <header className="absolute top-0 inset-x-0 z-20 h-12 flex items-center gap-1.5 px-2 sm:px-3 text-white/85 bg-gradient-to-b from-black/75 via-black/35 to-transparent backdrop-blur-[2px]">
      <button
        onClick={onBack}
        title="返回 (Esc)"
        className="inline-flex items-center gap-1 h-8 px-2 rounded-md text-[13px] hover:bg-white/10 transition-colors"
      >
        <ChevronLeftIcon size={14} />
        <span className="hidden sm:inline">返回</span>
      </button>

      <h1 className="min-w-0 flex-1 flex items-baseline gap-2.5 sm:gap-3 ml-1">
        <span className="truncate text-[14px] font-medium text-white">
          {name}
        </span>
        <span className="text-[12.5px] tabular-nums text-white/70 shrink-0">
          {counterText}
        </span>
      </h1>

      {/* 上一张 / 下一张：常驻小按钮，沉浸模式不挡住图片 */}
      <div className="hidden md:flex items-center gap-0.5">
        <HeaderIconButton
          onClick={onPrev}
          disabled={displayIndex <= 0}
          title={isVideo ? "上一个视频 (PageUp)" : "上一张 (←)"}
        >
          <ChevronLeftIcon size={14} />
        </HeaderIconButton>
        <HeaderIconButton
          onClick={onNext}
          disabled={displayIndex >= total - 1}
          title={isVideo ? "下一个视频 (PageDown)" : "下一张 (→)"}
        >
          <ChevronRightIcon size={14} />
        </HeaderIconButton>
      </div>

      {/* 阅读模式：直接在顶栏切换，不再只藏在"…"菜单里 */}
      {!isVideo && (
        <div
          className="hidden md:flex items-center gap-0.5 p-0.5 rounded-lg bg-white/10 ring-1 ring-white/10"
          role="group"
          aria-label="阅读模式"
        >
          {(
            [
              { value: "single", label: "单张", Icon: SinglePageIcon, key: "1" },
              { value: "continuous", label: "连续", Icon: ScrollPageIcon, key: "2" },
              { value: "double", label: "并排", Icon: DoublePageIcon, key: "3" },
            ] as { value: ReaderMode; label: string; Icon: typeof SinglePageIcon; key: string }[]
          ).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setMode(o.value)}
              title={`${o.label} (${o.key})`}
              aria-label={o.label}
              aria-pressed={mode === o.value}
              className={`inline-flex items-center justify-center h-7 w-8 rounded-md transition-colors ${
                mode === o.value
                  ? "bg-white/20 text-white"
                  : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              <o.Icon size={14} />
            </button>
          ))}
        </div>
      )}

      {/* 适配方式：常驻一个按钮，点击按 适应 → 按宽 → 按高 → 原始 循环 */}
      {!isVideo && (
        <HeaderIconButton
          onClick={cycleFit}
          title={`适配：${FIT_LABEL[fit]} (F 循环)`}
        >
          {FIT_ICON[fit]}
        </HeaderIconButton>
      )}

      <HeaderIconButton
        onClick={onToggleFavorite}
        active={isFavorite}
        title={isFavorite ? "取消收藏 (S)" : "加入收藏 (S)"}
      >
        <StarIcon
          size={14}
          filled={isFavorite}
          className={isFavorite ? "text-amber-300" : ""}
        />
      </HeaderIconButton>

      <HeaderIconButton
        onClick={toggleFullscreen}
        title="全屏 (F11)"
        hideOnMobile
      >
        <FullscreenIcon size={14} />
      </HeaderIconButton>

      {/* 阅读设置（模式 / 适配 / 缩放 / 旋转 / 方向）：全尺寸可用 */}
      {!isVideo && <GalleryDisplayMenu />}

      <Popover
        align="end"
        trigger={
          <HeaderIconButton title="更多">
            <MoreHorizontalIcon size={15} />
          </HeaderIconButton>
        }
      >
        <PopoverLabel>阅读</PopoverLabel>
        {!isVideo && (
          <PopoverItem onClick={onToggleInfo}>
            <InfoIcon size={13} />
            <span>图片信息</span>
            <span className="ml-auto text-[11.5px] text-fg-subtle">I</span>
          </PopoverItem>
        )}
        <PopoverItem onClick={onToggleHelp}>
          <KeyboardIcon size={13} />
          <span>快捷键</span>
          <span className="ml-auto text-[11.5px] text-fg-subtle">?</span>
        </PopoverItem>
        {onSetCover && (
          <PopoverItem onClick={onSetCover}>
            <ImageIcon size={13} />
            <span>设为封面</span>
            <span className="ml-auto text-[11.5px] text-fg-subtle">U</span>
          </PopoverItem>
        )}
        {onClearCover && hasCustomCover && (
          <PopoverItem onClick={onClearCover}>
            <RefreshIcon size={13} />
            <span>清除自定义封面</span>
            <span className="ml-auto text-[11.5px] text-fg-subtle">⇧U</span>
          </PopoverItem>
        )}
        {hasAlbumNav && <PopoverSeparator />}
        {hasAlbumNav && <PopoverLabel>列表</PopoverLabel>}
        {onPrevAlbum && (
          <PopoverItem onClick={onPrevAlbum}>
            <ArrowUpIcon size={13} />
            <span>上一本</span>
            <span className="ml-auto text-[11.5px] text-fg-subtle">P</span>
          </PopoverItem>
        )}
        {onNextAlbum && (
          <PopoverItem onClick={onNextAlbum}>
            <ArrowDownIcon size={13} />
            <span>下一本</span>
            <span className="ml-auto text-[11.5px] text-fg-subtle">N</span>
          </PopoverItem>
        )}
        <PopoverSeparator />
        <PopoverLabel>跳转</PopoverLabel>
        <PopoverItem onClick={jumpToFirst}>
          <span>{isVideo ? "第一个视频" : "第一张"}</span>
          <span className="ml-auto text-[11.5px] text-fg-subtle">Home</span>
        </PopoverItem>
        <PopoverItem onClick={jumpToLast}>
          <span>{isVideo ? "最后一个视频" : "最后张"}</span>
          <span className="ml-auto text-[11.5px] text-fg-subtle">End</span>
        </PopoverItem>
      </Popover>
    </header>
  );
}

// 适配方式：按钮图标 + 中文标题，顺序与 store 的循环顺序一致。
const FIT_LABEL: Record<FitMode, string> = {
  fit: "适应",
  width: "按宽",
  height: "按高",
  original: "原始",
};
const FIT_ICON: Record<FitMode, React.ReactNode> = {
  fit: <FitIcon size={14} />,
  width: <FitWidthIcon size={14} />,
  height: <FitHeightIcon size={14} />,
  original: <OriginalSizeIcon size={14} />,
};

function HeaderIconButton({
  children,
  onClick,
  disabled,
  title,
  active,
  hideOnMobile,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  active?: boolean;
  hideOnMobile?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`inline-flex items-center justify-center h-8 w-8 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        hideOnMobile ? "hidden sm:inline-flex" : ""
      } ${
        active
          ? "bg-white/15 text-white"
          : "text-white/80 hover:text-white hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}
