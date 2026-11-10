/**
 * 照片墙的自适应排布算法。
 *
 * 目标：让每张照片按真实宽高比占位，行与行之间不留裁切、不留空洞，
 * 也不把竖幅照片压成统一的小方块。实现参考图库常见的 justified layout：
 * 逐张累加比例，凑不满一行就换行，并把每行等比缩放到刚好铺满容器宽度。
 *
 * 这里是纯函数，不碰 DOM：布局要在容器宽度、媒体尺寸或相册切换时反复
 * 重算，纯函数才好测、好缓存。
 */

/** 未知宽高比时使用的默认比例（3:2）。 */
export const DEFAULT_TILE_RATIO = 1.5;

/** 视频缩略图的默认画幅（16:9）。 */
export const VIDEO_TILE_RATIO = 16 / 9;

/** 排布输入的一项。ratio 是宽 / 高。 */
export interface WallTile {
  id: string;
  ratio: number;
}

/** 排布输出的一项：宽度由行高与比例共同决定。 */
export interface PlacedTile {
  id: string;
  ratio: number;
  width: number;
}

/** 排布输出的一行。 */
export interface WallRow {
  /** 行内第一个元素的 ID，用作虚拟列表的稳定 key。 */
  key: string;
  /** 行高（像素），包含行间距。 */
  height: number;
  /** 图片实际高度（像素），等于 height 减去行间距。 */
  tileHeight: number;
  tiles: PlacedTile[];
}

export interface JustifiedLayoutOptions {
  /** 可用宽度（像素）。 */
  containerWidth: number;
  /** 目标行高（像素）：一行图片大致多高。 */
  targetHeight: number;
  /** 图片之间的间距（像素），横向与纵向相同。 */
  gap: number;
  /** 单行高度相对目标行高的上限，避免一张竖图占满整屏。 */
  maxRowScale?: number;
  /** 单行高度相对目标行高的下限，避免一行被压得过高。 */
  minRowScale?: number;
}

const DEFAULT_MAX_ROW_SCALE = 1.8;
const DEFAULT_MIN_ROW_SCALE = 0.6;

/**
 * 把一组带比例的条目排成若干自适应行。
 *
 * 规则：
 *  - 一行能放下就继续放，放不下（按目标行高算会超出容器宽度）就换行；
 *  - 换行后按实际比例把整行等比缩放，铺满容器宽度；
 *  - 行高被夹在目标行高的上下限之间，竖图不会顶满屏幕，横图也不会被压扁；
 *  - 最后一行不满时保持目标行高，不为了填满而把一张图撑成巨幅。
 */
export function layoutJustified(
  tiles: readonly WallTile[],
  options: JustifiedLayoutOptions,
): WallRow[] {
  const { containerWidth, targetHeight, gap } = options;
  if (containerWidth <= 0 || targetHeight <= 0 || tiles.length === 0) {
    return [];
  }
  const maxScale = options.maxRowScale ?? DEFAULT_MAX_ROW_SCALE;
  const minScale = options.minRowScale ?? DEFAULT_MIN_ROW_SCALE;
  const minHeight = targetHeight * minScale;
  const maxHeight = targetHeight * maxScale;

  const rows: WallRow[] = [];
  let current: WallTile[] = [];
  let sumRatio = 0;
  // 上一行的高度：末行按它收，末行才不会比上面的行矮一截。
  let previousHeight = targetHeight;

  const flush = (isLast: boolean) => {
    if (current.length === 0) return;
    const gaps = gap * (current.length - 1);
    const natural = (containerWidth - gaps) / sumRatio;
    let height = clamp(natural, minHeight, maxHeight);
    if (isLast) {
      // 末行不为了填满宽度而放大：一张图撑满整行看起来像加载失败。
      // 但也不该比上面那几行矮一截 —— 高度一致，末行只是没铺满宽度。
      height = Math.min(height, previousHeight);
    }
    // 夹取后仍可能与容器宽度有出入（极端比例），这里统一按实际宽度回缩，
    // 保证任何一行都不会溢出容器。
    const total = sumRatio * height + gaps;
    if (total > containerWidth && total > 0) {
      height = (containerWidth - gaps) / sumRatio;
    }
    previousHeight = height;
    rows.push({
      key: `row-${rows.length}-${current[0].id}`,
      height: height + gap,
      tileHeight: height,
      tiles: current.map((tile) => ({
        id: tile.id,
        ratio: tile.ratio,
        width: tile.ratio * height,
      })),
    });
    current = [];
    sumRatio = 0;
  };

  for (const tile of tiles) {
    const ratio = tile.ratio > 0 ? tile.ratio : DEFAULT_TILE_RATIO;
    const next: WallTile = { id: tile.id, ratio };
    const candidateRatio = sumRatio + ratio;
    const candidateCount = current.length + 1;
    const candidateWidth = candidateRatio * targetHeight + gap * (candidateCount - 1);
    if (current.length > 0 && candidateWidth > containerWidth) {
      flush(false);
      current = [next];
      sumRatio = ratio;
      continue;
    }
    current.push(next);
    sumRatio = candidateRatio;
  }
  flush(true);
  return rows;
}

/**
 * 从媒体项取出用于排布的宽高比。
 *
 * 服务端给出像素宽高时用真实比例；否则视频按 16:9，图片退回默认比例。
 */
export function tileRatio(
  item: { kind: string; width?: number; height?: number } | undefined,
): number {
  if (!item) return DEFAULT_TILE_RATIO;
  if (item.kind === "video") return VIDEO_TILE_RATIO;
  if (item.width && item.height && item.width > 0 && item.height > 0) {
    return item.width / item.height;
  }
  return DEFAULT_TILE_RATIO;
}

/**
 * 自适应密度的候选行高，从密到疏。
 *
 * 步子不均匀：密集的一头密得多（那里照片多、屏幕装不下），稀疏的一头
 * 稀疏（照片少时一行两张就够，再疏就成了幻灯片）。
 */
const AUTO_DENSITY_LADDER = [
  110, 130, 150, 175, 200, 230, 260, 295, 335, 380, 430, 490,
];

/**
 * 自适应模式下整面墙最多占几屏。
 *
 * 超过两屏就不是「一眼看完」了：用户要滚动才看得全，照片墙的卖点
 * （铺满当下这一屏）就没了。
 */
const AUTO_MAX_SCREENS = 2;

export interface AutoLayoutOptions {
  /** 可用宽度（像素）。 */
  containerWidth: number;
  /** 可用高度（像素）：一屏能放下多少。 */
  containerHeight: number;
  /** 图片之间的间距（像素）。 */
  gap: number;
  /**
   * 密度下限（像素）。
   *
   * 自适应只会让照片更大，不会更密：照片多的时候保持浏览密度，
   * 照片少的时候才把画面让给每一张。
   */
  minTargetHeight: number;
  /**
   * 密度上限（像素）：一行至少要放得下两张照片。
   *
   * 窄屏上这一条说了算：容器只有三百多像素宽时，行高再大就变成
   * 一行一张，手机相册会退化成一列照片列表。
   */
  maxTargetHeight?: number;
}

/**
 * 按数量、比例与视口算出自适应模式下的目标行高。
 *
 * 做法是试排：每一档候选行高都真排一遍，看这面墙有多高、每张照片
 * 平均有多大，然后在「放得下」的档位里挑照片最大的那一档。
 *
 * 为什么不直接用公式：行高决定一行放几张，而一行的实际高度由这一行
 * 的比例和容器宽度决定 —— 行高与墙高不是线性关系，算不出闭式解。
 * 真排一遍才准，代价也只是几次数组扫描。
 */
export function autoTargetHeight(
  tiles: readonly WallTile[],
  options: AutoLayoutOptions,
): number {
  const { containerWidth, containerHeight, gap, minTargetHeight } = options;
  const floor = Math.max(1, Math.round(minTargetHeight));
  const ceiling = Math.max(floor, Math.round(options.maxTargetHeight ?? Infinity));
  if (containerWidth <= 0 || containerHeight <= 0 || tiles.length === 0) {
    return floor;
  }
  const candidates = AUTO_DENSITY_LADDER.filter(
    (height) => height >= floor && height <= ceiling,
  );
  if (candidates.length === 0) return floor;
  const budget = containerHeight * AUTO_MAX_SCREENS;
  // 一档都放不下时（照片很多）退回密度下限：那才是浏览密度，
  // 稀疏档只会让人多滚几十屏。
  let best = floor;
  let bestArea = -1;
  for (const target of candidates) {
    const rows = layoutJustified(tiles, {
      containerWidth,
      targetHeight: target,
      gap,
    });
    let wallHeight = 0;
    for (const row of rows) wallHeight += row.height;
    // 这一档太疏：整面墙超过两屏，它就不算「一屏看完」。
    if (wallHeight > budget) continue;
    const area = averageTileArea(rows);
    if (area > bestArea) {
      bestArea = area;
      best = target;
    }
  }
  return best;
}

/** 一面墙里照片的平均面积。 */
function averageTileArea(rows: WallRow[]): number {
  let area = 0;
  let count = 0;
  for (const row of rows) {
    for (const tile of row.tiles) {
      area += tile.width * row.tileHeight;
      count += 1;
    }
  }
  return count === 0 ? 0 : area / count;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
