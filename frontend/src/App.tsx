import { lazy, Suspense, type ComponentType } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import AppShell from "./components/layout/AppShell";
import RouteLoading from "./components/common/RouteLoading";
import AccessGate from "./components/auth/AccessGate";
import ToastViewport from "./components/common/Toast";
import { useTheme } from "./hooks/useTheme";

const Home = lazy(() => import("./routes/Home"));
const Recents = lazy(() => import("./routes/Recents"));
const Favorites = lazy(() => import("./routes/Favorites"));
const Unread = lazy(() => import("./routes/Unread"));
const Album = lazy(() => import("./routes/Album"));
const Tag = lazy(() => import("./routes/Tag"));
const Gallery = lazy(() => import("./routes/Gallery"));
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
  return (
    <AccessGate>
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
        <Route path="/gallery/*" element={lazyPage(Gallery)} />
      </Routes>
      <ToastViewport />
    </AccessGate>
  );
}
