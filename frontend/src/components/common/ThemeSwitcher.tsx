import {
  useUIStore,
  type ThemePref,
  type AccentKey,
} from "../../store/uiStore";
import { SunIcon, MoonIcon, MonitorIcon, CheckIcon } from "./Icon";
import { ACCENT_SWATCHES } from "../../hooks/useTheme";
import Popover from "./Popover";

// 主题切换：
//  - compact：主题与强调色菜单，可连续选择后用 Esc 或外部焦点关闭
//  - default：设置页内联的三态主题按钮
export default function ThemeSwitcher({
  compact = false,
}: {
  compact?: boolean;
}) {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const accent = useUIStore((s) => s.accent);
  const setAccent = useUIStore((s) => s.setAccent);

  if (compact) {
    return (
      <CompactSwitch
        theme={theme}
        setTheme={setTheme}
        accent={accent}
        setAccent={setAccent}
      />
    );
  }

  return (
    <div className="inline-flex border border-border rounded-md overflow-hidden bg-bg-subtle/40">
      {[
        { value: "light", label: "浅色", Icon: SunIcon },
        { value: "dark", label: "深色", Icon: MoonIcon },
        { value: "system", label: "系统", Icon: MonitorIcon },
      ].map((o) => (
        <button
          key={o.value}
          onClick={() => setTheme(o.value as ThemePref)}
          className={`flex items-center gap-1 px-2.5 h-7 text-xs transition-colors ${
            theme === o.value
              ? "bg-bg-elevated text-fg shadow-xs"
              : "text-fg-muted hover:text-fg hover:bg-bg-subtle/60"
          }`}
        >
          <o.Icon size={12} />
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

// compact：单按钮 + 下拉面板（同时切换主题与强调色）
function CompactSwitch({
  theme,
  setTheme,
  accent,
  setAccent,
}: {
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  accent: AccentKey;
  setAccent: (a: AccentKey) => void;
}) {
  const cur =
    theme === "light" ? SunIcon : theme === "dark" ? MoonIcon : MonitorIcon;
  const Icon = cur;
  const accentColor =
    ACCENT_SWATCHES.find((a) => a.id === accent)?.light ??
    ACCENT_SWATCHES[0].light;

  return (
    <Popover
      aria-label="主题与强调色"
      className="w-[240px] p-2 fade-in"
      trigger={
        <button
          type="button"
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors relative"
          title={`主题: ${theme === "light" ? "浅色" : theme === "dark" ? "深色" : "系统"} · 强调色`}
        >
          <Icon size={14} />
          <span
            className="absolute bottom-1 right-1 w-1.5 h-1.5 rounded-full ring-2 ring-bg-elevated"
            style={{ background: accentColor }}
          />
        </button>
      }
    >
      <div className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle px-2 py-1.5">
        主题
      </div>
      <div
        role="group"
        aria-label="主题"
        className="grid grid-cols-3 gap-1 px-1"
      >
        {[
          { v: "light", l: "浅色" },
          { v: "dark", l: "深色" },
          { v: "system", l: "系统" },
        ].map((o) => {
          const active = theme === o.v;
          return (
            <button
              key={o.v}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              onClick={() => setTheme(o.v as ThemePref)}
              className={`relative h-8 rounded text-xs transition-colors ${
                active
                  ? "bg-accent text-accent-contrast"
                  : "text-fg-muted hover:bg-bg-subtle hover:text-fg"
              }`}
            >
              {o.l}
              {active && (
                <CheckIcon size={10} className="absolute top-0.5 right-0.5" />
              )}
            </button>
          );
        })}
      </div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle px-2 pt-3 pb-1.5">
        强调色
      </div>
      <div
        role="group"
        aria-label="强调色"
        className="grid grid-cols-6 gap-1.5 px-1"
      >
        {ACCENT_SWATCHES.map((a) => {
          const active = accent === a.id;
          return (
            <button
              key={a.id}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              onClick={() => setAccent(a.id)}
              className="relative w-7 h-7 rounded-full transition-transform hover:scale-110"
              style={{ background: a.light }}
              title={a.name}
              aria-label={a.name}
            >
              {active && (
                <span className="absolute inset-0 ring-2 ring-fg ring-offset-2 ring-offset-bg-elevated rounded-full" />
              )}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}
