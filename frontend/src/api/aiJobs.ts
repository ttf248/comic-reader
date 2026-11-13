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
  computeDevice: "cpu" | "gpu";
  errorCode?: string;
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
  peopleEnabled: boolean;
  gpuEnabled: boolean;
  lastScheduledDate?: string;
}

export type AIJobSettingsUpdate = Pick<
  AIJobSettings,
  "dailyEnabled" | "dailyTime" | "dailyModules" | "peopleEnabled"
>;

/** 某个模块在一种模式下的核算结果。 */
export interface AIJobEstimateMode {
  /** 本次真正要处理的张数。 */
  count: number;
  /** 按历史吞吐推出的预计耗时；没有历史记录时为 null。 */
  estimatedDurationMs: number | null;
  /** 这个耗时参考了几次历史任务、共多少张图。 */
  sampleCount: number;
  sampleImages: number;
}

/** 单个分析模块的核算结果。 */
export interface AIJobEstimateModule {
  type: AnalysisType;
  name: string;
  /** 模块已注册且运行环境就绪。 */
  installed: boolean;
  /** 现在能不能启动：已就绪且没有被人物开关锁住。 */
  available: boolean;
  reason?: string;
  version?: string;
  /** 模块不可用时为 null。 */
  incremental: AIJobEstimateMode | null;
  full: AIJobEstimateMode | null;
}

/** 若干个模块的合计。 */
export interface AIJobEstimateTotal {
  count: number;
  /** 任一参与模块没有历史时为 null。 */
  estimatedDurationMs: number | null;
  modules: AnalysisType[];
}

export interface AIJobEstimate {
  generatedAt: string;
  libraryRevision: number;
  /** 媒体库是否已扫描完成。 */
  libraryReady: boolean;
  totalImages: number;
  modules: AIJobEstimateModule[];
  /** 「按序启动全部任务」在两种模式下的合计。 */
  sequence: {
    incremental: AIJobEstimateTotal;
    full: AIJobEstimateTotal;
  };
}

export interface AIJobSnapshot {
  jobs: AIJob[];
  active?: AIJob;
  /** 按执行顺序排列的等待任务 ID，不含当前任务。 */
  queue: string[];
  settings: AIJobSettings;
  modules: AIJobModule[];
}

export interface AIWorkerStatus {
  pythonAvailable: boolean;
  pythonVersion?: string;
  torchVersion?: string;
  cudaAvailable: boolean;
  cudaExecutionProviderAvailable: boolean;
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
  ocrText?: string;
  resourceId?: string;
  kind: AppMode;
  albumId?: string;
  year?: string;
  /** 行政区划码（六位）。筛一个省包含它下面的市与区县。 */
  adcode?: number;
  personId?: string;
  favoriteOnly?: boolean;
  pickedOnly?: boolean;
  offset?: number;
  limit?: number;
}

export interface SemanticSearchHit {
  item: LibraryFeedItem;
  similarity?: number;
  matchReasons?: (
    "semantic" | "similar_image" | "ocr_exact" | "ocr_approximate"
  )[];
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

export type ChinaLocationPoint = [number, number];

export type ChinaLocationGeometry =
  | { type: "Polygon"; coordinates: ChinaLocationPoint[][] }
  | { type: "MultiPolygon"; coordinates: ChinaLocationPoint[][][] };

export interface ChinaLocationProvince {
  adcode: number;
  name: string;
  photoCount: number;
  unmatchedAreaPhotoCount: number;
}

/** 当前聚焦的那个区域。 */
export interface ChinaLocationRegionInfo {
  adcode: number;
  name: string;
  level: string;
  photoCount: number;
  unmatchedAreaPhotoCount: number;
  /** 按到访口径切出的次数。 */
  visitCount: number;
  /** 有可信拍摄时间的第一天；没有可信时间时是空串。 */
  firstAt: string;
  /** 有可信拍摄时间的最后一天；没有可信时间时是空串。 */
  lastAt: string;
  /** 代表照的资源 ID，最多 4 张。 */
  coverResourceIds: string[];
  /** 上级区划码；省级区域为 null。 */
  parentAdcode: number | null;
  /** 按全国到直接上级顺序排列，用于完整面包屑导航。 */
  ancestors: ChinaLocationAncestor[];
}

export interface ChinaLocationAncestor {
  adcode: number;
  name: string;
}

/** 某个区域的下一级区域。 */
export interface ChinaLocationRegion {
  adcode: number;
  name: string;
  level: string;
  photoCount: number;
}

export interface ChinaLocationSummary {
  revision: number;
  /** 离线边界数据的版本。 */
  boundaryVersion: string;
  gpsPhotoCount: number;
  chinaPhotoCount: number;
  unassignedPhotoCount: number;
  provinces: ChinaLocationProvince[];
  /** 本范围内的逐月分布，供时间轴使用。 */
  months: ChinaLocationMonth[];
  /** 本范围内的停靠序列，供地图上的轨迹线使用。 */
  trajectory: ChinaLocationStop[];
  /** 有位置但没有可信拍摄时间的照片数。 */
  untimedPhotoCount: number;
  /** 各有照片的行政区数量：省 / 市 / 区县。 */
  provinceCount: number;
  cityCount: number;
  districtCount: number;
}

/** 某个区域的下一级地图；regions 为空表示这个区域没有更细的边界。 */
export interface ChinaLocationRegions {
  revision: number;
  boundaryVersion: string;
  region: ChinaLocationRegionInfo;
  regions: ChinaLocationRegion[];
  /** 这个区域自己的逐月分布，随层级细化。 */
  months: ChinaLocationMonth[];
  /** 这个区域下级之间的停靠序列。 */
  trajectory: ChinaLocationStop[];
  untimedPhotoCount: number;
}

/** 某个月份的照片数。 */
export interface ChinaLocationMonth {
  /** "2024-06"。 */
  month: string;
  count: number;
}

/** 时间区间：按拍摄时间的日历月，左闭右闭。 */
export interface ChinaTimeRange {
  /** "2019-01"，空表示不限。 */
  from?: string | null;
  /** "2019-12"，空表示不限。 */
  to?: string | null;
}

/** 把时间区间转成查询参数。 */
function chinaTimeRangeParams(timeRange?: ChinaTimeRange) {
  if (!timeRange) return {};
  return {
    ...(timeRange.from ? { from: timeRange.from } : {}),
    ...(timeRange.to ? { to: timeRange.to } : {}),
  };
}

/** 轨迹上的一个停靠点：连续落在同一区域的一段时间。 */
export interface ChinaLocationStop {
  /** 该段第一张照片的拍摄日期。 */
  at: string;
  /** 该段最后一张照片的拍摄日期。 */
  until: string;
  adcode: number;
  name: string;
  photoCount: number;
}

/** 一次到访：同一个区域里连续的一段拍摄。 */
export interface ChinaLocationVisit {
  startedAt: string;
  endedAt: string;
  dayCount: number;
  photoCount: number;
  /** 这段时间里去过的其它区域。 */
  regions: { adcode: number; name: string; count: number }[];
}

/** 一个区域的到访记录。 */
export interface ChinaLocationVisits {
  revision: number;
  boundaryVersion: string;
  region: ChinaLocationRegionInfo;
  visits: ChinaLocationVisit[];
  untimedPhotoCount: number;
}

/** 绘图用的一个行政区轮廓。 */
export interface ChinaGeometryFeature {
  adcode: number;
  name: string;
  level: string;
  geometry: ChinaLocationGeometry;
}

/**
 * 一次绘图几何响应。
 *
 * 几何与统计是两份数据：统计随媒体库与时间区间变化，几何只随边界数据
 * 变化，因此这一份可以长期缓存。
 */
export interface ChinaGeometry {
  boundaryVersion: string;
  hash: string;
  level: string;
  parentAdcode: number;
  features: ChinaGeometryFeature[];
}

/** 地点索引里的一项：去过的一个地方。 */
export interface ChinaPlace {
  adcode: number;
  name: string;
  /** province | city | district —— 这个地方本身的层级。 */
  level: string;
  /** 归并到这一层的照片数（含下级）。 */
  photoCount: number;
  /** 没有落到任何直接下级的照片数。 */
  unmatchedCount: number;
  /** 按到访口径切出的次数。 */
  visitCount: number;
  /** 有可信拍摄时间的第一天；没有可信时间时是空串。 */
  firstAt: string;
  /** 有可信拍摄时间的最后一天；没有可信时间时是空串。 */
  lastAt: string;
  /** 代表照的资源 ID，最多 4 张。 */
  coverResourceIds: string[];
}

/** 地点索引的响应。 */
export interface ChinaPlaces {
  revision: number;
  boundaryVersion: string;
  /** 请求的归并粒度：province | city | district。 */
  level: string;
  total: number;
  gpsPhotoCount: number;
  chinaPhotoCount: number;
  unassignedPhotoCount: number;
  untimedPhotoCount: number;
  items: ChinaPlace[];
}

/** 一次行程里的一个停留段。 */
export interface ChinaTripStop {
  adcode: number;
  name: string;
  level: string;
  /**
   * 这个停留点的直接上级；省级停留点是 null。
   *
   * 界面按它取「停留点所在的那一层轮廓」：停留点是市，直接上级就是省，
   * 轮廓取该省的城市；停留点是省，没有上级，轮廓取全国各省。
   */
  parentAdcode: number | null;
  at: string;
  until: string;
  dayCount: number;
  photoCount: number;
}

/**
 * 一段行程或一次停留。
 *
 * kind 是 "trip"（走过多个地方）或 "stay"（只在一个地方）。
 */
export interface ChinaTrip {
  id: string;
  /** 这段在行程列表里的序号（从 0 起），照片端点按它寻址。 */
  index: number;
  kind: "trip" | "stay";
  startedAt: string;
  endedAt: string;
  dayCount: number;
  photoCount: number;
  stops: ChinaTripStop[];
  coverResourceIds: string[];
  /**
   * 照片带用的照片，最多 12 张。
   *
   * 按时间均匀采样并含首尾：只给开头几张会把这一段讲成「刚到那儿」。
   */
  bandResourceIds: string[];
}

/** 某一段行程的照片分页。 */
export interface ChinaTripMediaPage {
  revision: number;
  items: LibraryFeedItem[];
  total: number;
  nextCursor?: string;
  albums: { id: string; name: string; count: number }[];
  trip: ChinaTrip;
}

/** 行程的响应。 */
export interface ChinaTrips {
  revision: number;
  boundaryVersion: string;
  granularity: string;
  total: number;
  items: ChinaTrip[];
  untimedPhotoCount: number;
}

export interface PersonGroup {
  id: string;
  name: string;
  faceCount: number;
  photoCount: number;
  coverResourceId?: string;
  hidden: boolean;
}

export interface PersonFace {
  key: string;
  resourceId: string;
  faceIndex: number;
  personId: string;
  box: number[];
  score: number;
}

export interface PersonMediaPage {
  revision: number;
  person: PersonGroup;
  items: LibraryFeedItem[];
  faces: PersonFace[];
  total: number;
  nextCursor?: string;
}

export const aiJobsApi = {
  list: () => api<{ ok: boolean; snapshot: AIJobSnapshot }>("/api/ai/jobs"),
  /** 空闲时的规模与耗时核算；只读，不创建任务。 */
  estimate: () =>
    api<{ ok: boolean; estimate: AIJobEstimate }>("/api/ai/jobs/estimate"),
  start: (type: AnalysisType, mode: AnalysisMode) =>
    api<{ ok: boolean; job: AIJob; reused: boolean }>("/api/ai/jobs", {
      method: "POST",
      body: { type, mode },
      nonIdempotent: true,
    }),
  startAll: (mode: AnalysisMode) =>
    api<{
      ok: boolean;
      jobs: AIJob[];
      skippedModules: AIJobModule[];
    }>("/api/ai/jobs/sequence", {
      method: "POST",
      body: { mode },
      nonIdempotent: true,
    }),
  action: (id: string, action: "pause" | "resume" | "cancel" | "retry") =>
    api<{ ok: boolean; job?: AIJob }>(
      `/api/ai/jobs/${encodeURIComponent(id)}/${action}`,
      { method: "POST", nonIdempotent: true },
    ),
  moveQueued: (id: string, direction: "up" | "down") =>
    api<{ ok: boolean; snapshot: AIJobSnapshot }>(
      `/api/ai/jobs/${encodeURIComponent(id)}/move`,
      { method: "POST", body: { direction }, nonIdempotent: true },
    ),
  clearQueue: () =>
    api<{ ok: boolean; cancelledCount: number; snapshot: AIJobSnapshot }>(
      "/api/ai/jobs/queue",
      { method: "DELETE", nonIdempotent: true },
    ),
  deleteHistoryItem: (id: string) =>
    api<{ ok: boolean }>(`/api/ai/jobs/${encodeURIComponent(id)}`, {
      method: "DELETE",
      nonIdempotent: true,
    }),
  clearHistory: () =>
    api<{ ok: boolean; deletedCount: number; snapshot: AIJobSnapshot }>(
      "/api/ai/jobs/history",
      { method: "DELETE", nonIdempotent: true },
    ),
  settings: () =>
    api<{ ok: boolean; settings: AIJobSettings }>("/api/ai/jobs/settings"),
  updateSettings: (settings: AIJobSettingsUpdate) =>
    api<{ ok: boolean; settings: AIJobSettings }>("/api/ai/jobs/settings", {
      method: "PUT",
      body: settings,
      nonIdempotent: true,
    }),
  updateHardware: (gpuEnabled: boolean) =>
    api<{ ok: boolean; settings: AIJobSettings }>("/api/ai/jobs/hardware", {
      method: "PUT",
      body: { gpuEnabled },
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
  chinaLocations: (timeRange?: ChinaTimeRange) =>
    api<{ ok: boolean; locations: ChinaLocationSummary }>(
      "/api/locations/china",
      { params: chinaTimeRangeParams(timeRange) },
    ),
  /**
   * 取绘图用的行政区轮廓。
   *
   * level 用 "children" 表示「上级的全部直接下级」：省下面可能同时挂着
   * 地级市与省直辖县级区域，按单一层级取会漏掉一半。
   */
  chinaGeometry: (level: string, parent?: number | null) =>
    api<{ ok: boolean } & ChinaGeometry>(
      `/api/locations/china/geometry/${encodeURIComponent(level)}`,
      { params: { parent: parent ?? undefined } },
    ),
  /** 地点索引：去过哪些地方。 */
  chinaPlaces: (
    level?: string,
    parent?: number | null,
    timeRange?: ChinaTimeRange,
  ) =>
    api<{ ok: boolean; places: ChinaPlaces }>("/api/locations/china/places", {
      params: {
        level: level ?? undefined,
        parent: parent ?? undefined,
        ...chinaTimeRangeParams(timeRange),
      },
    }),
  /** 行程与停留：什么时候去了哪些地方。 */
  chinaTrips: (
    granularity?: string,
    timeRange?: ChinaTimeRange,
    gapDays?: number,
  ) =>
    api<{ ok: boolean; trips: ChinaTrips }>("/api/locations/china/trips", {
      params: {
        granularity: granularity ?? undefined,
        gapDays: gapDays ?? undefined,
        ...chinaTimeRangeParams(timeRange),
      },
    }),
  /**
   * 某一段行程的照片。
   *
   * 段是按「粒度 + 间隔 + 时间区间」切出来的，因此取照片必须带上同样
   * 的参数，否则按下标取到的不是同一段。
   */
  chinaTripMedia: (
    index: number,
    granularity?: string,
    timeRange?: ChinaTimeRange,
    cursor?: string,
  ) =>
    api<{ ok: boolean; page: ChinaTripMediaPage }>(
      `/api/locations/china/trips/${encodeURIComponent(String(index))}/media`,
      {
        params: {
          granularity: granularity ?? undefined,
          cursor,
          limit: 200,
          ...chinaTimeRangeParams(timeRange),
        },
      },
    ),
  chinaRegions: (adcode: number, timeRange?: ChinaTimeRange) =>
    api<{ ok: boolean; regions: ChinaLocationRegions }>(
      `/api/locations/china/regions/${encodeURIComponent(String(adcode))}`,
      { params: chinaTimeRangeParams(timeRange) },
    ),
  chinaRegionVisits: (adcode: number, timeRange?: ChinaTimeRange) =>
    api<{ ok: boolean; visits: ChinaLocationVisits }>(
      `/api/locations/china/regions/${encodeURIComponent(String(adcode))}/visits`,
      { params: chinaTimeRangeParams(timeRange) },
    ),
  chinaRegionMedia: (
    adcode: number,
    cursor?: string,
    timeRange?: ChinaTimeRange,
    visit?: number,
  ) =>
    api<{
      ok: boolean;
      page: LibraryPage<LibraryFeedItem> & {
        albums: { id: string; name: string; count: number }[];
        region: ChinaLocationRegionInfo;
      };
    }>(
      `/api/locations/china/regions/${encodeURIComponent(String(adcode))}/media`,
      {
        params: {
          cursor,
          limit: 200,
          ...chinaTimeRangeParams(timeRange),
          ...(visit === undefined ? {} : { visit }),
        },
      },
    ),
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
  people: (includeHidden = false) =>
    api<{
      ok: boolean;
      people: PersonGroup[];
      totalGroups: number;
      limit: number;
      groupingLimited: boolean;
      threshold: number;
      revision: number;
    }>("/api/people", { params: { includeHidden } }),
  searchPeople: (query: string) =>
    api<{
      ok: boolean;
      people: PersonGroup[];
      totalGroups: number;
      limit: number;
      groupingLimited: boolean;
      threshold: number;
      revision: number;
    }>("/api/people", { params: { q: query, limit: 20 } }),
  personMedia: (id: string, cursor?: string) =>
    api<{ ok: boolean; page: PersonMediaPage }>(
      `/api/people/${encodeURIComponent(id)}/media`,
      { params: { cursor, limit: 200 } },
    ),
  updatePerson: (id: string, body: { name?: string; hidden?: boolean }) =>
    api<{ ok: boolean }>(`/api/people/${encodeURIComponent(id)}`, {
      method: "PUT",
      body,
      nonIdempotent: true,
    }),
  mergePeople: (sourceId: string, targetId: string) =>
    api<{ ok: boolean }>("/api/people/merge", {
      method: "POST",
      body: { sourceId, targetId },
      nonIdempotent: true,
    }),
  splitPerson: (personId: string, faceKeys: string[]) =>
    api<{ ok: boolean; personId: string }>("/api/people/split", {
      method: "POST",
      body: { personId, faceKeys },
      nonIdempotent: true,
    }),
  clearPeople: () =>
    api<{ ok: boolean; cleared: boolean; peopleEnabled: boolean }>(
      "/api/people",
      { method: "DELETE", nonIdempotent: true },
    ),
};
