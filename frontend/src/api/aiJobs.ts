import { api } from "./client";
import type { LibraryFeedItem, LibraryPage } from "./library";

export type AnalysisType = "metadata" | "embedding" | "ocr" | "face";
export type AnalysisMode = "full" | "incremental";
export type AnalysisStatus =
  "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface AIJobError {
  resourceId: string;
  path?: string;
  code: string;
  message: string;
  at: string;
}

export interface AIJob {
  id: string;
  type: AnalysisType;
  mode: AnalysisMode;
  status: AnalysisStatus;
  stage: string;
  moduleVersion: string;
  total: number;
  processed: number;
  skipped: number;
  failed: number;
  done: number;
  currentResourceId?: string;
  checkpoint: {
    offset: number;
    lastResourceId?: string;
    batch: number;
    moduleVersion: string;
  };
  errors?: AIJobError[];
  error?: string;
  scheduled?: boolean;
  retryOf?: string;
  retryFailedOnly?: boolean;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
  elapsedMs: number;
  speedPerSecond: number;
}

export interface AIJobSettings {
  dailyEnabled: boolean;
  dailyTime: string;
  lastScheduledDate?: string;
}

export interface AIJobSnapshot {
  jobs: AIJob[];
  active?: AIJob;
  settings: AIJobSettings;
}

export interface ImageMetadata {
  status: string;
  dateTimeOriginal?: string;
  orientation?: number;
  cameraMake?: string;
  cameraModel?: string;
  gps?: {
    latitude: number;
    longitude: number;
    altitudeMeters?: number;
    dateTime?: string;
    imageDirectionDegrees?: number;
    imageDirectionReference?: string;
    trackDegrees?: number;
    trackReference?: string;
    speed?: number;
    speedReference?: string;
    dilutionOfPrecision?: number;
    horizontalPositioningError?: number;
    mapDatum?: string;
    processingMethod?: string;
    areaInformation?: string;
  };
}

export interface ImageMetadataResponse {
  ok: boolean;
  resourceId: string;
  status: "pending" | "parsed" | "no_exif" | "unsupported" | "failed";
  moduleVersion?: string;
  updatedAt?: string;
  metadata?: ImageMetadata;
  error?: { code: string; message: string };
}

export interface GPSLocationAlbum {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  fileCount: number;
  albumCount: number;
  coverResourceId?: string;
  cellPrecision: number;
}

export type GPSLocationMedia = LibraryFeedItem;

export const aiJobsApi = {
  list: () => api<{ ok: boolean; snapshot: AIJobSnapshot }>("/api/ai/jobs"),
  start: (type: AnalysisType, mode: AnalysisMode) =>
    api<{ ok: boolean; job: AIJob; reused: boolean }>("/api/ai/jobs", {
      method: "POST",
      body: { type, mode },
      nonIdempotent: true,
    }),
  action: (id: string, action: "pause" | "resume" | "cancel" | "retry") =>
    api<{ ok: boolean; job?: AIJob }>(
      `/api/ai/jobs/${encodeURIComponent(id)}/${action}`,
      { method: "POST", nonIdempotent: true },
    ),
  settings: () =>
    api<{ ok: boolean; settings: AIJobSettings }>("/api/ai/jobs/settings"),
  updateSettings: (settings: AIJobSettings) =>
    api<{ ok: boolean; settings: AIJobSettings }>("/api/ai/jobs/settings", {
      method: "PUT",
      body: settings,
      nonIdempotent: true,
    }),
  metadata: (id: string) =>
    api<ImageMetadataResponse>(
      `/api/images/${encodeURIComponent(id)}/metadata`,
    ),
  locations: (cursor?: string) =>
    api<{ ok: boolean; page: LibraryPage<GPSLocationAlbum> }>(
      "/api/locations",
      { params: { cursor, limit: 60 } },
    ),
  locationMedia: (id: string, cursor?: string) =>
    api<{
      ok: boolean;
      page: LibraryPage<GPSLocationMedia> & {
        albums: { id: string; name: string; count: number }[];
        location: GPSLocationAlbum;
      };
    }>(`/api/locations/${encodeURIComponent(id)}/media`, {
      params: { cursor, limit: 200 },
    }),
};
