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
import { useHistoryCards } from "../../hooks/useHistory";
import { useAppMode } from "../../hooks/useAppMode";
import { useMediaQuery, WIDE_LAYOUT_QUERY } from "../../hooks/useMediaQuery";
import { libraryApi } from "../../api/library";
import { albumRoute, favoritesRoute, homeRoute, recentsRoute, unreadRoute } from "../../utils/path";
import { thumbUrl } from "../../api/thumbs";
import { nodeSummaryToCard } from "../../utils/libraryCard";
import type { CardData } from "../album/AlbumGrid";
import { timeAgo } from "../../utils/date";
import { comicCopy, photoCopy, workbenchCopy } from "../../utils/workbench";
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
//
// 两组的路径也各属一侧（/photo/… 与 /comic/…）：菜单项不是同一个
// 页面换了个名字，而是两套互不相干的路由。
const PHOTO_GROUP: NavEntry[] = [
  { to: homeRoute("photo"), label: "照片库", Icon: HomeIcon },
  { to: recentsRoute("photo"), label: "最近浏览", Icon: ClockIcon },
  { to: favoritesRoute("photo"), label: "收藏照片", Icon: StarIcon },
];

const COMIC_GROUP: NavEntry[] = [
  { to: homeRoute("comic"), label: "漫画库", Icon: HomeIcon },
  { to: unreadRoute(), label: "未读", Icon: SparkleIcon },
  { to: recentsRoute("comic"), label: "最近阅读", Icon: ClockIcon },
  { to: favoritesRoute("comic"), label: "收藏漫画", Icon: StarIcon },
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
  // 宽屏时模式切换在顶栏；窄屏侧栏就是抽屉，切模式留在抽屉里。
  const isWide = useMediaQuery(WIDE_LAYOUT_QUERY);
  // 未读只属于漫画工作台：照片侧栏没有未读入口，也就没有它的徽标。
  const unreadCount = useLibraryActivitySummary().data?.summary.unreadCount ?? 0;
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    navRef.current?.querySelector<HTMLElement>("a, button")?.focus();
  }, [mobileOpen]);

  const randomAlbum = useMutation({
    mutationFn: () => libraryApi.randomAlbum(mode),
    onSuccess: ({ album }) => navigate(albumRoute(mode, album.id)),
    onError: () =>
      pushToast({ kind: "info", message: "没有可随机打开的相册" }),
  });

  const onShuffle = () => {
    if (!randomAlbum.isPending) randomAlbum.mutate();
  };

  // 侧栏的「继续」区：漫画侧是在读进度，照片侧是上次打开过的那本。
  //
  // 两侧各有各的线索：漫画有页码与完成状态，照片只有访问历史。照片那边
  // 不显示进度条，也不出现「读完」字样 —— 照片没有读完这回事。
  const dashboard = useLibraryDashboard();
  const inProgress = useMemo(
    () =>
      mode === "comic"
        ? (dashboard.data?.dashboard.inProgress ?? [])
        : [],
    [dashboard.data, mode],
  );
  // 照片侧：最近看过的相册（访问历史里按当前侧收敛的那部分）。
  const resumeCards = useHistoryCards(mode, mode === "photo").cards;
  const resumeEntries = useMemo(() => {
    if (mode === "comic") {
      return inProgress.map((item) => ({
        ...nodeSummaryToCard(item.album),
        progress: { index: item.pageIndex, total: item.pageCount },
      }));
    }
    return resumeCards;
  }, [mode, inProgress, resumeCards]);
  const resumeFirst = resumeEntries[0] ?? null;
  const resumeTitle =
    mode === "comic" ? comicCopy().continueTitle : photoCopy().resumeTitle;
  const resumeCountLabel =
    mode === "comic"
      ? comicCopy().unfinishedCountLabel
      : photoCopy().resumeCountLabel;
  // 侧栏的计数单位跟着这一侧走：漫画说「卷还没读完」，
  // 照片说「本相册」。

  // 选中态：比侧栏亮一档的灰块 + 白字。
  // 侧栏是墨黑表面，选中态靠明度差而不是色相来区分，
  // 整条导航才不会被第二个颜色带跑。
  const navItemClass = (isActive: boolean) =>
    `nav-entry group ${collapsed ? "nav-entry--compact" : ""} ${isActive ? "is-active" : ""}`;

  // 选中态：路径完全相等才算命中。
  //
  // 两个模式的路径互为前缀（/photo 与 /photo/recents），用 startsWith
  // 会让「照片库」和「最近浏览」同时亮起来。首页是精确匹配，
  // 其余条目靠前缀命中（/photo/albums/… 归属于相册入口）。
  const isEntryActive = (entry: NavEntry) =>
    entry.to === homeRoute(mode)
      ? location.pathname === entry.to
      : location.pathname.startsWith(entry.to);

  const renderGroup = (
    title: string,
    group: NavEntry[],
    badgeFor: (entry: NavEntry) => number,
  ) => {
    return (
      <div className="mt-5 first:mt-0">
        {/* 折叠态不挂分组名：72px 的栏里「照片」两个字会竖着叠成两行，
            像渲染事故而不是标题。折叠后每个入口都有图标与提示，够了。 */}
        {!collapsed && (
          <div className="px-4 pb-1 flex items-center gap-2">
            <span className="text-meta tracking-wide transition-colors text-rail-fg">
              {title}
            </span>
          </div>
        )}
        {group.map((entry) => {
          const isActive = isEntryActive(entry);
          const badge = badgeFor(entry);
          return (
            <Link
              key={`${entry.to}-${entry.label}`}
              to={entry.to}
              className={navItemClass(isActive)}
              aria-current={isActive ? "page" : undefined}
              title={`${entry.label}${badge > 0 ? ` · 还有 ${badge} ${copy.collectionUnit}` : ""}`}
            >
              <entry.Icon size={16} className="shrink-0" />
              {!collapsed && <span className="truncate">{entry.label}</span>}
              {!collapsed && badge > 0 && (
                <span
                  className="inline-flex items-center justify-center min-w-[22px] h-[20px] px-1.5 rounded-full bg-rail-hover text-rail-fg text-meta font-semibold tabular-nums"
                  aria-label={`还有 ${badge} ${copy.collectionUnit}`}
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
          collapsed ? "justify-center px-2" : "justify-between"
        }`}
      >
        {
          !collapsed ? (
            <div className="flex items-center gap-2.5 min-w-0">
              <Logo />
              <div className="leading-none min-w-0 font-display font-semibold text-label truncate">
                Local Gallery
                <span className="block font-sans text-meta font-normal text-rail-muted mt-2">
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
              ? "group/toggle relative z-10 inline-flex items-center gap-0.5 h-7 pl-1.5 pr-2 whitespace-nowrap rounded-full bg-rail-accent text-rail-accent-fg shadow-md ring-1 ring-rail-accent/40 hover:ring-2 hover:ring-rail-accent/70 hover:scale-105 active:scale-95 transition-all"
              : "shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-rail-muted hover:text-rail-fg hover:bg-rail-hover transition-colors"
          }
        >
          {collapsed ? (
            <>
              <ChevronRightIcon
                size={12}
                className="transition-transform group-hover/toggle:translate-x-0.5"
              />
              {/* 折叠态只有 72px 宽：字压到 11.5px 并禁止换行，
                  否则「展开」会折成两行、被 60px 高的品牌栏裁掉一半。 */}
              <span className="text-badge font-semibold tracking-wide whitespace-nowrap">
                展开
              </span>
            </>
          ) : (
            <ChevronLeftIcon size={14} />
          )}
        </button>
      </div>

      {/* 工作台模式切换：宽屏时它在顶栏左槽（与全局动作同层），
          窄屏顶栏放不下，改为留在这里 —— 侧栏在窄屏就是抽屉，
          打开抽屉即可切模式。两处互斥，DOM 里始终只有一份。 */}
      {!isWide && (
        <div className="px-4 pt-4">
          <ModeSwitch mode={mode} onChange={setMode} />
        </div>
      )}

      <nav ref={navRef} className="pt-5 pb-3 px-4 space-y-1.5">
        {mode === "comic"
          ? renderGroup("漫画", COMIC_GROUP, (entry) =>
              entry.to === unreadRoute() ? unreadCount : 0,
            )
          : renderGroup("照片", PHOTO_GROUP, () => 0)}
      </nav>

      {/* 「继续」区：紧跟导航，填掉侧栏中段的空白。
          漫画侧是"正在翻的那本"，照片侧是"上次打开的那本"。
          两侧的措辞与线索各自成套，不共用一套词。

          这里只留当前这一本：完整列表由首页的首屏专区与「最近浏览 /
          最近阅读」页承担。侧栏再挂一份，既重复又把侧栏中段塞满。 */}
      {!collapsed && resumeFirst && (
        <div className="px-4 pt-5 pb-2 min-h-0">
          <div className="px-1 pb-2 flex items-baseline gap-2">
            <span className="text-meta text-rail-muted">{resumeTitle}</span>
            <span className="text-meta text-rail-muted tabular-nums">
              {resumeEntries.length} {resumeCountLabel}
            </span>
          </div>
          <ResumeMiniCard
            card={resumeFirst}
            onOpen={() => navigate(continueReadingTarget(resumeFirst))}
          />
          {resumeEntries.length > 1 && (
            <Link
              to={recentsRoute(mode)}
              className="mt-2 flex min-h-7 items-center gap-1 px-1 text-meta text-rail-muted hover:text-rail-fg transition-colors"
            >
              <span>
                还有 {resumeEntries.length - 1}{" "}
                {mode === "comic"
                  ? `${copy.collectionUnit}没${comicCopy().finishVerb}`
                  : "本相册"}
              </span>
              <ChevronRightIcon size={11} />
            </Link>
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
          className={`w-full flex items-center gap-2.5 h-9 rounded-md text-body transition-colors ${
            collapsed ? "justify-center px-0" : "px-2.5"
          } text-rail-muted hover:bg-rail-hover hover:text-rail-fg disabled:opacity-50`}
        >
          <ShuffleIcon size={16} className="shrink-0" />
          {!collapsed && <span className="truncate">{copy.randomLabel}</span>}
        </button>

        {/* 「随机未读」原本也在这里，与「未读」页 / 首页的"随机未读"重复,
            已移除 —— 同一动作只保留一个入口。 */}
      </div>
    </aside>
  );
}

// 品牌方块：纯几何 + 字形，用琥珀品牌色 —— 全局唯一的彩色标记。
function Logo() {
  // 字母直接放在底板上（不再用一层绝对定位的兄弟节点盖上去）：
  // 兄弟节点的方式会让对比度检查工具读不到深色底板，把白字判成白底白字。
  return <div className="brand-mark">L</div>;
}

// 「接着看 / 继续读」迷你卡：侧栏常驻的那一条。
//
// 版式参照播放器的"正在播放"条：左侧封面缩略图 + 右侧标题与线索。
// 漫画侧点击回到上次看到的那一页，照片侧点击回到那本相册。
function ResumeMiniCard({
  card,
  onOpen,
}: {
  card: CardData;
  onOpen: () => void;
}) {
  const isComic = card.contentKind === "comic";
  const title = card.displayTitle ?? card.title;
  const percent = readingPercent({
    index: card.progress?.index ?? 0,
    total: card.progress?.total ?? 0,
  });
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${resumeLabel(card)}「${title}」`}
      className="mt-2 w-full rounded-lg bg-rail-hover hover:bg-rail-hover p-2 flex gap-2.5 items-center text-left transition-colors group/mini focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rail-accent"
    >
      <span
        className={`relative shrink-0 overflow-hidden bg-rail-hover block ${
          isComic ? "album-thumb--book w-9 h-12" : "rounded-md w-11 h-11"
        }`}
      >
        {card.coverPath ? (
          <img
            src={thumbUrl(card.coverPath)}
            alt=""
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover object-[50%_30%]"
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        {/* 标题直接起排：外层分组标题已经写了这一区的名字，
            这里再写一遍是重复信息。
            用 --fg-muted 而不是 --fg-subtle：卡片底色是 bg-rail-hover，
            fg-subtle 在这个底上只有 4.4:1（AA 要求 4.5:1）。 */}
        <span className="block text-body font-medium text-rail-fg truncate leading-tight group-hover/mini:text-rail-accent transition-colors">
          {title}
        </span>
        {/* 轨道与页码并排：轨道横贯整列时读作一条分隔线，
           压在书名下面尤其像下划线。缩到一截，跟页码并排，
           才读得出「进度条 + 读到哪里」。 */}
        <span className="mt-1.5 flex items-center gap-2 min-w-0">
          {/* 轨道只在真翻过几页时出现：一条永远空着的轨道在侧栏
              这一小块地方读起来就是一道多余的横线。「还没翻开」
              已经由标题行的未读标记承担。 */}
          {isComic && percent > 0 && (
            /* 轨道用半透明白：卡片底色本身就是 --rail-hover，
               轨道再用同一个色就等于没画，空的部分根本看不见。 */
            <span className="h-[3px] w-14 shrink-0 rounded-full bg-white/15 overflow-hidden">
              <span
                className="block h-full rounded-full bg-rail-accent"
                style={{ width: `${percent}%` }}
              />
            </span>
          )}
          <span className="text-meta text-rail-muted tabular-nums truncate">
            {resumeHint(card)}
          </span>
        </span>
      </span>
    </button>
  );
}

// 这一条属于哪一侧的动作名：漫画「继续阅读」，照片「接着看」。
function resumeLabel(card: CardData): string {
  return card.contentKind === "comic"
    ? comicCopy().continueTitle
    : photoCopy().resumeTitle;
}

// 这一条属于哪一侧的线索文案。
//
// 漫画给页码进度，照片给「上次浏览」的时间 —— 照片没有阅读位置，
// 说不出「读到第几张」。
function resumeHint(card: CardData): string {
  if (card.contentKind === "comic") {
    return `${comicCopy().positionVerb} ${(card.progress?.index ?? 0) + 1} / ${
      card.progress?.total ?? 0
    }`;
  }
  return card.lastSeenAt
    ? `${photoCopy().resumeLastSeenLabel} ${timeAgo(card.lastSeenAt)}`
    : photoCopy().resumeCountLabel;
}
