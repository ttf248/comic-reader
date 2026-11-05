import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useFavorites } from "../../hooks/useFavorites";
import { decodeFavPath, recentsRoute, unreadRoute } from "../../utils/path";
import { readingPercent } from "../../utils/continueReading";
import { comicCopy } from "../../utils/workbench";
import AlbumCard from "../album/AlbumCard";
import type { CardData } from "../album/AlbumGrid";
import Cover from "./Cover";
import {
  ArrowRightLineIcon,
  CheckIcon,
  CloseIcon,
  ShuffleIcon,
} from "../common/Icon";

interface UnreadHeroProps {
  cards: CardData[];
  count: number;
  onShuffle: () => void;
  onMarkRead: (card: CardData) => void;
}

// 未读区只出现在漫画工作台：照片那边没有未读这回事。
export function UnreadHero({
  cards,
  count,
  onShuffle,
  onMarkRead,
}: UnreadHeroProps) {
  const { favorites } = useFavorites();
  const favoriteIds = useMemo(() => new Set(favorites), [favorites]);
  const copy = comicCopy();
  return (
    <section
      className="discovery-panel"
      data-testid="unread-hero"
      aria-labelledby="unread-heading"
    >
      <div className="flex items-start justify-between gap-3 mb-5">
        <div>
          <p className="page-eyebrow mb-2">{copy.unreadEyebrow}</p>
          <h2 id="unread-heading" className="section-title">
            {copy.unreadTitle}{" "}
            <span className="font-sans text-[13px] font-normal text-fg-muted ml-2 tabular-nums">
              {count} {copy.unreadCountLabel}
            </span>
          </h2>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onShuffle}
            className="btn btn-sm btn-ghost"
            title={copy.unreadButton}
            aria-label={copy.unreadButton}
          >
            <ShuffleIcon size={15} />
          </button>
          <Link
            to={unreadRoute()}
            className="btn btn-sm btn-ghost"
            aria-label={`查看全部${copy.unreadTitle}相册`}
          >
            全部 <ArrowRightLineIcon size={14} />
          </Link>
        </div>
      </div>
      <div className="discovery-grid">
        {cards.slice(0, 4).map((card) => (
          <AlbumCard
            key={card.id}
            data={{
              ...card,
              isFavorite: favoriteIds.has(decodeFavPath(card.to)),
            }}
            showUnreadBadge={false}
            coverRatio="16/9"
            overlayAction={
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onMarkRead(card);
                }}
                className="w-7 h-7 rounded-full bg-black/65 text-white flex items-center justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                title={`将「${card.title}」${copy.markFinishedLabel}`}
                aria-label={`将${card.title}${copy.markFinishedLabel}`}
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

interface ContinueHeroProps {
  cards: CardData[];
  onContinue: (card: CardData) => void;
  onRemove: (card: CardData) => void;
  onClearAll: () => void;
}

// 继续阅读区只出现在漫画工作台：照片那边不记录阅读位置。
export function ContinueHero({
  cards,
  onContinue,
  onRemove,
  onClearAll,
}: ContinueHeroProps) {
  const featured = cards[0];
  if (!featured) return null;
  const rest = cards.slice(1, 4);
  const copy = comicCopy();
  return (
    <section
      className="reading-desk"
      data-testid="continue-hero"
      aria-labelledby="continue-heading"
    >
      <div className="flex items-center gap-3 flex-wrap">
        <h2 id="continue-heading" className="section-title">
          {copy.continueTitle}
        </h2>
        <span className="reading-desk__muted tabular-nums">
          {cards.length} {copy.unfinishedCountLabel}
        </span>
        <button
          type="button"
          onClick={onClearAll}
          className="reading-desk__muted inline-flex items-center gap-1 ml-auto min-h-7 px-1 rounded"
          title={copy.markAllTitle}
        >
          <CloseIcon size={12} />
          清空
        </button>
      </div>
      <div className="reading-desk__feature">
        <StagePoster card={featured} onClick={() => onContinue(featured)} />
        <div className="min-w-0">
          <p className="reading-desk__muted">上次，看到这里</p>
          <h3 className="reading-desk__title line-clamp-2">
            {featured.displayTitle ?? featured.title}
          </h3>
          <StageInfo
            card={featured}
            onContinue={() => onContinue(featured)}
            onRemove={() => onRemove(featured)}
          />
        </div>
      </div>
      {rest.length > 0 && (
        <div className="reading-queue">
          {rest.map((card) => (
            <QueueItem
              key={card.id}
              card={card}
              onOpen={() => onContinue(card)}
              onRemove={() => onRemove(card)}
            />
          ))}
        </div>
      )}
      {cards.length > 4 && (
        <Link
          to={recentsRoute("comic")}
          className="reading-desk__muted inline-flex items-center gap-2 self-end mt-4 min-h-7"
        >
          还有 {cards.length - 4} 本在读 <ArrowRightLineIcon size={12} />
        </Link>
      )}
    </section>
  );
}

function StagePoster({
  card,
  onClick,
}: {
  card: CardData;
  onClick: () => void;
}) {
  const copy = comicCopy();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${copy.continueTitle}「${card.title}」`}
      className="reading-cover"
    >
      <Cover card={card} large />
    </button>
  );
}

function StageInfo({
  card,
  onContinue,
  onRemove,
}: {
  card: CardData;
  onContinue: () => void;
  onRemove: () => void;
}) {
  const { index = 0, total = 0 } = card.progress ?? {};
  const percent = readingPercent({ index, total });
  const copy = comicCopy();
  return (
    <div className="mt-4">
      <p className="reading-desk__muted tabular-nums">
        {copy.positionVerb} {index + 1} / {total}
        {copy.showReadingPercent && (
          <span className="ml-3">已读 {percent}%</span>
        )}
      </p>
      <div
        className="mt-3 h-1.5 rounded-full bg-accent/15 overflow-hidden"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`「${card.title}」${copy.continueTitle}进度`}
      >
        <div
          className="h-full bg-accent rounded-full transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onContinue} className="btn btn-primary">
          {copy.continueButton} <ArrowRightLineIcon size={14} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="btn btn-sm btn-ghost"
          title={`将「${card.title}」${copy.markFinishedLabel}`}
          aria-label={`将${card.title}${copy.markFinishedLabel}`}
        >
          <CheckIcon size={13} />
          <span className="hidden sm:inline">{copy.markFinishedLabel}</span>
        </button>
      </div>
    </div>
  );
}

function QueueItem({
  card,
  onOpen,
  onRemove,
}: {
  card: CardData;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const copy = comicCopy();
  return (
    <div className="reading-queue__item group">
      <button
        type="button"
        className="reading-queue__open"
        onClick={onOpen}
        aria-label={`${copy.continueTitle}「${card.title}」`}
      >
        <span className="w-10 h-12 shrink-0 rounded-md overflow-hidden bg-bg-media">
          <Cover card={card} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium">
            {card.displayTitle ?? card.title}
          </span>
          <span className="reading-desk__muted block mt-1 tabular-nums">
            {copy.positionVerb} {(card.progress?.index ?? 0) + 1} /{" "}
            {card.progress?.total ?? 0}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="reading-queue__remove"
        title={`将「${card.title}」${copy.markFinishedLabel}`}
        aria-label={`将${card.title}${copy.markFinishedLabel}`}
      >
        <CheckIcon size={12} />
      </button>
    </div>
  );
}
