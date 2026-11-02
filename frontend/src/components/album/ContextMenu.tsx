import { useEffect, useRef, type ReactNode } from "react";
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
}

// 右键菜单：分隔符、边界检查、自动关闭、Esc 关闭。
// 视觉：极细的边 + 中性背景。
export default function ContextMenu({ x, y, items, onSelect, onClose }: Props) {
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

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (rect.right > window.innerWidth) nx = window.innerWidth - rect.width - 8;
    if (rect.bottom > window.innerHeight)
      ny = window.innerHeight - rect.height - 8;
    if (nx < 4) nx = 4;
    if (ny < 4) ny = 4;
    el.style.left = `${nx}px`;
    el.style.top = `${ny}px`;
  }, [x, y]);

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

  return (
    <div
      ref={ref}
      style={{ position: "fixed", top: y, left: x, zIndex: 1000 }}
      className="min-w-[190px] bg-bg-elevated border border-border rounded-lg shadow-lg py-1.5 fade-up text-[13px]"
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
            className="my-1 border-t border-border-faint mx-1"
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
              it.disabled
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
