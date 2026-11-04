import type { AppMode } from "../../api/library";

interface Props {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
}

/**
 * 工作台模式切换器：照片 / 漫画。
 *
 * 它是「我现在看哪一类相册」的选择，与相册自身的用途正交：
 * 切换只改变列表与措辞，不改变任何一本相册打开后的交互。
 *
 * 「全部相册」不在这里——它是逃生舱而不是第三个工作台，
 * 作为侧栏里的独立导航项存在。
 */
export default function ModeSwitch({ mode, onChange }: Props) {
  const options: { key: Exclude<AppMode, "all">; label: string }[] = [
    { key: "photo", label: "照片" },
    { key: "comic", label: "漫画" },
  ];
  return (
    <div
      role="group"
      aria-label="工作台模式"
      className="flex items-center gap-0.5 rounded-md border border-rail-line bg-rail-hover p-0.5"
    >
      {options.map((option) => {
        const active = mode === option.key;
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onChange(option.key)}
            aria-pressed={active}
            title={
              option.key === "photo"
                ? "照片工作台：只列照片相册"
                : "漫画工作台：只列漫画相册"
            }
            className={`h-7 flex-1 rounded px-2.5 text-[12.5px] transition-colors ${
              active
                ? "bg-rail-accent text-rail-accent-fg font-medium"
                : "text-rail-muted hover:text-rail-fg"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
