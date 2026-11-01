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
} from "../common/Icon";
import Popover, {
  PopoverItem,
  PopoverSeparator,
  PopoverLabel,
} from "../common/Popover";
import { useGalleryStore } from "../../store/galleryStore";
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

// 画廊顶部常驻条：极简 — 返回 / 名称 / 页码 / 收藏 / 全屏 / 菜单
//
// 设计要点：
// - 始终可见（不被 chromeVisible 影响）
// - glass 半透明，沉浸但不抢戏
// - 暗色背景下用浅色文字；hover 用白色
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
    <header
      className="absolute top-0 inset-x-0 z-20 h-11 flex items-center gap-1.5 px-2 sm:px-3 text-white/85"
      style={{
        background:
          "linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0))",
      }}
    >
      <button
        onClick={onBack}
        title="返回 (Esc)"
        className="inline-flex items-center gap-1 h-7 px-2 rounded text-[12px] hover:bg-white/10 transition-colors"
      >
        <ChevronLeftIcon size={13} />
        <span className="hidden sm:inline">返回</span>
      </button>

      <h1 className="min-w-0 flex-1 flex items-center gap-2 sm:gap-3 ml-1">
        <span className="truncate text-[13px] font-medium text-white">
          {name}
        </span>
        <span className="hidden sm:inline text-[10px] uppercase tracking-[0.18em] text-white/45 shrink-0">
          ·
        </span>
        <span className="text-[11px] tabular-nums text-white/65 shrink-0">
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
          <ChevronLeftIcon size={13} />
        </HeaderIconButton>
        <HeaderIconButton
          onClick={onNext}
          disabled={displayIndex >= total - 1}
          title={isVideo ? "下一个视频 (PageDown)" : "下一张 (→)"}
        >
          <ChevronRightIcon size={13} />
        </HeaderIconButton>
      </div>

      <HeaderIconButton
        onClick={onToggleFavorite}
        active={isFavorite}
        title={isFavorite ? "取消收藏 (S)" : "加入收藏 (S)"}
      >
        <StarIcon
          size={13}
          filled={isFavorite}
          className={isFavorite ? "text-amber-300" : ""}
        />
      </HeaderIconButton>

      <HeaderIconButton
        onClick={toggleFullscreen}
        title="全屏 (F11)"
        hideOnMobile
      >
        <FullscreenIcon size={13} />
      </HeaderIconButton>

      <Popover
        align="end"
        trigger={
          <HeaderIconButton title="更多">
            <MoreHorizontalIcon size={14} />
          </HeaderIconButton>
        }
      >
        <PopoverLabel>阅读</PopoverLabel>
        {!isVideo && (
          <PopoverItem onClick={onToggleInfo}>
            <InfoIcon size={12} />
            <span>图片信息</span>
            <span className="ml-auto text-[10px] text-fg-subtle">I</span>
          </PopoverItem>
        )}
        <PopoverItem onClick={onToggleHelp}>
          <KeyboardIcon size={12} />
          <span>快捷键</span>
          <span className="ml-auto text-[10px] text-fg-subtle">?</span>
        </PopoverItem>
        {onSetCover && (
          <PopoverItem onClick={onSetCover}>
            <ImageIcon size={12} />
            <span>设为封面</span>
            <span className="ml-auto text-[10px] text-fg-subtle">U</span>
          </PopoverItem>
        )}
        {onClearCover && hasCustomCover && (
          <PopoverItem onClick={onClearCover}>
            <RefreshIcon size={12} />
            <span>清除自定义封面</span>
            <span className="ml-auto text-[10px] text-fg-subtle">⇧U</span>
          </PopoverItem>
        )}
        {hasAlbumNav && <PopoverSeparator />}
        {hasAlbumNav && <PopoverLabel>列表</PopoverLabel>}
        {onPrevAlbum && (
          <PopoverItem onClick={onPrevAlbum}>
            <ArrowUpIcon size={12} />
            <span>上一本</span>
            <span className="ml-auto text-[10px] text-fg-subtle">P</span>
          </PopoverItem>
        )}
        {onNextAlbum && (
          <PopoverItem onClick={onNextAlbum}>
            <ArrowDownIcon size={12} />
            <span>下一本</span>
            <span className="ml-auto text-[10px] text-fg-subtle">N</span>
          </PopoverItem>
        )}
        <PopoverSeparator />
        <PopoverLabel>跳转</PopoverLabel>
        <PopoverItem onClick={jumpToFirst}>
          <span>{isVideo ? "第一个视频" : "第一张"}</span>
          <span className="ml-auto text-[10px] text-fg-subtle">Home</span>
        </PopoverItem>
        <PopoverItem onClick={jumpToLast}>
          <span>{isVideo ? "最后一个视频" : "最后张"}</span>
          <span className="ml-auto text-[10px] text-fg-subtle">End</span>
        </PopoverItem>
      </Popover>
    </header>
  );
}

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
      className={`inline-flex items-center justify-center h-7 w-7 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        hideOnMobile ? "hidden sm:inline-flex" : ""
      } ${
        active
          ? "bg-white/15 text-white"
          : "text-white/75 hover:text-white hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}
