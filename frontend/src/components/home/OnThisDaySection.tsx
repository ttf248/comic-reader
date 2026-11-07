import { useMemo } from "react";
import type { LibraryOnThisDayItem } from "../../api/library";
import { nodeSummaryToCard } from "../../utils/libraryCard";
import AlbumCard from "../album/AlbumCard";

interface Props {
  /** 往年同一天拍过照的相册，按命中的日期倒序。 */
  items: LibraryOnThisDayItem[];
  /** 今天的月与日（1 起）。 */
  month: number;
  day: number;
  /** 这一段在首页里的序号。 */
  sectionIndex: string;
}

/**
 * 「那年今日」：往年同一天拍过照的那几本相册。
 *
 * 它靠拍摄时间成立 —— 拍摄时间从文件名推断（IMG_20240101_… 这类
 * 写法），没有拍摄时间的相册不在其中：「那天拍过」这句话得是真的。
 *
 * 这一段只属于照片工作台：漫画没有拍摄时间，它那侧是「继续阅读」。
 */
export default function OnThisDaySection({
  items,
  month,
  day,
  sectionIndex,
}: Props) {
  // 命中的那一天跟相册的代表日期不是一回事：相册的 date 未必是
  // 今天这个月日，两者一起带着走。
  const cards = useMemo(
    () =>
      items.map((item) => ({
        card: nodeSummaryToCard(item),
        matched: item.matchedDate,
      })),
    [items],
  );
  if (cards.length === 0) return null;
  return (
    <section className="page-shell pt-9" data-testid="on-this-day-section">
      <div className="section-heading">
        <span className="section-index">{sectionIndex}</span>
        <h2 className="section-title">那年今日</h2>
        <span className="section-meta">
          {month} 月 {day} 日 · 往年这天有 {cards.length} 本相册
        </span>
      </div>
      <div className="on-this-day__grid">
        {cards.map(({ card, matched }) => (
          <AlbumCard
            key={card.id}
            data={card}
            showUnreadBadge={false}
            coverRatio="1/1"
            note={formatMatchedDate(matched)}
          />
        ))}
      </div>
    </section>
  );
}

/** "2023-11-07" → "2023 年 11 月 7 日"。 */
function formatMatchedDate(value: string): string {
  const parts = value.split("-");
  if (parts.length !== 3) return value;
  const [year, month, day] = parts;
  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
}
