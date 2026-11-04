import { lazy, Suspense, type ComponentType } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import AppShell from "./components/layout/AppShell";
import RouteLoading from "./components/common/RouteLoading";
import AccessGate from "./components/auth/AccessGate";
import ErrorBoundary from "./components/common/ErrorBoundary";
import ToastViewport from "./components/common/Toast";
import { useTheme } from "./hooks/useTheme";
import { useAppModeHydration } from "./hooks/useAppMode";
import { useLibraryActivitySync } from "./hooks/useLibrary";

const Home = lazy(() => import("./routes/Home"));
const Recents = lazy(() => import("./routes/Recents"));
const Favorites = lazy(() => import("./routes/Favorites"));
const Unread = lazy(() => import("./routes/Unread"));
const Album = lazy(() => import("./routes/Album"));
const Tag = lazy(() => import("./routes/Tag"));
const Reader = lazy(() => import("./routes/Reader"));
const LegacyGalleryRedirect = lazy(
  () => import("./routes/LegacyGalleryRedirect"),
);
const Settings = lazy(() => import("./routes/Settings"));

function lazyPage(Page: ComponentType) {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Page />
    </Suspense>
  );
}

export default function App() {
  useTheme();
  // 工作台模式来自服务端偏好：先水合，列表查询才知道该按哪种用途收敛。
  useAppModeHydration();
  useLibraryActivitySync();
  return (
    <AccessGate>
      {/* 阅读器（/read）不挂在 AppShell 下，没有内层错误边界；
          这里再兜一层，渲染异常时至少给出提示和重试，而不是整页空白。 */}
      <ErrorBoundary>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={lazyPage(Home)} />
            <Route path="/recents" element={lazyPage(Recents)} />
            <Route path="/favorites" element={lazyPage(Favorites)} />
            <Route path="/unread" element={lazyPage(Unread)} />
            <Route path="/albums/*" element={lazyPage(Album)} />
            <Route path="/tags/*" element={lazyPage(Tag)} />
            <Route path="/settings" element={lazyPage(Settings)} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
          {/* 漫画阅读器：/read/<album id>。它不在 AppShell 下，
              没有侧栏也没有工具栏，沉浸在一张画布里。 */}
          <Route path="/read/:albumId" element={lazyPage(Reader)} />
          {/* 旧链接（/gallery?path=…）仍然可用，重定向到新地址。 */}
          <Route path="/gallery/*" element={lazyPage(LegacyGalleryRedirect)} />
        </Routes>
      </ErrorBoundary>
      <ToastViewport />
    </AccessGate>
  );
}
