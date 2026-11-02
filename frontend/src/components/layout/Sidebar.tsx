import { NavLink, useLocation } from "react-router-dom";
import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  HomeIcon,
  ClockIcon,
  StarIcon,
  SettingsIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ShuffleIcon,
  SparkleIcon,
} from "../common/Icon";
import { useNavigate } from "react-router-dom";
import { useUIStore } from "../../store/uiStore";
import { useLibraryActivitySummary } from "../../hooks/useLibrary";
import { libraryApi } from "../../api/library";
import { albumRoute } from "../../utils/path";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen?: boolean;
}

const items = [
  { to: "/", label: "主页", Icon: HomeIcon, end: true },
  { to: "/recents", label: "最近", Icon: ClockIcon, end: false },
  { to: "/favorites", label: "收藏", Icon: StarIcon, end: false },
];

// 设置沉到底部组：它是低频入口，不该和「主页 / 最近 / 收藏」平级。
const secondaryItems = [
  { to: "/settings", label: "设置", Icon: SettingsIcon, end: false },
];

// 侧边栏：
// - 品牌区只留「图标 + Local Gallery」，不再叠一行 10px 副标题
// - 导航项统一 36px 高 / 13.5px 文字，选中态 = 强调色浅底 + 强调色字
// - 「随机」类操作沉到底部一组，与主导航分开，避免平铺抢注意力
export default function Sidebar({
  collapsed,
  onToggle,
  mobileOpen = false,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const pushToast = useUIStore((s) => s.pushToast);
  // 常驻导航只消费服务端派生的计数，不能为 badge 常驻下载全库相册摘要。
  const activitySummary = useLibraryActivitySummary();
  const unreadCount = activitySummary.data?.summary.unreadCount ?? 0;
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    navRef.current?.querySelector<HTMLElement>("a, button")?.focus();
  }, [mobileOpen]);
  const randomAlbum = useMutation({
    mutationFn: (scope: "all" | "unread") => libraryApi.randomAlbum(scope),
    onSuccess: ({ album }) => navigate(albumRoute(album.id)),
    onError: (_error, scope) =>
      pushToast({
        kind: "info",
        message: scope === "unread" ? "没有未读相册可跳" : "尚未加载图像库",
      }),
  });

  const onShuffle = () => {
    if (!randomAlbum.isPending) randomAlbum.mutate("all");
  };

  const onShuffleUnread = () => {
    if (!randomAlbum.isPending && unreadCount > 0) {
      randomAlbum.mutate("unread");
    }
  };

  const navItemClass = (isActive: boolean) =>
    `group relative flex items-center gap-2.5 h-9 rounded-md text-[13.5px] transition-colors ${
      collapsed ? "justify-center px-0" : "px-2.5"
    } ${
      isActive
        ? "bg-accent-soft text-accent font-medium"
        : "text-fg-muted hover:bg-bg-subtle hover:text-fg"
    }`;

  return (
    <aside
      aria-label="主导航"
      className={`flex flex-col bg-bg-elevated/80 backdrop-blur-xl border-r border-border-faint transition-[width] duration-200 ease-out ${
        mobileOpen
          ? "fixed inset-y-0 left-0 z-50 w-[208px]"
          : `hidden lg:flex lg:static ${collapsed ? "w-[60px]" : "w-[208px]"}`
      }`}
    >
      <div
        className={`h-14 relative flex items-center px-3 ${
          collapsed ? "justify-center" : "justify-between"
        }`}
      >
        {
          !collapsed ? (
            <div className="flex items-center gap-2.5 min-w-0">
              <Logo />
              <div className="leading-none min-w-0 font-display font-semibold tracking-tight text-[13.5px] truncate">
                Local Gallery
              </div>
            </div>
          ) : null /* 折叠态下隐藏 logo,把整行让给展开按钮 */
        }
        {/* 折叠/展开按钮:
            折叠态是用户「想找回菜单」的关键时刻 —— 按钮必须一眼可见,
            所以用 accent 主色填充的"药丸"按钮悬浮在右缘。
            展开态时侧边栏本来就在视野里,按钮保持低调(灰图标 + hover 背景)
            即可,避免和品牌名挤。 */}
        <button
          onClick={onToggle}
          aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          title={collapsed ? "展开侧边栏 (Ctrl+B)" : "折叠侧边栏 (Ctrl+B)"}
          className={
            collapsed
              ? "group/toggle relative z-10 inline-flex items-center gap-1 h-7 pl-2 pr-2.5 rounded-full bg-accent text-accent-contrast shadow-md ring-1 ring-accent/40 hover:ring-2 hover:ring-accent/70 hover:scale-105 active:scale-95 transition-all"
              : "shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-fg-subtle hover:text-fg hover:bg-bg-subtle transition-colors"
          }
        >
          {collapsed ? (
            <>
              <ChevronRightIcon
                size={12}
                className="transition-transform group-hover/toggle:translate-x-0.5"
              />
              <span className="text-[11px] font-semibold tracking-wide">
                展开
              </span>
            </>
          ) : (
            <ChevronLeftIcon size={14} />
          )}
        </button>
      </div>

      <nav ref={navRef} className="flex-1 py-2 px-2 space-y-0.5">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={({ isActive }) => navItemClass(isActive)}
          >
            <it.Icon size={16} className="shrink-0" />
            {!collapsed && <span className="truncate">{it.label}</span>}
          </NavLink>
        ))}

        {/* 未读 — 独立一行,有 count badge。位置放在「收藏」之后、「随机」之前,
            跟「按重要度排列」的视觉顺序一致:主页 / 最近 / 收藏 / 未读 / 随机。 */}
        <NavLink
          to="/unread"
          end={false}
          className={({ isActive }) => navItemClass(isActive)}
          title={`未读相册 (U)${unreadCount > 0 ? ` · 还有 ${unreadCount} 本没看` : ""}`}
        >
          <SparkleIcon size={16} className="shrink-0" />
          {!collapsed && (
            <>
              <span className="truncate flex-1">未读</span>
              {unreadCount > 0 && (
                <span
                  className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full bg-accent-soft text-accent text-[11px] font-semibold tabular-nums"
                  aria-label={`还有 ${unreadCount} 本未读`}
                >
                  {unreadCount > 999 ? "999+" : unreadCount}
                </span>
              )}
            </>
          )}
          {collapsed && unreadCount > 0 && (
            <span
              className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-accent"
              aria-hidden
            />
          )}
        </NavLink>
      </nav>

      {/* 次级入口 + 随机：沉到底部一组，与主导航之间用一条细分隔线断开 */}
      <div className="px-2 pb-3">
        <div className="h-px bg-border-faint mb-2" />
        {secondaryItems.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={({ isActive }) => navItemClass(isActive)}
          >
            <it.Icon size={16} className="shrink-0" />
            {!collapsed && <span className="truncate">{it.label}</span>}
          </NavLink>
        ))}
        <button
          onClick={onShuffle}
          disabled={randomAlbum.isPending}
          title="随机一本 (R)"
          className={`w-full flex items-center gap-2.5 h-9 rounded-md text-[13.5px] transition-colors ${
            collapsed ? "justify-center px-0" : "px-2.5"
          } text-fg-muted hover:bg-bg-subtle hover:text-accent disabled:opacity-50`}
        >
          <ShuffleIcon size={16} className="shrink-0" />
          {!collapsed && <span className="truncate">随机一本</span>}
        </button>

        {/* 随机未读 — 仅在有未读时高亮可点;没未读时变灰提示 */}
        <button
          onClick={onShuffleUnread}
          disabled={unreadCount === 0 || randomAlbum.isPending}
          title={
            unreadCount === 0
              ? "没有未读相册"
              : `从 ${unreadCount} 本未读里随机挑一本`
          }
          className={`w-full flex items-center gap-2.5 h-9 rounded-md text-[13.5px] transition-colors ${
            collapsed ? "justify-center px-0" : "px-2.5"
          } ${
            unreadCount === 0
              ? "text-fg-disabled cursor-not-allowed"
              : "text-fg-muted hover:bg-bg-subtle hover:text-accent"
          }`}
        >
          <SparkleIcon size={16} className="shrink-0" />
          {!collapsed && (
            <>
              <span className="truncate">随机未读</span>
              {unreadCount > 0 && (
                <span className="ml-auto text-[11.5px] tabular-nums text-fg-subtle">
                  {unreadCount}
                </span>
              )}
            </>
          )}
        </button>
      </div>

      {!collapsed && (
        <div className="px-4 pb-3.5">
          <div className="flex items-center gap-2 text-[11.5px] text-fg-subtle">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                location.pathname.startsWith("/gallery")
                  ? "bg-accent"
                  : "bg-success"
              }`}
            />
            <span>
              {location.pathname.startsWith("/gallery") ? "阅读中" : "已就绪"}
            </span>
          </div>
        </div>
      )}
    </aside>
  );
}

// 品牌方块：纯几何 + 字形，使用 accent 颜色
function Logo() {
  return (
    <div className="relative w-7 h-7 shrink-0">
      <div className="absolute inset-0 rounded-lg bg-accent" />
      <div className="absolute inset-0 flex items-center justify-center text-accent-contrast font-display font-semibold text-[13px] tracking-tighter">
        L
      </div>
    </div>
  );
}
