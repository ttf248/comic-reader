import { useRef } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

interface Props<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 无障碍名称：这个分段控件管的是什么。 */
  label: string;
  disabled?: boolean;
}

/**
 * 分段控件：在一组互斥的选项里选一个。
 *
 * 同一类操作都用它 —— 展开/折叠、照片/漫画、增量/全量 —— 长得一样，
 * 用户看一眼就知道这是「二选一」。用 radio 语义并支持左右方向键，
 * 键盘用户不必逐个 Tab 过去。
 */
export default function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled = false,
}: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);

  function move(step: number) {
    const enabled = options.filter((option) => !option.disabled);
    if (enabled.length === 0) return;
    const currentIndex = enabled.findIndex((option) => option.value === value);
    const nextIndex =
      (currentIndex + step + enabled.length) % enabled.length;
    onChange(enabled[nextIndex].value);
    const buttons = ref.current?.querySelectorAll<HTMLButtonElement>(
      'button[role="radio"]',
    );
    buttons?.[nextIndex]?.focus();
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      className="inline-flex items-center overflow-hidden rounded-md border border-border bg-bg-subtle/40"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled || option.disabled}
            title={option.title}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              } else if (
                event.key === "ArrowLeft" ||
                event.key === "ArrowUp"
              ) {
                event.preventDefault();
                move(-1);
              }
            }}
            className={`h-8 px-3 text-meta transition-colors ${
              selected
                ? "bg-bg-elevated text-fg shadow-xs"
                : "text-fg-muted hover:bg-bg-subtle"
            } disabled:opacity-50`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
