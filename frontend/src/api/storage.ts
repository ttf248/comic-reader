import { api } from "./client";
import type { AnalysisType } from "./aiJobs";

/** 模型权重的位置类别：none 无权重，cache 在缓存根目录内，python 在 Python 环境内。 */
export type StorageModelLocation = "none" | "cache" | "python";

/** 产物目录的种类：批次结果随每次任务新增，索引是全局共享的。 */
export type StorageOutputKind = "batches" | "vectors" | "index";

/**
 * 一个模型权重文件。
 *
 * path 是相对路径：location 为 cache 时相对缓存根目录，为 python 时相对
 * Python 环境目录。相对基准写在 location 里。
 */
export interface StorageModelFile {
  name: string;
  path: string;
  location: StorageModelLocation;
  sizeBytes: number;
  exists: boolean;
}

/** 一个产物目录（或单个索引文件）的占用。 */
export interface StorageOutput {
  kind: StorageOutputKind;
  label: string;
  path: string;
  bytes: number;
  fileCount: number;
  available: boolean;
}

/** 一个分析模块的模型与产物。 */
export interface StorageModule {
  type: AnalysisType;
  name: string;
  modelDirectory: string;
  modelLocation: StorageModelLocation;
  modelFiles: StorageModelFile[];
  modelBytes: number;
  outputBytes: number;
  outputFileCount: number;
  outputs: StorageOutput[];
}

export interface StorageSummary {
  modelBytes: number;
  modelFileCount: number;
  outputBytes: number;
  outputFileCount: number;
}

/** 相对缓存根目录的关键路径，各设备都可见。 */
export interface StorageRelativePaths {
  relativeTo: string;
  stateDirectory: string;
  jobsFile: string;
  metadataDirectory: string;
  aiDerivedDirectory: string;
  vectorDirectory: string;
  modelDirectory: string;
}

/** GET /api/storage/usage 的响应体。 */
export interface StorageUsage {
  scannedAt: string;
  durationMs: number;
  available: boolean;
  cacheTtlSeconds: number;
  summary: StorageSummary;
  modules: StorageModule[];
  paths: StorageRelativePaths;
}

export interface StorageAbsoluteModelFile {
  name: string;
  path: string;
  sizeBytes: number;
  exists: boolean;
}

export interface StorageAbsoluteModule {
  type: AnalysisType;
  name: string;
  modelDirectory: string;
  modelFiles: StorageAbsoluteModelFile[];
}

/** GET /api/storage/paths 的响应体：只有本机浏览器拿得到。 */
export interface StorageAbsolutePaths {
  workingDirectory: string;
  configFile: string;
  cacheRoot: string;
  stateDirectory: string;
  jobsFile: string;
  pythonEnvironment: string;
  pythonExecutable: string;
  modules: StorageAbsoluteModule[];
}

/** GET /api/ai/jobs/:jobId/output 的响应体。 */
export interface JobOutput {
  jobId: string;
  type: AnalysisType;
  batchSize: number;
  path: string;
  bytes: number;
  fileCount: number;
  available: boolean;
  scannedAt: string;
}

export const storageApi = {
  usage: () => api<{ ok: boolean; usage: StorageUsage }>("/api/storage/usage"),
  paths: () =>
    api<{ ok: boolean; paths: StorageAbsolutePaths }>("/api/storage/paths"),
  jobOutput: (jobId: string) =>
    api<{ ok: boolean; output: JobOutput }>(
      `/api/ai/jobs/${encodeURIComponent(jobId)}/output`,
    ),
};
