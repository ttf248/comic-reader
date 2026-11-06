import type { Config } from "tailwindcss";

// 保留完整 CSS 颜色 token，同时让 /30 等透明度修饰符参与生成。
const tokenColor = (name: string) =>
  `color-mix(in srgb, var(--${name}) calc(<alpha-value> * 100%), transparent)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 主题颜色统一从 tokens.css 取得，不在工具类中重复维护色值。
        bg: tokenColor("bg"),
        "bg-elevated": tokenColor("bg-elevated"),
        "bg-subtle": tokenColor("bg-subtle"),
        "bg-strong": tokenColor("bg-strong"),
        "bg-media": tokenColor("bg-media"),
        fg: tokenColor("fg"),
        "fg-muted": tokenColor("fg-muted"),
        "fg-subtle": tokenColor("fg-subtle"),
        accent: tokenColor("accent"),
        "accent-hover": tokenColor("accent-hover"),
        "accent-soft": tokenColor("accent-soft"),
        "accent-contrast": tokenColor("accent-contrast"),
        border: tokenColor("border"),
        "border-strong": tokenColor("border-strong"),
        "border-faint": tokenColor("border-faint"),
        danger: tokenColor("danger"),
        success: tokenColor("success"),
        warning: tokenColor("warning"),
        favorite: tokenColor("favorite"),
        focus: tokenColor("focus"),
        brand: tokenColor("brand"),
        "brand-soft": tokenColor("brand-soft"),
        "brand-ink": tokenColor("brand-ink"),
        // 压在品牌色上的文字色。品牌色跟着主题与工作台翻明暗，
        // 压在它上面的字也要跟着翻 —— 没有这一项，模式切换按钮
        // 会继承正文色，明亮两套主题下都读不清。
        "brand-contrast": tokenColor("brand-contrast"),
        "rail-bg": tokenColor("rail-bg"),
        "rail-fg": tokenColor("rail-fg"),
        "rail-muted": tokenColor("rail-muted"),
        "rail-hover": tokenColor("rail-hover"),
        "rail-line": tokenColor("rail-line"),
        "rail-active": tokenColor("rail-active"),
        "rail-active-fg": tokenColor("rail-active-fg"),
        "rail-accent": tokenColor("rail-accent"),
        "rail-accent-fg": tokenColor("rail-accent-fg"),
        "feature-bg": tokenColor("feature-bg"),
        "feature-fg": tokenColor("feature-fg"),
        "feature-muted": tokenColor("feature-muted"),
        "reader-bg": tokenColor("reader-bg"),
        "reader-panel": tokenColor("reader-panel"),
        "overlay-bg": tokenColor("overlay-bg"),
        "overlay-panel": tokenColor("overlay-panel"),
        "overlay-panel-strong": tokenColor("overlay-panel-strong"),
        "overlay-border": tokenColor("overlay-border"),
        "overlay-fg": tokenColor("overlay-fg"),
        "overlay-scrim": tokenColor("overlay-scrim"),
        "overlay-danger": tokenColor("overlay-danger"),
        "overlay-warning": tokenColor("overlay-warning"),
        "overlay-success": tokenColor("overlay-success"),
        "overlay-favorite": tokenColor("overlay-favorite"),
      },
      // 圆角数值只有一份来源（tokens.css 的语义 token）。Tailwind 侧保留
      // 数字档名，避免同一个圆角出现「rounded-lg」和「rounded-tile」两套
      // 叫法；样式表内部一律用语义名 var(--radius-tile) 之类。
      borderRadius: {
        DEFAULT: "var(--radius-xs)",
        sm: "var(--radius-media)",
        md: "var(--radius-control)",
        lg: "var(--radius-tile)",
        xl: "var(--radius-panel)",
      },
      fontSize: {
        badge: "var(--text-badge)",
        meta: "var(--text-meta)",
        body: "var(--text-body)",
        label: "var(--text-label)",
        section: "var(--text-section)",
        "page-sm": "var(--text-page-sm)",
        page: "var(--text-page)",
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        display: ["var(--font-display)"],
        mono: ["var(--font-mono)"],
      },
    },
  },
  darkMode: ["class", '[data-theme="dark"]'],
  plugins: [],
} satisfies Config;
