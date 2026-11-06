import { useCallback, useEffect, useRef, useState } from "react";

interface EdgeFade {
  /** 起点一侧还有内容（可以往回滚）。 */
  start: boolean;
  /** 终点一侧还有内容（可以继续滚）。 */
  end: boolean;
}

/**
 * 横向滚动容器的两端渐隐。
 *
 * 内容溢出时才出现，滑到尽头就收起来：一排卡被右边框硬切一刀，
 * 读起来像布局坏了；淡出的一小段则明确地说「右边还有」。
 *
 * 用单个 mask gradient 的四个色标拼出两端，中间始终不透明。
 */
export function useEdgeFade<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [fade, setFade] = useState<EdgeFade>({ start: false, end: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setFade({
      start: el.scrollLeft > 2,
      end: max > 2 && el.scrollLeft < max - 2,
    });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    // ResizeObserver 在 jsdom 里没有（测试环境），缺了它就退回到
    // 窗口尺寸变化时重算，功能不会因此失效。
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(el);
    for (const child of Array.from(el.children)) observer?.observe(child);
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [update]);

  const maskImage = `linear-gradient(to right, ${
    fade.start ? "transparent 0, #000 28px" : "#000 0"
  }, ${fade.end ? "#000 calc(100% - 28px), transparent 100%" : "#000 100%"})`;

  return { ref, maskImage, fade };
}
