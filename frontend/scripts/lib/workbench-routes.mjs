// 工作台路由助手。
//
// 应用把两侧的页面收在 /photo 与 /comic 路径前缀下（见 utils/path.ts）。
// 审计脚本若仍用 /recents 这类旧路径，每个路由都会落回兜底路由 → 首页，
// 量到的全是首页的数据，却报成「各页面对齐」。这里补上模式前缀，
// 让审计真的走到它声称要审的页面。

/** 读取当前工作台模式：根元素上的 data-mode 由 URL 推导。 */
export async function resolveMode(page) {
  const mode = await page.evaluate(
    () => document.documentElement.getAttribute("data-mode") || "photo",
  );
  return mode === "comic" ? "comic" : "photo";
}

/**
 * 取一本相册的 id。
 *
 * 优先从媒体根的子节点里找图多且没有视频的相册（封面与排版更有代表性）；
 * 找不到就退回第一本。kind 决定取照片侧还是漫画侧：漫画相册才有阅读器。
 */
export async function resolveAlbumId(page, kind = "photo") {
  return page.evaluate(async (want) => {
    const manifestRes = await fetch("/api/library/manifest");
    if (!manifestRes.ok) return null;
    const manifest = await manifestRes.json();
    const roots = (manifest.manifest?.roots ?? []).filter(
      (r) => (r.contentKind ?? "photo") === want,
    );
    for (const root of roots) {
      const res = await fetch(
        `/api/library/${encodeURIComponent(root.id)}/children?kind=${want}&limit=50`,
      );
      if (!res.ok) continue;
      const items = (await res.json()).page?.items ?? [];
      const albums = items.filter((i) => i.kind === "album");
      const hit =
        albums.find((a) => (a.imageCount ?? 0) > 3 && !(a.videoCount > 0)) ??
        albums[0];
      if (hit) return hit.id;
    }
    return null;
  }, kind);
}

/**
 * 把审计页面清单里的写法翻译成真实地址。
 *
 * - "/" 保持原样（根路径按服务端偏好落到某一侧）
 * - "/settings" 与 "/tasks" 与模式无关，保持原样
 * - 已带 /photo 或 /comic 前缀的原样使用
 * - 其它以 "/" 开头的按当前模式补前缀（/recents → /photo/recents）
 */
export function buildRoute(route, mode) {
  if (route === "/" || route === "/settings" || route === "/tasks") return route;
  if (route.startsWith("/photo") || route.startsWith("/comic")) return route;
  if (route.startsWith("/")) return `/${mode}${route}`;
  return route;
}
