import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { scanApi } from "../../api/scan";
import { useScanSSE } from "../../hooks/useScanSSE";
import { useKeyboard } from "../../hooks/useKeyboard";
import { useUIStore } from "../../store/uiStore";
import { libraryApi } from "../../api/library";
import { libraryQueryKeys } from "../../hooks/useLibrary";
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
  const location = useLocation();
  const sse = useScanSSE();
  const queryClient = useQueryClient();
  const pushToast = useUIStore((s) => s.pushToast);

  const onGallery = location.pathname.startsWith("/gallery");

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
    <header className="h-14 flex items-center gap-4 px-5 lg:px-7 border-b border-border-faint glass">
      {/* 左侧：极简字标（窄屏隐藏） */}
      <div className="hidden lg:flex items-center gap-2 min-w-0">
        <span className="font-display text-sm text-fg-muted">
          Local Gallery
        </span>
        <span className="text-fg-subtle/50">/</span>
        <span className="text-sm font-medium truncate">
          {titleOf(location.pathname)}
        </span>
      </div>
      {/* 窄屏：返回按钮 */}
      <div className="flex items-center gap-1 lg:hidden">
        {onOpenMobileNav && (
          <button
            type="button"
            ref={mobileMenuButtonRef}
            onClick={onOpenMobileNav}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors"
            title="打开导航"
            aria-label="打开导航"
          >
            <MenuIcon size={15} />
          </button>
        )}
        {onGallery && (
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="text-xs h-8 px-2.5 rounded-md text-fg-muted hover:bg-bg-subtle"
          >
            返回
          </button>
        )}
      </div>

      {!onGallery && (
        <div className="flex-1 max-w-[560px]">
          <GlobalSearch />
        </div>
      )}
      {onGallery && <div className="flex-1" />}

      <div className="flex items-center gap-1">
        <button
          onClick={() =>
            window.dispatchEvent(new CustomEvent("comic:open-help"))
          }
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors"
          title="快捷键帮助 (?)"
          aria-label="快捷键帮助"
        >
          <HelpIcon size={14} />
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
    </header>
  );
}

function titleOf(pathname: string): string {
  if (pathname === "/" || pathname === "") return "图像库";
  if (pathname.startsWith("/recents")) return "最近";
  if (pathname.startsWith("/favorites")) return "收藏";
  if (pathname.startsWith("/settings")) return "设置";
  if (pathname.startsWith("/albums")) return "文件夹";
  if (pathname.startsWith("/gallery")) return "浏览";
  if (pathname.startsWith("/tags")) return "标签";
  if (pathname.startsWith("/unread")) return "未读";
  return "图像";
}

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
        className="inline-flex items-center justify-center w-8 h-8 rounded-md text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors"
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
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors disabled:opacity-50"
          >
            <ScanIcon size={12} />
            <span>{scanPending ? "扫描中…" : "重新扫描"}</span>
            <span className="ml-auto text-[10px] text-fg-subtle font-mono">
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
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors"
          >
            <RefreshIcon size={12} />
            <span>刷新缓存</span>
          </button>
        </div>
      )}
    </div>
  );
}
