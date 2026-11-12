import { useEffect, useState } from "react";
import type { PageSection } from "../utils/pageSections";
import { useSectionNavStore } from "../store/sectionNavStore";

// 判定「当前在哪个分区」的偏移量：粘性分区条的高度再加一点余量。
// 分区标题要滚到分区条下方才算进入视野。
const SPY_OFFSET = 56;
// 判定线再放宽几个像素：跳转到某个分区时，标题正好停在这条线上，
// 亚像素误差会让判定落在上一段里去。
const SPY_TOLERANCE = 4;

/**
 * 滚动时判断当前在哪个分区，并把它记进 store。
 *
 * 页面内容装在 `.app-main` 这层可滚动容器里，滚动事件挂在它上面，
 * 不是挂在 window 上 —— 挂在 window 上永远不会触发。
 *
 * 判定的同时把结果写进 store，侧栏据此显示「你在这一页的哪一段」：
 * 侧栏与页面顶部的分区条因此说的是同一件事，不会各说各话。
 */
export function useSectionSpy(
  sections: PageSection[],
  pathname: string,
): string {
  const [active, setActive] = useState(sections[0]?.id ?? "");
  const setStoreActive = useSectionNavStore((state) => state.setActive);

  useEffect(() => {
    const container = document.querySelector(".app-main");
    if (!container || sections.length === 0) return;

    function update() {
      const threshold =
        container!.getBoundingClientRect().top + SPY_OFFSET + SPY_TOLERANCE;
      let current = sections[0]!.id;
      for (const section of sections) {
        const element = document.getElementById(section.id);
        if (!element) continue;
        if (element.getBoundingClientRect().top <= threshold) {
          current = section.id;
        }
      }
      // 滚到底时最后一个分区可能永远到不了判定线（页面不够长），
      // 这时它就是正在看的那一段。
      if (
        container!.scrollHeight > container!.clientHeight &&
        container!.scrollTop + container!.clientHeight >=
          container!.scrollHeight - 2
      ) {
        current = sections[sections.length - 1]!.id;
      }
      setActive(current);
      setStoreActive(pathname, current);
    }

    update();
    container.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [sections, pathname, setStoreActive]);

  return active;
}

/**
 * 滚到指定分区。
 *
 * 用滚动容器自己滚，而不是 scrollIntoView：后者按视口定位，落点会压在
 * 顶栏上，粘性分区条也会跟着算错位置 —— 顶开一条时它跑到窗口最上边，
 * 滚到底时它干脆跟着内容一起消失。容器自己滚，落点才稳定在分区条下方。
 */
export function scrollToSection(id: string) {
  const element = document.getElementById(id);
  if (!element) return;
  const container = document.querySelector(".app-main");
  if (!container || typeof container.scrollTo !== "function") {
    element.scrollIntoView?.({ behavior: "smooth", block: "start" });
    return;
  }
  const top =
    element.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop -
    SPY_OFFSET;
  container.scrollTo({ top: Math.max(top, 0), behavior: "smooth" });
}
