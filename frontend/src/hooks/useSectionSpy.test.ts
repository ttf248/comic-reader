import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSectionSpy } from "./useSectionSpy";
import { SETTINGS_SECTIONS } from "../utils/pageSections";
import { useSectionNavStore } from "../store/sectionNavStore";

/** 造一个可滚动的容器；每个分区的位置由 tops 决定，可以随时改。 */
function setupContainer(tops: Record<string, number>) {
  const container = document.createElement("main");
  container.className = "app-main";
  for (const id of Object.keys(tops)) {
    const element = document.createElement("section");
    element.id = id;
    element.getBoundingClientRect = () =>
      ({ top: tops[id]!, bottom: tops[id]! + 100, height: 100, width: 0 }) as DOMRect;
    container.appendChild(element);
  }
  document.body.appendChild(container);
  return container;
}

describe("分区跟随滚动", () => {
  it("滚动到哪一段就高亮哪一段，并把结果写进 store", () => {
    const tops: Record<string, number> = { appearance: -100, reading: 200 };
    const container = setupContainer(tops);
    const { result } = renderHook(() =>
      useSectionSpy(SETTINGS_SECTIONS, "/settings"),
    );

    // 初始：只有第一个分区在判定线之上。
    expect(result.current).toBe("appearance");
    expect(useSectionNavStore.getState().active["/settings"]).toBe("appearance");

    // 第二个分区越过判定线之后，当前分区切过去。
    tops.reading = 40;
    act(() => {
      container.dispatchEvent(new Event("scroll"));
    });
    expect(result.current).toBe("reading");
    expect(useSectionNavStore.getState().active["/settings"]).toBe("reading");

    container.remove();
  });

  it("没有滚动容器时保持第一个分区", () => {
    const { result } = renderHook(() =>
      useSectionSpy(SETTINGS_SECTIONS, "/settings"),
    );
    expect(result.current).toBe("appearance");
  });
});
