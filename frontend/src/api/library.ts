import { api, ApiError } from "./client";

export const LIBRARY_PAGE_LIMIT = 200;
export const LIBRARY_NODE_BATCH_LIMIT = 500;

/** 相册的浏览用途：照片墙还是漫画阅读器。 */
export type ContentKind = "photo" | "comic";

/**
 * 全局工作台模式。
 *
 * photo / comic 让列表只呈现该用途的相册，all 不过滤（逃生舱）。
 * 它与相册自身的 contentKind 正交：模式只决定「我现在看哪一类」，
 * 不改变任何一本相册自己的打开方式。
 */
export type AppMode = ContentKind | "all";

export interface LibraryStatistics {
  rootCount: number;
  /** 全库相册总数。它不随工作台模式变化。 */
  albumCount: number;
  /** 按用途拆分的相册数。 */
  photoAlbumCount?: number;
  comicAlbumCount?: number;
  collectionCount: number;
  tagCount: number;
  warningCount: number;
}

export interface ScanWarning {
  code: string;
  path?: string;
  message: string;
}

export interface LibraryRootSummary {
  id: string;
  name: string;
  childCount: number;
}

export interface LibraryManifest {
  revision: number;
  scannedAt: string;
  duration: number;
  roots: LibraryRootSummary[];
  statistics: LibraryStatistics;
  warnings?: ScanWarning[];
}

export interface LibraryNodeSummary {
  id: string;
  kind: "album" | "collection";
  name: string;
  displayName: string;
  sourceRoot?: string;
  sourceName?: string;
  coverImage?: string;
  coverImages: string[];
  coverKind?: "image" | "video";
  imageCount?: number;
  videoCount?: number;
  mediaCount?: number;
  albumCount?: number;
  childCount?: number;
  folderSize?: number;
  tags?: string[];
  modTime?: string;
  date?: string;
  dateSource?: "captured" | "folder" | "modified";
  virtual?: boolean;
  hasCustomCover?: boolean;
  /**
   * 虚拟相册（"本目录媒体"）归属目录相对媒体根的路径，如 "2020年"、
   * "2011年/10.1一号公馆"。用于替代同名卡片标题，让用户能分辨归属目录。
   * 普通相册为空。
   */
  location?: string;
  /**
   * 内容用途："photo"（照片墙）或 "comic"（漫画阅读器）。
   * 它决定点击相册后进入哪套交互，与文件是图片还是视频无关。
   */
  contentKind?: ContentKind;
  /** 取消相册级覆盖后会回落到的用途（媒体根默认值）。 */
  contentKindDefault?: ContentKind;
  /** 用户是否手动切换过这本相册的用途。 */
  contentKindOverridden?: boolean;
}

export interface LibraryMediaItem {
  id: string;
  kind: "image" | "video";
  name: string;
  index: number;
  kindIndex: number;
  /** 原始像素宽高；未知时为 0，照片墙据此按真实宽高比排布。 */
  width?: number;
  height?: number;
}

export interface LibraryTagSummary {
  tag: string;
  albumCount: number;
  coverImage?: string;
  coverImages: string[];
}

export interface LibraryActivitySummary {
  revision: number;
  albumCount: number;
  unreadCount: number;
}

export interface LibraryDashboardProgress {
  album: LibraryNodeSummary;
  pageIndex: number;
  pageCount: number;
  /** 位置的语义：photo 是照片墙里翻到第几张，image 是漫画读到第几页。 */
  mediaKind?: "photo" | "image";
  updated: string;
}

export interface LibraryHomeDashboard {
  revision: number;
  albumCount: number;
  unreadCount: number;
  unread: LibraryNodeSummary[];
  inProgress: LibraryDashboardProgress[];
}

export interface LibraryPage<T> {
  revision: number;
  items: T[];
  total: number;
  nextCursor?: string;
}

export interface LibraryNodeQueryResult {
  revision: number;
  items: LibraryNodeSummary[];
  missing: string[];
}

interface PageResponse<T> {
  ok: boolean;
  page: LibraryPage<T>;
}

export class LibraryRevisionChangedError extends Error {
  constructor() {
    super("library revision changed while loading pages");
  }
}

async function collectPages<T>(
  load: (cursor?: string) => Promise<PageResponse<T>>,
): Promise<LibraryPage<T>> {
  let cursor: string | undefined;
  let revision: number | undefined;
  let total = 0;
  const items: T[] = [];
  // 切换工作台模式后旧游标会失效（游标作用域含用途）：这时从第一页重来，
  // 而不是把整页加载判成失败。
  let restarted = false;
  do {
    let response: PageResponse<T>;
    try {
      response = await load(cursor);
    } catch (error: unknown) {
      if (!restarted && cursor && isInvalidCursor(error)) {
        restarted = true;
        cursor = undefined;
        items.length = 0;
        revision = undefined;
        continue;
      }
      throw error;
    }
    const page = response.page;
    if (revision !== undefined && page.revision !== revision) {
      throw new LibraryRevisionChangedError();
    }
    revision = page.revision;
    total = page.total;
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return { revision: revision ?? 0, items, total };
}

// isInvalidCursor 识别「游标对不上当前作用域」这一类 400。
function isInvalidCursor(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400 && error.code === "invalid_cursor";
}

async function queryNodes(ids: string[]): Promise<LibraryNodeQueryResult> {
  if (ids.length === 0) return { revision: 0, items: [], missing: [] };
  let revision: number | undefined;
  const items: LibraryNodeSummary[] = [];
  const missing: string[] = [];
  for (
    let offset = 0;
    offset < ids.length;
    offset += LIBRARY_NODE_BATCH_LIMIT
  ) {
    const response = await api<{
      ok: boolean;
      result: LibraryNodeQueryResult;
    }>("/api/library/nodes/query", {
      method: "POST",
      body: { ids: ids.slice(offset, offset + LIBRARY_NODE_BATCH_LIMIT) },
    });
    if (revision !== undefined && response.result.revision !== revision) {
      throw new LibraryRevisionChangedError();
    }
    revision = response.result.revision;
    items.push(...response.result.items);
    missing.push(...response.result.missing);
  }
  return { revision: revision ?? 0, items, missing };
}

export const libraryApi = {
  manifest: () =>
    api<{ ok: boolean; manifest: LibraryManifest }>("/api/library/manifest"),
  activitySummary: (kind: AppMode) =>
    api<{ ok: boolean; summary: LibraryActivitySummary }>(
      "/api/library/activity-summary",
      { params: { kind } },
    ),
  dashboard: (kind: AppMode) =>
    api<{ ok: boolean; dashboard: LibraryHomeDashboard }>(
      "/api/library/dashboard",
      { params: { kind } },
    ),
  unreadAlbumPage: (
    kind: AppMode,
    cursor?: string,
    limit = LIBRARY_PAGE_LIMIT,
  ) =>
    api<PageResponse<LibraryNodeSummary>>("/api/library/unread", {
      params: { cursor, limit, kind },
    }),
  childrenPage: (
    parentId: string,
    kind: AppMode,
    cursor?: string,
    limit = LIBRARY_PAGE_LIMIT,
  ) =>
    api<PageResponse<LibraryNodeSummary>>(
      `/api/library/${encodeURIComponent(parentId)}/children`,
      { params: { cursor, limit, kind } },
    ),
  mediaPage: (albumId: string, cursor?: string, limit = LIBRARY_PAGE_LIMIT) =>
    api<PageResponse<LibraryMediaItem>>(
      `/api/albums/${encodeURIComponent(albumId)}/media`,
      { params: { cursor, limit } },
    ),
  tagPage: (kind: AppMode, cursor?: string, limit = LIBRARY_PAGE_LIMIT) =>
    api<PageResponse<LibraryTagSummary>>("/api/tags", {
      params: { cursor, limit, kind },
    }),
  tagAlbumsPage: (
    tag: string,
    kind: AppMode,
    cursor?: string,
    limit = LIBRARY_PAGE_LIMIT,
  ) =>
    api<PageResponse<LibraryNodeSummary>>(
      `/api/tags/${encodeURIComponent(tag)}/albums`,
      { params: { cursor, limit, kind } },
    ),
  randomAlbum: (kind: AppMode, scope: "all" | "unread" = "all") =>
    api<{
      ok: boolean;
      album: LibraryNodeSummary;
      revision: number;
    }>("/api/albums/random", {
      params: { scope: scope === "unread" ? "unread" : undefined, kind },
    }),
  allUnreadAlbums: (kind: AppMode) =>
    collectPages((cursor) => libraryApi.unreadAlbumPage(kind, cursor)),
  allChildren: (parentId: string, kind: AppMode) =>
    collectPages((cursor) => libraryApi.childrenPage(parentId, kind, cursor)),
  allMedia: (albumId: string) =>
    collectPages((cursor) => libraryApi.mediaPage(albumId, cursor)),
  allTags: (kind: AppMode) =>
    collectPages((cursor) => libraryApi.tagPage(kind, cursor)),
  allTagAlbums: (tag: string, kind: AppMode) =>
    collectPages((cursor) => libraryApi.tagAlbumsPage(tag, kind, cursor)),
  queryNodes,
};
