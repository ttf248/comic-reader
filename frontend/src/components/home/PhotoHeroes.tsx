import { Link } from "react-router-dom";
import type { LibraryNodeSummary } from "../../api/library";
import { useFavorites } from "../../hooks/useFavorites";
import { recentsRoute } from "../../utils/path";
import { photoCopy } from "../../utils/workbench";
import { nodeSummaryToCard } from "../../utils/libraryCard";
import AlbumCard from "../album/AlbumCard";
import type { CardData } from "../album/AlbumGrid";
import Cover from "./Cover";
import { ArrowRightLineIcon, ShuffleIcon } from "../common/Icon";

/**
 * 照片工作台的首屏专区。
 *
 * 漫画那边有「继续阅读」与「未读」，照片这边没有进度可言，但它同样需要
 * 一块值得停留的地方：最近加入的照片与随手看看的一本。两块专区共用
 * 首页既有的 hero 骨架，视觉上与漫画侧对齐，语义上完全属于照片。
 */

interface RecentlyAddedProps {
  items: LibraryNodeSummary[];
  total: number;
}

/** 最近加入：按业务日期倒序的最近照片相册。 */
export function RecentlyAddedHero({ items, total }: RecentlyAddedProps) {
  const copy = photoCopy();
  const { favorites } = useFavorites();
  const favoriteIds = new Set(favorites);
  const cards: CardData[] = items.map((album) => ({
    ...nodeSummaryToCard(album),
    isFavorite: favoriteIds.has(album.id),
  }));
  if (cards.length === 0) return null;
  return (
    <section
      className="discovery-panel home-recent"
      data-testid="recently-added-hero"
      aria-labelledby="recently-added-heading"
    >
      <div className="flex items-start justify-between gap-3 mb-5">
        <div>
          <p className="page-eyebrow mb-2">{copy.recentlyAddedEyebrow}</p>
          <h2 id="recently-added-heading" className="section-title">
            {copy.recentlyAddedTitle}{" "}
            <span className="font-sans text-[13px] font-normal text-fg-muted ml-2 tabular-nums">
              {total} {copy.recentlyAddedCountLabel}
            </span>
          </h2>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Link
            to={recentsRoute("photo")}
            className="btn btn-sm btn-ghost"
            aria-label={`查看${copy.recentlyAddedTitle}`}
          >
            全部 <ArrowRightLineIcon size={14} />
          </Link>
        </div>
      </div>
      <div className="discovery-grid discovery-grid--wall">
        {cards.slice(0, 4).map((card) => (
          <AlbumCard
            key={card.id}
            data={card}
            showUnreadBadge={false}
            coverRatio="1/1"
          />
        ))}
      </div>
    </section>
  );
}

interface SerendipityProps {
  album: LibraryNodeSummary | null;
  isLoading: boolean;
  onReshuffle: () => void;
}

/**
 * 随手看看：随机给一本照片相册。
 *
 * 照片工作台没有「未读」那种天然的下一步，所以给一个轻量的随机入口：
 * 一次点击换一本，让人从时间线之外撞见一张没预期的照片。
 */
export function SerendipityHero({
  album,
  isLoading,
  onReshuffle,
}: SerendipityProps) {
  const copy = photoCopy();
  if (!album) return null;
  const card = nodeSummaryToCard(album);
  return (
    <section
      className="photo-desk home-serendipity"
      data-testid="serendipity-hero"
      aria-labelledby="serendipity-heading"
    >
      <div className="flex items-center gap-3 flex-wrap">
        <h2 id="serendipity-heading" className="section-title">
          {copy.serendipityTitle}
        </h2>
        <button
          type="button"
          onClick={onReshuffle}
          disabled={isLoading}
          className="reading-desk__muted inline-flex items-center gap-1 ml-auto min-h-7 px-1 rounded"
          title={copy.serendipityButton}
          aria-label={copy.serendipityButton}
        >
          <ShuffleIcon size={12} />
          {isLoading ? copy.serendipityLoading : copy.serendipityButton}
        </button>
      </div>
      <div className="photo-desk__feature">
        <Link
          to={card.to}
          aria-label={`打开相册「${card.title}」`}
          className="photo-cover"
        >
          <Cover card={card} large />
        </Link>
        <div className="min-w-0">
          <p className="reading-desk__muted">{copy.serendipityHint}</p>
          <h3 className="reading-desk__title line-clamp-2">
            {card.displayTitle ?? card.title}
          </h3>
          <p className="reading-desk__muted mt-3 tabular-nums">
            {card.imageCount ?? 0} {copy.mediaUnit}
            {(card.videoCount ?? 0) > 0 && ` · ${card.videoCount} 个视频`}
          </p>
          <div className="mt-5">
            <Link to={card.to} className="btn btn-primary">
              {copy.serendipityOpenButton} <ArrowRightLineIcon size={14} />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
