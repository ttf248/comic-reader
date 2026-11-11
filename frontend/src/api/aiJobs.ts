import { api } from "./client";
import type { AppMode, LibraryFeedItem, LibraryPage } from "./library";

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

/** 后端已知的分析模块及其安装状态。 */
export interface AIJobModule {
  type: AnalysisType;
  name: string;
  installed: boolean;
  version?: string;
  reason?: string;
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
  /** 本次任务实际要处理的张数：增量任务里不含已经是最新的部分。 */
  planned: number;
  /** 已处理的张数（含失败）。 */
  completed: number;
  /** 运行中任务的预计剩余毫秒；非运行状态为 0。 */
  estimatedRemainingMs: number;
  /** 按解析状态分类的产出计数，如 parsed / no_exif / unsupported / failed。 */
  results?: Record<string, number>;
  /** 按字段统计的产出计数，如 exifTime / camera / gps。 */
  fields?: Record<string, number>;
}

export interface AIJobSettings {
  dailyEnabled: boolean;
  dailyTime: string;
  dailyModules: AnalysisType[];
  lastScheduledDate?: string;
}

export interface AIJobSnapshot {
  jobs: AIJob[];
  active?: AIJob;
  settings: AIJobSettings;
  modules: AIJobModule[];
}

export interface AIWorkerStatus {
  pythonAvailable: boolean;
  pythonVersion?: string;
  torchVersion?: string;
  cudaAvailable: boolean;
  cudaVersion?: string;
  gpuName?: string;
  gpuMemoryBytes?: number;
  device: string;
  runtimeReady: boolean;
  runtimeError?: string;
  modelAvailable: boolean;
  modelValid: boolean;
  modelLoaded: boolean;
  modelVersion: string;
  modelSha256?: string;
  index: {
    modelVersion: string;
    dimension: number;
    vectors: number;
    shards: number;
    indexVersion: number;
    ready: boolean;
  };
  coverage: { indexed: number; total: number };
  modules?: Partial<Record<"ocr" | "face", AIWorkerModuleStatus>>;
}

export interface AIWorkerModuleStatus {
  ready: boolean;
  version?: string;
  error?: string;
}

export interface ImageAnalysisResponse {
  ok: boolean;
  resourceId: string;
  ocr: {
    status: "pending" | "recognized" | "no_text" | "failed";
    text?: string;
    lines?: { text: string; confidence: number; box: number[][] }[];
    error?: { code: string; message: string };
  };
  face: {
    status: "pending" | "faces_found" | "no_faces" | "failed";
    faces?: { box: number[]; score: number }[];
    error?: { code: string; message: string };
  };
}

export interface FaceSearchResponse {
  ok: boolean;
  threshold: number;
  total: number;
  results: {
    item: LibraryFeedItem;
    faceIndex: number;
    similarity: number;
  }[];
}

export interface SemanticSearchRequest {
  text?: string;
  resourceId?: string;
  kind: AppMode;
  albumId?: string;
  year?: string;
  locationId?: string;
  offset?: number;
  limit?: number;
}

export interface SemanticSearchHit {
  item: LibraryFeedItem;
  similarity: number;
}

export interface SemanticSearchResponse {
  ok: boolean;
  results: SemanticSearchHit[];
  total: number;
  offset: number;
  nextOffset: number;
  revision: number;
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
  analysis: (id: string) =>
    api<ImageAnalysisResponse>(
      `/api/images/${encodeURIComponent(id)}/analysis`,
    ),
  faceSearch: (resourceId: string, faceIndex: number) =>
    api<FaceSearchResponse>("/api/ai/faces/search", {
      method: "POST",
      body: { resourceId, faceIndex },
      nonIdempotent: true,
    }),
  embeddingStatus: () =>
    api<{ ok: boolean; status: AIWorkerStatus }>("/api/ai/semantic/status"),
  semanticSearch: (request: SemanticSearchRequest, image?: File) => {
    if (!image) {
      return api<SemanticSearchResponse>("/api/ai/search", {
        method: "POST",
        body: request,
        nonIdempotent: true,
      });
    }
    const body = new FormData();
    body.append("image", image);
    for (const [key, value] of Object.entries(request)) {
      if (value !== undefined) body.append(key, String(value));
    }
    return api<SemanticSearchResponse>("/api/ai/search", {
      method: "POST",
      body,
      nonIdempotent: true,
    });
  },
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
