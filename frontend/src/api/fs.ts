import { api } from "./client";

// 服务端 fs 接口封装。
export const fsApi = {
  openInExplorer(id: string) {
    return api<{ ok: boolean }>("/api/fs/open", {
      body: { id },
      method: "POST",
      nonIdempotent: true,
    });
  },
  openConfiguredPath(path: string) {
    return api<{ ok: boolean }>("/api/admin/fs/open", {
      params: { path, allowConfig: 1 },
      method: "GET",
      nonIdempotent: true,
      cache: "no-store",
    });
  },
  async capabilities(signal?: AbortSignal): Promise<FsCapabilities> {
    const data = await api<{ allowOsOpen?: boolean }>("/api/health", {
      signal,
    });
    return { allowOsOpen: data.allowOsOpen === true };
  },
};

export interface FsCapabilities {
  allowOsOpen: boolean;
}
