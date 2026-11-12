import type { SettingsSection } from "./sectionSpy";

interface Props {
  sections: SettingsSection[];
  active: string;
  onSelect: (id: string) => void;
}

/**
 * 设置页的分区导航。
 *
 * 设置页是唯一一页「内容比一屏多」的表单页。之前用 CSS 多列排版，
 * 列高差一大就留下一整片空白，看起来像没加载完。改成一条粘性导航加
 * 一列内容：分区关系写在导航里，滚动时高亮当前分区。
 */
export default function SectionRail({
  sections,
  active,
  onSelect,
}: Props) {
  return (
    <nav aria-label="设置分区" className="lg:sticky lg:top-4">
      <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0.5 lg:overflow-visible">
        {sections.map((section) => {
          const isActive = section.id === active;
          return (
            <li key={section.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onSelect(section.id)}
                aria-current={isActive ? "true" : undefined}
                className={`w-full rounded-md px-3 py-1.5 text-left text-meta transition-colors ${
                  isActive
                    ? "bg-brand-soft/60 font-medium text-fg"
                    : "text-fg-muted hover:bg-bg-subtle hover:text-fg"
                }`}
              >
                {section.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
