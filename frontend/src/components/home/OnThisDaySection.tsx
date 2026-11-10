import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  LibraryOnThisDayItem,
  LibraryOnThisDayPhoto,
} from "../../api/library";
import { nodeSummaryToCard } from "../../utils/libraryCard";
import AlbumCard from "../album/AlbumCard";
import ThumbImage from "../common/ThumbImage";
import PhotoViewer from "../wall/PhotoViewer";
import { albumRoute } from "../../utils/path";

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
 * 「那年今日」：往年同一天拍过照的那些照片。
 *
 * 它靠拍摄时间成立 —— 拍摄时间从文件名推断（IMG_20240101_… 这类
 * 写法），没有拍摄时间的相册不在其中：「那天拍过」这句话得是真的。
 *
 * 摆的是**那一天的那一张照片**，不是相册的通用封面：这一段回答的是
 * 「往年这天我拍到了什么」，给一张封面等于什么也没说。服务端拿不出
 * 这一张时（日期证据不足）退回相册封面，并且不假装封面就是那天拍的。
 *
 * 这一段只属于照片工作台：漫画没有拍摄时间，它那侧是「继续阅读」。
 */
export default function OnThisDaySection({
  items,
  month,
  day,
  sectionIndex,
}: Props) {
  // 打开大图预览的那一条：点照片直接看照片本身。
  const [viewing, setViewing] = useState<{
    photo: LibraryOnThisDayPhoto;
    albumName: string;
    albumId: string;
  } | null>(null);

  // 命中的那一天跟相册的代表日期不是一回事：相册的 date 未必是
  // 今天这个月日，两者一起带着走。
  const cards = useMemo(
    () =>
      items.map((item) => ({
        item,
        card: nodeSummaryToCard(item),
        matched: item.matchedDate,
        photo: item.photo,
      })),
    [items],
  );
  if (cards.length === 0) return null;
  // 有照片证据时数照片，没有时数相册：两个数说的事不一样，
  // 混着说会让读者以为摆出来的就是照片。
  const photoCount = cards.filter((entry) => entry.photo).length;
  const summary =
    photoCount > 0
      ? `${month} 月 ${day} 日 · 往年这天拍过 ${photoCount} 张`
      : `${month} 月 ${day} 日 · 往年这天有 ${cards.length} 本相册拍过照`;
  return (
    <section className="page-shell pt-9" data-testid="on-this-day-section">
      <div className="section-heading">
        <span className="section-index">{sectionIndex}</span>
        <h2 className="section-title">那年今日</h2>
        <span className="section-meta">{summary}</span>
      </div>
      <div className="on-this-day__grid">
        {cards.map(({ item, card, matched, photo }) =>
          photo ? (
            <OnThisDayPhotoCard
              key={card.id}
              photo={photo}
              matched={matched}
              albumName={card.displayTitle ?? card.title}
              /* 路由要的是资源 ID 本身：卡片 id 带着收藏用的前缀。 */
              albumId={item.id}
              onOpen={() =>
                setViewing({
                  photo,
                  albumName: card.displayTitle ?? card.title,
                  albumId: item.id,
                })
              }
            />
          ) : (
            // 没有日期证据时不摆照片：改回相册封面，并且说清这一段
            // 指的是这本相册，不假装封面就是那天拍的那张。
            <AlbumCard
              key={card.id}
              data={card}
              showUnreadBadge={false}
              coverRatio="1/1"
              note={`${formatMatchedDate(matched)} 拍过`}
            />
          ),
        )}
      </div>

      {viewing && (
        <PhotoViewer
          items={[viewing.photo]}
          index={0}
          albumName={viewing.albumName}
          /* 标题点一下就回到那本相册：这一段是照片，出去的路却是相册。 */
          albumHref={albumRoute("photo", viewing.albumId)}
          totalCount={1}
          onIndexChange={() => {}}
          onClose={() => setViewing(null)}
        />
      )}
    </section>
  );
}

/**
 * 一张「那年今日」的照片卡。
 *
 * 照片在上、日期与相册在下：这一段的主角是照片本身，说明只占两行。
 * 相册名是链接 —— 看完这一天还能回到那本相册里它在的位置。
 */
function OnThisDayPhotoCard({
  photo,
  matched,
  albumName,
  albumId,
  onOpen,
}: {
  photo: LibraryOnThisDayPhoto;
  matched: string;
  albumName: string;
  albumId: string;
  onOpen: () => void;
}) {
  return (
    <div className="group min-w-0" data-testid="on-this-day-photo">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full overflow-hidden rounded-md bg-bg-subtle shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-shadow duration-200 hover:shadow-[0_6px_18px_rgba(0,0,0,0.28)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        aria-label={`查看 ${formatMatchedDate(matched)} 拍的这张照片`}
      >
        {/* 照片铺满方格：这一段是展陈墙，照片之间留一道缝就够，
            不给每张再套一张白卡片。 */}
        <div className="aspect-square w-full overflow-hidden">
          <ThumbImage
            fileId={photo.id}
            alt={photo.name}
            version={photo.version}
            displayWidth={240}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        </div>
      </button>
      <div className="mt-2 min-w-0">
        <div className="text-meta text-fg-muted tabular-nums">
          {formatMatchedDate(matched)}
        </div>
        <Link
          to={albumRoute("photo", albumId)}
          title={`回到相册「${albumName}」`}
          className="block truncate text-body font-medium text-fg transition-colors hover:text-brand-ink"
        >
          {albumName}
        </Link>
      </div>
    </div>
  );
}

/** "2023-11-07" → "2023 年 11 月 7 日"。 */
function formatMatchedDate(value: string): string {
  const parts = value.split("-");
  if (parts.length !== 3) return value;
  const [year, month, day] = parts;
  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
}
