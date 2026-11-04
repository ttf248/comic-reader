import { useEffect, useRef, useState } from "react";

/**
 * 观察元素的可用宽度。
 *
 * 照片墙按容器宽度排布，容器会随侧栏折叠、窗口缩放和断点变化；
 * 没有测量就只能写死列数，那正是要摆脱的做法。
 */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}
