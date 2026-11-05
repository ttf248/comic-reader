import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppModeStore } from "../../store/appModeStore";
import { counterpartRoute, modeFromPath } from "../../utils/path";
import {
  WorkbenchModeContext,
  type WorkbenchModeValue,
} from "../../hooks/useAppMode";
import type { AppMode } from "../../api/library";

/**
 * 工作台模式的提供者。
 *
 * 模式由 URL 路径前缀决定（`/photo` / `/comic`），服务端偏好只在根路径
 * 落哪一侧时起作用。URL 是唯一真相源：切模式就是一次普通导航，浏览器
 * 前进后退能跨模式，深链也能直接分享。
 *
 * 它挂在应用最外层（main.tsx），因此连整屏脱离外壳的漫画阅读器也在
 * 这套上下文里。
 */
export default function WorkbenchModeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const preference = useAppModeStore((s) => s.preference);
  const hydrated = useAppModeStore((s) => s.hydrated);
  const switchPreference = useAppModeStore((s) => s.switchPreference);

  const routeMode = modeFromPath(location.pathname);
  // 路径没落在某一侧时（根路径、设置页）回落到偏好。
  const mode = routeMode ?? preference;
  // 路径已经指明一侧时不必等偏好：水合只是落地页的落点。
  const ready = routeMode !== null || hydrated;

  // 路径与模式放进 ref：setMode 因此保持稳定，普通导航不会让所有
  // 消费这个上下文的组件重绘。
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const setMode = useCallback(
    (target: AppMode) => {
      if (target === modeRef.current) return;
      switchPreference(target);
      navigate(counterpartRoute(pathRef.current, target));
    },
    [navigate, switchPreference],
  );

  // 模式写到根元素上，CSS token 按 [data-theme][data-mode] 组合覆盖，
  // 组件本身不感知模式。
  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
  }, [mode]);

  const value = useMemo<WorkbenchModeValue>(
    () => ({ mode, ready, setMode }),
    [mode, ready, setMode],
  );
  return (
    <WorkbenchModeContext.Provider value={value}>
      {children}
    </WorkbenchModeContext.Provider>
  );
}
