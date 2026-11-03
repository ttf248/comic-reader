import { useEffect } from "react";
import { useUIStore, type ThemePref, type AccentKey } from "../store/uiStore";

// 把 store 中的主题与强调色同步到 :root[data-theme] / :root[data-accent]。
// 'system' 时跟随 prefers-color-scheme。
export function useTheme() {
  const theme = useUIStore((s) => s.theme);
  const accent = useUIStore((s) => s.accent);

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

  useEffect(() => {
    document.documentElement.setAttribute("data-accent", accent);
  }, [accent]);

  return { theme, accent };
}

// 强调色调色板（用于设置页的色块）
export const ACCENT_SWATCHES: {
  id: AccentKey;
  name: string;
  light: string;
  dark: string;
}[] = [
  { id: "graphite", name: "石墨", light: "#263c32", dark: "#f1ebdd" },
  { id: "indigo", name: "靛蓝", light: "#4f46e5", dark: "#818cf8" },
  { id: "rose", name: "绯红", light: "#e11d48", dark: "#fb7185" },
  { id: "forest", name: "森林", light: "#059669", dark: "#34d399" },
  { id: "ochre", name: "琥珀", light: "#d97706", dark: "#fbbf24" },
  { id: "plum", name: "紫罗兰", light: "#7c3aed", dark: "#a78bfa" },
];
