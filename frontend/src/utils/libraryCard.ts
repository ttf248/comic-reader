import type { LibraryNodeSummary, LibraryTagSummary } from "../api/library";
import type { CardData } from "../components/album/AlbumCard";
import { albumRoute, tagRoute } from "./path";

export function nodeSummaryToCard(
  node: LibraryNodeSummary,
  idPrefix = node.kind === "album" ? "a:" : "c:",
): CardData {
  const isAlbum = node.kind === "album";
  // 虚拟相册（散图）的 name 恒为“本目录媒体”：几十张同名卡片在未读 /
  // 最近等扁平列表里无法区分，搜索和按名排序也都只命中这个类型词。
  // 改用归属目录（location）做标题，把“本目录媒体”降级成副标题里的
  // 类型说明。
  //
  // title 也用归属目录：各列表页的搜索、排序、跨卷上下文与提示文案都读
  // title，只改 displayTitle 的话这些地方仍会显示“本目录媒体”。
  const isVirtualAlbum = isAlbum && node.virtual === true;
  const virtualLocation = node.location?.trim();
  const title =
    isVirtualAlbum && virtualLocation ? virtualLocation : node.name;
  return {
    id: idPrefix + node.id,
    variant: node.kind,
    title,
    displayTitle:
      isVirtualAlbum && virtualLocation ? virtualLocation : node.displayName,
    subtitle: isVirtualAlbum
      ? "本目录媒体"
      : isAlbum
        ? node.tags?.join(" · ") || undefined
        : "集合",
    count: isAlbum ? (node.imageCount ?? 0) : (node.albumCount ?? 0),
    imageCount: isAlbum ? (node.imageCount ?? 0) : undefined,
    videoCount: isAlbum ? (node.videoCount ?? 0) : undefined,
    modTime: node.modTime,
    coverPath: node.coverImage ?? "",
    covers: node.coverImages,
    coverKind: node.coverKind,
    to: albumRoute(node.id),
    sourceRoot: node.sourceRoot,
    sourceName: node.sourceName,
    contentKind: node.contentKind,
  };
}

export function tagSummaryToCard(tag: LibraryTagSummary): CardData {
  return {
    id: "s:" + tag.tag,
    variant: "smart",
    title: tag.tag,
    count: tag.albumCount,
    coverPath: tag.coverImage ?? "",
    covers: tag.coverImages,
    to: tagRoute(tag.tag),
  };
}

// 首页根视图隐藏“本目录媒体”虚拟节点：它属于同路径集合的内部入口，
// 同时展示会形成两张看似重复的卡片。进入集合后仍会正常显示该相册。
export function libraryOverviewCards(
  nodes: LibraryNodeSummary[],
  tags: LibraryTagSummary[],
): CardData[] {
  return [
    ...nodes
      .filter((node) => !node.virtual)
      .map((node) => nodeSummaryToCard(node)),
    ...tags.map(tagSummaryToCard),
  ];
}

// 列表页搜索：标题与副标题一起匹配。
// 各列表页（未读 / 最近 / 收藏 / 首页）共用这一份语义，避免同一处搜索
// 在不同页面结果不同。标题对散图相册来说是归属目录，所以搜目录名能命中。
export function cardMatchesQuery(card: CardData, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${card.title} ${card.subtitle ?? ""}`.toLowerCase().includes(q);
}
