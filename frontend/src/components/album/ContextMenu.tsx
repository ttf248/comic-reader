import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { handleMenuKeyDown } from "../../utils/menuKeyboard";

export interface MenuItem {
  id: string;
  label: string;
  /** 左侧图标；与全站统一用 Icon.tsx 里的 SVG 组件，避免 unicode 字符渲染不一致 */
  icon?: ReactNode;
  disabled?: boolean;
  separator?: never;
}

export interface MenuSeparator {
  id: "separator";
  separator: true;
}

export type AnyMenuItem = MenuItem | MenuSeparator;

interface Props {
  x: number;
  y: number;
  items: AnyMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
  /**
   * 配色档：theme（跟随应用主题）/ reader（阅读器暗场）。
   * 阅读器画布恒为深色，浅色菜单浮在上面像"嵌了一块白板"。
   */
  tone?: "theme" | "reader";
}

// 右键菜单：分隔符、边界检查、自动关闭、Esc 关闭。
// 视觉：极细的边 + 中性背景。
export default function ContextMenu({
  x,
  y,
  items,
  onSelect,
  onClose,
  tone = "theme",
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // 打开菜单前获得焦点的元素（右键时是卡片链接），关闭后还回去。
  const previousRef = useRef<HTMLElement | null>(null);
  // StrictMode 会"挂载→卸载→再挂载"一次，用来保证焦点只被接管一次。
  const focusedRef = useRef(false);

  useEffect(() => {
    if (focusedRef.current) return;
    focusedRef.current = true;
    previousRef.current = document.activeElement as HTMLElement | null;
    const menu = ref.current;
    const firstItem = ref.current?.querySelector<HTMLButtonElement>(
      "button:not(:disabled)",
    );
    (firstItem ?? menu)?.focus();
  }, []);

  useEffect(() => {
    const menu = ref.current;
    const restoreFocus = () => {
      const previous = previousRef.current;
      const active = document.activeElement;
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        (active === document.body ||
          (active instanceof Node && menu?.contains(active)))
      ) {
        previous.focus({ preventScroll: true });
      }
    };
    return () => {
      // 卸载时把焦点还给来源元素。
      //
      // 但 React 18 的 StrictMode 在开发模式下会额外做一次"假卸载"：
      // 上面那个 effect 的清理如果立刻抢回焦点，菜单刚打开就被自己的
      // onBlur 关掉（右键菜单在开发模式下等于不可用）。
      //
      // 真实卸载时 React 已经把菜单节点从文档里摘掉，可以立刻还焦点；
      // 假卸载时节点还在文档里，推迟到下一个任务再判断，届时组件仍挂着
      // 就说明只是 StrictMode 的假卸载，不动焦点。
      if (menu && !menu.isConnected) {
        restoreFocus();
        return;
      }
      window.setTimeout(() => {
        if (ref.current) return; // 还挂着 → 只是 StrictMode 的假卸载
        restoreFocus();
      }, 0);
    };
  }, []);

  // 视口夹紧：菜单必须整块落在视口里。
  //
  // 位置存在 state 里，而不是直接写 el.style —— 父组件重渲染时 React
  // 会把内联 style 重新贴回 JSX 里的值，之前命令式写进去的夹紧结果
  // 就被覆盖了：靠近屏幕下缘右键时，菜单有一半在屏幕外点不到。
  //
  // 尺寸用 offsetWidth/offsetHeight 实测：菜单的宽度随内容变
  // （分项文案长短不一），猜一个值迟早会在窄屏上越界。
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const clamp = () => {
      const el = ref.current;
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let nx = x;
      let ny = y;
      if (x + w > window.innerWidth - 8) nx = window.innerWidth - 8 - w;
      if (y + h > window.innerHeight - 8) ny = window.innerHeight - 8 - h;
      if (nx < 8) nx = 8;
      if (ny < 8) ny = 8;
      setPos((prev) =>
        Math.abs(prev.left - nx) < 0.5 && Math.abs(prev.top - ny) < 0.5
          ? prev
          : { left: nx, top: ny },
      );
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [x, y, items.length]);

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const timer = window.setTimeout(() => {
      window.addEventListener("mousedown", fn);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", fn);
    };
  }, [onClose]);

  const dark = tone === "reader";
  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        zIndex: 1000,
        /* 菜单比视口还高时（缩到很矮的窗口）自己滚动，
           而不是把下半截留在屏幕外。 */
        maxHeight: "calc(100vh - 16px)",
        overflowY: "auto",
      }}
      className={`min-w-[190px] border rounded-lg shadow-lg py-1.5 fade-up text-body ${
        dark
          ? "bg-overlay-panel border-overlay-border text-overlay-fg backdrop-blur-md"
          : "bg-bg-elevated border-border"
      }`}
      role="menu"
      tabIndex={-1}
      aria-label="上下文菜单"
      onKeyDown={(event) => handleMenuKeyDown(event, onClose)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
    >
      {items.map((it, i) =>
        "separator" in it ? (
          <div
            key={`sep-${i}`}
            className={`my-1 border-t mx-1 ${
              dark ? "border-white/12" : "border-border-faint"
            }`}
          />
        ) : (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              if (!it.disabled) onSelect(it.id);
            }}
            className={`w-full text-left px-3 py-2 flex items-center gap-2.5 rounded-md transition-colors ${
              dark
                ? it.disabled
                  ? "text-white/35 cursor-not-allowed"
                  : "text-white/85 hover:text-white hover:bg-white/10"
                : it.disabled
                  ? "text-fg-subtle cursor-not-allowed"
                  : "text-fg hover:bg-bg-subtle"
            }`}
          >
            {it.icon && (
              <span className="w-3.5 inline-flex items-center justify-center opacity-80">
                {it.icon}
              </span>
            )}
            <span>{it.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
