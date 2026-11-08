import { useEffect } from "react";
import {
  setGalleryContext,
  type GalleryContextEntry,
  type GallerySource,
} from "../utils/galleryContext";

// 把当前列表页的「可见条目」写进画廊上下文，
// 这样画廊内的 N / P 才能正确地跳到上一本 / 下一本。
//
// - 必须在每次列表渲染时调用（依赖 useEffect）。
// - 列表为空时不写（保持上一次上下文，避免把「空列表」当上下文起点）。
export function useGalleryContextSync(
  source: GallerySource,
  entries: GalleryContextEntry[] | undefined,
  currentKey?: string,
  pagination?: import("../utils/galleryContext").GalleryContext["pagination"],
): void {
  useEffect(() => {
    if (!entries || entries.length === 0) return;
    const idx =
      currentKey != null ? entries.findIndex((e) => e.key === currentKey) : -1;
    setGalleryContext({
      source,
      pagination,
      list: entries,
      // 找不到当前项时取第一项；之后用户点击进入会覆盖
      index: idx >= 0 ? idx : 0,
    });
  }, [source, entries, currentKey, pagination]);
}
