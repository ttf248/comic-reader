import type { AppMode } from "../../api/library";
import { ImageIcon, ReaderIcon } from "../common/Icon";

interface Props {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
  /** 侧栏折叠时只留两枚图标按钮：切模式在折叠态也要一步可达。 */
  compact?: boolean;
}

/**
 * 工作台模式切换器：照片 / 漫画。
 *
 * 模式就是目录的内容属性：照片目录的相册归照片工作台，漫画目录的归漫画工作台，
 * 两半互斥。这里只有两档，没有「全部」——不过滤的第三档会让两套菜单互相掺入。
 */
export default function ModeSwitch({ mode, onChange, compact }: Props) {
  const options: { key: AppMode; label: string }[] = [
    { key: "photo", label: "照片" },
    { key: "comic", label: "漫画" },
  ];
  return (
    <div
      role="group"
      aria-label="工作台模式"
      className={
        compact
          ? "flex flex-col items-center gap-0.5"
          : "flex items-center gap-0.5 rounded-md border border-rail-line bg-rail-hover p-0.5"
      }
    >
      {options.map((option) => {
        const active = mode === option.key;
        const title =
          option.key === "photo"
            ? "照片工作台：只列照片相册"
            : "漫画工作台：只列漫画相册";
        if (compact) {
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => onChange(option.key)}
              aria-pressed={active}
              aria-label={option.label}
              title={title}
              className={`w-9 h-8 rounded-md flex items-center justify-center transition-colors ${
                active
                  ? "bg-rail-accent text-rail-accent-fg"
                  : "text-rail-muted hover:text-rail-fg hover:bg-rail-hover"
              }`}
            >
              {option.key === "photo" ? (
                <ImageIcon size={15} />
              ) : (
                <ReaderIcon size={15} />
              )}
            </button>
          );
        }
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onChange(option.key)}
            aria-pressed={active}
            title={title}
            className={`h-7 flex-1 rounded px-2.5 text-meta transition-colors ${
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
