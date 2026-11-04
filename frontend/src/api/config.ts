import { api } from "./client";

// 后端 /api/config 的响应结构。所有字段都来自 config.yaml；
// 当前生效值在 GetConfig 时返回。
export interface ServerConfig {
  mediaRoots: string[];
  host: string;
  port: number;
  accessMode: "local" | "lan";
  accessTokenConfigured: boolean;
  cacheDir: string;
  thumbSizeW: number;
  thumbSizeH: number;
  thumbCacheSize: number;
  cacheMaxAgeDays: number;
  cacheMaxSizeMB: number;
  allowOsOpen: boolean;
  staticDir: string;
  // ffmpegPath:服务端 ffmpeg 可执行文件路径;空 = 客户端抽帧 fallback
  // ffmpegAvailable:运行时探测 -version 是否可用
  ffmpegPath?: string;
  ffmpegAvailable?: boolean;
  configPath: string;
  // 扫描排除规则:见 backend/internal/services/exclude.go
  //   - skipHidden 决定是否跳过 .开头的隐藏目录(默认 true)
  //   - systemFiles 是「在 Thumbs.db / desktop.ini / .DS_Store 之上追加」
  //     的用户自定义系统噪声列表
  //   - excludePatterns 是 glob 模式列表,匹配单个目录/文件名
  skipHidden: boolean;
  systemFiles: string[];
  excludePatterns: string[];
  // 相册的浏览用途：默认按哪种方式打开相册，以及每个媒体根的按根默认值。
  // 键是规范化后的媒体根路径（与 mediaRoots 同一套写法）。
  defaultContentKind: ContentKind;
  rootContentKinds: Record<string, ContentKind>;
}

/** 相册的浏览用途：照片墙 / 漫画阅读器。 */
export type ContentKind = "photo" | "comic";

// PUT /api/config 的请求体。key 缺省视为"不修改"；
// bool 字段（如 allowOsOpen）必须显式传值以区分 unset / explicit false。
// mediaRoots 数组用空数组 `[]` 表达"清空所有根"，不传字段表达"不修改"。
//
// excludePatterns / systemFiles 也是数组替换语义:空数组 = 清空,缺省 = 不改。
// skipHidden 走 Set 语义,缺省 = 不改;传了 false 也能关掉隐藏目录跳过。
type ServerConfigFields = Partial<
  Pick<
    ServerConfig,
    | "mediaRoots"
    | "host"
    | "port"
    | "accessMode"
    | "cacheDir"
    | "thumbSizeW"
    | "thumbSizeH"
    | "thumbCacheSize"
    | "cacheMaxAgeDays"
    | "cacheMaxSizeMB"
    | "allowOsOpen"
    | "staticDir"
    | "ffmpegPath"
    | "skipHidden"
    | "systemFiles"
    | "excludePatterns"
    | "defaultContentKind"
    | "rootContentKinds"
  >
>;

export type ServerConfigPatch = ServerConfigFields & {
  /** 只写字段，服务端响应永不回显。 */
  accessToken?: string;
};

export interface ServerConfigUpdateResponse {
  ok: boolean;
  config: ServerConfig;
  requiresRestart: string[];
  // 根集合是否变化（顺序无关）；前端据此决定是否提示"重新扫描"
  mediaRootsChanged: boolean;
}

export const configApi = {
  get: (signal?: AbortSignal) =>
    api<ServerConfig>("/api/config", { signal, cache: "no-store" }),

  update: (patch: ServerConfigPatch) =>
    api<ServerConfigUpdateResponse>("/api/config", {
      method: "PUT",
      body: patch,
    }),
};
