import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { handleMenuKeyDown } from "../../utils/menuKeyboard";

type TriggerProps = {
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "menu";
};

const PopoverCloseContext = createContext<(() => void) | null>(null);

interface Props {
  trigger: ReactNode;
  children: ReactNode;
  /** 自定义对齐位置；默认相对 trigger 右下角。 */
  align?: "start" | "end";
  /** 受控开关；非受控时使用内部 state。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 菜单容器类名（用于覆盖默认样式）。 */
  className?: string;
}

// 轻量弹出层：点 trigger 切换；点击外部或 Esc 关闭。
//
// 用 portal 渲染到 body，避免被父级 overflow / transform 裁剪。
// 不接管 trigger 的 ref，只接管 click 事件 + 控制显隐。
export default function Popover({
  trigger,
  children,
  align = "end",
  open: controlled,
  onOpenChange,
  className = "",
}: Props) {
  const [internal, setInternal] = useState(false);
  const open = controlled ?? internal;
  const setOpen = useCallback(
    (value: boolean) => {
      if (controlled === undefined) setInternal(value);
      onOpenChange?.(value);
    },
    [controlled, onOpenChange],
  );
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusedMenuRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);
  const menuFocusedRef = useRef(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 计算位置：portal 到 body
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // 默认放在 trigger 下方，右对齐
      setPos({
        top: r.bottom + 6,
        left: align === "end" ? r.right : r.left,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, align]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, setOpen]);

  // 菜单打开后把焦点交给第一项，关闭后返回 trigger，避免键盘用户失去位置。
  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        const trigger = triggerRef.current?.querySelector<HTMLElement>(
          'button, a, [tabindex]:not([tabindex="-1"])',
        );
        const active = document.activeElement;
        if (
          active === document.body ||
          (active instanceof Node && focusedMenuRef.current?.contains(active))
        ) {
          trigger?.focus({ preventScroll: true });
        }
      }
      wasOpenRef.current = false;
      menuFocusedRef.current = false;
      focusedMenuRef.current = null;
      return;
    }

    wasOpenRef.current = true;
    if (!pos || menuFocusedRef.current) return;
    focusedMenuRef.current = menuRef.current;
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    (firstItem ?? menuRef.current)?.focus();
    menuFocusedRef.current = true;
  }, [open, pos]);

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(!open);
  };

  // 默认菜单样式 + 用户覆盖
  const baseCls =
    "min-w-[180px] bg-bg-elevated border border-border rounded-md shadow-lg p-1 text-sm";
  const enhancedTrigger = isValidElement(trigger)
    ? cloneElement(trigger as ReactElement<TriggerProps>, {
        "aria-haspopup": "menu",
        "aria-expanded": open,
      })
    : trigger;

  return (
    <>
      <div
        ref={triggerRef}
        onClick={handleTriggerClick}
        className="inline-flex shrink-0"
      >
        {enhancedTrigger}
      </div>
      {open &&
        pos &&
        createPortal(
          <PopoverCloseContext.Provider value={() => setOpen(false)}>
            <div
              ref={menuRef}
              role="menu"
              tabIndex={-1}
              onKeyDown={(event) =>
                handleMenuKeyDown(event, () => setOpen(false))
              }
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setOpen(false);
              }}
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                transform: align === "end" ? "translateX(-100%)" : "none",
                zIndex: 60,
              }}
              className={`${baseCls} ${className}`}
            >
              {children}
            </div>
          </PopoverCloseContext.Provider>,
          document.body,
        )}
    </>
  );
}

interface MenuItemProps {
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}

// 菜单项：行内 block；hover 高亮；active 显示左侧指示点。
export function PopoverItem({
  onClick,
  disabled,
  active,
  children,
}: MenuItemProps) {
  const close = useContext(PopoverCloseContext);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) {
          onClick?.();
          close?.();
        }
      }}
      className={`w-full text-left flex items-center gap-2 px-2.5 h-8 rounded text-[12px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? "bg-bg-subtle text-fg"
          : "text-fg-muted hover:text-fg hover:bg-bg-subtle/70"
      }`}
    >
      {children}
    </button>
  );
}

// 菜单分隔线
export function PopoverSeparator() {
  return <div className="my-1 h-px bg-border-faint" />;
}

// 菜单分组标签（不可点击的灰色小标题）
export function PopoverLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
      {children}
    </div>
  );
}
