import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useUIStore } from "../../store/uiStore";
import { useKeyboard } from "../../hooks/useKeyboard";
import { albumRoute, decodePathTail, favoritesRoute, homeRoute, isReaderPath, recentsRoute, unreadRoute } from "../../utils/path";
import { workbenchCopy } from "../../utils/workbench";
import { useFsCapabilities } from "../../hooks/useFsCapabilities";
import { useAppMode } from "../../hooks/useAppMode";
import { scanApi } from "../../api/scan";
import { useScanSSE } from "../../hooks/useScanSSE";
import Sidebar from "./Sidebar";
import Toolbar from "./Toolbar";
import ScanProgress from "../album/ScanProgress";
import HelpOverlay from "../common/HelpOverlay";
import ErrorBoundary from "../common/ErrorBoundary";
import { libraryApi } from "../../api/library";

// 应用外壳：侧边栏 + 工具栏 + 主内容。
// 全局帮助浮层通过 comic:open-help 事件触发（所有页面 ? 都能唤起）。
export default function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const pushToast = useUIStore((s) => s.pushToast);
  const { mode } = useAppMode();
  const immersiveOverlay = useUIStore((s) => s.immersiveOverlay);
  const helpContext = useUIStore((s) => s.helpContext);
  const [helpOpen, setHelpOpen] = useState(false);
  const [isCancellingScan, setIsCancellingScan] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const wasMobileNavOpen = useRef(false);
  // 阅读器（/read）占用单键快捷键：r 是旋转，u 不是「未读」。
  // 大图预览（照片墙上的浮层）同样占用单键：它自己处理方向键与缩放，
  // 全局的 r / u 必须在它打开时让位，否则按 r 会一边旋转一边跳走整页。
  const immersive = isReaderPath(location.pathname) || immersiveOverlay;
  // 扫描进度 + 取消（提升到 AppShell 后所有路由都能看到顶部进度条）
  const scanSse = useScanSSE();
  useFsCapabilities();

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileNavOpen) {
      if (wasMobileNavOpen.current) mobileMenuButtonRef.current?.focus();
      wasMobileNavOpen.current = false;
      return;
    }
    wasMobileNavOpen.current = true;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileNavOpen]);

  useEffect(() => {
    const titles: Record<string, string> = {
      [homeRoute(mode)]: mode === "comic" ? "漫画库" : "照片库",
      [recentsRoute(mode)]: mode === "comic" ? "最近阅读" : "最近浏览",
      [favoritesRoute(mode)]: mode === "comic" ? "收藏漫画" : "收藏照片",
      [unreadRoute()]: "未读",
      "/settings": "设置",
    };
    const path = location.pathname;
    let base = titles[path];
    if (base === undefined) {
      if (path.includes("/tags/")) {
        // 标签段只解码一次：路径里可能是字面 %xx。
        const raw = decodePathTail(path, "/tags/");
        base = raw || "标签";
      } else {
        base = workbenchCopy(mode).albumTypeLabel;
      }
    }
    document.title = `${base} · Local Gallery`;
  }, [location.pathname, mode]);

  useEffect(() => {
    const fn = () => setHelpOpen(true);
    window.addEventListener("comic:open-help", fn as EventListener);
    return () =>
      window.removeEventListener("comic:open-help", fn as EventListener);
  }, []);

  const randomAlbum = useMutation({
    mutationFn: () => libraryApi.randomAlbums(mode),
    onSuccess: ({ albums }) => {
      const album = albums[0];
      if (album) navigate(albumRoute(mode, album.id));
    },
    onError: () => pushToast({ kind: "info", message: "没有可随机打开的相册" }),
  });

  const goShuffle = () => {
    if (!randomAlbum.isPending) randomAlbum.mutate();
  };

  const cancelScan = useCallback(async () => {
    if (!scanSse.scanId || isCancellingScan) return;

    setIsCancellingScan(true);
    try {
      await scanApi.cancel(scanSse.scanId);
      pushToast({ kind: "info", message: "已请求取消扫描" });
    } catch {
      pushToast({ kind: "error", message: "取消扫描失败，请稍后重试" });
    } finally {
      setIsCancellingScan(false);
    }
  }, [isCancellingScan, pushToast, scanSse.scanId]);

  useKeyboard({
    "ctrl+b": () => toggleSidebar(),
    "ctrl+h": () => navigate(homeRoute(mode)),
    "ctrl+d": () => navigate(favoritesRoute(mode)),
    "ctrl+,": () => navigate("/settings"),
    "ctrl+r": () => navigate(recentsRoute(mode)),
    "?": () => setHelpOpen((v) => !v),
    "/": () => {
      const el = document.querySelector<HTMLInputElement>(
        'input[placeholder^="搜索"]',
      );
      el?.focus();
    },
    // 随机一卷：仅在非沉浸场景生效（阅读器与大图预览的 r 有别的含义）
    r: () => {
      if (immersive) return;
      goShuffle();
    },
    // U → 未读页（未读只属于漫画工作台）
    u: () => {
      if (immersive || mode !== "comic") return;
      navigate(unreadRoute());
    },
  });

  return (
    <div className="app-shell flex h-full bg-bg">
      <Sidebar
        collapsed={mobileNavOpen ? false : sidebarCollapsed}
        onToggle={toggleSidebar}
        mobileOpen={mobileNavOpen}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <Toolbar
          onOpenMobileNav={() => setMobileNavOpen(true)}
          mobileMenuButtonRef={mobileMenuButtonRef}
        />
        <main className="app-main flex-1 overflow-auto">
          {/* 路由层错误兜底:任意子组件 render 抛错都不会让整个 SPA 白屏。 */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="关闭导航"
          onClick={() => setMobileNavOpen(false)}
          className="fixed inset-0 z-40 bg-black/30 lg:hidden"
        />
      )}
      {/*
        扫描进度卡：左下角浮动卡（fixed，相对 viewport）。
        必须在 <main> 外面，否则会被 main 的 overflow-auto 影响 sticky/fixed 行为。
        scanSse.startWith 由 Toolbar 在用户触发「重新扫描」/ Ctrl+S 时写 store.scanId。
      */}
      <ScanProgress
        progress={scanSse.progress}
        onCancel={cancelScan}
        isCancelling={isCancellingScan}
        connectionState={scanSse.connectionState}
        onReconnect={scanSse.reconnect}
        onStopTracking={scanSse.reset}
      />
      <HelpOverlay
        context={helpContext}
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
      />
    </div>
  );
}
