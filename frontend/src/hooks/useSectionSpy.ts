import { useEffect, useState } from "react";
import type { PageSection } from "../utils/pageSections";
import { useSectionNavStore } from "../store/sectionNavStore";

// 判定「当前在哪个分区」的偏移量：分区标题要滚到顶栏下方才算进入视野。
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
  const pinned = useSectionNavStore((state) => state.pinned[pathname]);
  const releasePins = useSectionNavStore((state) => state.releasePins);

  useEffect(() => {
    const container = document.querySelector(".app-main");
    if (!container || sections.length === 0) return;

    function update() {
      const locked = useSectionNavStore.getState().pinned[pathname];
      if (locked) {
        setActive(locked);
        return;
      }
      const threshold =
        container!.getBoundingClientRect().top + SPY_OFFSET + SPY_TOLERANCE;
      // 宽屏上分区排成两列，同一高度有两个分区标题。只认「越过判定线
      // 且位置更靠下」的那个 —— 位置相同就保留先出现的那个，
      // 也就是先读的那一列。
      let current = sections[0]!.id;
      let best = Number.NEGATIVE_INFINITY;
      for (const section of sections) {
        const element = document.getElementById(section.id);
        if (!element) continue;
        const top = element.getBoundingClientRect().top;
        if (top <= threshold && top > best) {
          best = top;
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

    // 用户自己滚动时解除锁定：锁定只管「刚点完跳转」这一小段时间。
    const release = () => releasePins();
    const onKey = (event: KeyboardEvent) => {
      if (
        ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(
          event.key,
        )
      ) {
        release();
      }
    };

    update();
    container.addEventListener("scroll", update, { passive: true });
    container.addEventListener("wheel", release, { passive: true });
    container.addEventListener("touchstart", release, { passive: true });
    // 拖滚动条：在容器上按下就说明用户自己接管了滚动。
    container.addEventListener("pointerdown", release, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", update);
    return () => {
      container.removeEventListener("scroll", update);
      container.removeEventListener("wheel", release);
      container.removeEventListener("touchstart", release);
      container.removeEventListener("pointerdown", release);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", update);
    };
  }, [sections, pathname, setStoreActive, releasePins]);

  // 锁定期间侧栏按用户点的那个显示。
  useEffect(() => {
    if (pinned) setActive(pinned);
  }, [pinned]);

  return active;
}

/**
 * 滚到指定分区。
 *
 * 用滚动容器自己滚，而不是 scrollIntoView：后者按视口定位，落点会压在
 * 顶栏上，粘性分区条也会跟着算错位置 —— 顶开一条时它跑到窗口最上边，
 * 滚到底时它干脆跟着内容一起消失。容器自己滚，落点才稳定在分区条下方。
 *
 * 跳转的同时锁定这一段：两列并排时两个标题在同一高度，只看位置认不出
 * 用户点了哪一个。
 */
export function scrollToSection(id: string, pathname: string) {
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
  useSectionNavStore.getState().pin(pathname, id);
}
