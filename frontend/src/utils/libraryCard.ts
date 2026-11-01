import type { LibraryNodeSummary, LibraryTagSummary } from "../api/library";
import type { CardData } from "../components/album/AlbumCard";
import { albumRoute, tagRoute } from "./path";

export function nodeSummaryToCard(
  node: LibraryNodeSummary,
  idPrefix = node.kind === "album" ? "a:" : "c:",
): CardData {
  const isAlbum = node.kind === "album";
  // 虚拟相册（散图）的 name 恒为“本目录媒体”：几十张同名卡片在未读 /
  // 最近等扁平列表里无法区分。改用归属目录（location）做标题，把
  // “本目录媒体”降级成副标题里的类型说明。
  const isVirtualAlbum = isAlbum && node.virtual === true;
  const virtualLocation = node.location?.trim();
  return {
    id: idPrefix + node.id,
    variant: node.kind,
    title: node.name,
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
