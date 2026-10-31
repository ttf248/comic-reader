import type { LibraryNodeSummary, LibraryTagSummary } from "../api/library";
import type { CardData } from "../components/album/AlbumCard";
import { albumRoute, tagRoute } from "./path";

export function nodeSummaryToCard(
  node: LibraryNodeSummary,
  idPrefix = node.kind === "album" ? "a:" : "c:",
): CardData {
  const isAlbum = node.kind === "album";
  return {
    id: idPrefix + node.id,
    variant: node.kind,
    title: node.name,
    displayTitle: node.displayName,
    subtitle: isAlbum ? node.tags?.join(" · ") || undefined : "集合",
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
