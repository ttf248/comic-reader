import { useMemo } from "react";
import { Link } from "react-router-dom";
import { thumbUrl } from "../../api/thumbs";
import { previewUrl } from "../../api/images";
import { useFavorites } from "../../hooks/useFavorites";
import { decodeFavPath } from "../../utils/path";
import AlbumCard from "../album/AlbumCard";
import type { CardData } from "../album/AlbumGrid";
import {
  ArrowRightLineIcon,
  CheckIcon,
  CloseIcon,
  FolderIcon,
  ShuffleIcon,
} from "../common/Icon";

// 首页的两种内容呈现：
//
//   1. 「封面台」ContinueStage —— 一本在读的主封面 + 紧贴它的信息 + 其余在读的货架；
//   2. 「封面货架」Shelf —— 横向排开的一排海报，横向可滚。
//
// 上一版首页用的是"横幅卡"：一张 1340×200 的浅灰盒子，封面只有 140×176，
// CTA 按钮被推到 1000px 之外，右侧整片空白。视觉重量落在空白上而不是内容上，
// 于是首页看起来像后台面板而不是画廊。
//
// 现在的做法：把版面让给封面。封面尺寸、标题字号、按钮距离都按
// "主角 / 次要 / 其它"三档拉开。

/**
 * 书架上一张海报的宽度。
 *
 * 用 flex-1 + min/max 而不是固定宽度：条目少时（如未读的 6 张）
 * 海报会撑开把整行铺满，不会在右侧留一大块看起来像"排版没做完"的空白；
 * 条目多时（在读的 10 张）撑不开就保持最小宽度并横向滚动。
 */
const SHELF_WIDTH = "flex-1 min-w-[148px] max-w-[240px]";

interface UnreadHeroProps {
  cards: CardData[];
  count: number;
  onShuffle: () => void;
  onMarkRead: (card: CardData) => void;
}

// 首页未读入口：只展示前六本，完整列表交给 /unread 页面。
//
// 版式：横向海报货架。封面等高排开，横向铺满，窄屏可滑动 ——
// 不再是"六张等大的方块"和下面的网格连成一片墙。
export function UnreadHero({
  cards,
  count,
  onShuffle,
  onMarkRead,
}: UnreadHeroProps) {
  const { favorites } = useFavorites();
  const favoriteIds = useMemo(() => new Set(favorites), [favorites]);
  const visible = cards.slice(0, 6);

  return (
    <section className="page-shell pt-2 pb-2" data-testid="unread-hero">
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <h2 className="section-title">未读</h2>
        <span className="section-meta">
          还有 <span className="tabular-nums text-fg font-medium">{count}</span>{" "}
          本没看
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={onShuffle} className="btn btn-sm btn-outline">
            <ShuffleIcon size={12} />
            随机未读
          </button>
          <Link to="/unread" className="btn btn-sm btn-ghost">
            全部
            <ArrowRightLineIcon size={12} />
          </Link>
        </div>
      </div>

      <div className="shelf shelf-fade">
        {visible.map((card) => (
          <div key={card.id} className={SHELF_WIDTH}>
            <AlbumCard
              data={{
                ...card,
                isFavorite: favoriteIds.has(decodeFavPath(card.to)),
              }}
              /* 整个区块都是未读，卡片再挂「新」角标只是噪音 */
              showUnreadBadge={false}
              /* 视频按 16:9 排（封面本来就是横画幅，硬塞进海报比例
                 会留下大片灰条）；图片按 2:3 海报比例。 */
              coverRatio={card.coverKind === "video" ? "16/9" : "2/3"}
              overlayAction={
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onMarkRead(card);
                  }}
                  className="w-7 h-7 rounded-full bg-black/55 text-white/90 hover:bg-accent hover:text-accent-contrast flex items-center justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-all"
                  title={`将「${card.title}」标记为已读`}
                  aria-label={`将${card.title}标记为已读`}
                >
                  <CheckIcon size={13} />
                </button>
              }
            />
          </div>
        ))}
      </div>
    </section>
  );
}

interface ContinueReadingHeroProps {
  cards: CardData[];
  onContinue: (card: CardData) => void;
  onRemove: (card: CardData) => void;
  onClearAll: () => void;
}

// 首页继续阅读入口：点击卡片直接进入上次阅读位置。
//
// 版式：「封面台」。
//   ┌──────────┐   看到 5 / 262
//   │  主封面   │   ▓▓░░░░░░░░░  2%
//   │  2:3     │   [继续阅读 →]  [标记为已读]
//   └──────────┘   ┌──┐┌──┐┌──┐┌──┐   ← 其余在读（横向货架）
//    标题（墙签）  └──┘└──┘└──┘└──┘
//
// 关键约束：
//   - 主封面高度 ≥ 货架海报 1.6 倍（"主角 / 次要"必须一眼可分）；
//   - 主按钮与标题/封面的视觉距离 < 1 屏（旧版相距 ~1000px）；
//   - 进度同时用"数字 + 条"两处表达，不只靠一条 3px 细线。
export function ContinueReadingHero({
  cards,
  onContinue,
  onRemove,
  onClearAll,
}: ContinueReadingHeroProps) {
  const featured = cards[0];
  // 货架展示 10 本（而不是 6 本）：货架是"还有更多"的可视化 ——
  // 6 本在宽屏上只占半行，右侧留一大块空白，看起来像排版没做完；
  // 10 本刚好把一整行铺满并溢出，渐隐 + 横向滚动明确表达"还有"。
  const rest = cards.slice(1, 11);

  return (
    <section className="page-shell pt-2 pb-10" data-testid="continue-hero">
      <div className="flex items-center gap-3 flex-wrap mb-5">
        <h2 className="section-title">继续阅读</h2>
        <span className="section-meta">
          <span className="tabular-nums text-fg font-medium">{cards.length}</span>{" "}
          本还没看完
        </span>
        <button
          onClick={onClearAll}
          className="btn btn-sm btn-ghost ml-auto"
          title="把当前所有继续阅读相册标记为已读(不影响收藏 / 最近)"
        >
          <CloseIcon size={11} />
          清空
        </button>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:gap-9">
        {featured && (
          /* 窄屏：封面 + 墙签并排（112px 封面），保证标题 / 进度 / 按钮
             都在第一屏内；宽屏：封面独占一列（300px），下方挂墙签标题。 */
          <div className="flex gap-4 items-end lg:flex-col lg:items-stretch lg:gap-4 lg:w-[300px] xl:w-[320px] shrink-0">
            <div className="w-[112px] lg:w-full shrink-0">
              <StagePoster
                card={featured}
                onClick={() => onContinue(featured)}
              />
            </div>
            {/* 墙签：标题贴在封面下方，像展厅里的作品说明 */}
            <h3 className="hero-title lg:mt-4 line-clamp-2">
              {featured.title}
            </h3>
          </div>
        )}

        {/* 信息 + 其余在读的货架：占据剩余宽度，横向铺满，不再留空洞 */}
        <div className="flex-1 min-w-0">
          {featured && (
            <StageInfo
              card={featured}
              onContinue={() => onContinue(featured)}
              onRemove={() => onRemove(featured)}
            />
          )}

          {rest.length > 0 && (
            <div className="mt-7 lg:mt-9">
              <div className="section-meta mb-3">其余在读</div>
              <div className="shelf shelf-fade">
                {rest.map((card) => (
                  <div key={card.id} className={SHELF_WIDTH}>
                    <ShelfPoster
                      card={card}
                      onClick={() => onContinue(card)}
                      onRemove={() => onRemove(card)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// 舞台主封面：2:3 海报比例，明显大于货架海报。
//
// 图片封面走 /api/previews（按宽度等比缩放），避免把 320px 的缩略图
// 放大成 450px 高的主视觉；视频封面没有预览接口，用缩略图 + 深色底，
// 让"画幅不同"看起来是有意的，而不是缺图。
//
// 可访问性约束（回归测试锁定）：
// - 真正可点击的是 role=button 的内容区；「标记为已读」按钮是它的兄弟
//   节点，嵌套会让 Enter/Space 冒泡触发跳转，也会污染卡片的可访问名。
function StagePoster({
  card,
  onClick,
}: {
  card: CardData;
  onClick: () => void;
}) {
  const progress = card.progress;
  const total = progress?.total ?? 0;
  const index = progress?.index ?? 0;
  const percent =
    total > 1
      ? Math.min(100, Math.round((index / Math.max(1, total - 1)) * 100))
      : 0;

  const isVideo = card.coverKind === "video";
  const src = card.coverPath
    ? isVideo
      ? thumbUrl(card.coverPath)
      : previewUrl(card.coverPath, 640)
    : "";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      aria-label={`继续阅读「${card.title}」`}
      className="group relative block w-full aspect-[2/3] rounded-xl overflow-hidden bg-bg-subtle shadow-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="eager"
          decoding="async"
          className={`w-full h-full group-hover:scale-[1.03] transition-transform duration-500 ${
            isVideo ? "object-contain" : "object-cover object-[50%_30%]"
          }`}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-fg-subtle">
          <FolderIcon size={26} />
        </div>
      )}

      {/* 进度压在封面底边：既是进度，也是这块封面的收尾 */}
      <div className="absolute left-0 right-0 bottom-0 h-[3px] bg-black/45">
        <div
          className="h-full bg-white/95 transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

// 舞台信息栏：进度读数 + 进度条 + 主操作。
//
// 与封面同处一行右侧，距离在几百像素内 —— 旧版把按钮推到横幅最右端
// （相距约 1000px），用户要横跨整个屏幕才能把按钮和封面联系起来。
function StageInfo({
  card,
  onContinue,
  onRemove,
}: {
  card: CardData;
  onContinue: () => void;
  onRemove: () => void;
}) {
  const progress = card.progress;
  const total = progress?.total ?? 0;
  const index = progress?.index ?? 0;
  const percent =
    total > 1
      ? Math.min(100, Math.round((index / Math.max(1, total - 1)) * 100))
      : 0;

  return (
    <div className="max-w-[520px]">
      <div className="flex items-baseline gap-x-3 gap-y-1 flex-wrap">
        <span className="text-[15px] text-fg font-medium tabular-nums">
          看到 {index + 1} / {total}
        </span>
        {percent > 0 && (
          <span className="text-[13px] text-fg-subtle tabular-nums">
            已读 {percent}%
          </span>
        )}
      </div>

      <div
        className="mt-3 h-1.5 w-full rounded-full bg-bg-strong overflow-hidden"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`「${card.title}」阅读进度`}
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="mt-5 flex items-center gap-2.5 flex-wrap">
        <button type="button" onClick={onContinue} className="btn btn-primary">
          继续阅读
          <ArrowRightLineIcon size={12} />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove();
          }}
          className="btn btn-sm btn-ghost border border-border-faint"
          title={`将「${card.title}」标记为已读`}
          aria-label={`将${card.title}标记为已读`}
        >
          <CheckIcon size={12} />
          标记为已读
        </button>
      </div>
    </div>
  );
}

// 货架上的次级海报：与主封面同族的卡片，但更小。
//
// 结构与旧版一致（role=button 包住内容，X 按钮是兄弟节点），
// 这样既保留键盘 / 可访问名行为，也让封面成为这一行的视觉主体。
function ShelfPoster({
  card,
  onClick,
  onRemove,
}: {
  card: CardData;
  onClick: () => void;
  onRemove: () => void;
}) {
  const progress = card.progress;
  const progressPercent =
    progress && progress.total > 1
      ? Math.min(
          100,
          Math.round((progress.index / Math.max(1, progress.total - 1)) * 100),
        )
      : null;

  return (
    <div className="group relative rounded-lg overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick();
          }
        }}
        className="block w-full text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="relative aspect-[2/3] bg-bg-subtle overflow-hidden rounded-lg">
          {card.coverPath ? (
            <img
              src={thumbUrl(card.coverPath)}
              alt=""
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover object-[50%_30%] group-hover:scale-[1.04] transition-transform duration-500"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-fg-subtle">
              <FolderIcon size={20} />
            </div>
          )}
          {/* 进度角标只在真正读过几页时出现：刚打开过的相册（index=0）
              挂一层暗化蒙版 + 「看到 1 / N」只是噪音。 */}
          {progressPercent !== null && progress && progress.index > 0 && (
            <div className="absolute bottom-0 left-0 right-0 px-2.5 py-2 bg-gradient-to-t from-black/75 to-transparent">
              <div className="text-white/95 text-[11.5px] font-medium tabular-nums">
                看到 {progress.index + 1} / {progress.total}
              </div>
              <div className="mt-1.5 h-0.5 bg-white/25 rounded-full overflow-hidden">
                <div
                  className="h-full bg-white rounded-full"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}
        </div>
        <div className="pt-2.5">
          <div className="text-[14px] font-medium text-fg line-clamp-2 leading-snug group-hover:text-accent transition-colors">
            {card.title}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRemove();
        }}
        className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-black/55 text-white/90 hover:bg-danger hover:text-white flex items-center justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-all"
        title={`将「${card.title}」标记为已读`}
        aria-label={`将${card.title}标记为已读`}
      >
        <CloseIcon size={13} />
      </button>
    </div>
  );
}
