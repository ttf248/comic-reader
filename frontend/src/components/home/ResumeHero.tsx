import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { CardData } from "../album/AlbumGrid";
import Cover from "./Cover";
import { ArrowRightLineIcon } from "../common/Icon";
import { photoCopy } from "../../utils/workbench";
import { recentsRoute } from "../../utils/path";
import { timeAgo } from "../../utils/date";

/**
 * 照片工作台的「接着看」专区。
 *
 * 它是漫画侧「继续阅读」的对称物：漫画有阅读进度与已读状态，所以能说
 * 「读到 12 / 200」；照片没有进度，只有「上次打开过哪本」这一条线索，
 * 因此这里给的是相册本身与上次浏览的时间，不假装有进度条。
 *
 * 边界说清楚：照片不留浏览位置，所以「接着看」回到相册，回不到具体
 * 某一张。这与照片侧的其它入口一致（「最近浏览」同样只到相册）。
 */

interface Props {
  /** 当前工作台最近看过的相册，按最近在前。 */
  cards: CardData[];
}

export default function ResumeHero({ cards }: Props) {
  const copy = photoCopy();
  const featured = cards[0];
  const rest = useMemo(() => cards.slice(1, 4), [cards]);

  if (!featured) return null;

  return (
    <section
      className="photo-desk home-resume"
      data-testid="resume-hero"
      aria-labelledby="resume-heading"
    >
      <div className="flex items-center gap-3 flex-wrap">
        <h2 id="resume-heading" className="section-title">
          {copy.resumeTitle}
        </h2>
        <span className="reading-desk__muted tabular-nums">
          {cards.length} {copy.resumeCountLabel}
        </span>
      </div>
      <div className="photo-desk__feature">
        <Link
          to={featured.to}
          className="photo-cover"
          aria-label={`${copy.resumeButton}「${featured.displayTitle ?? featured.title}」`}
        >
          <Cover card={featured} large />
        </Link>
        <div className="min-w-0">
          <p className="reading-desk__muted">{copy.resumeHint}</p>
          <h3 className="reading-desk__title line-clamp-2">
            {featured.displayTitle ?? featured.title}
          </h3>
          <p className="reading-desk__muted mt-3 tabular-nums">
            {featured.imageCount ?? 0} {copy.mediaUnit}
            {featured.lastSeenAt && (
              <>
                {" · "}
                {copy.resumeLastSeenLabel} {timeAgo(featured.lastSeenAt)}
              </>
            )}
          </p>
          <div className="mt-5">
            <Link to={featured.to} className="btn btn-primary">
              {copy.resumeButton} <ArrowRightLineIcon size={14} />
            </Link>
          </div>
        </div>
      </div>
      {rest.length > 0 && (
        <div className="reading-queue">
          {rest.map((card) => (
            <ResumeQueueItem key={card.id} card={card} />
          ))}
        </div>
      )}
      {cards.length > 4 && (
        <Link
          to={recentsRoute("photo")}
          className="reading-desk__muted inline-flex items-center gap-2 self-end mt-4 min-h-7"
        >
          还有 {cards.length - 4} 本最近看过 <ArrowRightLineIcon size={12} />
        </Link>
      )}
    </section>
  );
}

function ResumeQueueItem({ card }: { card: CardData }) {
  const copy = photoCopy();
  return (
    <div className="reading-queue__item">
      <Link
        to={card.to}
        className="reading-queue__open"
        aria-label={`${copy.resumeButton}「${card.displayTitle ?? card.title}」`}
      >
        <span className="w-10 h-10 shrink-0 rounded-md overflow-hidden bg-bg-media">
          <Cover card={card} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-body font-medium">
            {card.displayTitle ?? card.title}
          </span>
          <span className="reading-desk__muted block mt-1 tabular-nums">
            {card.imageCount ?? 0} {copy.mediaUnit}
            {card.lastSeenAt && (
              <>
                {" · "}
                {timeAgo(card.lastSeenAt)}
              </>
            )}
          </span>
        </span>
      </Link>
    </div>
  );
}
