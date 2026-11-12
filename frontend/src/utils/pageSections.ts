export interface PageSection {
  id: string;
  label: string;
  /** 分区序号；只有本身带编号的页面才写。 */
  index?: string;
}

// 页面级分区清单。
//
// 这是「应用级导航」（左侧栏）与「页面级导航」（内容顶部的分区条）
// 共用的唯一一份数据：两处显示的分区名、顺序与 id 都从这里出，
// 不会出现侧栏写着「本机存储」而分区条上写着「存储」。
//
// 设置页的分区 id 同时是 DOM 里的 section id，滚动定位与高亮都靠它。

export const TASK_SECTIONS: PageSection[] = [
  { id: "run", label: "运行", index: "01" },
  { id: "history", label: "任务记录", index: "02" },
  { id: "plan", label: "每日计划", index: "03" },
  { id: "storage", label: "本机存储", index: "04" },
];

export const SETTINGS_SECTIONS: PageSection[] = [
  { id: "appearance", label: "外观" },
  { id: "reading", label: "阅读" },
  { id: "data", label: "数据" },
  { id: "backup", label: "备份与恢复" },
  { id: "about", label: "关于" },
  // 服务端内容最重，宽屏上独占一栏，排在最后。
  { id: "server", label: "服务端" },
];

/** 按路由给出页面级分区；没有分区的路由返回空数组。 */
export function sectionsForPath(pathname: string): PageSection[] {
  if (pathname.startsWith("/tasks")) return TASK_SECTIONS;
  if (pathname.startsWith("/settings")) return SETTINGS_SECTIONS;
  return [];
}
