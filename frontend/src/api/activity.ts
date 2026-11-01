import { API_BASE, ApiError, api } from "./client";

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

export const activityApi = {
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
    withActivityChanged(
      api<Activity>("/api/activity", { method: "PUT", body: activity }),
      activity.mediaKind === "image",
    ),

  setImage: (albumId: string, pageIndex: number, pageCount: number) =>
    withActivityChanged(
      api<ImageActivity>("/api/activity", {
        method: "PUT",
        body: { albumId, mediaKind: "image", pageIndex, pageCount },
      }),
    ),

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
    withActivityChanged(
      api<{ ok: boolean; updated: number }>("/api/activity/batch", {
        method: "PUT",
        body: { activities },
      }),
      activities.some((activity) => activity.mediaKind === "image"),
    ),

  remove: (identity: ActivityIdentity) =>
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
    ),

  removeImage: (albumId: string) =>
    withActivityChanged(
      api<{ ok: boolean; removed: boolean }>("/api/activity", {
        method: "DELETE",
        params: { albumId, mediaKind: "image" },
      }),
    ),

  clear: () =>
    withActivityChanged(
      api<{ ok: boolean; removed: number }>("/api/activity/all", {
        method: "DELETE",
      }),
    ),

  // 页面卸载时的最后一次写入不等待响应；会话仍只通过 HttpOnly cookie 携带。
  keepalive: (activity: ActivityInput) => {
    void fetch(`${API_BASE}/api/activity`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      credentials: "include",
      keepalive: true,
      body: JSON.stringify(activity),
    }).then((response) => {
      if (response.ok) {
        notifyActivityChanged();
      }
    }).catch(() => {});
  },
};
