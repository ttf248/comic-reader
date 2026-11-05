import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { scanApi } from "../../api/scan";
import { useScanSSE } from "../../hooks/useScanSSE";
import { useKeyboard } from "../../hooks/useKeyboard";
import { useUIStore } from "../../store/uiStore";
import { useAppMode } from "../../hooks/useAppMode";
import { libraryApi } from "../../api/library";
import { libraryQueryKeys, useLibraryManifest } from "../../hooks/useLibrary";
import { useMediaQuery, WIDE_LAYOUT_QUERY } from "../../hooks/useMediaQuery";
import ThemeSwitcher from "../common/ThemeSwitcher";
import GlobalSearch from "../common/GlobalSearch";
import ModeSwitch from "./ModeSwitch";
import {
  MoreHorizontalIcon,
  RefreshIcon,
  HelpIcon,
  MenuIcon,
  AlertIcon,
} from "../common/Icon";

// 顶部工具栏：
//   左侧：工作台模式（照片 / 漫画）
//   中部：全局搜索
//   右侧：扫描告警 / 帮助 / 主题 / 更多(刷新缓存)
//
// 排序 / 视图模式 / 视图 chips 已迁移到各 list 页面的 filter strip,
//  让 toolbar 只承担"全局动作"职责,避免挤 7+ 控件。
//
// 媒体库规模不再常驻顶栏：它和页头的「上次更新」是同一组上下文，
// 放在页头才是它的语境。底部状态栏也已移除 —— 它的「就绪」是填充
// 文案，秒级时钟对一个本地媒体库没有意义，而扫描进度本来就由
// 左下角的 ScanProgress 浮卡负责。
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

  // 沉浸场景（照片墙的大图预览）里，顶栏的搜索会与浮层抢注意力，
  // 收起来更干净。阅读器整屏脱离 AppShell，不经过这里。
  const immersiveOverlay = useUIStore((s) => s.immersiveOverlay);
  const onGallery = immersiveOverlay;
  const manifest = useLibraryManifest().data?.manifest;
  const warningCount = manifest?.statistics.warningCount ?? 0;
  const { mode, setMode } = useAppMode();
  // 宽屏时模式切换在顶栏；窄屏顶栏放不下，改为在侧栏抽屉里。
  const isWide = useMediaQuery(WIDE_LAYOUT_QUERY);

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

        {/* 左槽：工作台模式。
            它原来在侧栏品牌区下方。搬到顶栏有三个好处：侧栏因此只
            剩「品牌 + 本工作台的入口」，模式切换与全局动作同属一层；
            侧栏折叠成 72px 时模式切换不再被挤成两枚图标；
            顶栏左槽也就不必再塞一份和页头重复的库规模。 */}
        {!onGallery && isWide && (
          <div className="shrink-0 mr-4">
            <ModeSwitch mode={mode} onChange={setMode} tone="surface" />
          </div>
        )}

        {/* 中槽：搜索。整条顶栏里它是最主要的功能，左对齐放在模式切换
            之后；动作组靠右。 */}
        {!onGallery && (
          <div className="flex-1 min-w-0 flex justify-start">
            <div className="w-full max-w-[620px]">
              <GlobalSearch />
            </div>
          </div>
        )}
        {onGallery && <div className="flex-1 min-w-0" />}

        <div className="flex items-center gap-1 shrink-0 ml-auto">
          {/* 扫描问题：全局条件，平时没有，只有真有未读干净的目录时才出现。
              点进去是设置页里的扫描告警明细。 */}
          {warningCount > 0 && (
            <Link
              to="/settings"
              className="inline-flex items-center gap-1 h-9 px-2.5 rounded-md text-meta text-warning hover:bg-bg-subtle transition-colors"
              title="扫描完成但有部分目录或媒体未能完整读取"
            >
              <AlertIcon size={13} />
              <span className="tabular-nums">{warningCount}</span>
            </Link>
          )}
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
              onRefresh={() =>
                void queryClient.invalidateQueries({
                  queryKey: libraryQueryKeys.root,
                })
              }
            />
          )}
        </div>
      </div>
    </header>
  );
}

// 说明：页面标题由各路由自己渲染（page-title 样式），顶栏不再重复展示
// 面包屑，避免同一信息出现两次、顶部白白占掉一块高度。

// kebab 菜单: 刷新缓存。
//
// 「重新扫描」不在这里：它已经有一个始终可见的入口（页头右上角），
// 外加 Ctrl+S。三个入口做同一件事，多出来的那个只会在菜单深处
// 增加一次"这个菜单里到底有什么"的猜测。
function MoreMenu({ onRefresh }: { onRefresh: () => void }) {
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
