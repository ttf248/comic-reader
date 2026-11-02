// Gallery 上下文：在多个列表页（主页 / 最近 / 收藏 / 智能合集 / 单本详情）点开一个
// 相册进入画廊时，把「从这里来的列表」存下来；画廊内 `N / P` 快捷键就在
// 这个列表里上下移动，让「随便翻翻收藏」的连续阅读体验更顺。
//
// 写入由各列表页负责，读取由 Gallery 负责。同一 session 内有效，
// 关闭标签页或点开完全不同的来源时由写入方覆盖。

import { decodeFavPath } from "./path";

export type GallerySource =
  | {
      type: "home";
    }
  | { type: "favorites" }
  | { type: "recents" }
  | { type: "unread" }
  | { type: "tag"; tag: string }
  | { type: "album"; parentPath: string }
  | { type: "collection"; parentPath: string }
  | { type: "search" }
  | { type: "shuffle" }
  | { type: "direct" };

export interface GalleryContextEntry {
  /** 列表元素的稳定资源 ID：用于与当前画廊 path 对比。 */
  key: string;
  /** 跳转 URL（相对路径）。 */
  to: string;
  /** 显示用名称（列表页上展示的标题）。 */
  name: string;
  /**
   * 条目类型：集合没有阅读器入口（集合下是子相册，不能直接翻页）。
   * 缺省按相册处理 —— 列表页给相册写上下文时无需重复标注。
   */
  kind?: "album" | "collection";
  /** 图片数：跳本时用来跳过没有可读图片的相册。缺省表示未知，不跳过。 */
  imageCount?: number;
  /** 视频数：同上，用于视频模式。 */
  videoCount?: number;
}

/**
 * 条目在阅读器里的地址；集合没有阅读器入口，返回 null。
 *
 * 跳本（上一本 / 下一本、读到末尾自动切换）时用它留在阅读器里继续读，
 * 而不是跳到相册首页再让用户重新点「开始浏览」。
 */
export function entryReaderUrl(entry: GalleryContextEntry): string | null {
  if (entry.kind === "collection") return null;
  if (!entry.to.startsWith("/albums/")) return null;
  const id = decodeFavPath(entry.to);
  if (!id) return null;
  const params = new URLSearchParams({ path: id, index: "0" });
  if (entry.name) params.set("name", entry.name);
  return `/gallery?${params.toString()}`;
}

export interface GalleryContext {
  source: GallerySource;
  /** 当前列表的全部条目。 */
  list: GalleryContextEntry[];
  /** 进入画廊那一刻所在列表里的索引；N/P 用它定位上下本。 */
  index: number;
  /** 进入时间，用于诊断 / 显示「从某处点开」。 */
  openedAt: number;
}

const KEY = "local-gallery-context";

/** 写入：覆盖式（最近一次导航的列表为准）。 */
export function setGalleryContext(ctx: Omit<GalleryContext, "openedAt">): void {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ ...ctx, openedAt: Date.now() } satisfies GalleryContext),
    );
  } catch {
    // sessionStorage 不可用时静默退化
  }
}

/** 读取最近一次上下文；读不到返回 null。 */
export function getGalleryContext(): GalleryContext | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GalleryContext;
    if (!parsed || !Array.isArray(parsed.list)) return null;
    return parsed;
  } catch {
    return null;
  }
}
