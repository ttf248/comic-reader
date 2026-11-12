import type { PageSection } from "../../utils/pageSections";

interface Props {
  sections: PageSection[];
  active: string;
  onSelect: (id: string) => void;
}

/**
 * 页面级分区导航：贴在内容顶部的一条横轴。
 *
 * 应用级导航是左边那条竖轴（侧栏），页面级分区就顺着做横的 —— 两条轴
 * 方向不同，不会互相抢注意力；窄屏时侧栏收进抽屉，横轴照样够得着。
 *
 * 它粘在顶栏下方，页面滚到哪儿都能跳到别的分区；当前分区随滚动高亮。
 */
export default function SectionNav({ sections, active, onSelect }: Props) {
  if (sections.length === 0) return null;
  return (
    <nav
      aria-label="页面分区"
      className="sticky top-0 z-20 border-b border-border-faint bg-bg/95 py-1.5 backdrop-blur"
    >
      <ul className="flex items-center gap-1 overflow-x-auto">
        {sections.map((section) => {
          const isActive = section.id === active;
          return (
            <li key={section.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onSelect(section.id)}
                aria-current={isActive ? "true" : undefined}
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-meta transition-colors ${
                  isActive
                    ? "bg-bg-elevated font-medium text-fg shadow-xs"
                    : "text-fg-muted hover:bg-bg-subtle hover:text-fg"
                }`}
              >
                {section.index ? (
                  <span className="font-mono tabular-nums text-fg-subtle">
                    {section.index}
                  </span>
                ) : null}
                {section.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
