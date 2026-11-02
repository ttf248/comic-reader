import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useGalleryStore } from "../../store/galleryStore";
import { imageUrl } from "../../api/images";
import { ImageIcon } from "../common/Icon";

interface Props {
  images: string[];
  /** 点击图片时触发：根据 clickX 在容器宽度的左/中/右决定动作。父组件传入 prev/next 即可。 */
  onClickNavigate?: (dir: -1 | 0 | 1) => void;
  /** 连续模式可见范围变化时，上报首尾两个 0-based 索引。 */
  onVisibleRangeChange?: (startIndex: number, endIndex: number) => void;
}

type Aspect =
  | { mode: "fit" } // contain
  | { mode: "width" } // 100% 宽，自适应高
  | { mode: "height" } // 100vh 高，水平居中
  | { mode: "original" }; // 自然尺寸

// 图片画廊：
// - 三种显示模式：单张 / 连续滚动 / 双张并排
// - 四种适配：适应 / 按宽 / 按高 / 原始
// - 双张并排模式下支持 LTR / RTL（右→左：从右开始翻页）
// - 缩放 / 旋转 / 拖拽 / 预加载 ±2
// - 点击翻页：左半区上一页 / 右半区下一页 / 中段 30% 不响应避免误触
export default function ImageGallery({
  images,
  onClickNavigate,
  onVisibleRangeChange,
}: Props) {
  const index = useGalleryStore((s) => s.index);
  const zoom = useGalleryStore((s) => s.zoom);
  const rotation = useGalleryStore((s) => s.rotation);
  const mode = useGalleryStore((s) => s.mode);
  const fit = useGalleryStore((s) => s.fit);
  const direction = useGalleryStore((s) => s.direction);

  const containerRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const continuousVisibleIndexRef = useRef<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [imgKey, setImgKey] = useState(0);
  const dragRef = useRef<{
    x: number;
    y: number;
    px: number;
    py: number;
    moved: boolean;
    pointerType: string;
  } | null>(null);
  const suppressClickRef = useRef(false);

  // 预加载前后各 2 张
  useEffect(() => {
    const ranges = [index - 2, index - 1, index + 1, index + 2];
    for (const i of ranges) {
      const p = images[i];
      if (!p) continue;
      const img = new Image();
      img.src = imageUrl(p);
    }
  }, [index, images]);

  // 切页 / 切模式时复位 transform;切模式时复位容器滚动。
  // 关键:连续模式下切页(index 变)不再重置 scrollTop,
  // 否则 PageSlider.onJump 调的 scrollContinuousTo (target.scrollIntoView)
  // 会立刻被这个 effect 滚回 0,导致拖动 slider 后页面又跳回第 0 张。
  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setImgKey((k) => k + 1);
  }, [index, mode]);

  useEffect(() => {
    // 只在切模式时滚回 0;切 index 不动 scroll,留给 jumpTo / scrollContinuousTo
    // 自己管定位。连续模式切回 0 也没事 —— 切到连续时另一个 effect (Gallery.tsx)
    // 会 scrollContinuousTo(index) 把当前 index 滚进来,用户不会停在 0。
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
      containerRef.current.scrollLeft = 0;
    }
  }, [mode]);

  // 连续模式下，外部的页码跳转（恢复进度、滑杆、Home/End）通过 store.index
  // 驱动 Virtuoso 定位；自然滚动上报 index 时会先更新 visible ref，因此不会
  // 反向触发 scrollToIndex 形成滚动反馈环。
  useEffect(() => {
    if (mode !== "continuous" || images.length === 0) {
      continuousVisibleIndexRef.current = null;
      return;
    }
    const targetIndex = Math.max(
      0,
      Math.min(images.length - 1, Math.floor(index)),
    );
    if (continuousVisibleIndexRef.current === targetIndex) return;
    virtuosoRef.current?.scrollToIndex({ index: targetIndex, align: "start" });
  }, [mode, images.length, index]);

  // 滚轮缩放：所有模式统一为 Ctrl/Cmd + wheel 才触发。
  // 普通 wheel 留给浏览器原生滚动（单/双页溢出滚动、连续模式翻页）。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      const store = useGalleryStore.getState();
      if (dir > 0) store.zoomIn();
      else store.zoomOut();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 单页模式下统一用 Pointer Events 处理鼠标拖拽和触摸手势：
  // - 放大时拖动图片；
  // - 原始大小时横向滑动翻页；
  // - 连续/双页模式保留浏览器原生滚动，不抢占手势。
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== "single") return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      px: pan.x,
      py: pan.y,
      moved: false,
      pointerType: e.pointerType,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const gesture = dragRef.current;
    if (!gesture) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) gesture.moved = true;
    if (zoom > 1) {
      setPan({ x: gesture.px + dx, y: gesture.py + dy });
    }
  };

  const finishPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const gesture = dragRef.current;
    if (!gesture) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);

    if (gesture.moved) suppressClickRef.current = true;
    const isTouch = gesture.pointerType !== "mouse";
    const isSwipe =
      isTouch &&
      zoom <= 1 &&
      Math.abs(dx) >= 48 &&
      Math.abs(dx) > Math.abs(dy) * 1.2;
    if (isSwipe && onClickNavigate) {
      e.preventDefault();
      onClickNavigate(dx < 0 ? 1 : -1);
    }
  };

  const cancelPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const gesture = dragRef.current;
    if (!gesture) return;
    dragRef.current = null;
    if (gesture.moved) suppressClickRef.current = true;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // 点击翻页：根据 clickX 在容器宽度的左/中/右决定 -1/0/+1
  // - 中段 30% 不响应，避免用户想"瞄准"图片内容时误触翻页
  // - 缩放 > 1 时不响应（用户想拖动图片而不是翻页）
  // - 双击是独立事件，不会触发 click；拖拽距离 > 3px 时 click 也不触发
  const onContainerClick = (e: React.MouseEvent) => {
    if (!onClickNavigate) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (mode === "single" && zoom > 1) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = x / rect.width;
    let dir: -1 | 0 | 1 = 0;
    if (ratio < 0.35) dir = -1;
    else if (ratio > 0.65) dir = 1;
    if (dir !== 0) onClickNavigate(dir);
  };

  // 单页模式下，索引到当前页（双页模式 index 指向左页）
  const current = images[index];

  // 解析 fit → 样式 / 容器类
  const aspect: Aspect = useMemo(() => ({ mode: fit }), [fit]);
  const isSingle = mode === "single";
  const isContinuous = mode === "continuous";

  // 容器公共类
  // 单页模式：容器自己滚动 + flex 居中
  // 连续 / 双页模式：容器滚动（避免上层 / 下层元素双层滚动）
  // 背景用透明，让外层（Gallery 的深色画布）决定整体氛围
  //
  // 原始尺寸模式例外：图片比视口大，居中对齐会让溢出的一侧滚不到
  // （flex 居中 + overflow 的已知问题），此时从左上角开始并允许滚动。
  const containerCls = isSingle
    ? `relative flex-1 overflow-auto flex ${
        aspect.mode === "original"
          ? "items-start justify-start"
          : "items-center justify-center"
      } min-h-0`
    : "relative flex-1 overflow-auto min-h-0";
  const containerStyle: React.CSSProperties | undefined = isSingle
    ? { touchAction: zoom > 1 ? "none" : "pan-y" }
    : undefined;
  // data-image-gallery 让外部（Gallery 路由）能定位连续模式下的单图
  // （用于 Home/End 跳到首/尾图片的 scrollIntoView）。
  const dataImageGalleryProps = { "data-image-gallery": "" } as const;

  // 单张图片的尺寸 / object-fit 规则
  function imgStyleFor(zoomOverride?: number): React.CSSProperties {
    const z = zoomOverride ?? zoom;
    const transform = isSingle
      ? `translate(${pan.x}px, ${pan.y}px) scale(${z}) rotate(${rotation}deg)`
      : `rotate(${rotation}deg)`;
    const base: React.CSSProperties = {
      transform,
      transformOrigin: "center",
      transition: dragRef.current ? "none" : "transform 200ms var(--ease-out)",
    };
    if (aspect.mode === "fit") {
      return {
        ...base,
        maxWidth: "100%",
        maxHeight: "100%",
        objectFit: "contain" as const,
      };
    }
    if (aspect.mode === "width") {
      return { ...base, width: "100%", height: "auto" };
    }
    if (aspect.mode === "height") {
      return { ...base, height: "100vh", width: "auto", maxWidth: "100%" };
    }
    // 原始尺寸：按像素原样显示，由容器滚动查看。
    // flex 子项默认会被压缩到容器宽度；Tailwind preflight 还给 img 设了
    // max-width: 100%，两者都要显式解除，否则原始尺寸会被夹回视口宽度。
    return {
      ...base,
      width: "auto",
      height: "auto",
      maxWidth: "none",
      flexShrink: 0,
    };
  }

  function imgClassFor(): string {
    const baseCls = "select-none scale-fade";
    if (isSingle) {
      return `${baseCls} ${zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`;
    }
    return baseCls;
  }

  if (isSingle) {
    return (
      <div
        ref={containerRef}
        className={containerCls}
        style={containerStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={cancelPointer}
        onContextMenu={(e) => e.preventDefault()}
        onClick={onContainerClick}
        {...dataImageGalleryProps}
      >
        {current ? (
          <GalleryImage
            key={imgKey}
            src={imageUrl(current)}
            alt={`第 ${index + 1} 张`}
            onDoubleClick={() => {
              const store = useGalleryStore.getState();
              if (store.zoom > 1) {
                store.zoomReset();
                setPan({ x: 0, y: 0 });
              } else {
                // 与滚轮/键盘 `+` 一致：每次 +20%
                store.zoomIn();
              }
            }}
            className={imgClassFor()}
            style={imgStyleFor()}
          />
        ) : (
          <div className="text-fg-muted">未选择图片</div>
        )}
      </div>
    );
  }

  if (isContinuous) {
    // 连续滚动模式:用 react-virtuoso 的 Virtuoso 做窗口化,只渲染视口
    // 上下 ±overscan 范围内的图。1000+ 张大本连续模式不再一次性挂 1000+
    // 个 <img>,DOM 节点数稳定在视口高度相关的小常数。
    //
    // 交互约束:
    //   - click 翻页 / contextmenu 阻止 / data-image-gallery 属性挂在外层
    //   - 缩放(zoom)变化时 virtuoso 通过 overscan 重新计算可视窗口
    //   - rotate 同理
    //   - 切页 index 变时 Virtuoso 用 itemContent 重新计算,大本下应能正确跟随
    return (
      <div
        ref={containerRef}
        className={containerCls}
        onContextMenu={(e) => e.preventDefault()}
        onClick={onContainerClick}
        {...dataImageGalleryProps}
      >
        <Virtuoso
          ref={virtuosoRef}
          style={{ height: "100%" }}
          data={images}
          overscan={3}
          rangeChanged={(range) => {
            if (images.length === 0) return;
            const startIndex = Math.max(
              0,
              Math.min(images.length - 1, range.startIndex),
            );
            const endIndex = Math.max(
              startIndex,
              Math.min(images.length - 1, range.endIndex),
            );
            continuousVisibleIndexRef.current = startIndex;
            onVisibleRangeChange?.(startIndex, endIndex);
          }}
          itemContent={(i, src) => (
            <ContinuousImage
              src={src}
              index={i}
              aspect={aspect}
              nearIndex={Math.abs(i - index) <= 2}
              isRotated={rotation !== 0}
              zoom={zoom}
            />
          )}
        />
      </div>
    );
  }

  // double mode
  return (
    <div
      ref={containerRef}
      className={containerCls}
      onContextMenu={(e) => e.preventDefault()}
      onClick={onContainerClick}
      {...dataImageGalleryProps}
    >
      <DoublePage
        images={images}
        index={index}
        aspect={aspect}
        direction={direction}
        imgKey={imgKey}
      />
    </div>
  );
}

interface DoubleProps {
  images: string[];
  index: number;
  aspect: Aspect;
  direction: "ltr" | "rtl";
  imgKey: number;
}

// 双张并排模式：每两张为一对，左侧 = index，右侧 = index+1。
// RTL（从右到左翻页）时右侧在前，左侧在后。
function DoublePage({ images, index, aspect, direction, imgKey }: DoubleProps) {
  const left = images[index];
  const right = images[index + 1];

  // RTL 把 (left, right) 反过来渲染
  const order: Array<"left" | "right"> =
    direction === "rtl" ? ["right", "left"] : ["left", "right"];
  const pages: Array<{ key: "left" | "right"; src: string | undefined }> = [
    { key: "left", src: left },
    { key: "right", src: right },
  ];
  const ordered = order
    .map((k) => pages.find((p) => p.key === k)!)
    .filter(Boolean);

  function pageClass() {
    if (aspect.mode === "fit") {
      return "max-w-full max-h-full object-contain";
    }
    if (aspect.mode === "width") {
      return "w-full h-auto";
    }
    if (aspect.mode === "height") {
      return "h-screen w-auto max-w-full";
    }
    return "w-auto h-auto";
  }

  return (
    <div
      key={imgKey}
      className="flex flex-row items-center justify-center w-full h-full gap-1 p-2"
    >
      {ordered.map((p, i) => (
        <div key={p.key + i} className="flex-1 min-w-0 flex justify-center">
          {p.src ? (
            <GalleryImage
              src={imageUrl(p.src)}
              alt={`第 ${p.key === "left" ? "左" : "右"} 页`}
              loading="eager"
              className={`select-none ${pageClass()}`}
            />
          ) : (
            <div className="text-fg-subtle text-xs">（空白）</div>
          )}
        </div>
      ))}
    </div>
  );
}

// 连续模式下的单张图：根据 fit 模式选择样式。
// 关键：使用 maxWidth: 100% + block 布局，让图片按比例缩放并触发容器纵向滚动。
// 缩放：用 transform: scale(zoom) 叠加在 fit 尺寸之上，
//   transform-origin 设为 top center，缩放时从顶部对齐，
//   整体高度随之增加 → 容器自然出现纵向滚动条，用户可继续往下看。
interface ContinuousImageProps {
  src: string;
  index: number;
  aspect: Aspect;
  nearIndex: boolean;
  isRotated: boolean;
  zoom: number;
}

// 用 React.memo 包:1000+ 张大本里,父 re-render(切 index/zoom)时
// 1000 个子组件一起 re-render 是真实瓶颈。memo 走 props 浅比较,只
// 真正发生变化的子组件(nearIndex 翻转 / 自己的 zoom 变 / 自己的
// isRotated 变)会 re-render。
const ContinuousImage = memo(function ContinuousImage({
  src,
  index,
  aspect,
  nearIndex,
  isRotated,
  zoom,
}: ContinuousImageProps) {
  const baseStyle: React.CSSProperties = {
    display: "block",
    maxWidth: "100%",
    height: "auto",
  };
  let style: React.CSSProperties;
  if (aspect.mode === "fit") {
    // 适应：宽度 100%，高度自适应（按原比例），浏览器自动堆叠可滚动
    style = { ...baseStyle, width: "100%", height: "auto" };
  } else if (aspect.mode === "width") {
    // 按宽：同上
    style = { ...baseStyle, width: "100%", height: "auto" };
  } else if (aspect.mode === "height") {
    // 按高：每张图占满视口高度（适合长条图）→ 高度 100vh，宽度按比例
    style = {
      ...baseStyle,
      height: "100vh",
      width: "auto",
      maxHeight: "100vh",
    };
  } else {
    // 原始：自然尺寸，超过容器宽度时缩小
    style = { ...baseStyle, width: "auto", height: "auto", maxWidth: "100%" };
  }

  // 缩放：连续模式下用 transform，避免破坏流式布局。
  // transform-origin: top center → 缩放时图片从顶部对齐，下方自然溢出形成滚动。
  const transforms: string[] = [];
  if (zoom !== 1) transforms.push(`scale(${zoom})`);
  if (isRotated) transforms.push("rotate(90deg)");
  if (transforms.length) {
    style = {
      ...style,
      transform: transforms.join(" "),
      transformOrigin: isRotated ? "center" : "top center",
    };
  }

  return (
    <div className="w-full flex justify-center" data-image-index={index}>
      <GalleryImage
        src={imageUrl(src)}
        alt={`第 ${index + 1} 张`}
        loading={nearIndex ? "eager" : "lazy"}
        decoding={nearIndex ? "sync" : "async"}
        className="select-none scale-fade"
        style={style}
      />
    </div>
  );
});

// 阅读器里的单张图片：加载失败时显示占位，而不是浏览器的破图图标。
//
// 失败是真实存在的：服务端没有 ffmpeg 时 HEIC/TIFF 会被拒绝（415），
// 源文件被删除或损坏时也会 404。破图图标没有任何说明，用户无从判断
// 是图片坏了还是网络断了。
function GalleryImage({
  src,
  alt,
  className,
  style,
  loading = "eager",
  decoding = "async",
  onDoubleClick,
}: {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  loading?: "eager" | "lazy";
  decoding?: "sync" | "async";
  onDoubleClick?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  // 换图后重置失败态，避免上一张的失败影响下一张。
  useEffect(() => setFailed(false), [src]);

  if (failed) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-2 text-fg-subtle ${className ?? ""}`}
        role="img"
        aria-label={alt}
        title="该图片无法显示"
      >
        <ImageIcon size={28} />
        <span className="text-xs">该图片无法显示</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      draggable={false}
      loading={loading}
      decoding={decoding}
      onError={() => setFailed(true)}
      onDoubleClick={onDoubleClick}
      className={className}
      style={style}
    />
  );
}
