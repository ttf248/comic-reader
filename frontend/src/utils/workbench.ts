import type { AppMode } from "../api/library";

/**
 * 工作台文案。
 *
 * 照片与漫画是两个完全独立的世界：各自的列表、措辞与操作互不掺入。
 * 照片这边没有「继续浏览」「未浏览」「看到第 N 张」——进度与未读属于漫画；
 * 漫画这边没有照片墙式的浏览说法。集中在这里，避免每个组件各写一份
 * if 而慢慢走样。
 */
export interface WorkbenchCopy {
  /** 首页主标题：照片库 / 漫画库。 */
  libraryTitle: string;
  /** 首页眉标。 */
  libraryEyebrow: string;
  /** 首页副标题。 */
  libraryDescription: string;
  /** 主列表区的标题。 */
  sectionTitle: string;
  /** 年份筛选生效时的主列表区标题。 */
  yearSectionTitle: string;
  /** 最近访问页的标题。 */
  recentsTitle: string;
  /** 最近访问页的眉标。 */
  recentsEyebrow: string;
  /** 最近访问页的空态。 */
  recentsEmpty: string;
  /** 最近访问页的历史读取失败提示。 */
  recentsLoadError: string;
  /** 最近访问页的相册摘要读取失败提示。 */
  recentsAlbumsLoadError: string;
  /** 收藏页的标题。 */
  favoritesTitle: string;
  /** 收藏页空态。 */
  favoritesEmpty: string;
  /** 随机打开一本相册的动作名。 */
  randomLabel: string;
}

/** 漫画工作台专有的文案：进度与未读都属于漫画。 */
export interface ComicCopy extends WorkbenchCopy {
  /** 「继续阅读」区的标题。 */
  continueTitle: string;
  /** 继续区里的主动作按钮。 */
  continueButton: string;
  /** 进度位置的动词：读到。 */
  positionVerb: string;
  /** 完成的说法：已读完（状态徽标）。 */
  finishedLabel: string;
  /** 完成的动词：读完。 */
  finishVerb: string;
  /** 标记完成的说法。 */
  markFinishedLabel: string;
  /** 「还没读完」的计数说明。 */
  unfinishedCountLabel: string;
  /** 批量标记完成按钮的说明。 */
  markAllTitle: string;
  /** 是否显示阅读百分比。 */
  showReadingPercent: boolean;
  /** 未读区的标题。 */
  unreadTitle: string;
  /** 未读列表页的标题。 */
  unreadPageTitle: string;
  /** 未读计数句里的动词：没读。 */
  unreadCountVerb: string;
  /** 未读列表清空后的引导文案。 */
  unreadEmptyHint: string;
  /** 未读区的眉标。 */
  unreadEyebrow: string;
  /** 未读区的计数说明。 */
  unreadCountLabel: string;
  /** 未读区的随机按钮。 */
  unreadButton: string;
  /** 未读清空后的空态。 */
  unreadEmpty: string;
}

const PHOTO: WorkbenchCopy = {
  libraryTitle: "照片库",
  libraryEyebrow: "你的照片",
  libraryDescription: "照片、故事与每一次重逢",
  sectionTitle: "全部照片",
  yearSectionTitle: "该年份的照片",
  recentsTitle: "最近浏览",
  recentsEyebrow: "浏览足迹",
  recentsEmpty: "还没有最近浏览",
  recentsLoadError: "最近浏览加载失败。",
  recentsAlbumsLoadError: "最近浏览的相册信息加载失败。",
  favoritesTitle: "我收藏的照片",
  favoritesEmpty: "还没有收藏照片",
  randomLabel: "随机翻翻",
};

const COMIC: ComicCopy = {
  libraryTitle: "漫画库",
  libraryEyebrow: "你的漫画",
  libraryDescription: "漫画、章节与还没翻完的那一话",
  continueTitle: "继续阅读",
  continueButton: "继续阅读",
  positionVerb: "读到",
  finishedLabel: "已读完",
  finishVerb: "读完",
  markFinishedLabel: "标记为已读完",
  unfinishedCountLabel: "本还没读完",
  markAllTitle: "把当前所有未读相册标记为已读完(不影响收藏 / 最近)",
  showReadingPercent: true,
  unreadTitle: "未读",
  unreadPageTitle: "未读相册",
  unreadCountVerb: "没读",
  unreadEmptyHint:
    "漫画都读完了，可以在「主页」随机翻一卷，或去「收藏」里找回老朋友。",
  unreadEyebrow: "下一本的灵感",
  unreadCountLabel: "本等你翻开",
  unreadButton: "随机一本未读",
  unreadEmpty: "全部看完啦 🎉",
  sectionTitle: "全部漫画",
  yearSectionTitle: "该年份的漫画",
  recentsTitle: "最近阅读",
  recentsEyebrow: "阅读足迹",
  recentsEmpty: "还没有最近阅读",
  recentsLoadError: "最近阅读加载失败。",
  recentsAlbumsLoadError: "最近阅读的相册信息加载失败。",
  favoritesTitle: "我收藏的漫画",
  favoritesEmpty: "还没有收藏漫画",
  randomLabel: "随机一本",
};

/** 返回某个工作台模式对应的文案。 */
export function workbenchCopy(mode: AppMode): WorkbenchCopy {
  return mode === "comic" ? COMIC : PHOTO;
}

/**
 * 漫画工作台的专有文案。
 *
 * 进度与未读只存在于漫画工作台，因此这些措辞不随模式切换：
 * 需要它们的地方（继续阅读区、未读区、漫画卡片）本来就只在漫画模式出现。
 */
export function comicCopy(): ComicCopy {
  return COMIC;
}
