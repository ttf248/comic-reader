import { Link } from "react-router-dom";
import type { LibraryNodeSummary } from "../../api/library";
import { useFavorites } from "../../hooks/useFavorites";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { photoCopy } from "../../utils/workbench";
import { mediaCountCompact, mediaCountLabel } from "../../utils/mediaCount";
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

/**
 * 宽屏的照片墙：墙面够宽就多摆几本。
 *
 * 四张一排时，1600px 以上每张被拉到三百多像素见方，读起来像四张巨幅
 * 海报，不像一面展陈墙；六张一排才回到「墙」的密度。
 */
const WIDE_WALL_QUERY = "(min-width: 1600px)";

interface RecentlyAddedProps {
  items: LibraryNodeSummary[];
  total: number;
  /** 「全部」：把首页网格按加入时间排好并滚过去。 */
  onShowAll: () => void;
}

/** 最近加入：按业务日期倒序的最近照片相册。 */
export function RecentlyAddedHero({
  items,
  total,
  onShowAll,
}: RecentlyAddedProps) {
  const copy = photoCopy();
  const { favorites } = useFavorites();
  const favoriteIds = new Set(favorites);
  const cards: CardData[] = items.map((album) => ({
    ...nodeSummaryToCard(album),
    isFavorite: favoriteIds.has(album.id),
  }));
  const isWideWall = useMediaQuery(WIDE_WALL_QUERY);
  if (cards.length === 0) return null;
  return (
    <section
      className="hero-panel home-recent"
      data-testid="recently-added-hero"
      aria-labelledby="recently-added-heading"
    >
      <div className="flex items-start justify-between gap-3 mb-5">
        <div>
          <p className="page-eyebrow mb-2">{copy.recentlyAddedEyebrow}</p>
          <h2 id="recently-added-heading" className="section-title">
            {copy.recentlyAddedTitle}{" "}
            <span className="font-sans text-body font-normal text-fg-muted ml-2 tabular-nums">
              {total} {copy.recentlyAddedCountLabel}
            </span>
          </h2>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* 这一区讲的是「最近加入」，所以「全部」指的是全部按加入
              时间排开，而不是跳到「最近看」那一页。 */}
          <button
            type="button"
            onClick={onShowAll}
            className="btn btn-sm btn-ghost"
            aria-label="按加入时间排序，查看全部相册"
            title="按加入时间排序，查看全部相册"
          >
            全部 <ArrowRightLineIcon size={14} />
          </button>
        </div>
      </div>
      <div className="hero-grid hero-grid--wall">
        {cards.slice(0, isWideWall ? 6 : 4).map((card) => (
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
  /** 随机候选：第一本是主角，其余是下面那一排。 */
  albums: LibraryNodeSummary[];
  isLoading: boolean;
  onReshuffle: () => void;
}

/**
 * 随手看看：随机给几本照片相册。
 *
 * 照片工作台没有「未读」那种天然的下一步，所以给一个轻量的随机入口：
 * 一次点击换一批，让人从时间线之外撞见没预期的照片。
 *
 * 一次给三本：只摆一本时面板下方空出一大片 —— 与「接着看」并排时，
 * 两块面板一高一低，矮的那块读起来像没写完。三本候选把那块填上，
 * 也让人一次撞见几种不同的照片。
 */
export function SerendipityHero({
  albums,
  isLoading,
  onReshuffle,
}: SerendipityProps) {
  const copy = photoCopy();
  const featured = albums[0];
  const rest = albums.slice(1, 3);
  if (!featured) return null;
  const card = nodeSummaryToCard(featured);
  return (
    <section
      className="hero-panel home-serendipity"
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
          className="hero-panel__muted inline-flex items-center gap-1 ml-auto min-h-7 px-1 rounded"
          title={copy.serendipityButton}
          aria-label={copy.serendipityButton}
        >
          <ShuffleIcon size={12} />
          {isLoading ? copy.serendipityLoading : copy.serendipityButton}
        </button>
      </div>
      <div className="hero-panel__feature">
        <Link
          to={card.to}
          aria-label={`打开相册「${card.title}」`}
          className="hero-cover hero-cover--print"
        >
          <Cover card={card} large />
        </Link>
        <div className="min-w-0">
          <p className="hero-panel__muted">{copy.serendipityHint}</p>
          <h3 className="hero-panel__title line-clamp-2">
            {card.displayTitle ?? card.title}
          </h3>
          <p className="hero-panel__muted mt-3 tabular-nums">
            {mediaCountLabel(card)}
          </p>
          <div className="mt-5">
            <Link to={card.to} className="btn btn-primary">
              {copy.serendipityOpenButton} <ArrowRightLineIcon size={14} />
            </Link>
          </div>
        </div>
      </div>
      {rest.length > 0 && (
        <div className="serendipity-candidates mini-queue">
          {rest.map((album) => (
            <SerendipityCandidate key={album.id} album={album} />
          ))}
        </div>
      )}
    </section>
  );
}

/** 随手看看的另外几本：与「接着看」的队列同一套小图语言。 */
function SerendipityCandidate({ album }: { album: LibraryNodeSummary }) {
  const card = nodeSummaryToCard(album);
  return (
    <Link
      to={card.to}
      className="mini-queue__item"
      aria-label={`打开相册「${card.displayTitle ?? card.title}」`}
    >
      <span className="mini-queue__cover">
        <Cover card={card} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-body font-medium">
          {card.displayTitle ?? card.title}
        </span>
        <span className="hero-panel__muted block mt-1 tabular-nums truncate">
          {mediaCountCompact(card)}
        </span>
      </span>
    </Link>
  );
}
