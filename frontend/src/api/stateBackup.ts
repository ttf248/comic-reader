import { api } from "./client";
import { afterImageActivityWrites } from "./activity";

export const backupCategories = [
  "favorites",
  "history",
  "preferences",
  "activities",
  "covers",
] as const;
export type BackupCategory = (typeof backupCategories)[number];
export const backupLabels: Record<BackupCategory, string> = {
  favorites: "收藏",
  history: "最近访问",
  preferences: "服务端偏好",
  activities: "阅读与播放活动",
  covers: "自定义封面",
};
export interface StatePreview {
  versions: Record<string, string>;
  libraryRevision: number;
  ready: boolean;
  counts: Record<BackupCategory, number>;
  missing: Partial<Record<BackupCategory, number>>;
  skippedCovers: number;
}
export interface StateRestoreResult {
  completed: BackupCategory[];
  failed?: BackupCategory;
  pending: BackupCategory[];
  code?: string;
  skippedCovers: number;
}
export const stateBackupApi = {
  export: (signal?: AbortSignal) =>
    api<unknown>("/api/admin/state/export", { cache: "no-store", signal }),
  preview: (backup: unknown, signal?: AbortSignal) =>
    api<StatePreview>("/api/admin/state/import/preview", {
      method: "POST",
      body: { backup },
      signal,
    }),
  restore: (
    backup: unknown,
    categories: BackupCategory[],
    preview: StatePreview,
  ) => {
    const restore = () =>
      api<StateRestoreResult>("/api/admin/state/import", {
        method: "POST",
        body: {
          backup,
          categories,
          versions: preview.versions,
          libraryRevision: preview.libraryRevision,
        },
        nonIdempotent: true,
      });
    return categories.includes("activities")
      ? afterImageActivityWrites(restore)
      : restore();
  },
};
