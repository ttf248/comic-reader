import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { CardData } from "../album/AlbumGrid";
import Cover from "./Cover";
import { ArrowRightLineIcon } from "../common/Icon";
import { photoCopy } from "../../utils/workbench";
import { mediaCountCompact, mediaCountLabel } from "../../utils/mediaCount";
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
      className="hero-panel home-resume"
      data-testid="resume-hero"
      aria-labelledby="resume-heading"
    >
      {/* 标题行右侧是「还有几本」的出口：它说的是这一段的总量，
          放在这里而不是面板底部 —— 底部左侧空着、右侧飘着一行字，
          读起来像漏排。 */}
      <div className="flex items-center gap-3 flex-wrap">
        <h2 id="resume-heading" className="section-title">
          {copy.resumeTitle}
        </h2>
        <span className="hero-panel__muted tabular-nums">
          {cards.length} {copy.resumeCountLabel}
        </span>
        {cards.length > 4 && (
          <Link
            to={recentsRoute("photo")}
            className="hero-panel__muted ml-auto inline-flex items-center gap-1.5 min-h-7 hover:text-fg transition-colors"
          >
            还有 {cards.length - 4} 本最近看过 <ArrowRightLineIcon size={12} />
          </Link>
        )}
      </div>
      {/* 主角与最近看过的其余相册并排：主角右边空着一大片时，
          队列就该挪过来填上，而不是掉到下一行把面板拉高。
          队列排成一排小方照（展陈墙上的次级展品），而不是一列
          三行 —— 一列三行只占住面板的右上角，中间与右下都空着。 */}
      <div className="resume-body">
        <div className="hero-panel__feature">
          <Link
            to={featured.to}
            className="hero-cover hero-cover--print"
            aria-label={`${copy.resumeButton}「${featured.displayTitle ?? featured.title}」`}
          >
            <Cover card={featured} large />
          </Link>
          <div className="min-w-0">
            <p className="hero-panel__muted">{copy.resumeHint}</p>
            <h3 className="hero-panel__title line-clamp-2">
              {featured.displayTitle ?? featured.title}
            </h3>
            <p className="hero-panel__muted mt-3 tabular-nums">
              {mediaCountLabel(featured)}
              {featured.lastSeenAt && (
                <>
                  {" · "}
                  {/* 「上次浏览 刚刚」整体不断行：窄屏上它会断在
                      「览」与「刚」之间，读起来像两个词。 */}
                  <span className="whitespace-nowrap">
                    {copy.resumeLastSeenLabel} {timeAgo(featured.lastSeenAt)}
                  </span>
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
          <div className="resume-shelf">
            {rest.map((card) => (
              <ResumeShelfItem key={card.id} card={card} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * 队列里的一本相册：一张小方照加两行说明。
 *
 * 照片侧展示的是一本相册，缩略图不能小成邮票 —— 48px 的方照读起来
 * 像一排图标，不像「看过的相册」。
 */
function ResumeShelfItem({ card }: { card: CardData }) {
  const copy = photoCopy();
  const label = card.displayTitle ?? card.title;
  return (
    <Link
      to={card.to}
      className="resume-shelf__item group"
      aria-label={`${copy.resumeButton}「${label}」`}
    >
      <span className="resume-shelf__cover">
        <Cover card={card} />
      </span>
      <span className="mt-2 block truncate text-body font-medium text-fg transition-colors group-hover:text-brand-ink">
        {label}
      </span>
      <span className="hero-panel__muted mt-0.5 block truncate text-meta tabular-nums">
        {mediaCountCompact(card)}
        {card.lastSeenAt && (
          <>
            {" · "}
            <span className="whitespace-nowrap">{timeAgo(card.lastSeenAt)}</span>
          </>
        )}
      </span>
    </Link>
  );
}
