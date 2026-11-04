import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 照片墙的密度：目标行高（像素）。 */
export type WallDensity = "compact" | "cozy" | "large";

export const WALL_DENSITY_HEIGHT: Record<WallDensity, number> = {
  compact: 150,
  cozy: 210,
  large: 290,
};

export const WALL_DENSITY_LABEL: Record<WallDensity, string> = {
  compact: "密集",
  cozy: "标准",
  large: "宽松",
};

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
      density: "cozy",
      showInfo: false,
      setDensity: (density) => set({ density }),
      setShowInfo: (showInfo) => set({ showInfo }),
    }),
    {
      name: "local-gallery-photos",
    },
  ),
);
