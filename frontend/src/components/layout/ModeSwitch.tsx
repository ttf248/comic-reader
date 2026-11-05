import type { AppMode } from "../../api/library";

interface Props {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
  /**
   * 落在哪一层表面上：
   *   rail —— 侧栏的墨黑表面上（窄屏抽屉里用这一档）；
   *   surface —— 页面画布上（顶栏用这一档）。
   * 两层的对比体系不同，颜色不能混用。
   */
  tone?: "rail" | "surface";
}

/**
 * 工作台模式切换器：照片 / 漫画。
 *
 * 模式就是目录的内容属性：照片目录的相册归照片工作台，漫画目录的归漫画工作台，
 * 两半互斥。这里只有两档，没有「全部」——不过滤的第三档会让两套菜单互相掺入。
 */
export default function ModeSwitch({ mode, onChange, tone = "rail" }: Props) {
  const options: { key: AppMode; label: string }[] = [
    { key: "photo", label: "照片" },
    { key: "comic", label: "漫画" },
  ];
  const onRail = tone === "rail";
  return (
    <div
      role="group"
      aria-label="工作台模式"
      className={
        onRail
          ? "flex items-center gap-0.5 rounded-md border border-rail-line bg-rail-hover p-0.5"
          : "flex items-center gap-0.5 rounded-md border border-border bg-bg-subtle p-0.5"
      }
    >
      {options.map((option) => {
        const active = mode === option.key;
        const title =
          option.key === "photo"
            ? "照片工作台：只列照片相册"
            : "漫画工作台：只列漫画相册";
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onChange(option.key)}
            aria-pressed={active}
            title={title}
            className={`h-7 flex-1 rounded px-2.5 text-meta transition-colors ${
              active
                ? onRail
                  ? "bg-rail-accent text-rail-accent-fg font-medium"
                  : "bg-accent text-accent-contrast font-medium"
                : onRail
                  ? "text-rail-muted hover:text-rail-fg"
                  : "text-fg-muted hover:text-fg"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
