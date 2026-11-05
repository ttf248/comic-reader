import { Link, NavLink, useLocation } from "react-router-dom";
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
import { useAppMode } from "../../hooks/useAppMode";
import { libraryApi } from "../../api/library";
import { albumRoute } from "../../utils/path";
import { thumbUrl } from "../../api/thumbs";
import { nodeSummaryToCard } from "../../utils/libraryCard";
import { comicCopy, workbenchCopy } from "../../utils/workbench";
import {
  continueReadingTarget,
  readingPercent,
} from "../../utils/continueReading";
import ModeSwitch from "./ModeSwitch";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen?: boolean;
}

interface NavEntry {
  to: string;
  label: string;
  Icon: typeof HomeIcon;
  /** 徽标数字（未读计数）。 */
  badge?: number;
}

// 侧栏只呈现当前工作台的那一组。
//
// 两个模式是完全独立的界面：照片这边只有浏览、收藏与最近；
// 漫画这边才有未读与继续阅读。菜单不混排，操作也不互相沾边。
const PHOTO_GROUP: NavEntry[] = [
  { to: "/", label: "照片库", Icon: HomeIcon },
  { to: "/recents", label: "最近浏览", Icon: ClockIcon },
  { to: "/favorites", label: "收藏照片", Icon: StarIcon },
];

const COMIC_GROUP: NavEntry[] = [
  { to: "/", label: "漫画库", Icon: HomeIcon },
  { to: "/unread", label: "未读", Icon: SparkleIcon },
  { to: "/recents", label: "最近阅读", Icon: ClockIcon },
  { to: "/favorites", label: "收藏漫画", Icon: StarIcon },
];

// 设置沉到底部组：它是低频入口，不该和「主页 / 最近 / 收藏」平级。
const secondaryItems = [
  { to: "/settings", label: "设置", Icon: SettingsIcon, end: false },
];

// 侧栏：
// - 品牌区只留「图标 + Local Gallery」，不再叠一行 10px 副标题
// - 导航项统一 36px 高 / 13.5px 文字，选中态 = 亮一档的灰块 + 白字
// - 「随机」类操作沉到底部一组，与主导航分开，避免平铺抢注意力
export default function Sidebar({
  collapsed,
  onToggle,
  mobileOpen = false,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const pushToast = useUIStore((s) => s.pushToast);
  const { mode, setMode } = useAppMode();
  const copy = workbenchCopy(mode);
  // 未读只属于漫画工作台：照片侧栏没有未读入口，也就没有它的徽标。
  const unreadCount = useLibraryActivitySummary().data?.summary.unreadCount ?? 0;
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    navRef.current?.querySelector<HTMLElement>("a, button")?.focus();
  }, [mobileOpen]);

  const randomAlbum = useMutation({
    mutationFn: () => libraryApi.randomAlbum(mode),
    onSuccess: ({ album }) => navigate(albumRoute(album.id)),
    onError: () =>
      pushToast({ kind: "info", message: "没有可随机打开的相册" }),
  });

  const onShuffle = () => {
    if (!randomAlbum.isPending) randomAlbum.mutate();
  };

  // 继续阅读只属于漫画工作台：照片侧栏不显示在读摘要。
  const dashboard = useLibraryDashboard();
  const inProgress = useMemo(
    () =>
      mode === "comic"
        ? (dashboard.data?.dashboard.inProgress ?? [])
        : [],
    [dashboard.data, mode],
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

  // 选中态：比侧栏亮一档的灰块 + 白字。
  // 侧栏是墨黑表面，选中态靠明度差而不是色相来区分，
  // 整条导航才不会被第二个颜色带跑。
  const navItemClass = (isActive: boolean) =>
    `nav-entry group ${collapsed ? "nav-entry--compact" : ""} ${isActive ? "is-active" : ""}`;

  const isEntryActive = (entry: NavEntry) =>
    entry.to === "/"
      ? location.pathname === "/"
      : location.pathname.startsWith(entry.to);

  const renderGroup = (
    title: string,
    group: NavEntry[],
    badgeFor: (entry: NavEntry) => number,
  ) => {
    return (
      <div className="mt-5 first:mt-0">
        <div className="px-4 pb-1 flex items-center gap-2">
          <span className="text-[11.5px] tracking-wide transition-colors text-rail-fg">
            {title}
          </span>
        </div>
        {group.map((entry) => {
          const isActive = isEntryActive(entry);
          const badge = badgeFor(entry);
          return (
            <Link
              key={`${entry.to}-${entry.label}`}
              to={entry.to}
              className={navItemClass(isActive)}
              aria-current={isActive ? "page" : undefined}
              title={`${entry.label}${badge > 0 ? ` · 还有 ${badge} 本` : ""}`}
            >
              <entry.Icon size={16} className="shrink-0" />
              {!collapsed && <span className="truncate">{entry.label}</span>}
              {!collapsed && badge > 0 && (
                <span
                  className="inline-flex items-center justify-center min-w-[22px] h-[20px] px-1.5 rounded-full bg-rail-hover text-rail-fg text-[12.5px] font-semibold tabular-nums"
                  aria-label={`还有 ${badge} 本`}
                >
                  {badge > 999 ? "999+" : badge}
                </span>
              )}
              {collapsed && badge > 0 && (
                <span
                  className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-rail-accent"
                  aria-hidden
                />
              )}
            </Link>
          );
        })}
      </div>
    );
  };

  return (
    <aside
      aria-label="主导航"
      className={`app-sidebar flex flex-col shrink-0 transition-[width] duration-200 ease-out ${
        mobileOpen
          ? "fixed inset-y-0 left-0 z-50 w-[236px]"
          : `hidden lg:flex lg:static ${collapsed ? "w-[72px]" : "w-[236px]"}`
      }`}
    >
      <div
        className={`sidebar-brand relative flex items-center ${
          collapsed ? "justify-center" : "justify-between"
        }`}
      >
        {
          !collapsed ? (
            <div className="flex items-center gap-2.5 min-w-0">
              <Logo />
              <div className="leading-none min-w-0 font-display font-semibold text-[17px] truncate">
                Local Gallery
                <span className="block font-sans text-[12.5px] font-normal text-rail-muted mt-2">
                  本地影像档案
                </span>
              </div>
            </div>
          ) : null /* 折叠态下隐藏 logo,把整行让给展开按钮 */
        }
        {/* 折叠/展开按钮:
            折叠态是用户「想找回菜单」的关键时刻 —— 按钮必须一眼可见,
            所以用亮色填充的"药丸"按钮悬浮在右缘。
            侧栏是墨黑表面,应用级 --accent 在浅色主题下也是近黑,
            压上去看不见 —— 这里用侧栏专用的 --rail-accent。
            展开态时侧边栏本来就在视野里,按钮保持低调(灰图标 + hover 背景)
            即可,避免和品牌名挤。 */}
        <button
          onClick={onToggle}
          aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          title={collapsed ? "展开侧边栏 (Ctrl+B)" : "折叠侧边栏 (Ctrl+B)"}
          className={
            collapsed
              ? "group/toggle relative z-10 inline-flex items-center gap-1 h-7 pl-2 pr-2.5 rounded-full bg-rail-accent text-rail-accent-fg shadow-md ring-1 ring-rail-accent/40 hover:ring-2 hover:ring-rail-accent/70 hover:scale-105 active:scale-95 transition-all"
              : "shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-rail-muted hover:text-rail-fg hover:bg-rail-hover transition-colors"
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

      {/* 工作台模式切换：它决定下面所有列表呈现哪一类相册。 */}
      {!collapsed && (
        <div className="px-4 pt-4">
          <ModeSwitch mode={mode} onChange={setMode} />
        </div>
      )}

      <nav ref={navRef} className="pt-5 pb-3 px-4 space-y-1.5">
        {mode === "comic"
          ? renderGroup("漫画", COMIC_GROUP, (entry) =>
              entry.to === "/unread" ? unreadCount : 0,
            )
          : renderGroup("照片", PHOTO_GROUP, () => 0)}
      </nav>

      {/* 「继续阅读」区：紧跟导航，填掉侧栏中段的空白。
          上面是"正在翻的那本"，下面是"接下来几本"。
          它只出现在漫画工作台 —— 照片这边没有阅读进度。 */}
      {!collapsed && mode === "comic" && continueCard && (
        <div className="px-4 pt-5 pb-2 min-h-0 overflow-y-auto">
          <div className="px-1 pb-2 flex items-baseline gap-2">
            <span className="text-[12.5px] text-rail-muted">
              {comicCopy().continueTitle}
            </span>
            <span className="text-[12.5px] text-rail-muted tabular-nums">
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
            <div className="px-2 pt-1.5 text-[12.5px] text-rail-muted tabular-nums">
              还有 {continueRestCount} 本没{comicCopy().finishVerb}
            </div>
          )}
        </div>
      )}

      {/* 弹性留白：把次级入口压到侧栏底部，侧栏中段即使没有内容
          也是"底部对齐"的布局，而不是内容浮在中间。 */}
      <div className="flex-1 min-h-8" />

      {/* 次级入口 + 随机：沉到底部一组，与主导航之间用一条细分隔线断开 */}
      <div className="px-4 pb-3">
        <div className="h-px bg-rail-line mb-2" />
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
                  className={`shrink-0 ${isActive ? "opacity-100" : ""}`}
                />
                {!collapsed && <span className="truncate">{it.label}</span>}
              </>
            )}
          </NavLink>
        ))}
        <button
          onClick={onShuffle}
          disabled={randomAlbum.isPending}
          title={`${copy.randomLabel} (R)`}
          className={`w-full flex items-center gap-2.5 h-9 rounded-md text-[13.5px] transition-colors ${
            collapsed ? "justify-center px-0" : "px-2.5"
          } text-rail-muted hover:bg-rail-hover hover:text-rail-fg disabled:opacity-50`}
        >
          <ShuffleIcon size={16} className="shrink-0" />
          {!collapsed && <span className="truncate">{copy.randomLabel}</span>}
        </button>

        {/* 「随机未读」原本也在这里，与「未读」页 / 首页的"随机未读"重复,
            已移除 —— 同一动作只保留一个入口。 */}
      </div>

      {!collapsed && (
        <div className="px-4 pb-3.5">
          <div className="flex items-center gap-2 text-[12.5px] text-rail-muted">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-success" />
            <span>已就绪</span>
          </div>
        </div>
      )}
    </aside>
  );
}

// 品牌方块：纯几何 + 字形，用琥珀品牌色 —— 全局唯一的彩色标记。
function Logo() {
  // 字母直接放在底板上（不再用一层绝对定位的兄弟节点盖上去）：
  // 兄弟节点的方式会让对比度检查工具读不到深色底板，把白字判成白底白字。
  return <div className="brand-mark">L</div>;
}

// 紧凑行：侧栏「继续」区里其余在读书目的单行形态。
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
      title={`${comicCopy().continueTitle}「${title}」`}
      className="w-full mt-1 rounded-md px-1 py-1 flex items-center gap-2.5 text-left transition-colors hover:bg-rail-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rail-accent"
    >
      <span className="relative w-[26px] h-[34px] shrink-0 rounded overflow-hidden bg-rail-hover block">
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
        <span className="block text-[12.5px] text-rail-fg truncate leading-tight">
          {title}
        </span>
        <span className="block text-[12.5px] text-rail-muted tabular-nums mt-0.5">
          {comicCopy().positionVerb} {index + 1} / {total}
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
      title={`${comicCopy().continueTitle}「${title}」`}
      className="mt-2 w-full rounded-lg bg-rail-hover hover:bg-rail-hover p-2 flex gap-2.5 items-center text-left transition-colors group/mini focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rail-accent"
    >
      <span className="relative w-9 h-12 shrink-0 rounded overflow-hidden bg-rail-hover block">
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
            用 --fg-muted 而不是 --fg-subtle：卡片底色是 bg-rail-hover，
            fg-subtle 在这个底上只有 4.4:1（AA 要求 4.5:1）。 */}
        <span className="block text-[13px] font-medium text-rail-fg truncate leading-tight group-hover/mini:text-rail-accent transition-colors">
          {title}
        </span>
        <span className="mt-1.5 block h-[3px] rounded-full bg-rail-hover overflow-hidden">
          <span
            className="block h-full rounded-full bg-rail-accent"
            style={{ width: `${percent}%` }}
          />
        </span>
        <span className="mt-1 block text-[12.5px] text-rail-muted tabular-nums">
          {comicCopy().positionVerb} {index + 1} / {total}
        </span>
      </span>
    </button>
  );
}
