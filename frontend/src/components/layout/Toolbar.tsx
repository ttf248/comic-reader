import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { scanApi } from "../../api/scan";
import { useScanSSE } from "../../hooks/useScanSSE";
import { useKeyboard } from "../../hooks/useKeyboard";
import { useUIStore } from "../../store/uiStore";
import { useAppMode } from "../../hooks/useAppMode";
import { libraryApi } from "../../api/library";
import { libraryQueryKeys, useLibraryManifest } from "../../hooks/useLibrary";
import ThemeSwitcher from "../common/ThemeSwitcher";
import GlobalSearch from "../common/GlobalSearch";
import {
  ScanIcon,
  MoreHorizontalIcon,
  RefreshIcon,
  HelpIcon,
  MenuIcon,
} from "../common/Icon";

// 顶部工具栏（精简后）：
//   左侧：极简字标
//   中部：全局搜索
//   右侧：主题 / 帮助 / 更多(扫描 + 刷新缓存)
//
// 排序 / 视图模式 / 视图 chips 已迁移到各 list 页面的 filter strip,
//  让 toolbar 只承担"全局信息 + 主题"职责,避免挤 7+ 控件。
export default function Toolbar({
  onOpenMobileNav,
  mobileMenuButtonRef,
}: {
  onOpenMobileNav?: () => void;
  mobileMenuButtonRef?: RefObject<HTMLButtonElement>;
}) {
  const navigate = useNavigate();
  const sse = useScanSSE();
  const queryClient = useQueryClient();
  const pushToast = useUIStore((s) => s.pushToast);

  // 沉浸场景（照片墙的大图预览）里，顶栏的搜索与库规模会与浮层抢注意力，
  // 收起来更干净。阅读器整屏脱离 AppShell，不经过这里。
  const immersiveOverlay = useUIStore((s) => s.immersiveOverlay);
  const onGallery = immersiveOverlay;
  // 媒体库规模：放在顶栏左槽，作为全局上下文（底部状态栏不再重复）。
  // 规模按当前工作台算：这一侧只有多少相册、多少集合。
  const manifest = useLibraryManifest().data?.manifest;
  const { mode } = useAppMode();
  const libraryContext = manifest
    ? mode === "comic"
      ? `${manifest.statistics.comicAlbumCount ?? 0} 本漫画 · ${manifest.statistics.comicCollectionCount ?? 0} 个集合`
      : `${manifest.statistics.photoAlbumCount ?? 0} 本相册 · ${manifest.statistics.photoCollectionCount ?? 0} 个集合`
    : "";

  const startScan = useMutation({
    mutationFn: () => scanApi.start(),
    onSuccess: (r) => {
      sse.startWith(r.scanId);
      pushToast({ kind: "info", message: "扫描已开始" });
    },
    onError: () => pushToast({ kind: "error", message: "启动扫描失败" }),
  });

  // Ctrl+S 全局触发扫描 — 走 useKeyboard 让 SHORTCUTS 表与实际行为
  // 始终一致;输入框优先跳过(由 useKeyboard 内置,避免与浏览器
  // 「保存网页」冲突)。
  useKeyboard({
    "ctrl+s": () => {
      if (!startScan.isPending && !sse.isRunning) startScan.mutate();
    },
  });

  useEffect(() => {
    if (!sse.isComplete || !sse.scanId) return;
    void queryClient.invalidateQueries({ queryKey: libraryQueryKeys.root });
    void queryClient
      .fetchQuery({
        queryKey: libraryQueryKeys.manifest(),
        queryFn: () => libraryApi.manifest(),
      })
      .then((response) => {
        pushToast({
          kind: "success",
          message: `扫描完成 · 共 ${response.manifest.statistics.albumCount} 本相册`,
        });
      })
      .catch(() => pushToast({ kind: "error", message: "刷新媒体库失败" }));
  }, [queryClient, sse.isComplete, sse.scanId, pushToast]);

  return (
    // 当前顶栏内层复用 .page-shell；可随导航与页面布局方案调整。
    //
    // relative z-30：顶栏里的下拉（搜索结果、更多菜单）要盖住正文。
    // 顶栏带 backdrop-blur，本身已经是一个层叠上下文，面板里的 z-30
    // 只在顶栏内部有效 —— 正文在 DOM 里排在顶栏之后，会把面板下半截
    // 盖掉（实测搜索结果的第 4、5 条被正文的封面压住）。
    <header className="app-toolbar relative z-30">
      <div className="page-shell h-full flex items-center gap-2 sm:gap-3">
        {/* 窄屏：导航 / 返回 */}
        <div className="flex items-center gap-1 lg:hidden shrink-0">
          {onOpenMobileNav && (
            <button
              type="button"
              ref={mobileMenuButtonRef}
              onClick={onOpenMobileNav}
              className="inline-flex items-center justify-center w-9 h-9 rounded-md text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors"
              title="打开导航"
              aria-label="打开导航"
            >
              <MenuIcon size={16} />
            </button>
          )}
          {onGallery && (
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="inline-flex items-center h-9 px-3 rounded-md text-body text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors"
            >
              返回
            </button>
          )}
        </div>

        {/* 左槽：全局上下文（媒体库规模）。
            旧版顶栏只有"搜索 + 右侧三个图标"，中间空出六七百像素，
            看起来像被遗弃的控件区。把库规模放进左槽、搜索居中、
            动作靠右，顶栏才是一个有结构的应用栏。 */}
        {!onGallery && (
          <div className="hidden xl:block shrink-0 mr-8">
            <span className="toolbar-caption mb-1">我的媒体库</span>
            <span className="text-meta text-fg-muted tabular-nums">
              {libraryContext}
            </span>
          </div>
        )}
        {onGallery && <div className="hidden lg:block shrink-0" />}

        {/* 中槽：搜索。居中放置，和左右两槽形成对称。 */}
        {!onGallery && (
          <div className="flex-1 min-w-0 flex justify-start">
            <div className="w-full max-w-[620px]">
              <GlobalSearch />
            </div>
          </div>
        )}
        {onGallery && <div className="flex-1 min-w-0" />}

        <div className="flex items-center gap-1 shrink-0 ml-auto">
          <button
            onClick={() =>
              window.dispatchEvent(new CustomEvent("comic:open-help"))
            }
            className="inline-flex items-center justify-center w-9 h-9 rounded-md text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors"
            title="快捷键帮助 (?)"
            aria-label="快捷键帮助"
          >
            <HelpIcon size={15} />
          </button>
          <ThemeSwitcher compact />
          {!onGallery && (
            <MoreMenu
              onScan={() => startScan.mutate()}
              onRefresh={() =>
                void queryClient.invalidateQueries({
                  queryKey: libraryQueryKeys.root,
                })
              }
              scanPending={startScan.isPending || sse.isRunning}
            />
          )}
        </div>
      </div>
    </header>
  );
}

// 说明：页面标题由各路由自己渲染（page-title 样式），顶栏不再重复展示
// 面包屑，避免同一信息出现两次、顶部白白占掉一块高度。

// kebab 菜单: 扫描 + 刷新缓存
// 收纳了原来 toolbar 上两个独立的次级按钮,让 toolbar 更克制。
function MoreMenu({
  onScan,
  onRefresh,
  scanPending,
}: {
  onScan: () => void;
  onRefresh: () => void;
  scanPending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        ref.current
          ?.querySelector<HTMLButtonElement>(
            'button[aria-haspopup="menu"], button',
          )
          ?.focus();
      }
      wasOpenRef.current = false;
      return;
    }
    wasOpenRef.current = true;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const timer = window.setTimeout(() => {
      window.addEventListener("mousedown", onClick);
      window.addEventListener("keydown", onKey);
    }, 0);
    menuRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        type="button"
        className="inline-flex items-center justify-center w-9 h-9 rounded-md text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors"
        title="更多"
        aria-label="更多"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontalIcon size={16} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="更多操作"
          className="absolute right-0 top-full mt-1.5 min-w-[180px] bg-bg-elevated border border-border rounded-lg shadow-lg py-1 z-40 fade-up"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onScan();
            }}
            disabled={scanPending}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-body text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors disabled:opacity-50"
          >
            <ScanIcon size={12} />
            <span>{scanPending ? "扫描中…" : "重新扫描"}</span>
            <span className="ml-auto text-badge text-fg-subtle font-mono">
              Ctrl+S
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onRefresh();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-body text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors"
          >
            <RefreshIcon size={12} />
            <span>刷新缓存</span>
          </button>
        </div>
      )}
    </div>
  );
}
