import { useEffect } from "react";
import { useUIStore, type ThemePref } from "../store/uiStore";

// 把 store 中的主题同步到 :root[data-theme]。
// 'system' 时跟随 prefers-color-scheme。
//
// 强调色不再可切换：它由主题方案本身决定（中性灰阶 + 琥珀点缀），
// 所以这里只处理主题一个维度。
export function useTheme() {
  const theme = useUIStore((s) => s.theme);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (t: ThemePref) => {
      const effective = t === "system" ? (mql.matches ? "dark" : "light") : t;
      document.documentElement.setAttribute("data-theme", effective);
    };
    apply(theme);

    if (theme === "system") {
      const onChange = () => apply("system");
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
  }, [theme]);

  return { theme };
}
