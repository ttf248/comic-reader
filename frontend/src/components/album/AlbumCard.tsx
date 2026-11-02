import {
  useEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import AlbumContextMenu from "./AlbumContextMenu";
import PropertiesDialog from "../common/PropertiesDialog";
import {
  StarIcon,
  FolderIcon,
  ReaderIcon,
  RewindIcon,
  CheckIcon,
  ClockIcon,
  ArrowUpRightIcon,
  PlayFilledIcon,
} from "../common/Icon";
import HoverPreview from "../common/HoverPreview";
import TranscodeStatusBadge from "../common/TranscodeStatusBadge";
import { useUIStore, type ViewMode } from "../../store/uiStore";
import { timeAgo } from "../../utils/date";
import { formatDuration } from "../../utils/format";
import { isCompleted, isUnread, progressPercent } from "../../utils/progress";
import { favoriteResourceId } from "../../utils/path";
import { useToggleFavorite } from "../../hooks/useFavorites";
import CardCover from "./CardCover";

export type CardVariant = "album" | "collection" | "smart";
export type CardBadge = "rewind"; // 重温：30 天以上没看

export interface CardData {
  id: string;
  variant: CardVariant;
  // 原始名（来自后端 album.name）
  title: string;
  // 多根冲突时显示的"处理后"名；与 title 不同时说明带来源前缀
  displayTitle?: string;
  // 副标题（集合 / smart 通常为空；album 显示标签或路径 basename）
  subtitle?: string;
  /** variant='album' 时为图片数，其他变体时为子相册数。 */
  count: number;
  /** 视频数（仅 album 变体有意义）。0 或缺省按"无视频"渲染。 */
  videoCount?: number;
  /** 图片数（仅 album 变体有意义），与 videoCount 一起区分纯视频相册。 */
  imageCount?: number;
  /** 后端摘要中的修改时间，供列表的「最近改」排序使用。 */
  modTime?: string;
  coverPath: string;
  /** 集合 / 智能视图的代表封面，按顺序最多展示四张；为空时回退到 coverPath。 */
  covers?: string[];
  /**
   * 封面源类型："image" / "video" / 不传（不传时由 coverPath 扩展名推断）。
   * 视频封面由前端浏览器抽帧 → 上传后才会显示首帧静态图（见 useVideoCover）。
   */
  coverKind?: "image" | "video";
  /**
   * 当 cover 是视频时，可附带总时长（秒）显示在角标。
   * 由调用方在用 <video> 探测后填入；非必填，缺省时角标只显示 ▶。
   */
  durationSec?: number;
  to: string;
  isFavorite?: boolean;
  // 阅读进度：index + total，用于显示百分比与定位条
  progress?: { index: number; total: number };
  // 上次阅读时间（ISO），用于悬停预览的「上次 X」展示
  lastSeenAt?: string | null;
  // 来源媒体根（多根扫描时填充）。前端用来显示 badge "来自 X"
  sourceRoot?: string;
  // 来源媒体根的 basename（直接给 UI 用）
  sourceName?: string;
  // 角标：当前只支持重温；未来可扩展
  badge?: CardBadge;
}

interface Props {
  data: CardData;
  variant?: ViewMode;
  /** 显示「上次 X · 看到 Y/Z」行（仅 Recents 列表需要）。 */
  showLastSeen?: boolean;
  /** 列表容器统一持有菜单，独立卡片则在本地展示同一套操作。 */
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  /**
   * 封面右上角的额外操作（如「标记为已读」）。
   * 渲染在链接之外的浮层里，避免在 <a> 内嵌套按钮；仅网格视图支持。
   */
  overlayAction?: ReactNode;
}

// 通用卡片：网格（统一 4:5 封面）/ 列表（横向缩略图 + 元数据）。
// 设计：
//  - 不画死板边框；hover 时给 cover 细微的明度变化 + 上浮
//  - 标题短截断 2 行；副标题只 1 行
//  - 阅读进度以底部细线 + 数字显示
//  - 智能集合有专属角标
//  - showLastSeen=true 时在标题下加一行「上次 X · 看到 Y/Z」
export default function AlbumCard({
  data,
  variant = "grid",
  showLastSeen,
  onContextMenu,
  overlayAction,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [propertiesId, setPropertiesId] = useState<string | null>(null);
  const toggleFavorite = useToggleFavorite();
  const pushToast = useUIStore((s) => s.pushToast);
  const label = data.displayTitle ?? data.title;

  // 星标直接写收藏：失败时给出中文提示，不让失败静默。
  const onToggleFavorite = async () => {
    try {
      await toggleFavorite(favoriteResourceId(data));
      pushToast({
        kind: "success",
        message: data.isFavorite
          ? `已取消收藏「${label}」`
          : `已收藏「${label}」`,
        ttl: 1200,
      });
    } catch {
      pushToast({ kind: "error", message: "收藏失败，请稍后重试" });
    }
  };

  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget
          .querySelector<HTMLAnchorElement>("a")
          ?.focus({ preventScroll: true });
        if (onContextMenu) onContextMenu(event);
        else setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {variant === "list" ? (
        <ListCard
          data={data}
          showLastSeen={showLastSeen}
          onToggleFavorite={onToggleFavorite}
        />
      ) : (
        <GridCard
          data={data}
          showLastSeen={showLastSeen}
          onToggleFavorite={onToggleFavorite}
          overlayAction={overlayAction}
        />
      )}
      {menu && (
        <AlbumContextMenu
          item={data}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onShowProperties={setPropertiesId}
        />
      )}
      {propertiesId && (
        <PropertiesDialog
          target={{ kind: "node", id: propertiesId }}
          onClose={() => setPropertiesId(null)}
        />
      )}
    </div>
  );
}

// 卡片底部"X 张 / Y 个视频 / X 张 · Y 个视频"渲染。
//
// 仅 album 变体按图/视频分别展示；集合/smart 走 count + "卷"（语义是子相册数）。
function formatMediaCount(
  data: CardData,
): { label: string; title: string } | null {
  if (data.variant !== "album") return null;
  const imgs = data.imageCount ?? 0;
  const vids = data.videoCount ?? 0;
  if (imgs > 0 && vids > 0) {
    return {
      label: `${imgs} 张 · ${vids} 个视频`,
      title: `${imgs} 张图片 + ${vids} 个视频`,
    };
  }
  if (imgs === 0 && vids > 0) {
    return { label: `${vids} 个视频`, title: `${vids} 个视频` };
  }
  // 纯图 / 空相册。
  return { label: `${imgs} 张`, title: `${imgs} 张` };
}

function GridCard({
  data,
  showLastSeen,
  onToggleFavorite,
  overlayAction,
}: {
  data: CardData;
  showLastSeen?: boolean;
  onToggleFavorite: () => void;
  overlayAction?: ReactNode;
}) {
  // 直接渲染 <img loading="lazy">：浏览器原生懒加载比我们自写的 IO 简单且更可靠
  // （自写 IO 在 React 18 StrictMode dev mount-twice + 卡片树整体重渲染时容易
  // 错过首次 intersect，导致大量卡片永远停在占位符上）。
  // 悬停预览状态
  const [previewOn, setPreviewOn] = useState(false);
  const [previewRect, setPreviewRect] = useState<DOMRect | null>(null);
  const previewTimer = useRef<number | null>(null);
  const progressPct = progressPercent(data.progress);
  // 0-based 页码到达 total - 1 即已读完。
  const isFinished = isCompleted(data.progress);
  // 全新：没有有效进度记录。保存过 index=0 说明已经打开第一张，属于在读。
  // 重要：仅 album 变体显示；智能集合 / 集合不适用。
  const isFresh = data.variant === "album" && isUnread(data.progress);
  // 只有配置了多个媒体根才需要标来源。
  const multiRoot = useUIStore((s) => s.multiRoot);

  // 悬停预览：350ms 后弹出，移出卡片或预览延迟 150ms 关闭。
  // （延迟是为了让用户能从卡片顺利移到预览上，预览是 portal 元素，
  //   鼠标在 card→preview 的过渡中会先触发 card mouseleave。）
  // 触摸设备不启用（pointer: coarse 才挂监听）。
  const closeTimer = useRef<number | null>(null);
  const onEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    if (window.matchMedia("(pointer: coarse)").matches) return;
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const target = e.currentTarget;
    previewTimer.current = window.setTimeout(() => {
      setPreviewRect(target.getBoundingClientRect());
      setPreviewOn(true);
    }, 350);
  };
  const onLeave = () => {
    if (previewTimer.current !== null) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    // 延迟关闭：给用户时间移到预览上
    closeTimer.current = window.setTimeout(() => {
      setPreviewOn(false);
      closeTimer.current = null;
    }, 150);
  };
  // 卸载时清理 timer
  useEffect(() => {
    return () => {
      if (previewTimer.current !== null)
        window.clearTimeout(previewTimer.current);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    };
  }, []);

  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="relative group"
    >
      <Link
        to={data.to}
        aria-label={`打开${data.variant === "album" ? "相册" : data.variant === "collection" ? "集合" : "智能视图"}“${data.displayTitle ?? data.title}”`}
        className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <div
          className="relative aspect-[4/5] bg-bg-subtle rounded-lg overflow-hidden border border-border lift-card shadow-xs group-hover:shadow-lg group-hover:border-border-strong"
          data-testid="card-cover"
        >
          <CardCover data={data} />

          {/* 服务端转码状态（仅在转码中/失败时显示；不与上面 ▶ 角标冲突） */}
          {data.coverKind === "video" && (
            <div className="absolute top-2 left-2">
              <TranscodeStatusBadge
                videoPath={data.coverPath ?? ""}
                size="sm"
              />
            </div>
          )}

          {/* 底部暗化蒙版（hover 时让「进入」提示更清晰） */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

          {/* 「进入」提示 — hover 时从右下角淡入 */}
          <div
            className="absolute bottom-2.5 right-2.5 inline-flex items-center gap-1 px-2 h-6 rounded-full bg-bg-elevated/90 backdrop-blur text-fg text-[10px] font-medium shadow-sm opacity-100 translate-y-0 md:opacity-0 md:translate-y-1 md:group-hover:opacity-100 md:group-hover:translate-y-0 transition-all duration-200 ease-out"
            aria-hidden
          >
            <span>进入</span>
            <ArrowUpRightIcon size={10} />
          </div>

          {/* 全新 / 重温 / 集合 / 标签 角标（同一位置，优先级：fresh > rewind > collection > smart） */}
          {isFresh && data.badge !== "rewind" ? (
            // 全新：强调色 + 白圆点 + "新"字
            // 用 accent 而非 info（tailwind 没定义 info 颜色）
            <div className="absolute top-2 left-2 inline-flex items-center gap-1 bg-accent text-accent-contrast text-[10px] font-medium px-1.5 py-0.5 rounded-md shadow-sm">
              <span
                className="w-1.5 h-1.5 rounded-full bg-accent-contrast"
                aria-hidden
              />
              <span>新</span>
            </div>
          ) : data.badge === "rewind" ? (
            <div className="absolute top-2 left-2 inline-flex items-center gap-1 bg-bg-elevated/95 backdrop-blur text-fg-muted text-[10px] font-medium px-1.5 py-0.5 rounded-md border border-border-faint shadow-xs">
              <RewindIcon size={10} className="text-accent" />
              <span>重温</span>
            </div>
          ) : data.variant === "collection" ? (
            <div className="absolute top-2 left-2 bg-bg-elevated/90 backdrop-blur text-fg-muted text-[10px] font-medium px-1.5 py-0.5 rounded-md">
              <FolderIcon size={10} className="inline -mt-0.5 mr-0.5" />
              集合
            </div>
          ) : data.variant === "smart" ? (
            <div className="absolute top-2 left-2 bg-accent text-accent-contrast text-[10px] font-medium px-1.5 py-0.5 rounded-md">
              标签
            </div>
          ) : null}

          {/* 阅读进度 */}
          {progressPct !== null && progressPct > 0 && (
            <div className="absolute bottom-0 left-0 right-0 px-2.5 py-2 bg-gradient-to-t from-black/55 to-transparent">
              <div className="flex items-center gap-1.5 text-white/95">
                <ReaderIcon size={11} className="shrink-0" />
                <span className="text-[10px] font-medium tabular-nums">
                  {progressPct}%
                </span>
              </div>
              <div className="mt-1.5 h-0.5 bg-white/20 rounded-full overflow-hidden">
                <div
                  className="h-full bg-white/90"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}

          {/* 已读：右下角徽章，封面略微提亮（叠在 cover 上时通过 mix-blend 强可读） */}
          {isFinished && data.variant === "album" && (
            <div
              className="absolute bottom-2 right-2 inline-flex items-center gap-1 bg-success/95 text-white text-[10px] font-medium px-1.5 py-0.5 rounded-md shadow-sm"
              title="已读完"
            >
              <CheckIcon size={10} />
              <span>已读</span>
            </div>
          )}
        </div>

        <div className="pt-3 pb-1 min-w-0">
          <div
            className="text-[13px] font-medium text-fg truncate-2 leading-snug transition-colors group-hover:text-accent"
            title={data.displayTitle ?? data.title}
          >
            {data.displayTitle ?? data.title}
          </div>
          <div className="text-[11px] text-fg-subtle mt-1 tabular-nums flex items-center gap-1.5 min-w-0">
            {(() => {
              const media = formatMediaCount(data);
              if (media) {
                // album 变体：按图/视频分别展示
                return <span title={media.title}>{media.label}</span>;
              }
              // collection / smart 变体：维持 count + "卷"（语义是子相册数）
              return (
                <span>
                  {data.count}{" "}
                  {data.variant === "collection"
                    ? "卷"
                    : data.variant === "smart"
                      ? "卷"
                      : "张"}
                </span>
              );
            })()}
            {data.subtitle && (
              <>
                <span className="text-fg-subtle/50">·</span>
                <span className="truncate">{data.subtitle}</span>
              </>
            )}
          </div>
          {/* 多根来源 badge：与标签副标题独立，作为视觉小标签放在元数据行。
              单一媒体根下每张卡片都挂同一句来源是噪音，multiRoot 为 false 时隐藏。 */}
          {data.sourceName && multiRoot && (
            <div className="text-[10px] text-fg-subtle/80 mt-0.5 inline-flex items-center gap-1">
              <FolderIcon size={10} className="shrink-0" />
              <span className="truncate">来自 {data.sourceName}</span>
            </div>
          )}
          {showLastSeen && data.lastSeenAt && (
            <div
              className="text-[11px] text-fg-subtle mt-0.5 tabular-nums flex items-center gap-1.5 truncate"
              title={`上次 ${timeAgo(data.lastSeenAt)}`}
            >
              <ClockIcon size={10} className="shrink-0 text-fg-subtle/70" />
              {data.progress &&
                data.progress.total > 0 &&
                data.progress.index >= 0 && (
                  <>
                    <span>
                      看到 {data.progress.index + 1} / {data.progress.total}
                    </span>
                    <span className="text-fg-subtle/40">·</span>
                  </>
                )}
              <span>上次 {timeAgo(data.lastSeenAt)}</span>
            </div>
          )}
        </div>
      </Link>

      {/* 封面右上角浮层：视频角标 + 收藏星标。
          放在 Link 之外：在 <a> 里嵌按钮既不合法，也会让 Enter 冒泡触发跳转。 */}
      <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
        {data.coverKind === "video" && (
          <div className="pointer-events-none inline-flex items-center gap-1 bg-bg-elevated/90 backdrop-blur text-fg text-[10px] font-medium px-1.5 py-0.5 rounded-md shadow-sm">
            <PlayFilledIcon size={9} className="text-accent" />
            <span>{formatDuration(data.durationSec)}</span>
          </div>
        )}
        {overlayAction}
        <FavoriteStar
          fav={Boolean(data.isFavorite)}
          label={data.displayTitle ?? data.title}
          onToggle={onToggleFavorite}
        />
      </div>

      {/* 悬停预览（仅相册/合集；触摸设备不启用） */}
      {previewOn && previewRect && data.variant !== "smart" && (
        <HoverPreview
          data={data}
          anchorRect={previewRect}
          lastSeenAt={data.lastSeenAt}
          onPointerEnter={() => {
            // 鼠标进入预览时取消正在等待的关闭 timer
            if (closeTimer.current !== null) {
              window.clearTimeout(closeTimer.current);
              closeTimer.current = null;
            }
          }}
          onPointerLeave={onLeave}
        />
      )}
    </div>
  );
}

function ListCard({
  data,
  showLastSeen,
  onToggleFavorite,
}: {
  data: CardData;
  showLastSeen?: boolean;
  onToggleFavorite: () => void;
}) {
  // 与 GridCard 一致：直接依赖 <img loading="lazy">，不重复自写 IO。
  const progressPct = progressPercent(data.progress);
  const isFinished = isCompleted(data.progress);
  // 只有配置了多个媒体根才需要标来源。
  const multiRoot = useUIStore((s) => s.multiRoot);

  return (
    <div className="relative group flex items-center">
      <Link
        to={data.to}
        aria-label={`打开${data.variant === "album" ? "相册" : data.variant === "collection" ? "集合" : "智能视图"}“${data.displayTitle ?? data.title}”`}
        className="group flex flex-1 min-w-0 items-center gap-4 py-2 px-2.5 -mx-2.5 rounded-lg hover:bg-bg-subtle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div
          className="relative w-20 aspect-[4/5] rounded-md bg-bg-subtle overflow-hidden shrink-0 border border-border shadow-xs"
          data-testid="card-cover"
        >
          <CardCover data={data} loading="eager" />
          {data.coverKind === "video" && (
            <div className="pointer-events-none absolute top-1 right-1 inline-flex items-center gap-1 bg-bg-elevated/90 backdrop-blur text-fg text-[10px] font-medium px-1.5 py-0.5 rounded-md shadow-sm">
              <PlayFilledIcon size={9} className="text-accent" />
              <span>{formatDuration(data.durationSec)}</span>
            </div>
          )}
          {isFinished && data.variant === "album" && (
            <div
              className="absolute bottom-1 right-1 bg-success/95 text-white rounded-md px-1.5 py-0.5 text-[10px] font-medium inline-flex items-center gap-0.5 shadow-sm"
              title="已读完"
            >
              <CheckIcon size={10} />
              <span>已读</span>
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-medium text-fg truncate flex items-center gap-1.5">
            <span className="truncate" title={data.displayTitle ?? data.title}>
              {data.displayTitle ?? data.title}
            </span>
            {isFinished && data.variant === "album" && (
              <span className="inline-flex items-center gap-0.5 text-success text-[11px] font-medium shrink-0">
                <CheckIcon size={11} />
                <span>已读</span>
              </span>
            )}
          </div>
          <div className="text-[12px] text-fg-subtle mt-1 flex items-center gap-2">
            {data.subtitle && <span className="truncate">{data.subtitle}</span>}
            {data.sourceName && multiRoot && (
              <span className="text-fg-subtle/80 inline-flex items-center gap-0.5 shrink-0">
                <FolderIcon size={11} className="shrink-0" />
                <span className="truncate">来自 {data.sourceName}</span>
              </span>
            )}
          </div>
          {progressPct !== null && progressPct > 0 && (
            <div className="mt-2 flex items-center gap-2 max-w-md">
              <div className="flex-1 h-1 bg-bg-strong rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-[11px] text-fg-subtle tabular-nums shrink-0">
                {data.progress!.index + 1} / {data.progress!.total}
              </span>
            </div>
          )}
        </div>

        {/* 右侧信息列：张数 / 最近查看固定右对齐，逐行对齐便于扫读。 */}
        <div className="shrink-0 w-24 sm:w-32 text-right flex flex-col items-end gap-1">
          <span className="text-[12px] text-fg-muted tabular-nums">
            {(() => {
              const media = formatMediaCount(data);
              if (media) {
                return (
                  <span title={media.title}>{media.label}</span>
                );
              }
              return (
                <>
                  {data.count}{" "}
                  {data.variant === "collection"
                    ? "卷"
                    : data.variant === "smart"
                      ? "卷"
                      : "张"}
                </>
              );
            })()}
          </span>
          {showLastSeen && data.lastSeenAt && (
            <span className="text-[11px] text-fg-subtle inline-flex items-center gap-1">
              <ClockIcon size={11} className="shrink-0 text-fg-subtle/70" />
              <span>上次 {timeAgo(data.lastSeenAt)}</span>
            </span>
          )}
        </div>

        <div className="text-fg-subtle opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity pr-1">
          <span className="text-sm">›</span>
        </div>
      </Link>

      {/* 收藏星标：与链接平级，避免在 <a> 内嵌套按钮。 */}
      <FavoriteStar
        fav={Boolean(data.isFavorite)}
        label={data.displayTitle ?? data.title}
        onToggle={onToggleFavorite}
        className="shrink-0 mr-1"
      />
    </div>
  );
}

// 收藏星标：卡片右上角的收藏开关。
// - 必须是链接的兄弟节点：在 <a> 内嵌按钮会让 Enter 冒泡触发跳转，也不合法。
// - 桌面端悬停卡片才出现，已收藏的常驻显示；窄屏没有 hover，直接常驻。
function FavoriteStar({
  fav,
  label,
  onToggle,
  className = "",
}: {
  fav: boolean;
  label: string;
  onToggle: () => void;
  className?: string;
}) {
  const visibility = fav
    ? "opacity-100"
    : "opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100";
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      aria-pressed={fav}
      aria-label={fav ? `取消收藏「${label}」` : `收藏「${label}」`}
      title={fav ? "取消收藏" : "收藏"}
      className={`inline-flex items-center justify-center w-6 h-6 rounded-full bg-bg-elevated/90 backdrop-blur shadow-sm transition-opacity ${visibility} ${
        fav ? "text-warning" : "text-fg-muted hover:text-fg"
      } ${className}`}
    >
      <StarIcon size={12} filled={fav} />
    </button>
  );
}
