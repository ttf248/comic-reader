import { Link } from "react-router-dom";
import type { CardData } from "../album/AlbumGrid";
import Cover from "../home/Cover";
import { ChevronRightIcon } from "../common/Icon";
import { mediaCountLabel } from "../../utils/mediaCount";

/**
 * 浏览足迹：把最近看过的相册排成一条时间线。
 *
 * 「最近浏览」这一页问的问题是「我刚才在翻什么」，答案有时间。
 * 网格把相册摊平成一堆方块，时间信息被压到卡片下面的一行小字里；
 * 时间线则把「什么时候看过哪一本」直接摆出来：左边一列时刻，
 * 右边一列照片，读起来像一份浏览日记。
 *
 * 只用于照片工作台：照片没有阅读进度，「最近浏览」是这一侧唯一的
 * 「刚才在做什么」的线索。漫画侧是「最近阅读」，那儿的进度与
 * 已读状态由封面与进度条承担，仍然用网格。
 */
export default function FootprintTimeline({ cards }: { cards: CardData[] }) {
  return (
    <ol className="footprint">
      {cards.map((card) => (
        <li key={card.id} className="footprint__row">
          <span className="footprint__stamp">{stamp(card.lastSeenAt)}</span>
          <span className="footprint__node" aria-hidden="true" />
          <Link to={card.to} className="footprint__item group/footprint">
            <span className="footprint__print">
              <Cover card={card} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="footprint__title block truncate">
                {card.displayTitle ?? card.title}
              </span>
            </span>
            {/* 数量单独一列，右对齐：整列上下对齐，扫读时一眼看到
                「看过的量」；压在名字下面就成了随手的一行小字。 */}
            <span className="footprint__meta tabular-nums shrink-0">
              {mediaCountLabel(card)}
            </span>
            <ChevronRightIcon
              size={14}
              className="shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover/footprint:opacity-100"
            />
          </Link>
        </li>
      ))}
    </ol>
  );
}

/**
 * 时刻标签：今天给到分钟，昨天给「昨天 HH:MM」，更早给月日。
 *
 * 「N 分钟前」这类相对时间在时间线上会越排越短，读起来像一列长度
 * 不一的字符串；固定格式的时刻才能上下对齐成一条轴。
 */
function stamp(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  const time = d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
