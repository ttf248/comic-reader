import {
  createContext,
  useContext,
  useEffect,
  useMemo,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { prefsApi } from "../api/prefs";
import { useAppModeStore } from "../store/appModeStore";
import { homeRoute } from "../utils/path";
import type { AppMode } from "../api/library";

export interface WorkbenchModeValue {
  /** 当前工作台：照片 / 漫画。 */
  mode: AppMode;
  /** 模式是否已经确定。列表查询在它就绪前不发请求。 */
  ready: boolean;
  /** 切到另一侧：导航到对应页面，并记住这个选择。 */
  setMode: (mode: AppMode) => void;
}

export const WorkbenchModeContext = createContext<WorkbenchModeValue | null>(
  null,
);

/**
 * 当前工作台。
 *
 * mode 就是目录的内容属性：照片工作台只列照片目录的相册，漫画工作台只列
 * 漫画目录的。它决定列表呈现什么、页面用什么措辞，也决定相册点开进照片墙
 * 还是阅读器。
 *
 * 真相源是 URL 路径前缀（`/photo` / `/comic`），服务端偏好只在根路径落哪
 * 一侧时起作用。
 *
 * 没有 Provider 时（单测直接渲染组件）回落到服务端偏好：那样至少还有
 * 一个确定的模式可用，不会因为缺少路由上下文而整个崩掉。
 */
export function useAppMode(): WorkbenchModeValue {
  const context = useContext(WorkbenchModeContext);
  const preference = useAppModeStore((s) => s.preference);
  const hydrated = useAppModeStore((s) => s.hydrated);
  const switchPreference = useAppModeStore((s) => s.switchPreference);
  const fallback = useMemo<WorkbenchModeValue>(
    () => ({
      mode: preference,
      ready: hydrated,
      // 没有 Provider 时无处可导航：只记下偏好。
      setMode: switchPreference,
    }),
    [preference, hydrated, switchPreference],
  );
  return context ?? fallback;
}

/**
 * 用服务端偏好水合本地镜像。挂在应用顶层调用一次。
 *
 * 偏好读不出来时也要放行（用默认偏好）：偏好接口故障不该把整个应用
 * 卡在骨架屏上——它只决定根路径落到哪一侧，不影响当前页面的数据。
 */
export function useAppModeHydration() {
  const query = useQuery({
    queryKey: ["prefs"],
    queryFn: () => prefsApi.get(),
    staleTime: 5 * 60 * 1000,
  });
  const hydrate = useAppModeStore((s) => s.hydrate);

  useEffect(() => {
    if (query.data) {
      hydrate(query.data.appMode ?? "photo");
      return;
    }
    if (query.isError) hydrate("photo");
  }, [query.data, query.isError, hydrate]);

  return query;
}

/** 当前工作台首页路径。给「返回主页」这类动作用。 */
export function useHomeRoute(): string {
  const { mode } = useAppMode();
  return homeRoute(mode);
}
