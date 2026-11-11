// 内联 SVG 图标组件，统一尺寸与线宽。
// 命名沿用业内常规语义，可独立 import 使用。
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number;
};

function base({
  size = 18,
  strokeWidth = 1.6,
  ...rest
}: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...rest,
  };
}

export const HomeIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 11.5 12 4l9 7.5" />
    <path d="M5 10.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9.5" />
  </svg>
);

export const ClockIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const StarIcon = (p: IconProps & { filled?: boolean }) => {
  const { filled, ...rest } = p;
  return (
    <svg {...base(rest)}>
      <path
        d="M12 3.5l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.9l6-.9L12 3.5z"
        fill={filled ? "currentColor" : "none"}
      />
    </svg>
  );
};

export const SettingsIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9 1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.36.16.74.27 1.09.36V21a2 2 0 0 1-2 2h-.09c-.36 0-.73-.2-1.09-.36z" />
  </svg>
);

export const SearchIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const MenuIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export const ScanIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 7V5a1 1 0 0 1 1-1h2" />
    <path d="M20 7V5a1 1 0 0 0-1-1h-2" />
    <path d="M4 17v2a1 1 0 0 0 1 1h2" />
    <path d="M20 17v2a1 1 0 0 1-1 1h-2" />
    <path d="M7 12h10" />
  </svg>
);

export const SunIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4" />
  </svg>
);

export const MoonIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

export const MonitorIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

export const FolderIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </svg>
);

// 「打开文件夹」图标：FolderIcon + 右下箭头,表示"在文件管理器中打开"
export const FolderOpenIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 14l1.5-5h11l-1.5 5H6z" />
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H5a2 2 0 0 0-2 2V7z" />
    <path d="M14 11l3 3m0 0l-1.5 1.5M17 14H21" />
  </svg>
);

// 「搜索/选择文件夹」图标：FolderIcon + 放大镜,表示"用选择器选目录"
export const FolderSearchIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    <circle cx="11" cy="13" r="2" />
    <path d="M12.5 14.5L14 16" />
  </svg>
);

export const ImageIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.5" />
    <path d="m4 18 5-5 4 4 3-3 4 4" />
  </svg>
);

export const PeopleIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 20v-1a5.5 5.5 0 0 1 11 0v1z" />
    <path d="M16 5.5a3 3 0 0 1 0 5.8M18 14a4.5 4.5 0 0 1 2.5 4v2" />
  </svg>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m15 6-6 6 6 6" />
  </svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const PlusIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const MinusIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 12h14" />
  </svg>
);

export const RefreshIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.4-4.1" />
    <path d="M3 12a9 9 0 0 1 16.4-4.4" />
    <path d="M21 4v5h-5M3 20v-5h5" />
  </svg>
);

export const FullscreenIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
  </svg>
);

export const InfoIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8h.01M11 12h1v4h1" />
  </svg>
);

export const HelpIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 1-1 1.7" />
    <path d="M12 17h.01" />
  </svg>
);

export const CloseIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const ReaderIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 5a1 1 0 0 1 1-1h5v15H5a1 1 0 0 1-1-1V5z" />
    <path d="M20 5a1 1 0 0 0-1-1h-5v15h5a1 1 0 0 0 1-1V5z" />
  </svg>
);

export const RotateIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 12a9 9 0 0 1 15.5-6.3M21 12a9 9 0 0 1-15.5 6.3" />
    <path d="M18 3v4h-4M6 21v-4h4" />
  </svg>
);

export const TrashIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
  </svg>
);

export const LibraryIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 19V6a2 2 0 0 1 2-2h12v17H6a2 2 0 0 1-2-2z" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </svg>
);

export const GridIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

export const ListIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <line x1="8" y1="6" x2="20" y2="6" />
    <line x1="8" y1="12" x2="20" y2="12" />
    <line x1="8" y1="18" x2="20" y2="18" />
    <circle cx="4" cy="6" r="1" fill="currentColor" />
    <circle cx="4" cy="12" r="1" fill="currentColor" />
    <circle cx="4" cy="18" r="1" fill="currentColor" />
  </svg>
);

export const CheckIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m5 12 5 5L20 7" />
  </svg>
);

// 复制：两张叠在一起的纸
export const CopyIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

// 重温 / 倒带：环形箭头朝左
export const RewindIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);

// 全新 / 闪光：四角星（与重温/继续阅读的图标节奏一致）
export const SparklesIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3l1.6 4.2L18 9l-4.4 1.8L12 15l-1.6-4.2L6 9l4.4-1.8L12 3z" />
    <path d="M19 14l.7 1.8L21.5 17l-1.8.7L19 19.5l-.7-1.8L16.5 17l1.8-1.2L19 14z" />
  </svg>
);

// 更多：水平三点（用于菜单折叠入口）
export const MoreHorizontalIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

// 日历
export const CalendarIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 9h18M8 3v4M16 3v4" />
  </svg>
);

export const AlertIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3 2 21h20L12 3z" />
    <path d="M12 10v5M12 18h.01" />
  </svg>
);

export const PlayFilledIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M7 5v14l12-7z" fill="currentColor" stroke="none" />
  </svg>
);

export const KeyboardIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2" y="6" width="20" height="14" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M8 17h8" />
  </svg>
);

export const ChevronUpIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m18 15-6-6-6 6" />
  </svg>
);

export const ShuffleIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M16 3h5v5" />
    <path d="M4 20 21 3" />
    <path d="M21 16v5h-5" />
    <path d="m15 15 6 6" />
    <path d="M4 4l5 5" />
  </svg>
);

/** 交换：左右两支反向箭头 */
export const ArrowsIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 9h13" />
    <path d="m14 6 3 3-3 3" />
    <path d="M20 15H7" />
    <path d="m10 12-3 3 3 3" />
  </svg>
);

/** 精选：圆圈里的勾。照片墙上的精选角标就是它。 */
export const PickIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.2 12.3 2.6 2.6 5-5.4" />
  </svg>
);

/** 取消标记：圆圈加斜杠。精选角标是「圆圈 + 勾」，去掉它就是这个。 */
export const UncheckIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m6.5 6.5 11 11" />
  </svg>
);

/** 多选：方框里一个小方块 */
export const SelectIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
    <rect
      x="8"
      y="8"
      width="8"
      height="8"
      rx="1.5"
      fill="currentColor"
      stroke="none"
    />
  </svg>
);

/** 未读 / 新内容:四角星 + 中心点,代表"新" */
export const SparkleIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" />
    <path d="M19 16l.7 2L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-1z" />
  </svg>
);

/** 漏斗:filter / 过滤 通用图标(用于 ListFilterBar 最小图数控件) */
export const FilterIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 5h18l-7 9v6l-4-2v-4z" />
  </svg>
);

/** 单页：单页居中 */
export const SinglePageIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="6" y="4" width="12" height="16" rx="1" />
  </svg>
);

/** 连续滚动：垂直堆叠的多页 */
export const ScrollPageIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="6" y="3" width="12" height="5" rx="1" />
    <rect x="6" y="10" width="12" height="5" rx="1" />
    <rect x="6" y="17" width="12" height="4" rx="1" />
  </svg>
);

/** 双页：左右并排 */
export const DoublePageIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="8" height="16" rx="1" />
    <rect x="13" y="4" width="8" height="16" rx="1" />
  </svg>
);

/** 适应：contain 缩放 */
export const FitIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
    <path d="M9 9h6v6H9z" />
  </svg>
);

/** 按宽：w-100% */
export const FitWidthIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
    <path d="M9 8h6v8H9z" />
  </svg>
);

/** 按高：h-100vh */
export const FitHeightIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
    <path d="M7 9h10v6H7z" />
  </svg>
);

/** 原始：1:1 */
export const OriginalSizeIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
    <text
      x="12"
      y="14"
      textAnchor="middle"
      fontSize="7"
      fill="currentColor"
      stroke="none"
    >
      1:1
    </text>
  </svg>
);

/** 从左到右 */
export const ArrowRightLineIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 12h16" />
    <path d="m14 6 6 6-6 6" />
  </svg>
);

/** 从右到左翻页（适合从右到左的出版物） */
export const ArrowLeftLineIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 12h16" />
    <path d="m10 6-6 6 6 6" />
  </svg>
);

/** 右上箭头（hover 时暗示"点击进入"） */
export const ArrowUpRightIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M7 17 17 7" />
    <path d="M7 7h10v10" />
  </svg>
);

/** 上一本 / 上一项（粗箭头向上） */
export const ArrowUpIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 4v16" />
    <path d="m5 11 7-7 7 7" />
  </svg>
);

/** 下一本 / 下一项（粗箭头向下） */
export const ArrowDownIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 4v16" />
    <path d="m5 13 7 7 7-7" />
  </svg>
);

/** 服务器（机柜） */
export const ServerIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="4" y="3" width="16" height="7" rx="1" />
    <rect x="4" y="14" width="16" height="7" rx="1" />
    <path d="M7 6.5h.01M7 17.5h.01" />
  </svg>
);

/** 盾牌（安全 / 隐私） */
export const ShieldIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3 4 6v6c0 4.5 3 8.4 8 9 5-.6 8-4.5 8-9V6l-8-3z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

/** 重启（循环箭头） */
export const RestartIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);

/** 图片（用于缩略图相关） */
export const ThumbIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.5" />
    <path d="m4 18 5-5 4 4 3-3 4 4" />
  </svg>
);

/** 拍摄地点 */
export const MapPinIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
    <circle cx="12" cy="10" r="2.5" />
  </svg>
);

/** 任务列表 */
export const TasksIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2" />
  </svg>
);
