import { useQuery } from "@tanstack/react-query";
import { prefsApi, type Prefs } from "../api/prefs";

/**
 * 服务端偏好（主题、收藏、最近访问、自动切换下一本等）。
 *
 * 与设置页共用同一个 query key，改动后两边同时刷新。
 */
export function usePrefs() {
  return useQuery<Prefs>({
    queryKey: ["prefs"],
    queryFn: () => prefsApi.get(),
  });
}
