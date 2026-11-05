import { lazy, Suspense, type ComponentType } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import AppShell from "./components/layout/AppShell";
import RouteLoading from "./components/common/RouteLoading";
import AccessGate from "./components/auth/AccessGate";
import ErrorBoundary from "./components/common/ErrorBoundary";
import ToastViewport from "./components/common/Toast";
import { useTheme } from "./hooks/useTheme";
import { useAppMode, useAppModeHydration } from "./hooks/useAppMode";
import { useLibraryActivitySync } from "./hooks/useLibrary";
import { homeRoute, MODE_PREFIX, MODE_ROUTE_PATHS } from "./utils/path";
import type { AppMode } from "./api/library";

const Home = lazy(() => import("./routes/Home"));
const Recents = lazy(() => import("./routes/Recents"));
const Favorites = lazy(() => import("./routes/Favorites"));
const Unread = lazy(() => import("./routes/Unread"));
const Album = lazy(() => import("./routes/Album"));
const Tag = lazy(() => import("./routes/Tag"));
const Reader = lazy(() => import("./routes/Reader"));
const Settings = lazy(() => import("./routes/Settings"));

function lazyPage(Page: ComponentType) {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Page />
    </Suspense>
  );
}

// 两个工作台各有一套同名页面。路径表只有一份，内容随模式前缀走：
// 照片侧与漫画侧的「最近 / 收藏 / 相册 / 标签」是同一批组件，
// 差别在数据源与措辞，由 workbench.ts 统一收口。
//
// 路径清单只有一个来源（utils/path.ts 的 MODE_ROUTE_PATHS）：子路径自带
// 前导斜杠，完整路径 = 模式前缀 + 子路径。少一个斜杠就会拼出
// "/photoalbums/*" 这种匹配不上的路径 —— 首页能开，点进相册却落回兜底。
const MODE_ROUTE_ELEMENTS: Record<
  (typeof MODE_ROUTE_PATHS)[number],
  ComponentType
> = {
  "": Home,
  "/recents": Recents,
  "/favorites": Favorites,
  "/albums/*": Album,
  "/tags/*": Tag,
};

const MODES: AppMode[] = ["photo", "comic"];

export default function App() {
  useTheme();
  // 工作台偏好来自服务端：先水合，根路径才知道该落到哪一侧。
  useAppModeHydration();
  useLibraryActivitySync();
  return (
    <AccessGate>
      {/* 阅读器（/comic/read）不挂在 AppShell 下，没有内层错误边界；
          这里再兜一层，渲染异常时至少给出提示和重试，而不是整页空白。 */}
      <ErrorBoundary>
        <Routes>
          <Route element={<AppShell />}>
            {MODES.flatMap((mode) =>
              MODE_ROUTE_PATHS.map((path) => (
                <Route
                  key={`${MODE_PREFIX[mode]}${path}`}
                  path={`${MODE_PREFIX[mode]}${path}`}
                  element={lazyPage(MODE_ROUTE_ELEMENTS[path])}
                />
              )),
            )}
            {/* 未读只属于漫画工作台：照片侧没有这个页面，路由表里也不注册。 */}
            <Route path="/comic/unread" element={lazyPage(Unread)} />
            <Route path="/settings" element={lazyPage(Settings)} />
          </Route>
          {/* 漫画阅读器：/comic/read/<album id>。它不在 AppShell 下，
              没有侧栏也没有工具栏，沉浸在一张画布里。 */}
          <Route path="/comic/read/:albumId" element={lazyPage(Reader)} />
          {/* 根路径按服务端偏好落到某一侧；旧链接统一落到这里。 */}
          <Route path="/" element={<ModeHomeRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
      <ToastViewport />
    </AccessGate>
  );
}

/**
 * 根路径重定向：按服务端记住的偏好落到照片侧或漫画侧。
 *
 * 偏好还没回来之前不能急着跳——那会把漫画用户丢进照片库。
 */
function ModeHomeRedirect() {
  const { mode, ready } = useAppMode();
  if (!ready) return <RouteLoading />;
  return <Navigate to={homeRoute(mode)} replace />;
}
