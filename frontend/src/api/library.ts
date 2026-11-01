import { api } from "./client";

export const LIBRARY_PAGE_LIMIT = 200;
export const LIBRARY_NODE_BATCH_LIMIT = 500;

export interface LibraryStatistics {
  rootCount: number;
  albumCount: number;
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
}

export interface LibraryMediaItem {
  id: string;
  kind: "image" | "video";
  name: string;
  index: number;
  kindIndex: number;
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
  do {
    const response = await load(cursor);
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
  activitySummary: () =>
    api<{ ok: boolean; summary: LibraryActivitySummary }>(
      "/api/library/activity-summary",
    ),
  dashboard: () =>
    api<{ ok: boolean; dashboard: LibraryHomeDashboard }>(
      "/api/library/dashboard",
    ),
  unreadAlbumPage: (cursor?: string, limit = LIBRARY_PAGE_LIMIT) =>
    api<PageResponse<LibraryNodeSummary>>("/api/library/unread", {
      params: { cursor, limit },
    }),
  childrenPage: (
    parentId: string,
    cursor?: string,
    limit = LIBRARY_PAGE_LIMIT,
  ) =>
    api<PageResponse<LibraryNodeSummary>>(
      `/api/library/${encodeURIComponent(parentId)}/children`,
      { params: { cursor, limit } },
    ),
  mediaPage: (albumId: string, cursor?: string, limit = LIBRARY_PAGE_LIMIT) =>
    api<PageResponse<LibraryMediaItem>>(
      `/api/albums/${encodeURIComponent(albumId)}/media`,
      { params: { cursor, limit } },
    ),
  tagPage: (cursor?: string, limit = LIBRARY_PAGE_LIMIT) =>
    api<PageResponse<LibraryTagSummary>>("/api/tags", {
      params: { cursor, limit },
    }),
  tagAlbumsPage: (tag: string, cursor?: string, limit = LIBRARY_PAGE_LIMIT) =>
    api<PageResponse<LibraryNodeSummary>>(
      `/api/tags/${encodeURIComponent(tag)}/albums`,
      { params: { cursor, limit } },
    ),
  randomAlbum: (scope: "all" | "unread" = "all") =>
    api<{
      ok: boolean;
      album: LibraryNodeSummary;
      revision: number;
    }>("/api/albums/random", {
      params: { scope: scope === "unread" ? "unread" : undefined },
    }),
  allUnreadAlbums: () =>
    collectPages((cursor) => libraryApi.unreadAlbumPage(cursor)),
  allChildren: (parentId: string) =>
    collectPages((cursor) => libraryApi.childrenPage(parentId, cursor)),
  allMedia: (albumId: string) =>
    collectPages((cursor) => libraryApi.mediaPage(albumId, cursor)),
  allTags: () => collectPages((cursor) => libraryApi.tagPage(cursor)),
  allTagAlbums: (tag: string) =>
    collectPages((cursor) => libraryApi.tagAlbumsPage(tag, cursor)),
  queryNodes,
};
