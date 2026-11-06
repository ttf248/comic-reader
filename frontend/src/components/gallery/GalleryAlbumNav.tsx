import { ArrowUpIcon, ArrowDownIcon } from "../common/Icon";

interface Props {
  visible: boolean;
  onPrevAlbum?: () => void;
  onNextAlbum?: () => void;
  /** 目标卷名：悬停时浮在箭头旁边，回答「点下去会翻到哪一卷」。 */
  prevLabel?: string;
  nextLabel?: string;
}

// 跨卷导航（上一卷 / 下一卷）。
//
// 2026-11 重设计后，阅读控制已经全部收到画面底部的浮动工具条里，
// 画面右侧不再竖排控件 —— 那里会压住图片右缘，也会挡住窄屏唯一
// 可靠的翻页热区（点击右侧三分之一）。
//
// 跨卷导航保留在画面左侧竖排：它是低频但有辨识度的操作（这个项目的
// 卖点之一就是「读完这卷接着翻下一卷」），需要常驻可见，不能藏进菜单。
//
// 样式刻意做轻 —— 不带玻璃面板，只在 hover 时浮出浅底，避免和图片抢戏。
// 但"轻"不能等于"看不见"：箭头是白图标，压在亮照片上时白/70 的实际
// 对比度只有 1.4:1（WCAG 对非文本控件要求 ≥3:1），实拍确认箭头在明亮
// 画面上几乎消失。所以给每枚箭头配一层恒定的深色圆底 —— 底色只盖
// 36px 的小圆，比玻璃面板轻得多，却保证箭头的局部背景永远是深色。
export default function GalleryAlbumNav({
  visible,
  onPrevAlbum,
  onNextAlbum,
  prevLabel,
  nextLabel,
}: Props) {
  if (!onPrevAlbum && !onNextAlbum) return null;

  return (
    <div
      className={`absolute left-2 sm:left-3 top-1/2 z-10 hidden -translate-y-1/2 flex-col gap-1 transition-opacity duration-300 md:flex ${
        visible ? "opacity-100" : "opacity-0 pointer-events-none"
      }`}
    >
      {onPrevAlbum && (
        <NavButton onClick={onPrevAlbum} title="上一卷 (P)" label={prevLabel}>
          <ArrowUpIcon size={17} />
        </NavButton>
      )}
      {onNextAlbum && (
        <NavButton onClick={onNextAlbum} title="下一卷 (N)" label={nextLabel}>
          <ArrowDownIcon size={17} />
        </NavButton>
      )}
    </div>
  );
}

function NavButton({
  children,
  onClick,
  title,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  label?: string;
}) {
  return (
    <div className="group/nav flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-label={label ? `${title}：${label}` : title}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-overlay-panel/55 text-overlay-fg backdrop-blur-[2px] ring-1 ring-overlay-border transition-colors hover:bg-overlay-panel/75 hover:text-overlay-fg"
      >
        {children}
      </button>
      {/* 目标卷名：只在悬停时浮出，平时不占画面。 */}
      {label && (
        <span className="pointer-events-none max-w-[10rem] truncate rounded-md bg-overlay-panel/80 px-2 py-1 text-meta text-overlay-fg opacity-0 backdrop-blur-[2px] transition-opacity duration-150 group-hover/nav:opacity-100">
          {label}
        </span>
      )}
    </div>
  );
}
