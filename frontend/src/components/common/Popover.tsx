import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ENABLED_MENU_ITEM_SELECTOR,
  handleMenuKeyDown,
} from "../../utils/menuKeyboard";

type TriggerProps = {
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "menu";
};

const PopoverCloseContext = createContext<(() => void) | null>(null);

/**
 * 菜单配色档：
 *   theme —— 跟随应用主题（页面内的普通菜单）
 *   reader —— 阅读器暗场（画布恒为深色，菜单也必须跟着暗；
 *              浅色卡片浮在黑底阅读器上就像"嵌了一块白板"）
 */
type PopoverTone = "theme" | "reader";
const PopoverToneContext = createContext<PopoverTone>("theme");

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
  /** 配色档；阅读器里的菜单传 "reader"。 */
  tone?: PopoverTone;
  "aria-label"?: string;
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
  tone = "theme",
  "aria-label": ariaLabel,
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

  // 绘制前计算位置：portal 到 body
  //
  // 菜单必须整块留在视口里：触发按钮在屏幕下缘时，直接把菜单挂在按钮
  // 下方会有一半掉出视口，下半截的项点不到。做法是先让菜单挂在一个
  // 屏外的位置量出真实尺寸，再按视口决定最终位置 —— 菜单的宽度随
  // 内容变（分项文案长短不一），不实测就没法夹紧。
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = triggerRef.current;
      const menu = menuRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const w = menu?.offsetWidth ?? 0;
      const h = menu?.offsetHeight ?? 0;
      // 默认放在 trigger 下方，右对齐
      let top = r.bottom + 6;
      let left = align === "end" ? r.right : r.left;
      if (w > 0 && h > 0) {
        // align="end" 时 left 是菜单的右边缘（靠 translateX 收回来）。
        const menuLeft = align === "end" ? left - w : left;
        if (menuLeft + w > window.innerWidth - 8) {
          left =
            align === "end"
              ? window.innerWidth - 8
              : window.innerWidth - 8 - w;
        }
        if (menuLeft < 8) left = align === "end" ? 8 + w : 8;
        // 下方放不下就翻到按钮上方；上方也不够就贴着视口下沿。
        if (top + h > window.innerHeight - 8) {
          const above = r.top - 6 - h;
          top = above >= 8 ? above : Math.max(8, window.innerHeight - 8 - h);
        }
      }
      setPos((prev) =>
        prev &&
        Math.abs(prev.top - top) < 0.5 &&
        Math.abs(prev.left - left) < 0.5
          ? prev
          : { top, left },
      );
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

  // 绘制前把焦点交给菜单，避免快速按 Esc 时事件仍落在 trigger 上。
  // 关闭后返回 trigger，避免键盘用户失去位置。
  useLayoutEffect(() => {
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
    const firstItem = menuRef.current?.querySelector<HTMLElement>(
      ENABLED_MENU_ITEM_SELECTOR,
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
    tone === "reader"
      ? "min-w-[180px] bg-overlay-panel border border-overlay-border rounded-lg shadow-2xl p-1.5 text-body text-overlay-fg backdrop-blur-md"
      : "min-w-[180px] bg-bg-elevated border border-border rounded-lg shadow-lg p-1.5 text-body";
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
        createPortal(
          <PopoverCloseContext.Provider value={() => setOpen(false)}>
            <PopoverToneContext.Provider value={tone}>
              <div
                ref={menuRef}
                role="menu"
                aria-label={ariaLabel}
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
                  /* 位置量出来之前先挂在屏外：菜单始终在 DOM 里，
                     量得到真实尺寸；布局阶段再把它挪到该在的地方，
                     不会出现「先闪一下再跳位」。 */
                  top: pos?.top ?? -9999,
                  left: pos?.left ?? -9999,
                  transform: align === "end" ? "translateX(-100%)" : "none",
                  zIndex: 60,
                }}
                className={`${baseCls} ${className}`}
              >
                {children}
              </div>
            </PopoverToneContext.Provider>
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
  /** 悬停提示。用来讲清某个动作的副作用（例如「会清空另一种进度」）。 */
  title?: string;
  children: ReactNode;
}

// 菜单项：行内 block；hover 高亮；active 显示左侧指示点。
export function PopoverItem({
  onClick,
  disabled,
  active,
  title,
  children,
}: MenuItemProps) {
  const close = useContext(PopoverCloseContext);
  const tone = useContext(PopoverToneContext);
  const stateCls =
    tone === "reader"
      ? active
        ? "bg-white/15 text-white"
        : "text-white/80 hover:text-white hover:bg-white/10"
      : active
        ? "bg-bg-subtle text-fg"
        : "text-fg-muted hover:text-fg hover:bg-bg-subtle/70";
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) {
          onClick?.();
          close?.();
        }
      }}
      /* 菜单项不折行：h-9 是固定高度，文字一旦折行就会溢出按钮，
         「在资源管理器中打开」在 180px 宽的菜单里正好折成两行，
         第二行压在下一项上。宁可让菜单变宽，也不折行。 */
      className={`w-full text-left flex items-center gap-2.5 px-2.5 min-h-9 whitespace-nowrap rounded-md text-body transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${stateCls}`}
    >
      {children}
    </button>
  );
}

// 菜单分隔线
export function PopoverSeparator() {
  const tone = useContext(PopoverToneContext);
  return (
    <div
      className={`my-1 h-px ${tone === "reader" ? "bg-white/12" : "bg-border-faint"}`}
    />
  );
}

// 菜单分组标签（不可点击的灰色小标题）
export function PopoverLabel({ children }: { children: ReactNode }) {
  const tone = useContext(PopoverToneContext);
  return (
    <div
      className={`px-2.5 pt-2 pb-1.5 text-meta font-medium ${
        tone === "reader" ? "text-white/50" : "text-fg-subtle"
      }`}
    >
      {children}
    </div>
  );
}
