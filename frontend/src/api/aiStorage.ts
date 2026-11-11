import { api } from "./client";

export interface AIStorageFile {
  name: string;
  path: string;
  sizeBytes: number;
  exists: boolean;
}

export interface AIStorageUsage {
  path: string;
  bytes: number;
  fileCount: number;
  available: boolean;
}

export interface AIStorageTask {
  type: "metadata" | "embedding" | "ocr" | "face";
  name: string;
  modelDirectory?: string;
  modelFiles: AIStorageFile[];
  modelBytes: number;
  results: AIStorageUsage;
}

export interface AIStorageSnapshot {
  paths: {
    workingDirectory: string;
    configFile: string;
    cacheRoot: string;
    stateDirectory: string;
    jobsFile: string;
    metadataDirectory: string;
    modelDirectory: string;
    vectorDirectory: string;
    pythonEnvironment: string;
    pythonExecutable: string;
  };
  summary: {
    modelBytes: number;
    metadataBytes: number;
    metadataFileCount: number;
    vectorBytes: number;
    vectorFileCount: number;
  };
  tasks: AIStorageTask[];
  vectors: AIStorageUsage;
}

export const aiStorageApi = {
  get: () =>
    api<{ ok: boolean; storage: AIStorageSnapshot }>("/api/config/storage"),
};
