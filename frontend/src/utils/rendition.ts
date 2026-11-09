/**
 * 渲染档位：同一张源图在不同场景按需取不同宽度的那一档。
 *
 * 以前所有场景共用一张固定尺寸的缩略图 —— 侧栏 48px 的小图和照片墙
 * 550px 的大图拿到的是同一份字节：小位白下载、大位放大发虚。改成按宽度
 * 分档之后，每个槽位只拿自己够用的那一档。
 *
 * 阶梯值与后端 internal/services/rendition.go 的 RenditionWidths 必须一致：
 * 后端按请求宽度向上取整到档位，前端用同一批宽度写 srcset 描述符。
 * 两边对不上时描述符会与实际像素宽度不符，浏览器会挑到不够宽的一档，
 * 高 DPI 屏幕上就又糊了。
 */
export const RENDITION_WIDTHS = [320, 640, 1280, 1920, 2560, 4096] as const;

/**
 * 像素比上限。
 *
 * 再高的屏幕也没有更宽的档位可用，把倍数放开只会让浏览器去要一张
 * 实际用不到的图。
 */
const MAX_DEVICE_PIXEL_RATIO = 2;

/** 当前设备的像素比；SSR 或测试环境退回 1。 */
export function devicePixelRatio(): number {
  if (typeof window === "undefined") return 1;
  return Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
}

/**
 * pickRenditionWidth 选出够用的最小档位。
 *
 * 需要的像素宽 = 显示宽 × 像素比。向上取整到档位：档位是"至少这么大"
 * 的保证，取整到更小的档位会让高 DPI 屏幕上的图重新变糊。
 */
export function pickRenditionWidth(
  cssWidth: number,
  dpr: number = devicePixelRatio(),
): number {
  const needed = Math.max(1, Math.round(cssWidth * dpr));
  for (const width of RENDITION_WIDTHS) {
    if (needed <= width) return width;
  }
  return RENDITION_WIDTHS[RENDITION_WIDTHS.length - 1];
}

/**
 * renditionCandidates 返回某个槽位应当提供的候选档位（升序）。
 *
 * 全阶梯都列出来：浏览器只会下载它挑中的那一档，多列几个候选不花带宽，
 * 但能覆盖同一个槽位在不同像素比屏幕上的表现。
 */
export function renditionCandidates(): number[] {
  return [...RENDITION_WIDTHS];
}
