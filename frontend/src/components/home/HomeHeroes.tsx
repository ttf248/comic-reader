import { useMemo } from "react";
import { Link } from "react-router-dom";
import { thumbUrl } from "../../api/thumbs";
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

interface UnreadHeroProps {
  cards: CardData[];
  count: number;
  onShuffle: () => void;
  onMarkRead: (card: CardData) => void;
}

// 首页未读入口：只展示前六本，完整列表交给 /unread 页面。
//
// 视觉：不再套 accent-soft 边框盒 —— 区块靠标题行与留白分组，
// 内容（封面）才是主角。
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
          <button
            onClick={onShuffle}
            className="btn btn-sm btn-outline"
          >
            <ShuffleIcon size={12} />
            随机未读
          </button>
          <Link
            to="/unread"
            className="btn btn-sm btn-ghost"
          >
            全部
            <ArrowRightLineIcon size={12} />
          </Link>
        </div>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3 lg:gap-4">
        {visible.map((card) => (
          <AlbumCard
            key={card.id}
            data={{
              ...card,
              isFavorite: favoriteIds.has(decodeFavPath(card.to)),
            }}
            /* 整个区块都是未读，卡片再挂「新」角标只是噪音 */
            showUnreadBadge={false}
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
// 版式：最近在读的一本做成「横幅卡」（左封面 + 右信息 + 进度条），
// 其余最多 5 本降级为海报小卡。横幅卡承担主入口的视觉重量，
// 避免"继续阅读"和"未读"在首页平铺成两个同权重的盒子。
export function ContinueReadingHero({
  cards,
  onContinue,
  onRemove,
  onClearAll,
}: ContinueReadingHeroProps) {
  const featured = cards[0];
  const rest = cards.slice(1, 6);

  return (
    <section className="page-shell pt-2 pb-2" data-testid="continue-hero">
      <div className="flex items-center gap-3 flex-wrap mb-4">
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

      {featured && (
        <ContinueFeature card={featured} onClick={() => onContinue(featured)} onRemove={() => onRemove(featured)} />
      )}

      {rest.length > 0 && (
        <div className="mt-4 grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3 lg:gap-4">
          {rest.map((card) => (
            <ContinueCard
              key={card.id}
              card={card}
              onClick={() => onContinue(card)}
              onRemove={() => onRemove(card)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// 横幅卡：首页继续阅读的主入口。
//
// 可访问性约束（回归测试锁定）：
// - 真正可点击的是 role=button 的内容区；「标记为已读」按钮是它的兄弟
//   节点，嵌套会让 Enter/Space 冒泡触发跳转，也会污染卡片的可访问名。
function ContinueFeature({
  card,
  onClick,
  onRemove,
}: {
  card: CardData;
  onClick: () => void;
  onRemove: () => void;
}) {
  const progress = card.progress;
  const total = progress?.total ?? 0;
  const index = progress?.index ?? 0;
  const percent =
    total > 1 ? Math.min(100, Math.round((index / Math.max(1, total - 1)) * 100)) : 0;

  return (
    <div className="group relative flex items-center gap-4 sm:gap-5 rounded-xl bg-bg-inset p-4 overflow-hidden">
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
        className="flex flex-1 min-w-0 items-center gap-4 sm:gap-5 rounded-lg cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="relative w-[104px] h-[130px] sm:w-[140px] sm:h-[176px] shrink-0 rounded-lg overflow-hidden bg-bg-subtle">
          {card.coverPath ? (
            <img
              src={thumbUrl(card.coverPath)}
              alt=""
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover group-hover:scale-[1.04] transition-transform duration-500"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-fg-subtle">
              <FolderIcon size={22} />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="font-display text-[18px] sm:text-[20px] font-semibold leading-tight truncate">
            {card.title}
          </div>
          <div className="text-[13px] text-fg-muted mt-1.5 tabular-nums">
            看到 {index + 1} / {total}
          </div>
          {percent > 0 && (
            <div className="mt-2.5 text-[12.5px] text-fg-subtle tabular-nums">
              已读 {percent}%
            </div>
          )}
          <div className="mt-3 sm:hidden inline-flex items-center gap-1.5 text-[13px] font-medium text-accent">
            继续阅读
            <ArrowRightLineIcon size={12} />
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onClick}
        className="hidden sm:inline-flex btn btn-primary btn-sm shrink-0"
      >
        继续阅读
        <ArrowRightLineIcon size={12} />
      </button>

      {/* 进度条贴在卡片底边：既是进度，也给这张横幅一个视觉收尾 */}
      <div className="absolute left-0 right-0 bottom-0 h-[3px] bg-bg-strong/60">
        <div
          className="h-full bg-accent transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>

      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRemove();
        }}
        className="shrink-0 w-8 h-8 rounded-md text-fg-subtle hover:text-danger hover:bg-danger/10 flex items-center justify-center transition-colors"
        title={`将「${card.title}」标记为已读`}
        aria-label={`将${card.title}标记为已读`}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

function ContinueCard({
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
    // 外层只负责卡片外观；真正可点击的是 role=button 的内容区。
    // 「标记为已读」按钮放在内容区的兄弟位置，而不是嵌套在 role=button 内部：
    // 嵌套会让按钮上的 Enter/Space 冒泡到卡片并触发跳转（而不是移除），
    // 同时把按钮的 aria-label 拼进卡片的可访问名。
    <div className="group relative rounded-lg bg-bg-inset overflow-hidden hover:bg-bg-subtle transition-colors">
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
        <div className="relative aspect-[4/5] bg-bg-subtle overflow-hidden">
          {card.coverPath ? (
            <img
              src={thumbUrl(card.coverPath)}
              alt=""
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-fg-subtle">
              <FolderIcon size={20} />
            </div>
          )}
          {/* 进度角标只在真正读过几页时出现：刚打开过的相册（index=0）
              挂一层暗化蒙版 + 「看到 1 / N」只是噪音。 */}
          {progressPercent !== null && progress && progress.index > 0 && (
            <div className="absolute bottom-0 left-0 right-0 px-2.5 py-2 bg-gradient-to-t from-black/70 to-transparent">
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
        <div className="px-2.5 py-2">
          <div className="text-[13px] font-medium text-fg line-clamp-1 group-hover:text-accent transition-colors">
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
