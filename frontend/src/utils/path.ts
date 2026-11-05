import type { AppMode } from "../api/library";

/**
 * 工作台路由。
 *
 * 模式进 URL 路径：`/photo` 与 `/comic` 各有一套路由。路径前缀是
 * 「当前在看哪一侧」的唯一真相源；服务端偏好只决定进入根路径时
 * 落到哪一侧。这样切模式就是一次普通导航，浏览器前进后退能跨模式，
 * 深链也能直接分享。
 */
export const MODE_PREFIX: Record<AppMode, string> = {
  photo: "/photo",
  comic: "/comic",
};

const ALBUMS_MARKER = "/albums/";
const TAGS_MARKER = "/tags/";
const READER_PREFIX = "/comic/read/";

/** 路径是否落在漫画阅读器上。阅读器整屏脱离 AppShell。 */
export function isReaderPath(pathname: string): boolean {
  return pathname.startsWith(READER_PREFIX);
}

/**
 * 从路径首段判断当前工作台；不在任何一侧时返回 null。
 *
 * 按段匹配：`/photographs` 不是照片工作台。
 */
export function modeFromPath(pathname: string): AppMode | null {
  const first = pathname.split("/").filter(Boolean)[0];
  if (first === "photo") return "photo";
  if (first === "comic") return "comic";
  return null;
}

/** 工作台首页：照片库 / 漫画库。 */
export function homeRoute(mode: AppMode): string {
  return MODE_PREFIX[mode];
}

/** 最近浏览 / 最近阅读。 */
export function recentsRoute(mode: AppMode): string {
  return `${MODE_PREFIX[mode]}/recents`;
}

/** 收藏照片 / 收藏漫画。 */
export function favoritesRoute(mode: AppMode): string {
  return `${MODE_PREFIX[mode]}/favorites`;
}

/**
 * 未读页只在漫画工作台存在。
 *
 * 它没有模式参数：照片侧根本没有这个页面，路由表里也不注册。
 */
export function unreadRoute(): string {
  return "/comic/unread";
}

/** 相册页：照片侧渲染照片墙，漫画侧重定向到阅读器。 */
export function albumRoute(mode: AppMode, albumId: string): string {
  return `${MODE_PREFIX[mode]}${ALBUMS_MARKER}${encodeURIComponent(albumId)}`;
}

/** 标签页。标签名按单个路径段编码，服务端只解码一次。 */
export function tagRoute(mode: AppMode, tag: string): string {
  return `${MODE_PREFIX[mode]}${TAGS_MARKER}${encodeURIComponent(tag)}`;
}

/**
 * 漫画阅读器：`/comic/read/<相册 id>`。
 *
 * 阅读器只属于漫画侧，因此没有模式参数。
 */
export function readerRoute(albumId: string, index?: number): string {
  const base = `${READER_PREFIX}${encodeURIComponent(albumId)}`;
  return index === undefined ? base : `${base}?index=${index}`;
}

/**
 * 两个工作台共用的页面路径（相对模式前缀）。
 *
 * 子路径自带前导斜杠：完整路径 = 模式前缀 + 子路径。
 * 少了这个斜杠就会拼出 "/photoalbums/*" 这种匹配不上的路径 ——
 * 症状是页面能开首页，点进相册却落回兜底路由。
 */
export const MODE_ROUTE_PATHS = [
  "",
  "/recents",
  "/favorites",
  "/albums/*",
  "/tags/*",
] as const;

/** 某一侧的全部页面路径。 */
export function modeRoutePaths(mode: AppMode): string[] {
  return MODE_ROUTE_PATHS.map((path) => `${MODE_PREFIX[mode]}${path}`);
}

/**
 * 切到另一侧时该去的页面。
 *
 * 只有两侧都有的同名页（最近 / 收藏 / 标签）能一一对应；相册与阅读器
 * 只属于一侧，未读只属于漫画侧，因此它们都回落到目标侧首页。
 * 这张表是「模式切换」唯一的语义来源，侧栏开关与阅读器顶栏共用它。
 */
export function counterpartRoute(pathname: string, target: AppMode): string {
  const current = modeFromPath(pathname);
  if (!current) return homeRoute(target);
  if (current === target) return pathname;
  const rest = pathname.slice(MODE_PREFIX[current].length) || "/";
  if (rest === "/recents" || rest === "/favorites") {
    return `${MODE_PREFIX[target]}${rest}`;
  }
  // 标签段原样搬过去：它可能含字面 %xx，重新编码会破坏语义。
  if (rest.startsWith(TAGS_MARKER)) {
    return `${MODE_PREFIX[target]}${rest}`;
  }
  return homeRoute(target);
}

/**
 * 从原始路径里切出标记之后的整段，并解码一次。
 *
 * 路径段只解码一次：React Router 的 useParams 已经解过一次，再解会把
 * 标签名里的字面 `%xx` 破坏掉。因此一律从原始 pathname 切段。
 */
export function decodePathTail(pathname: string, marker: string): string {
  const index = pathname.indexOf(marker);
  if (index < 0) return "";
  const raw = pathname.slice(index + marker.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

/**
 * 从相册路由提取不透明资源 ID。
 *
 * 资源 ID 形如 `a_xxx` / `c_xxx`，不含路径分隔符，因此从串里找
 * "/albums/" 标记即可，不必关心前面是哪个工作台前缀。
 */
export function decodeFavPath(to: string): string {
  const index = to.indexOf(ALBUMS_MARKER);
  if (index < 0) return to;
  const raw = to.slice(index + ALBUMS_MARKER.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 收藏用的资源 ID：智能集合用 smart: 前缀，其余用收藏路径。
 * 卡片星标、右键菜单和收藏页必须用同一套 ID，否则收藏会互相看不见。
 */
export function favoriteResourceId(item: {
  variant?: string;
  title: string;
  to: string;
}): string {
  return item.variant === "smart"
    ? `smart:${item.title}`
    : decodeFavPath(item.to);
}
