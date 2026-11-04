import { Navigate, useSearchParams } from "react-router-dom";

/**
 * 旧阅读器链接的兼容入口。
 *
 * 旧地址是 `/gallery?path=<album id>&index=<n>&name=<x>`；阅读器搬到
 * `/read/<album id>` 之后，这些链接（收藏、书签、外部分享）仍然要能打开。
 * 这里把查询参数原样搬到新地址上，参数本身不做解释，行为完全交给阅读器。
 */
export default function LegacyGalleryRedirect() {
  const [params] = useSearchParams();
  const albumId = params.get("path") ?? "";
  if (!albumId) {
    return <Navigate to="/" replace />;
  }
  const query = new URLSearchParams();
  const index = params.get("index");
  const type = params.get("type");
  const name = params.get("name");
  if (index) query.set("index", index);
  if (type) query.set("type", type);
  if (name) query.set("name", name);
  const search = query.toString();
  return (
    <Navigate
      to={`/read/${encodeURIComponent(albumId)}${search ? `?${search}` : ""}`}
      replace
    />
  );
}
