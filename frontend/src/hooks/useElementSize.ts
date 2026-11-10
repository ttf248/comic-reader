import { useEffect, useState } from "react";

/**
 * 观察元素的可用宽高。
 *
 * 照片墙按容器宽度排布，容器会随侧栏折叠、窗口缩放和断点变化；
 * 没有测量就只能写死列数，那正是要摆脱的做法。自适应密度还要用容器
 * 高度：照片少时按「一屏放得下几行」决定每行几张。
 *
 * 这里用回调 ref 而不是对象 ref：被测量的元素未必在首帧就存在
 * （列表视图那一支是点「列表视图」才挂上去的），而 effect 只跑一次，
 * 首帧拿不到节点就等于永远量不到 —— 列数会一直停在 1。回调 ref 在
 * 节点真正挂上时才把 effect 重新拉起来。
 */
export function useElementSize<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (!element) return;
    const update = () => {
      // 宽高分开存：尺寸没变时 React 会跳过重渲染，合成一个对象则每次
      // 观察回调都会换引用，滚动与拖拽时白白重画。
      setWidth(element.clientWidth);
      setHeight(element.clientHeight);
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return { ref: setElement, width, height };
}
