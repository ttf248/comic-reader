import { useEffect, useRef, type ReactNode } from "react";

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

  useEffect(() => {
    const previous = document.activeElement;
    const menu = ref.current;
    const firstItem = ref.current?.querySelector<HTMLButtonElement>(
      "button:not(:disabled)",
    );
    firstItem?.focus();
    return () => {
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
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const timer = window.setTimeout(() => {
      window.addEventListener("mousedown", fn);
      window.addEventListener("keydown", esc);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", fn);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ position: "fixed", top: y, left: x, zIndex: 1000 }}
      className="min-w-[180px] bg-bg-elevated border border-border rounded-lg shadow-lg py-1 fade-up text-[13px]"
      role="menu"
      aria-label="上下文菜单"
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
            className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 transition-colors ${
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
