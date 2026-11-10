import { api } from "./client";
import type { LibraryMediaItem } from "./library";

/**
 * 精选（照片级）的接口。
 *
 * 精选与相册级收藏是两份数据：收藏标记「这一本值得留着」，
 * 精选标记「这一张值得留着」。两者互不覆盖，也不会互相清理。
 */

/** 精选的文件 ID 集合（最近加入在前）。 */
export interface PicksList {
  picks: string[];
  total: number;
  revision: number;
}

/** 精选列表里的一项：一张照片，加上它所属相册的定位信息。 */
export interface PickItem extends LibraryMediaItem {
  /** 这张照片所属的相册资源 ID。 */
  albumId: string;
  /** 所属相册的展示名。 */
  albumName: string;
}

export interface PickPage {
  revision: number;
  items: PickItem[];
  total: number;
  nextCursor?: string;
}

export const picksApi = {
  list: () => api<PicksList>("/api/picks"),
  batch: (ids: string[], action: "add" | "remove") =>
    api<{ ok: boolean; updated: number; total: number; revision: number }>(
      "/api/picks/batch",
      { method: "POST", body: { ids, action } },
    ),
  media: (cursor?: string) =>
    api<{ ok: boolean; page: PickPage }>("/api/picks/media", {
      params: cursor ? { cursor } : undefined,
    }),
};
