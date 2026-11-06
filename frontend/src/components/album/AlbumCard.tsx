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
  CheckIcon,
  ClockIcon,
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
import { albumCountUnit, comicCopy, mediaUnit } from "../../utils/workbench";
import type { ContentKind } from "../../api/library";
import CardCover from "./CardCover";

export type CardVariant = "album" | "collection" | "smart";

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
  /**
   * 内容属性："photo"（照片）/ "comic"（漫画）。
   * 它继承自所属媒体目录，并决定相册用哪种交互打开。
   * 进度与「已读完」只在漫画属性下出现。
   */
  contentKind?: ContentKind;
  /** 所属系列（漫画侧按连载分组用）：相册直接上级集合的名字。 */
  parentName?: string;
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
  /**
   * 是否显示未读标记。在「未读」这类整页都是未读的列表里，
   * 每张卡都挂同一个标记只是噪音，直接关掉。
   */
  showUnreadBadge?: boolean;
  /**
   * 标题印在封面上（书封），而不是压在封面下面。
   *
   * 漫画工作台默认开启：书架上的每一本都该在封面上写着书名，
   * 一排封面才读得出「一排书」。首页首屏面板里的卡片是紧凑陈列，
   * 封面下方留一行标题更清楚，那里显式关掉。
   */
  titleOnCover?: boolean;
  /**
   * 封面画幅比例。
   * 默认 "4/3" 用于照片卡片；也支持 "4/5"、"2/3" 和 "16/9"。
   */
  coverRatio?: CoverRatio;
  /**
   * 收藏星标常驻显示。
   *
   * 默认桌面端要 hover 才露出星标（界面退到背景）。但收藏页空态的
   * "从这里挑一个收藏"必须让星标一眼可见 —— 那条文案就是在教用户
   * 点星标，指着一个 hover 才出现的东西等于没说。
   */
  alwaysShowFavorite?: boolean;
}

export type CoverRatio = "4/5" | "2/3" | "16/9" | "4/3" | "1/1";

const COVER_RATIO_CLASS: Record<CoverRatio, string> = {
  "4/5": "aspect-[4/5]",
  "2/3": "aspect-[2/3]",
  "16/9": "aspect-video",
  "4/3": "aspect-[4/3]",
  "1/1": "aspect-square",
};

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
  showUnreadBadge = true,
  titleOnCover,
  coverRatio = "4/3",
  alwaysShowFavorite = false,
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
          showUnreadBadge={showUnreadBadge}
        />
      ) : (
        <GridCard
          data={data}
          showLastSeen={showLastSeen}
          onToggleFavorite={onToggleFavorite}
          overlayAction={overlayAction}
          showUnreadBadge={showUnreadBadge}
          titleOnCover={titleOnCover}
          coverRatio={coverRatio}
          alwaysShowFavorite={alwaysShowFavorite}
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
// 仅 album 变体按图/视频分别展示；集合/smart 走 count + 计数单位（语义是子相册数）。
//
// 计数单位跟着这一张卡自己的属性走：照片说「张」，漫画说「页」——
// 漫画里一张图就是「一页」，与阅读器的「第 N 页」说法一致。
function formatMediaCount(
  data: CardData,
): { label: string; lead: string; rest: string; title: string } | null {
  if (data.variant !== "album") return null;
  const imgs = data.imageCount ?? 0;
  const vids = data.videoCount ?? 0;
  const unit = mediaUnit(data.contentKind ?? "photo");
  if (imgs > 0 && vids > 0) {
    return {
      label: `${imgs} ${unit} · ${vids} 个视频`,
      lead: `${imgs} ${unit}`,
      rest: `${vids} 个视频`,
      title: `${imgs} ${unit} + ${vids} 个视频`,
    };
  }
  if (imgs === 0 && vids > 0) {
    return {
      label: `${vids} 个视频`,
      lead: `${vids} 个视频`,
      rest: "",
      title: `${vids} 个视频`,
    };
  }
  // 纯图 / 空相册。
  const label = `${imgs} ${unit}`;
  return { label, lead: label, rest: "", title: label };
}

function GridCard({
  data,
  showLastSeen,
  onToggleFavorite,
  overlayAction,
  showUnreadBadge,
  titleOnCover,
  coverRatio,
  alwaysShowFavorite,
}: {
  data: CardData;
  showLastSeen?: boolean;
  onToggleFavorite: () => void;
  overlayAction?: ReactNode;
  showUnreadBadge: boolean;
  titleOnCover?: boolean;
  coverRatio: CoverRatio;
  alwaysShowFavorite: boolean;
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
  // 阅读进度只属于漫画相册：照片相册没有进度条、没有「已读完」。
  const isComicAlbum =
    data.variant === "album" && data.contentKind === "comic";
  const cardCopy = comicCopy();
  // 标题印在封面上：漫画工作台的默认形态。书架上的书在封面上写着
  // 书名，一排封面才读得出「一排书」；照片工作台是展陈墙，标题仍然
  // 压在封面下方（展品说明牌）。
  const showTitleOnCover = titleOnCover ?? data.contentKind === "comic";
  const label = data.displayTitle ?? data.title;
  // 未读标记（见文件底部 showUnreadMark）：只对漫画相册、且页面不是「整页未读」时出现。
  const unread = showUnreadMark(data, showUnreadBadge);
  // 只有配置了多个媒体根才需要标来源。
  const multiRoot = useUIStore((s) => s.multiRoot);
  // 时长是否已知：视频角标只在有真实时长时才显示数字。
  const hasDuration =
    typeof data.durationSec === "number" &&
    Number.isFinite(data.durationSec) &&
    data.durationSec >= 0;

  // 悬停预览：350ms 后弹出，移出卡片或预览延迟 150ms 关闭。
  // （延迟是为了让用户能从卡片顺利移到预览上，预览是 portal 元素，
  //   鼠标在 card→preview 的过渡中会先触发 card mouseleave。）
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

  // 触摸设备没有悬停：长按 400ms 唤起同一张预览。
  //
  // 长按之后的那次抬手不能算作点击 —— 否则用户长按看了预览，松手却又
  // 被带进相册。因此长按成功时记下一个标记，链接的 onClick 见到它就
  // 取消这次跳转。
  const pressTimer = useRef<number | null>(null);
  const longPressedRef = useRef(false);
  const onPressStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    if (e.pointerType === "mouse") return;
    const target = e.currentTarget;
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      longPressedRef.current = true;
      setPreviewRect(target.getBoundingClientRect());
      setPreviewOn(true);
    }, 400);
  };
  const onPressEnd = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  // 卸载时清理 timer
  useEffect(() => {
    return () => {
      if (previewTimer.current !== null)
        window.clearTimeout(previewTimer.current);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      if (pressTimer.current !== null)
        window.clearTimeout(pressTimer.current);
    };
  }, []);

  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onPointerDown={onPressStart}
      onPointerUp={onPressEnd}
      onPointerCancel={onPressEnd}
      onPointerLeave={onPressEnd}
      /* 右键菜单与悬停预览不同时出现：两者都浮在指针附近，
         叠在一起时菜单被预览的大图压住，两边都读不清。
         这个处理器先跑（事件向上冒泡），外层再开菜单。
         还没到点的预览定时器也要撤掉 —— 否则它在菜单打开之后
         才把预览放出来，菜单照样被压住。 */
      onContextMenu={() => {
        if (previewTimer.current !== null) {
          window.clearTimeout(previewTimer.current);
          previewTimer.current = null;
        }
        setPreviewOn(false);
      }}
      className="album-tile relative group select-none"
      data-testid="album-card"
    >
      <Link
        to={data.to}
        onClick={(e) => {
          // 长按刚唤起过预览：这一下抬手不是「打开相册」。
          if (longPressedRef.current) {
            e.preventDefault();
            longPressedRef.current = false;
            return;
          }
          longPressedRef.current = false;
        }}
        aria-label={`打开${data.variant === "album" ? "相册" : data.variant === "collection" ? "集合" : "智能视图"}“${data.displayTitle ?? data.title}”`}
        className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <div
          className={`album-tile__cover relative ${COVER_RATIO_CLASS[coverRatio]} bg-bg-subtle overflow-hidden${
            showTitleOnCover ? " album-tile__cover--book" : ""
          }`}
          data-testid="card-cover"
        >
          {/* 视频封面同样裁切填满：方形画幅里保留 16:9 的完整画面会
              上下留出两条黑边，读起来像一只空信箱。 */}
          <CardCover data={data} fit="cover" />

          {/* 封面左上角：状态槽。阅读状态（未读 / 已读完）与视频转码角标
              都在这一列，堆叠显示，互不遮挡。

              「已读完」原先放在右下角，和未读点分处两个角 —— 扫读一张
              卡片时，状态散在两个方向，要分别去找。两者互斥（未读与
              已读完不会同时成立），所以放进同一列不冲突。
              深色蒙版材质压在任何封面上都读得清（原来的实心绿块在
              深色主题 / 浅色封面上都会糊掉）。 */}
          <div className="absolute top-2 left-2 flex flex-col items-start gap-1">
            {data.coverKind === "video" && (
              <TranscodeStatusBadge
                videoPath={data.coverPath ?? ""}
                size="sm"
              />
            )}
            {unread && <UnreadDot label={cardCopy.unreadTitle} />}
            {isFinished && isComicAlbum && <ReadChip />}
          </div>

          {/* 底部暗化蒙版（hover 时让进度条与徽章更清晰） */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

          {/* 书名压条：标题印在封面上。书封上本来就有书名，
              网格因此读成一排书，而不是「一堆图片 + 一堆说明」。
              宽幅封面（首屏面板里的横版海报）用紧凑压条：两行标题
              会把半张封面压成一块黑。 */}
          {showTitleOnCover && (
            <div
              className={`cover-title${
                coverRatio === "16/9" ? " cover-title--compact" : ""
              }`}
              data-testid="cover-title"
            >
              <div
                className={`cover-title__text ${
                  coverRatio === "16/9" ? "truncate" : "line-clamp-2"
                }`}
              >
                {label}
              </div>
            </div>
          )}

          {/* 集合 / 标签 这类"类型"信息不属于阅读状态，已移到标题下的元信息行，
              封面角位只留给状态（未读点 / 已读），避免角标互相打架。 */}

          {/* 阅读进度：百分比放深色蒙版 chip，进度条压在封面底边的暗色条上。
              以前整块用一层渐变蒙版，白字在亮封面（照片里的白墙、白纸）上
              会直接糊掉 —— 蒙版越往上越透明，而文字正好在透明那一侧。

              照片相册不显示百分比：它是「翻到了第几张」，不是「读完了一本」，
              百分比读数会让人误以为在读漫画。照片卡片只保留底边那条进度条，
              位置数字挪到元信息行。 */}
          {isComicAlbum && progressPct !== null && progressPct > 0 && (
            <>
              {/* 百分比 chip 只在标题不在封面上时出现：封面上已经有
                  书名压条，再压一枚百分比 chip，两层深色蒙版叠在
                  封面下缘会互相干扰。书封形态把百分比放进封面
                  下方的说明行，与计数读在一起。 */}
              {!isFinished && !showTitleOnCover && (
                <div className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-black/65 backdrop-blur-sm ring-1 ring-white/20 px-1.5 h-5 text-badge font-medium text-white shadow-sm">
                  <ReaderIcon size={11} className="shrink-0" />
                  <span className="tabular-nums">{progressPct}%</span>
                </div>
              )}
              <div className="absolute bottom-0 left-0 right-0 h-1 z-10 bg-black/55">
                <div
                  className="h-full bg-white/90"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </>
          )}
        </div>

        <div className="album-tile__meta min-w-0">
          {/* 标题印在封面上时，这里不再重复标题：同一句话在一张卡上
              说两遍，封面的书名会被下面的说明读成回声。 */}
          {!showTitleOnCover && (
            <div
              className="album-tile__title text-label font-medium text-fg truncate-2 leading-snug transition-colors group-hover:text-brand-ink"
              title={data.displayTitle ?? data.title}
            >
              {data.displayTitle ?? data.title}
            </div>
          )}
          {/* meta 行 12.5px → 13px：全量网格一次显示几十张卡，
              12.5px 的中文在一屏里会糊成灰团，是"内容存在感不足"
              的主要来源之一。 */}
          <div
            className={`text-body tabular-nums flex items-center gap-1.5 min-w-0 ${
              showTitleOnCover ? "text-fg-muted" : "text-fg-muted mt-1"
            }`}
          >
            <TypeChip variant={data.variant} />
            {(() => {
              const media = formatMediaCount(data);
              if (media) {
                // album 变体：按图/视频分别展示。
                // 不允许换行 —— 「384 张 · 19 个视 频」这种断字很难看，
                // 空间不够时应该让后面的来源副标题截断。
                return (
                  <span
                    title={media.title}
                    className="shrink-0 whitespace-nowrap"
                  >
                    {/* 数量是书封下方唯一剩下的信息，用正文色；其余
                        补充信息退回次要色，层级才分得开。 */}
                    {showTitleOnCover ? (
                      <>
                        <span className="text-fg font-medium">{media.lead}</span>
                        {media.rest && (
                          <span className="text-fg-muted"> · {media.rest}</span>
                        )}
                      </>
                    ) : (
                      media.label
                    )}
                  </span>
                );
              }
              // collection / smart 变体：count + 计数单位（语义是子相册数）。
              // 单位跟卡片所属的那一侧走：照片侧「本」，漫画侧「卷」。
              return (
                <span className="shrink-0 whitespace-nowrap">
                  {data.count}{" "}
                  {albumCountUnit(data.contentKind ?? "photo")}
                </span>
              );
            })()}
            {/* 阅读进度：书封形态下百分比放进说明行，与计数读在一起，
                封面上的书名压条不再压一枚 chip。 */}
            {showTitleOnCover &&
              isComicAlbum &&
              progressPct !== null &&
              progressPct > 0 &&
              !isFinished && (
                <>
                  <span className="text-fg-subtle">·</span>
                  <span className="text-brand-ink font-medium shrink-0 whitespace-nowrap">
                    已读 {progressPct}%
                  </span>
                </>
              )}
            {data.subtitle && (
              <>
                <span className="text-fg-subtle">·</span>
                <span className="truncate">{data.subtitle}</span>
              </>
            )}

          </div>
          {/* 多根来源 badge：与标签副标题独立，作为视觉小标签放在元数据行。
              单一媒体根下每张卡片都挂同一句来源是噪音，multiRoot 为 false 时隐藏。 */}
          {data.sourceName && multiRoot && (
            <div className="text-meta text-fg-subtle mt-0.5 inline-flex items-center gap-1">
              <FolderIcon size={10} className="shrink-0" />
              <span className="truncate">来自 {data.sourceName}</span>
            </div>
          )}
          {showLastSeen && data.lastSeenAt && (
            <div
              className="text-meta text-fg-subtle mt-0.5 tabular-nums flex items-center gap-1.5 truncate"
              title={`上次 ${timeAgo(data.lastSeenAt)}`}
            >
              <ClockIcon size={10} className="shrink-0 text-fg-subtle" />
              {isComicAlbum &&
                data.progress &&
                data.progress.total > 0 &&
                data.progress.index >= 0 && (
                  <>
                    <span>
                      {cardCopy.positionVerb} {data.progress.index + 1} /{" "}
                      {data.progress.total}
                    </span>
                    <span className="text-fg-subtle">·</span>
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
          <div className="pointer-events-none inline-flex items-center gap-1 bg-bg-elevated/90 backdrop-blur text-fg text-badge font-medium px-1.5 h-5 rounded shadow-sm">
            <PlayFilledIcon size={9} className="text-accent" />
            {/* 时长未知时不要显示 "—"：一个破折号看起来像"读不出来 / 坏了"，
                而不是"视频时长暂不可用"。只留播放图标。 */}
            {hasDuration && <span>{formatDuration(data.durationSec)}</span>}
          </div>
        )}
        {overlayAction}
        <FavoriteStar
          fav={Boolean(data.isFavorite)}
          label={data.displayTitle ?? data.title}
          onToggle={onToggleFavorite}
          alwaysVisible={alwaysShowFavorite}
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
  showUnreadBadge,
}: {
  data: CardData;
  showLastSeen?: boolean;
  onToggleFavorite: () => void;
  showUnreadBadge: boolean;
}) {
  // 与 GridCard 一致：直接依赖 <img loading="lazy">，不重复自写 IO。
  const progressPct = progressPercent(data.progress);
  const isFinished = isCompleted(data.progress);
  // 阅读进度只属于漫画相册。
  const isComicAlbum =
    data.variant === "album" && data.contentKind === "comic";
  const cardCopy = comicCopy();
  // 未读标记与网格视图同源。
  const unread = showUnreadMark(data, showUnreadBadge);
  // 只有配置了多个媒体根才需要标来源。
  const multiRoot = useUIStore((s) => s.multiRoot);
  // 时长是否已知：视频角标只在有真实时长时才显示数字。
  const hasDuration =
    typeof data.durationSec === "number" &&
    Number.isFinite(data.durationSec) &&
    data.durationSec >= 0;
  // 漫画侧的列表行也是书架：缩略图是一本书（竖版 + 装订边）。
  const isComicContent = data.contentKind === "comic";

  return (
    // 列表行：缩略图压到 48px，行高固定 86px —— 一屏能扫到更多条目。
    // 行高必须固定：超宽屏下同一行的两张卡并排，行高不一致时下面那张
    // 卡片底部的分隔线会错位，看起来像两张卡片没对齐。
    // 行底加分隔线：整行铺满内容宽度时，没有分隔线的话标题与右侧数字之间
    // 会变成一大片空白，分隔线把它读成一张表。
    //
    // 字号：标题 14px，其余（类型 / 副标题 / 计数 / 进度）统一 13px ——
    // 与网格卡同一套层级。旧版列表用 12.5px，比网格卡低一档，两种视图
    // 放在一起看会像两套产品。
    <div className="relative group flex items-center border-b border-border-faint h-[86px]">
      <Link
        to={data.to}
        aria-label={`打开${data.variant === "album" ? "相册" : data.variant === "collection" ? "集合" : "智能视图"}“${data.displayTitle ?? data.title}”`}
        className="group flex flex-1 min-w-0 items-center gap-3.5 py-2 px-2.5 -mx-2.5 rounded-lg hover:bg-bg-subtle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <div
          className={`relative w-12 aspect-[4/5] shrink-0 overflow-hidden bg-bg-subtle ${
            isComicContent
              ? "album-thumb--book"
              : "rounded-md border border-border shadow-xs"
          }`}
          data-testid="card-cover"
        >
          <CardCover
            data={data}
            loading="eager"
            compact
            fit={isComicContent ? "cover" : "contain"}
          />
          {data.coverKind === "video" && (
            <div className="pointer-events-none absolute top-1 right-1 inline-flex items-center gap-1 bg-bg-elevated/90 backdrop-blur text-fg text-badge font-medium px-1.5 h-5 rounded shadow-sm">
              <PlayFilledIcon size={9} className="text-accent" />
              {/* 时长未知时不显示数字：破折号看起来像"读不出来 / 坏了"。 */}
              {hasDuration && <span>{formatDuration(data.durationSec)}</span>}
            </div>
          )}
          {/* 状态角位（未读点）在列表视图改放到标题行：
              48px 的缩略图上塞不下标记，且标题行的文字更易扫读。 */}
        </div>

        {/* 溢出裁掉而不是压到右栏上：这一块可以缩到比内容更窄，
            但里面的进度读数不缩，窄列时它会直接盖住右侧的页数。 */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col justify-center gap-1">
          <div className="text-label font-medium text-fg truncate flex items-center gap-1.5">
            <span className="truncate" title={data.displayTitle ?? data.title}>
              {data.displayTitle ?? data.title}
            </span>
            {unread && (
              <span
                className="inline-flex items-center gap-1 text-body font-medium text-fg-muted shrink-0"
                title={cardCopy.unreadTitle}
              >
                {/* 未读点用品牌色：它是「这一本还没翻开」的信号，
                    近黑的强调色在这里读起来只是一个句点。 */}
                <span
                  className="h-2 w-2 rounded-full bg-brand"
                  aria-hidden="true"
                />
                <span>{cardCopy.unreadTitle}</span>
              </span>
            )}
            {isFinished && isComicAlbum && (
              <span className="inline-flex items-center gap-0.5 text-body font-medium text-fg-muted shrink-0">
                <CheckIcon size={11} className="text-success" />
                <span>{cardCopy.finishedLabel}</span>
              </span>
            )}
          </div>
          {/* 第二行：副标题在左，进度轨道占中间的空位，位置在右。
              轨道只在真有进度时出现：一条永远空着的灰条压在短标题下面，
              读起来是标题的下划线，不是进度条。「还没翻开」这件事由
              标题行上的未读标记承担，不必再用一个空轨道说一遍。 */}
          <div className="text-body text-fg-subtle flex items-center gap-2 min-w-0 overflow-hidden">
            <TypeChip variant={data.variant} />
            {data.subtitle && (
              <span className="truncate max-w-[10rem] shrink">{data.subtitle}</span>
            )}
            {isComicAlbum && progressPct !== null && progressPct > 0 && (
              <>
                {/* 轨道给固定宽度，不占满整行：一条横贯半屏的空条
                    读起来是分隔线，不是进度条。 */}
                <span className="w-20 shrink-0 h-[3px] bg-bg-strong rounded-full overflow-hidden">
                  <span
                    className="block h-full bg-brand"
                    style={{
                      width: `${progressPct}%`,
                    }}
                  />
                </span>
                <span className="tabular-nums shrink-0 whitespace-nowrap">
                  {cardCopy.positionVerb} {data.progress!.index + 1} /{" "}
                  {data.progress!.total}
                </span>
              </>
            )}
            {data.sourceName && multiRoot && (
              <span className="text-fg-subtle inline-flex items-center gap-0.5 shrink-0">
                <FolderIcon size={11} className="shrink-0" />
                <span className="truncate">来自 {data.sourceName}</span>
              </span>
            )}
          </div>
        </div>

        {/* 右侧信息列：张数 / 最近查看固定右对齐，逐行对齐便于扫读。 */}
        <div className="shrink-0 w-24 sm:w-32 text-right flex flex-col items-end gap-1">
          <span className="text-body text-fg tabular-nums font-medium">
            {(() => {
              const media = formatMediaCount(data);
              if (media) {
                return <span title={media.title}>{media.label}</span>;
              }
              return (
                <>
                  {data.count}{" "}
                  {albumCountUnit(data.contentKind ?? "photo")}
                </>
              );
            })()}
          </span>
          {showLastSeen && data.lastSeenAt && (
            <span className="text-body text-fg-subtle inline-flex items-center gap-1">
              <ClockIcon size={11} className="shrink-0 text-fg-subtle" />
              <span>上次 {timeAgo(data.lastSeenAt)}</span>
            </span>
          )}
        </div>

        <div className="text-fg-subtle opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity pr-1">
          <span className="text-body">›</span>
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

// ============================================================================
// 卡片状态表达（grid / list 共用同一套语义）
//
// 状态全部来自真实数据，不推断、不虚构：
//   未读 —— 从未打开过（没有阅读进度记录）。
//   在读 —— 已经翻开但还没看完（封面底部的进度条 + 百分比）。
//   已读 —— 已经翻到最后一页（封面右下角的「✓ 已读」chip）。
//
// 表达方式刻意做得安静：
//   - 封面左上角只放"待办"信号：未读是一颗不带文字的白点。
//     一页 78 张卡片各挂一个「新」字块只是噪音，点本身已经够用。
//   - 已读放在封面右下角，和左上角的"待办"分区隔开。
//   - 集合 / 标签是"类型"而不是状态，类型信息放在元信息行。
//
// chip 一律用"深色蒙版 + 浅色前景"的材质：封面可能是纯白、纯黑或任意
// 颜色，只有蒙版材质才能保证文字在所有封面上都读得清（浅色 chip 压在
// 白色封面上会整个消失）。
// ============================================================================

/** 是否给这张卡挂未读标记。
 *  未读只对漫画相册有意义：照片工作台没有阅读进度，也没有未读这回事。
 *  集合 / 智能视图是聚合视图，同样谈不上"翻开过"。
 *  showUnreadBadge=false 用于"整页都是未读"的列表：那里每张卡挂同一个
 *  标记纯属重复，未读状态由服务端筛选保证。 */
function showUnreadMark(data: CardData, showUnreadBadge: boolean): boolean {
  return (
    showUnreadBadge &&
    data.variant === "album" &&
    data.contentKind === "comic" &&
    isUnread(data.progress)
  );
}

/** 未读：一颗白点 + 深色描边。
 *  白心在深色封面上直接可见，深色描边在白色封面上把点的轮廓兜住 ——
 *  两边都不需要额外的底板，也不会像一个空心的圆环按钮。 */
function UnreadDot({ label }: { label: string }) {
  return (
    <span
      className="inline-flex h-2 w-2 items-center justify-center rounded-full bg-white ring-1 ring-black/50 shadow-[0_1px_3px_rgba(0,0,0,0.4)]"
      title={label}
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * 已读：蒙版 chip + 绿色对勾。
 *
 * 只有漫画相册会渲染它：阅读进度与「读完」都属于漫画，
 * 照片侧不显示完成态。
 */
function ReadChip() {
  const title = comicCopy().finishedLabel;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-black/65 backdrop-blur-sm ring-1 ring-white/20 px-1.5 h-5 text-meta font-medium text-white shadow-sm"
      title={title}
    >
      <CheckIcon size={10} className="text-overlay-success" />
      <span>{title}</span>
    </span>
  );
}

/** 类型标记（标签）：放在元信息行，不占封面角位。
 *  集合卡片本身已有「集合 / 子集合」副标题说明类型，不再重复挂 chip。 */
function TypeChip({ variant }: { variant: CardVariant }) {
  if (variant !== "smart") return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded bg-bg-subtle px-1.5 py-px text-meta font-medium leading-4 text-fg-muted ring-1 ring-border-faint">
      <FolderIcon size={10} />
      标签
    </span>
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
  alwaysVisible = false,
}: {
  fav: boolean;
  label: string;
  onToggle: () => void;
  className?: string;
  alwaysVisible?: boolean;
}) {
  const visibility =
    fav || alwaysVisible
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
      className={`inline-flex items-center justify-center w-7 h-7 rounded-full bg-bg-elevated/90 backdrop-blur shadow-sm transition-opacity ${visibility} ${
        fav ? "text-favorite" : "text-fg-muted hover:text-fg"
      } ${className}`}
    >
      <StarIcon size={13} filled={fav} />
    </button>
  );
}
