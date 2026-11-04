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
  ArrowRightLineIcon,
  ArrowLeftLineIcon,
  GridIcon,
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
  /** 上一张 / 下一张。图片模式由底部工具条提供，这里只服务视频模式。 */
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
  /** 打开目录（整本缩略图）。可选：不提供时不显示入口。 */
  onToggleOverview?: () => void;
  /** 把这本相册改成照片相册并离开阅读器。可选。 */
  onSwitchToPhoto?: () => void;
}

// 画廊顶部常驻条：返回 / 名称 / 页码 / 收藏 / 全屏 / 更多
//
// 2026-11 重设计：顶栏只保留"我在这 / 我是谁 / 我要离开"三类信息 ——
// 返回、相册名、页码、收藏、全屏与溢出菜单。
// 阅读模式 / 适配 / 缩放 / 旋转这类"看图"操作已移到画面底部的浮动
// 工具条（GalleryToolbar）：它们与顶栏控件挤在一起时，1440px 下顶栏
// 会出现 6 组并列控件；而底部才是拇指可达区，也是阅读器软件的惯例位置。
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
  onToggleOverview,
  onSwitchToPhoto,
}: Props) {
  const mode = useGalleryStore((s) => s.mode);
  const direction = useGalleryStore((s) => s.direction);
  const setDirection = useGalleryStore((s) => s.setDirection);
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
    <header className="reader-header absolute z-20 flex items-center gap-1.5 px-3 text-white/85 backdrop-blur-xl">
      <button
        onClick={onBack}
        title="返回 (Esc)"
        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[13px] transition-colors hover:bg-white/10"
      >
        <ChevronLeftIcon size={14} />
        <span className="hidden sm:inline">返回</span>
      </button>

      <h1 className="ml-1 flex min-w-0 flex-1 items-baseline gap-2.5 sm:gap-3">
        <span className="truncate text-[14px] font-medium text-white">
          {name}
        </span>
        <span className="shrink-0 text-[12.5px] tabular-nums text-white/70">
          {counterText}
        </span>
      </h1>

      {/* 视频模式没有底部工具条（<video> 自带 controls），
          换片按钮留在顶栏；图片模式的翻页在底部工具条里。 */}
      {isVideo && (
        <div className="hidden md:flex items-center gap-0.5">
          <HeaderIconButton
            onClick={onPrev}
            disabled={displayIndex <= 0}
            title="上一个视频 (PageUp)"
          >
            <ChevronLeftIcon size={14} />
          </HeaderIconButton>
          <HeaderIconButton
            onClick={onNext}
            disabled={displayIndex >= total - 1}
            title="下一个视频 (PageDown)"
          >
            <ChevronRightIcon size={14} />
          </HeaderIconButton>
        </div>
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

      <Popover
        align="end"
        tone="reader"
        trigger={
          <HeaderIconButton title="更多">
            <MoreHorizontalIcon size={15} />
          </HeaderIconButton>
        }
      >
        <PopoverLabel>内容</PopoverLabel>
        {!isVideo && (
          <PopoverItem onClick={onToggleInfo}>
            <InfoIcon size={13} />
            <span>图片信息</span>
            <span className="ml-auto text-[12.5px] text-white/55">I</span>
          </PopoverItem>
        )}
        {!isVideo && onToggleOverview && (
          <PopoverItem onClick={onToggleOverview}>
            <GridIcon size={13} />
            <span>目录</span>
            <span className="ml-auto text-[12.5px] text-white/55">T</span>
          </PopoverItem>
        )}
        <PopoverItem onClick={onToggleHelp}>
          <KeyboardIcon size={13} />
          <span>快捷键</span>
          <span className="ml-auto text-[12.5px] text-white/55">?</span>
        </PopoverItem>
        {onSetCover && (
          <PopoverItem onClick={onSetCover}>
            <ImageIcon size={13} />
            <span>设为封面</span>
            <span className="ml-auto text-[12.5px] text-white/55">U</span>
          </PopoverItem>
        )}
        {onClearCover && hasCustomCover && (
          <PopoverItem onClick={onClearCover}>
            <RefreshIcon size={13} />
            <span>清除自定义封面</span>
            <span className="ml-auto text-[12.5px] text-white/55">⇧U</span>
          </PopoverItem>
        )}
        {!isVideo && mode === "double" && (
          <PopoverItem
            onClick={() => setDirection(direction === "ltr" ? "rtl" : "ltr")}
          >
            {direction === "ltr" ? (
              <ArrowRightLineIcon size={13} />
            ) : (
              <ArrowLeftLineIcon size={13} />
            )}
            <span>阅读方向：{direction === "ltr" ? "左→右" : "右→左"}</span>
            <span className="ml-auto text-[12.5px] text-white/55">L</span>
          </PopoverItem>
        )}
        {onSwitchToPhoto && (
          <>
            <PopoverSeparator />
            <PopoverLabel>相册</PopoverLabel>
            <PopoverItem onClick={onSwitchToPhoto}>
              <ImageIcon size={13} />
              <span>改为照片相册</span>
            </PopoverItem>
          </>
        )}
        {hasAlbumNav && <PopoverSeparator />}
        {hasAlbumNav && <PopoverLabel>列表</PopoverLabel>}
        {onPrevAlbum && (
          <PopoverItem onClick={onPrevAlbum}>
            <ArrowUpIcon size={13} />
            <span>上一本</span>
            <span className="ml-auto text-[12.5px] text-white/55">P</span>
          </PopoverItem>
        )}
        {onNextAlbum && (
          <PopoverItem onClick={onNextAlbum}>
            <ArrowDownIcon size={13} />
            <span>下一本</span>
            <span className="ml-auto text-[12.5px] text-white/55">N</span>
          </PopoverItem>
        )}
        <PopoverSeparator />
        <PopoverLabel>跳转</PopoverLabel>
        <PopoverItem onClick={jumpToFirst}>
          <span>{isVideo ? "第一个视频" : "第一张"}</span>
          <span className="ml-auto text-[12.5px] text-white/55">Home</span>
        </PopoverItem>
        <PopoverItem onClick={jumpToLast}>
          <span>{isVideo ? "最后一个视频" : "最后张"}</span>
          <span className="ml-auto text-[12.5px] text-white/55">End</span>
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
  ariaLabel,
  active,
  hideOnMobile,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  /** 可访问名；缺省时退回 title（图标按钮的可访问名不能只靠图标）。 */
  ariaLabel?: string;
  active?: boolean;
  hideOnMobile?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel ?? title}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
        hideOnMobile ? "hidden sm:inline-flex" : ""
      } ${
        active
          ? "bg-white/15 text-white"
          : "text-white/80 hover:bg-white/10 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
