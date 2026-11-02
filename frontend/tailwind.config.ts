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
        "bg-inset": tokenColor("bg-inset"),
        fg: tokenColor("fg"),
        "fg-muted": tokenColor("fg-muted"),
        "fg-subtle": tokenColor("fg-subtle"),
        "fg-disabled": tokenColor("fg-disabled"),
        accent: tokenColor("accent"),
        "accent-hover": tokenColor("accent-hover"),
        "accent-soft": tokenColor("accent-soft"),
        "accent-fg": tokenColor("accent-fg"),
        "accent-contrast": tokenColor("accent-contrast"),
        "on-accent": tokenColor("accent-fg"),
        border: tokenColor("border"),
        "border-strong": tokenColor("border-strong"),
        "border-faint": tokenColor("border-faint"),
        danger: tokenColor("danger"),
        success: tokenColor("success"),
        warning: tokenColor("warning"),
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        display: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "SF Mono", "Menlo", "monospace"],
      },
    },
  },
  darkMode: ["class", '[data-theme="dark"]'],
  plugins: [],
} satisfies Config;
