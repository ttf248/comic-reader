import { useEffect, useState } from "react";

export interface SettingsSection {
  id: string;
  label: string;
}

/**
 * 滚动时判断当前在哪个分区。
 *
 * 页面内容装在 `.app-main` 这层可滚动容器里，滚动事件挂在它上面，
 * 不是挂在 window 上 —— 挂在 window 上永远不会触发。
 */
export function useSectionSpy(sections: SettingsSection[]): string {
  const [active, setActive] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const container = document.querySelector(".app-main");
    if (!container) return;

    function update() {
      const threshold = container!.getBoundingClientRect().top + 140;
      let current = sections[0]?.id ?? "";
      for (const section of sections) {
        const element = document.getElementById(section.id);
        if (!element) continue;
        if (element.getBoundingClientRect().top <= threshold) {
          current = section.id;
        }
      }
      setActive(current);
    }

    update();
    container.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [sections]);

  return active;
}

/** 滚到指定分区。 */
export function scrollToSection(id: string) {
  const element = document.getElementById(id);
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "start" });
}
