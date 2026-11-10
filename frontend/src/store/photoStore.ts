import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * 照片墙的密度。
 *
 * "auto" 是自适应：按数量、比例与视口算行高，照片少时把画面让给每一张。
 * 三个固定档位是手动密度 —— 用户明确选过之后，自适应不再插手。
 */
export type WallDensity = "auto" | "compact" | "cozy" | "large";

/** 手动档位对应的目标行高（像素）。 */
export const WALL_DENSITY_HEIGHT: Record<Exclude<WallDensity, "auto">, number> = {
  compact: 150,
  cozy: 210,
  large: 290,
};

export const WALL_DENSITY_LABEL: Record<WallDensity, string> = {
  auto: "自适应",
  compact: "密集",
  cozy: "标准",
  large: "宽松",
};

/** 手动密度档位，自适应模式不算在内。 */
export const WALL_DENSITY_KEYS = ["compact", "cozy", "large"] as const;

/**
 * 照片墙实际使用的目标行高。
 *
 * 自适应模式没有固定行高，返回 undefined 让照片墙自己算。
 */
export function wallTargetHeight(density: WallDensity): number | undefined {
  if (density === "auto") return undefined;
  return WALL_DENSITY_HEIGHT[density];
}

/**
 * 照片模式的偏好。
 *
 * 与漫画阅读器的偏好（store/galleryStore.ts，localStorage 键 "local-gallery"）
 * 分开存放：两种模式的交互模型不同，密度、铺排方式这类设置互相污染只会
 * 让两边都不顺手。
 */
export interface PhotoState {
  density: WallDensity;
  /** 大图预览是否显示图片信息面板。 */
  showInfo: boolean;
  setDensity: (density: WallDensity) => void;
  setShowInfo: (show: boolean) => void;
}

export const usePhotoStore = create<PhotoState>()(
  persist(
    (set) => ({
      density: "auto",
      showInfo: false,
      setDensity: (density) => set({ density }),
      setShowInfo: (showInfo) => set({ showInfo }),
    }),
    {
      name: "local-gallery-photos",
    },
  ),
);
