import { api } from "./client";
import type { AppMode, ContentKind } from "./library";

export interface SearchHit {
  kind: "album" | "collection" | "smartCollection";
  path: string;
  name: string;
  /** 散图（"本目录媒体"）：name 是归属目录路径，与同名集合区分靠这个标记。 */
  virtual?: boolean;
  tags?: string[];
  count: number;
  coverImage?: string;
  /** 内容用途："photo" / "comic"。搜索结果据此决定跳转目标。 */
  contentKind?: ContentKind;
}

export const albumsApi = {
  search(q: string, limit = 50, kind: AppMode = "photo") {
    return api<{ ok: boolean; results: SearchHit[]; count: number }>(
      `/api/search`,
      {
        params: { q, limit, kind },
      },
    );
  },
  // 自定义封面：把 file 设为 album path 的封面（持久化到 cover_overrides.json）。
  // 成功后调用方失效媒体库摘要，即可看到新封面。
  setCover(albumId: string, file: string) {
    return api<{
      ok: boolean;
      albumPath: string;
      coverImage: string;
      coverKind: string;
    }>(`/api/albums/${encodeURIComponent(albumId)}/cover`, {
      method: "PUT",
      params: { file },
    });
  },
  // 清除自定义封面：回退到扫描器默认（images[0]，否则 videos[0]）。
  clearCover(albumId: string) {
    return api<{ ok: boolean; albumPath: string }>(
      `/api/albums/${encodeURIComponent(albumId)}/cover`,
      {
        method: "DELETE",
      },
    );
  },
};

// 阅读/播放活动由 api/activity.ts 独立管理。
// 旧代码请从 'api/prefs' 引入。
