import type { CardData } from "../components/album/AlbumGrid";
import { decodeFavPath, readerRoute } from "./path";

/**
 * 「继续阅读」的跳转目标。
 *
 * 首页的封面台和侧栏的迷你卡都要能一键回到上次的位置，
 * 两处必须生成完全一样的 URL，否则会出现"首页跳到第 5 页、侧栏跳到封面"的
 * 分叉。逻辑集中在这里，调用方只提供卡片数据。
 *
 * 注意：不经过相册详情页 —— 进入首页最大的目的是"接着看"，
 * 中转一次详情会多一次点击。
 *
 * 落点按相册的内容用途决定：
 *  - 漫画相册 → 阅读器，并带上页码，从上次的位置接着读；
 *  - 照片相册 → 照片墙（相册入口按用途分派），照片墙自己管浏览位置。
 *
 * type 的推断（只在漫画相册里有意义）：
 *  - imageCount > 0（混合 / 纯图）→ type=image
 *  - imageCount === 0 && videoCount > 0（纯视频相册）→ type=video
 */
export function continueReadingTarget(card: CardData): string {
  if (card.variant !== "album") return card.to;
  if (card.contentKind !== "comic") return card.to;

  const idx = card.progress?.index ?? 0;
  const imgs = card.imageCount ?? 0;
  const vids = card.videoCount ?? 0;
  const galleryType: "image" | "video" =
    imgs > 0 ? "image" : vids > 0 ? "video" : "image";

  const qs = new URLSearchParams({
    index: String(idx),
    name: card.title,
    type: galleryType,
  });
  return `${readerRoute(decodeFavPath(card.to))}?${qs.toString()}`;
}

/** 阅读百分比：已翻页数 / 可翻页数。 */
export function readingPercent(
  progress: { index: number; total: number } | undefined,
): number {
  const total = progress?.total ?? 0;
  if (total <= 1) return 0;
  const index = progress?.index ?? 0;
  return Math.min(100, Math.round((index / Math.max(1, total - 1)) * 100));
}
