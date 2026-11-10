import { describe, expect, it } from "vitest";
import {
  usePhotoStore,
  wallTargetHeight,
  WALL_DENSITY_HEIGHT,
} from "./photoStore";

describe("照片墙密度", () => {
  it("默认是自适应：照片少时把画面让给每一张", () => {
    expect(usePhotoStore.getState().density).toBe("auto");
  });

  it("自适应没有固定行高，交给照片墙按视口算", () => {
    expect(wallTargetHeight("auto")).toBeUndefined();
  });

  it("手动档位给出固定行高", () => {
    expect(wallTargetHeight("compact")).toBe(WALL_DENSITY_HEIGHT.compact);
    expect(wallTargetHeight("cozy")).toBe(WALL_DENSITY_HEIGHT.cozy);
    expect(wallTargetHeight("large")).toBe(WALL_DENSITY_HEIGHT.large);
  });

  it("手动档位由密到疏", () => {
    expect(WALL_DENSITY_HEIGHT.compact).toBeLessThan(
      WALL_DENSITY_HEIGHT.cozy,
    );
    expect(WALL_DENSITY_HEIGHT.cozy).toBeLessThan(WALL_DENSITY_HEIGHT.large);
  });
});
