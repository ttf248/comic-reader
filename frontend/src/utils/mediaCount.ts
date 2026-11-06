import { mediaUnit } from "./workbench";

/**
 * 媒体计数说明：一个相册里有几张照片、几个视频。
 *
 * 照片侧的单位是「张」，漫画侧是「页」；视频两边都叫「个视频」。
 *
 * 只有视频没有照片时不能写「0 张」：那本相册里一张照片都没有，
 * 「0 张」既不说明它是视频相册，也会让人以为是个空相册。
 * 纯视频就说「2 个视频」，两者都有才两个一起说。
 */
export interface MediaCountSource {
  imageCount?: number;
  videoCount?: number;
  contentKind?: "photo" | "comic";
}

export interface MediaCountParts {
  /** 完整说明：「128 张 · 3 个视频」。 */
  label: string;
  /** 照片部分：「128 张」。 */
  lead: string;
  /** 视频部分：「3 个视频」；没有视频时为空。 */
  rest: string;
  /** 悬停提示：「128 张 + 3 个视频」。 */
  title: string;
}

export function mediaCountParts(data: MediaCountSource): MediaCountParts {
  const imgs = data.imageCount ?? 0;
  const vids = data.videoCount ?? 0;
  const unit = mediaUnit(data.contentKind ?? "photo");
  if (imgs > 0 && vids > 0) {
    return {
      label: `${imgs} ${unit} · ${vids} 个视频`,
      lead: `${imgs} ${unit}`,
      rest: `${vids} 个视频`,
      title: `${imgs} ${unit} + ${vids} 个视频`,
    };
  }
  if (imgs === 0 && vids > 0) {
    const only = `${vids} 个视频`;
    return { label: only, lead: only, rest: "", title: only };
  }
  const label = `${imgs} ${unit}`;
  return { label, lead: label, rest: "", title: label };
}

/** 只要一句说明文字时用这个。 */
export function mediaCountLabel(data: MediaCountSource): string {
  return mediaCountParts(data).label;
}

/**
 * 窄位用的简写：只报照片数，纯视频相册才报视频数。
 *
 * 「接着看」队列里每个格子只有一百来像素，写全「5 张 · 12 个视频」会
 * 折成两行，把后面的时刻挤到第三行。视频数是次要信息，在窄位先让位。
 */
export function mediaCountCompact(data: MediaCountSource): string {
  const imgs = data.imageCount ?? 0;
  const vids = data.videoCount ?? 0;
  if (imgs === 0 && vids > 0) return `${vids} 个视频`;
  return `${imgs} ${mediaUnit(data.contentKind ?? "photo")}`;
}
