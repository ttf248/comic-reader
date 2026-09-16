import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
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
  ReaderIcon,
  ShuffleIcon,
  SparkleIcon,
} from "../common/Icon";

interface UnreadHeroProps {
  cards: CardData[];
  count: number;
  onShuffle: () => void;
  onMarkRead: (card: CardData) => void;
}

// 首页未读入口：只展示前六本，完整列表交给 /unread 页面。
export function UnreadHero({
  cards,
  count,
  onShuffle,
  onMarkRead,
}: UnreadHeroProps) {
  const navigate = useNavigate();
  const { favorites } = useFavorites();
  const favoriteIds = useMemo(() => new Set(favorites), [favorites]);
  const visible = cards.slice(0, 6);

  return (
    <section
      className="px-6 lg:px-10 max-w-[1400px] mx-auto w-full pt-8 pb-2"
      data-testid="unread-hero"
    >
      <div className="bg-accent-soft border border-accent/20 rounded-xl px-5 py-4">
        <div className="flex items-center gap-3 flex-wrap mb-3">
          <SparkleIcon size={13} className="text-accent" />
          <span className="text-[11px] uppercase tracking-[0.18em] text-accent font-medium">
            未读
          </span>
          <span className="text-[13px] text-fg">
            还有 <span className="font-semibold tabular-nums">{count}</span>{" "}
            本没看
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onShuffle}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-accent text-accent-contrast hover:bg-accent-hover text-xs font-medium transition-colors"
            >
              <ShuffleIcon size={12} />
              随机未读
            </button>
            <button
              onClick={() => navigate("/unread")}
              className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-border-faint text-fg-muted hover:text-fg hover:border-border-strong text-xs transition-colors"
            >
              全部
              <ArrowRightLineIcon size={11} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
          {visible.map((card) => (
            <div key={card.id} className="relative group">
              <AlbumCard
                data={{
                  ...card,
                  isFavorite: favoriteIds.has(decodeFavPath(card.to)),
                }}
              />
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onMarkRead(card);
                }}
                className="absolute top-1.5 right-1.5 z-10 w-6 h-6 rounded-full bg-black/55 text-white/90 hover:bg-accent hover:text-white flex items-center justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-all"
                title={`将「${card.title}」标记为已读`}
                aria-label={`将${card.title}标记为已读`}
              >
                <CheckIcon size={12} />
              </button>
            </div>
          ))}
        </div>
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
export function ContinueReadingHero({
  cards,
  onContinue,
  onRemove,
  onClearAll,
}: ContinueReadingHeroProps) {
  return (
    <section
      className="px-6 lg:px-10 max-w-[1400px] mx-auto w-full pt-4 pb-2"
      data-testid="continue-hero"
    >
      <div className="border border-border-faint rounded-xl px-5 py-4 bg-bg-subtle/40">
        <div className="flex items-center gap-3 flex-wrap mb-3">
          <ReaderIcon size={13} className="text-fg-muted" />
          <span className="text-[11px] uppercase tracking-[0.18em] text-fg-muted font-medium">
            继续阅读
          </span>
          <span className="text-[13px] text-fg-muted">
            <span className="tabular-nums text-fg">{cards.length}</span>{" "}
            本还没看完
          </span>
          <span className="flex-1" />
          <button
            onClick={onClearAll}
            className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] text-fg-subtle hover:text-danger hover:bg-danger-soft transition-colors"
            title="把当前所有继续阅读相册标记为已读(不影响收藏 / 最近)"
          >
            <CloseIcon size={10} />
            清空
          </button>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
          {cards.slice(0, 6).map((card) => (
            <ContinueCard
              key={card.id}
              card={card}
              onClick={() => onContinue(card)}
              onRemove={() => onRemove(card)}
            />
          ))}
        </div>
      </div>
    </section>
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
      className="group block text-left rounded-lg border border-border-faint bg-bg-elevated overflow-hidden hover:border-border-strong hover:shadow-md transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="relative aspect-[3/4] bg-bg-subtle overflow-hidden">
        {card.coverPath ? (
          <img
            src={thumbUrl(card.coverPath)}
            alt={card.title}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-fg-subtle">
            <FolderIcon size={20} />
          </div>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove();
          }}
          className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/55 text-white/90 hover:bg-danger hover:text-white flex items-center justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-all"
          title={`将「${card.title}」标记为已读`}
          aria-label={`将${card.title}标记为已读`}
        >
          <CloseIcon size={12} />
        </button>
        {progressPercent !== null && progress && (
          <div className="absolute bottom-0 left-0 right-0 px-2 py-1.5 bg-gradient-to-t from-black/65 to-transparent">
            <div className="text-white/95 text-[10px] font-medium tabular-nums">
              看到 {progress.index + 1} / {progress.total}
            </div>
            <div className="mt-1 h-0.5 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-accent"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}
      </div>
      <div className="px-2 py-1.5">
        <div className="text-[12px] font-medium text-fg line-clamp-1 group-hover:text-accent transition-colors">
          {card.title}
        </div>
      </div>
    </div>
  );
}
