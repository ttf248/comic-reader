import { API_BASE, ApiError, api } from "./client";
import { ImageActivityQueue } from "./imageActivityQueue";

export const ACTIVITY_CHANGED_EVENT = "local-gallery:activity-changed";

function notifyActivityChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ACTIVITY_CHANGED_EVENT));
  }
}

async function withActivityChanged<T>(
  request: Promise<T>,
  affectsUnread = true,
): Promise<T> {
  const result = await request;
  if (affectsUnread) notifyActivityChanged();
  return result;
}

export function isActivityNotFound(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    error.code === "activity_not_found"
  );
}

/**
 * 活动类型。
 *
 * - image：漫画阅读进度（读到第几页）
 * - video：视频播放位置
 *
 * 照片浏览不留进度：照片工作台没有「看到第几张」这回事。
 */
export type MediaKind = "image" | "video";
export type ActivityStatus = "in_progress" | "completed";

export interface ActivityIdentity {
  albumId: string;
  mediaKind: MediaKind;
  itemId?: string;
}

export interface Activity extends ActivityIdentity {
  pageIndex?: number;
  pageCount?: number;
  positionMs?: number;
  durationMs?: number;
  status: ActivityStatus;
  updated: string;
}

export interface ImageActivity extends Activity {
  mediaKind: "image";
  pageIndex: number;
  pageCount: number;
}

export interface VideoActivity extends Activity {
  mediaKind: "video";
  itemId: string;
  positionMs: number;
  durationMs: number;
}

export type ActivityInput =
  | {
      albumId: string;
      mediaKind: "image";
      pageIndex: number;
      pageCount: number;
    }
  | {
      albumId: string;
      mediaKind: "video";
      itemId: string;
      positionMs: number;
      durationMs: number;
    };

const imageWrites = new ImageActivityQueue((input) =>
  withActivityChanged(
    api<ImageActivity>("/api/activity", {
      method: "PUT",
      body: input,
      keepalive: true,
    }),
  ),
);

// 恢复活动备份等外部写入也必须等待本会话已有进度，避免迟到覆盖。
export function afterImageActivityWrites<T>(
  action: () => Promise<T>,
): Promise<T> {
  return imageWrites.barrier(action);
}

export const activityApi = {
  removeImages: (albumIds: string[]) =>
    imageWrites.barrier(() =>
      withActivityChanged(
        api<{ deleted: number }>("/api/activity/batch", {
          method: "DELETE",
          body: { albumIds },
        }),
      ),
    ),
  get: (identity: ActivityIdentity) =>
    api<Activity>("/api/activity", {
      params: {
        albumId: identity.albumId,
        mediaKind: identity.mediaKind,
        itemId: identity.itemId,
      },
    }),

  getImage: (albumId: string) =>
    api<ImageActivity>("/api/activity", {
      params: { albumId, mediaKind: "image" },
    }),

  getVideo: (albumId: string, itemId: string) =>
    api<VideoActivity>("/api/activity", {
      params: { albumId, mediaKind: "video", itemId },
    }),

  set: (activity: ActivityInput) =>
    activity.mediaKind === "image"
      ? imageWrites.progress(activity)
      : api<Activity>("/api/activity", { method: "PUT", body: activity }),

  setImage: (
    albumId: string,
    pageIndex: number,
    pageCount: number,
    intent: "progress" | "explicit" = "progress",
  ) => {
    const input = {
      albumId,
      mediaKind: "image" as const,
      pageIndex,
      pageCount,
    };
    return intent === "explicit"
      ? imageWrites.barrier(() =>
          withActivityChanged(
            api<ImageActivity>("/api/activity", {
              method: "PUT",
              body: input,
              keepalive: true,
            }),
          ),
        )
      : imageWrites.progress(input);
  },

  setVideo: (
    albumId: string,
    itemId: string,
    positionMs: number,
    durationMs: number,
  ) =>
    // 视频活动同样影响未读统计：纯视频相册没有图片活动，播放记录就是
    // "已经翻开过"的唯一依据，写入后要通知常驻入口刷新。
    withActivityChanged(
      api<VideoActivity>("/api/activity", {
        method: "PUT",
        body: {
          albumId,
          mediaKind: "video",
          itemId,
          positionMs,
          durationMs,
        },
      }),
    ),

  query: (items: ActivityIdentity[]) =>
    api<{ activities: Activity[]; count: number }>("/api/activity/query", {
      method: "POST",
      body: { items },
    }),

  queryImages: async (albumIds: string[]) => {
    const response = await api<{ activities: ImageActivity[]; count: number }>(
      "/api/activity/query",
      {
        method: "POST",
        body: {
          items: albumIds.map((albumId) => ({
            albumId,
            mediaKind: "image" as const,
          })),
        },
      },
    );
    return response;
  },

  setBatch: (activities: ActivityInput[]) =>
    imageWrites.barrier(() =>
      withActivityChanged(
        api<{ ok: boolean; updated: number }>("/api/activity/batch", {
          method: "PUT",
          body: { activities },
        }),
        activities.some((activity) => activity.mediaKind === "image"),
      ),
    ),

  remove: (identity: ActivityIdentity) => {
    const remove = () =>
      withActivityChanged(
        api<{ ok: boolean; removed: boolean }>("/api/activity", {
          method: "DELETE",
          params: {
            albumId: identity.albumId,
            mediaKind: identity.mediaKind,
            itemId: identity.itemId,
          },
        }),
        identity.mediaKind === "image",
      );
    return identity.mediaKind === "image"
      ? imageWrites.barrier(remove)
      : remove();
  },

  removeImage: (albumId: string) =>
    imageWrites.barrier(() =>
      withActivityChanged(
        api<{ ok: boolean; removed: boolean }>("/api/activity", {
          method: "DELETE",
          params: { albumId, mediaKind: "image" },
        }),
      ),
    ),

  clear: () =>
    imageWrites.barrier(() =>
      withActivityChanged(
        api<{ ok: boolean; removed: number }>("/api/activity/all", {
          method: "DELETE",
        }),
      ),
    ),

  // 卸载补写也经过同一个写入者，避免旧请求越过显式操作；仅已确认响应
  // 表示落盘完成。关闭浏览器时尚未发送的排队进度只能尽力保存。
  keepalive: (activity: ActivityInput) => {
    if (activity.mediaKind === "image") {
      void imageWrites.progress(activity).catch(() => {});
      return;
    }
    void fetch(`${API_BASE}/api/activity`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      credentials: "include",
      keepalive: true,
      body: JSON.stringify(activity),
    })
      .then((response) => {
        if (response.ok) {
          notifyActivityChanged();
        }
      })
      .catch(() => {});
  },
};
