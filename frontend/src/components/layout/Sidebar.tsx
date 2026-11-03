import { NavLink, useLocation } from "react-router-dom";
import { useEffect, useMemo, useRef } from "react";
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
import {
  useLibraryActivitySummary,
  useLibraryDashboard,
} from "../../hooks/useLibrary";
import { libraryApi } from "../../api/library";
import { albumRoute } from "../../utils/path";
import { thumbUrl } from "../../api/thumbs";
import { nodeSummaryToCard } from "../../utils/libraryCard";
import {
  continueReadingTarget,
  readingPercent,
} from "../../utils/continueReading";

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

  // 「继续阅读」区：侧栏中段常驻在读的书目。
  //
  // 侧栏中段原本是一整片空白（4 个导航项撑不满 208px × 900px），
  // 而"接着看上一本"是全局最高频的动作。与其留白，不如把在读列表
  // 钉在那里 —— 像播放器的"正在播放 + 接下来"。
  //
  // 数据全部来自与首页同一个 dashboard 查询（React Query 共享缓存，
  // 不额外请求）：侧栏刻意不下载全库摘要（见 useLibrary 的注释），
  // 所以这里只能用 dashboard 里已经有的在读条目。
  const dashboard = useLibraryDashboard();
  const inProgress = useMemo(
    () => dashboard.data?.dashboard.inProgress ?? [],
    [dashboard.data],
  );
  const continueCard = useMemo(() => {
    const first = inProgress[0];
    if (!first) return null;
    return {
      ...nodeSummaryToCard(first.album),
      progress: { index: first.pageIndex, total: first.pageCount },
    };
  }, [inProgress]);
  // 其余在读：最多 5 条紧凑行，再多就只给一个总数提示。
  const continueRest = useMemo(
    () =>
      inProgress.slice(1, 6).map((item) => ({
        ...nodeSummaryToCard(item.album),
        progress: { index: item.pageIndex, total: item.pageCount },
      })),
    [inProgress],
  );
  const continueRestCount = Math.max(0, inProgress.length - 6);

  // 选中态：强调色浅底 + 前景色文字（文字保持 --fg，图标用强调色）。
  // 这样在六套强调色下都能保持稳定对比度 —— 选中文字直接用强调色时，
  // 浅色背景 + 靛蓝/琥珀这类中明度强调色的对比度并不总是够。
  const navItemClass = (isActive: boolean) =>
    `group relative flex items-center gap-2.5 h-9 rounded-md text-[13.5px] transition-colors ${
      collapsed ? "justify-center px-0" : "px-2.5"
    } ${
      isActive
        ? "bg-accent-soft text-fg font-medium"
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
              <span className="text-[11.5px] font-semibold tracking-wide">
                展开
              </span>
            </>
          ) : (
            <ChevronLeftIcon size={14} />
          )}
        </button>
      </div>

      <nav ref={navRef} className="py-2 px-2 space-y-0.5">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={({ isActive }) => navItemClass(isActive)}
          >
            {({ isActive }) => (
              <>
                <it.Icon
                  size={16}
                  className={`shrink-0 ${isActive ? "text-accent" : ""}`}
                />
                {!collapsed && <span className="truncate">{it.label}</span>}
              </>
            )}
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
                  className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full bg-accent-soft text-accent text-[11.5px] font-semibold tabular-nums"
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

      {/* 「继续阅读」区：紧跟导航，填掉侧栏中段的空白。
          上面是"正在读的那本"，下面是"接下来几本"。 */}
      {!collapsed && continueCard && (
        <div className="px-2 pt-1 pb-2">
          <div className="px-1 pb-2 flex items-baseline gap-2">
            <span className="text-[12.5px] text-fg-subtle">继续阅读</span>
            <span className="text-[12.5px] text-fg-subtle tabular-nums">
              {inProgress.length} 本
            </span>
          </div>
          <ContinueMiniCard
            title={continueCard.displayTitle ?? continueCard.title}
            coverPath={continueCard.coverPath}
            index={continueCard.progress?.index ?? 0}
            total={continueCard.progress?.total ?? 0}
            onOpen={() => navigate(continueReadingTarget(continueCard))}
          />
          {continueRest.map((card) => (
            <ContinueRow
              key={card.id}
              title={card.displayTitle ?? card.title}
              coverPath={card.coverPath}
              index={card.progress?.index ?? 0}
              total={card.progress?.total ?? 0}
              onOpen={() => navigate(continueReadingTarget(card))}
            />
          ))}
          {continueRestCount > 0 && (
            <div className="px-2 pt-1.5 text-[12.5px] text-fg-subtle tabular-nums">
              还有 {continueRestCount} 本没看完
            </div>
          )}
        </div>
      )}

      {/* 弹性留白：把次级入口压到侧栏底部，侧栏中段即使没有内容
          也是"底部对齐"的布局，而不是内容浮在中间。 */}
      <div className="flex-1 min-h-4" />

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
            {({ isActive }) => (
              <>
                <it.Icon
                  size={16}
                  className={`shrink-0 ${isActive ? "text-accent" : ""}`}
                />
                {!collapsed && <span className="truncate">{it.label}</span>}
              </>
            )}
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

        {/* 「随机未读」原本也在这里，与「未读」页 / 首页的"随机未读"重复，
            已移除 —— 同一动作只保留一个入口。 */}
      </div>

      {!collapsed && (
        <div className="px-4 pb-3.5">
          <div className="flex items-center gap-2 text-[12.5px] text-fg-subtle">
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
  // 字母直接放在底板上（不再用一层绝对定位的兄弟节点盖上去）：
  // 兄弟节点的方式会让对比度检查工具读不到深色底板，把白字判成白底白字。
  return (
    <div className="relative w-7 h-7 shrink-0 rounded-lg bg-accent flex items-center justify-center text-accent-contrast font-display font-semibold text-[13px] tracking-tighter">
      L
    </div>
  );
}

// 紧凑行：侧栏「继续阅读」区里其余在读书目的单行形态。
function ContinueRow({
  title,
  coverPath,
  index,
  total,
  onOpen,
}: {
  title: string;
  coverPath?: string;
  index: number;
  total: number;
  onOpen: () => void;
}) {
  const percent = readingPercent({ index, total });
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`继续阅读「${title}」`}
      className="w-full mt-1 rounded-md px-1 py-1 flex items-center gap-2.5 text-left transition-colors hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="relative w-[26px] h-[34px] shrink-0 rounded overflow-hidden bg-bg-strong block">
        {coverPath ? (
          <img
            src={thumbUrl(coverPath)}
            alt=""
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover object-[50%_30%]"
          />
        ) : null}
        <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-black/40">
          <span
            className="block h-full bg-white/90"
            style={{ width: `${percent}%` }}
          />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] text-fg truncate leading-tight">
          {title}
        </span>
        <span className="block text-[12.5px] text-fg-subtle tabular-nums mt-0.5">
          看到 {index + 1} / {total}
        </span>
      </span>
    </button>
  );
}

// 「接着读」迷你卡：侧栏常驻最近在读的一本。
//
// 版式参照播放器的"正在播放"条：左侧封面缩略图 + 右侧标题与进度。
// 点击直接回到上次看到的那一页（与首页封面台同一份跳转逻辑）。
function ContinueMiniCard({
  title,
  coverPath,
  index,
  total,
  onOpen,
}: {
  title: string;
  coverPath?: string;
  index: number;
  total: number;
  onOpen: () => void;
}) {
  const percent = readingPercent({ index, total });
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`继续阅读「${title}」`}
      className="mt-2 w-full rounded-lg bg-bg-subtle hover:bg-bg-strong/70 p-2 flex gap-2.5 items-center text-left transition-colors group/mini focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="relative w-9 h-12 shrink-0 rounded overflow-hidden bg-bg-strong block">
        {coverPath ? (
          <img
            src={thumbUrl(coverPath)}
            alt=""
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover object-[50%_30%]"
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        {/* 标题直接起排：外层分组标题已经写了"继续阅读"，
            这里再写一遍是重复信息。
            用 --fg-muted 而不是 --fg-subtle：卡片底色是 bg-bg-subtle，
            fg-subtle 在这个底上只有 4.4:1（AA 要求 4.5:1）。 */}
        <span className="block text-[13px] font-medium text-fg truncate leading-tight group-hover/mini:text-accent transition-colors">
          {title}
        </span>
        <span className="mt-1.5 block h-[3px] rounded-full bg-bg-strong overflow-hidden">
          <span
            className="block h-full rounded-full bg-accent"
            style={{ width: `${percent}%` }}
          />
        </span>
        <span className="mt-1 block text-[12.5px] text-fg-muted tabular-nums">
          看到 {index + 1} / {total}
        </span>
      </span>
    </button>
  );
}
