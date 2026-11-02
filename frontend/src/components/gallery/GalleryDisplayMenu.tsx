import {
  useGalleryStore,
  type FitMode,
  type ReaderMode,
} from "../../store/galleryStore";
import Popover, {
  PopoverItem,
  PopoverLabel,
  PopoverSeparator,
} from "../common/Popover";
import {
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
  ArrowRightLineIcon,
  ArrowLeftLineIcon,
  SettingsIcon,
} from "../common/Icon";

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

const FIT_OPTIONS: {
  value: FitMode;
  label: string;
  icon: typeof FitIcon;
}[] = [
  { value: "fit", label: "适应", icon: FitIcon },
  { value: "width", label: "按宽", icon: FitWidthIcon },
  { value: "height", label: "按高", icon: FitHeightIcon },
  { value: "original", label: "原始", icon: OriginalSizeIcon },
];

// 窄屏阅读设置。
//
// 桌面端右侧那列悬浮控件在手机上会盖住图片右缘，还挡住"点击右侧翻下一张"的
// 热区（连翻页按钮本身在窄屏也是隐藏的，只剩一个空面板）。因此小屏把这些
// 操作收进顶栏的弹层，桌面端仍用悬浮控件。
export default function GalleryDisplayMenu() {
  const mode = useGalleryStore((s) => s.mode);
  const fit = useGalleryStore((s) => s.fit);
  const zoom = useGalleryStore((s) => s.zoom);
  const rotation = useGalleryStore((s) => s.rotation);
  const direction = useGalleryStore((s) => s.direction);
  const setMode = useGalleryStore((s) => s.setMode);
  const setFit = useGalleryStore((s) => s.setFit);
  const setDirection = useGalleryStore((s) => s.setDirection);
  const zoomIn = useGalleryStore((s) => s.zoomIn);
  const zoomOut = useGalleryStore((s) => s.zoomOut);
  const zoomReset = useGalleryStore((s) => s.zoomReset);
  const rotate = useGalleryStore((s) => s.rotate);

  return (
    <Popover
      aria-label="阅读设置"
      className="w-[220px]"
      trigger={
        <button
          type="button"
          className="inline-flex items-center justify-center h-8 w-8 rounded-md text-white/80 hover:text-white hover:bg-white/10 transition-colors"
          title="阅读设置"
          aria-label="阅读设置"
        >
          <SettingsIcon size={13} />
        </button>
      }
    >
      <PopoverLabel>阅读模式</PopoverLabel>
      {MODE_OPTIONS.map((o) => (
        <PopoverItem
          key={o.value}
          active={mode === o.value}
          onClick={() => setMode(o.value)}
        >
          <o.icon size={12} />
          <span>{o.label}</span>
          <span className="ml-auto text-[11.5px] text-fg-subtle">{o.key}</span>
        </PopoverItem>
      ))}
      <PopoverSeparator />
      <PopoverLabel>适配（F 循环）</PopoverLabel>
      {FIT_OPTIONS.map((o) => (
        <PopoverItem
          key={o.value}
          active={fit === o.value}
          onClick={() => setFit(o.value)}
        >
          <o.icon size={12} />
          <span>{o.label}</span>
        </PopoverItem>
      ))}
      <PopoverSeparator />
      <PopoverLabel>缩放与旋转</PopoverLabel>
      <PopoverItem onClick={zoomOut}>
        <MinusIcon size={12} />
        <span>缩小</span>
        <span className="ml-auto text-[11.5px] text-fg-subtle">-</span>
      </PopoverItem>
      <PopoverItem onClick={zoomReset}>
        <span className="w-3" aria-hidden />
        <span>实际大小</span>
        <span className="ml-auto text-[11.5px] text-fg-subtle tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
      </PopoverItem>
      <PopoverItem onClick={zoomIn}>
        <PlusIcon size={12} />
        <span>放大</span>
        <span className="ml-auto text-[11.5px] text-fg-subtle">+</span>
      </PopoverItem>
      <PopoverItem onClick={() => rotate(90)}>
        <RotateIcon size={12} />
        <span>旋转 90°（当前 {rotation}°）</span>
        <span className="ml-auto text-[11.5px] text-fg-subtle">R</span>
      </PopoverItem>
      {mode === "double" && (
        <PopoverItem
          onClick={() => setDirection(direction === "ltr" ? "rtl" : "ltr")}
        >
          {direction === "ltr" ? (
            <ArrowRightLineIcon size={12} />
          ) : (
            <ArrowLeftLineIcon size={12} />
          )}
          <span>阅读方向：{direction === "ltr" ? "左→右" : "右→左"}</span>
          <span className="ml-auto text-[11.5px] text-fg-subtle">L</span>
        </PopoverItem>
      )}
    </Popover>
  );
}
