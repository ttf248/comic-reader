import type { AppMode, ContentKind } from "../api/library";

/**
 * 工作台文案。
 *
 * 同一个页面在照片与漫画两种工作台下要用不同的说法：照片是「浏览 / 看完 /
 * 看到」，漫画是「阅读 / 读完 / 读到」。把措辞集中在这里，
 * 避免每个组件各写一份 if 而慢慢走样。
 */
export interface WorkbenchCopy {
  /** 首页主标题：照片库 / 漫画库 / 全部相册。 */
  libraryTitle: string;
  /** 首页眉标。 */
  libraryEyebrow: string;
  /** 首页副标题。 */
  libraryDescription: string;
  /** 「继续」区的标题。 */
  continueTitle: string;
  /** 继续区里的主动作按钮。 */
  continueButton: string;
  /** 进度位置的动词：看到 / 读到。 */
  positionVerb: string;
  /** 完成的说法：已看完 / 已读完（状态徽标）。 */
  finishedLabel: string;
  /** 完成的动词：看完 / 读完（用于「已看完」这样的过去式提示）。 */
  finishVerb: string;
  /** 标记完成的说法。 */
  markFinishedLabel: string;
  /** 未读区的标题。 */
  unreadTitle: string;
  /** 未读列表页的标题。 */
  unreadPageTitle: string;
  /** 未读计数句里的动词：没看 / 没读。 */
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
  /** 主列表区的标题。 */
  sectionTitle: string;
  /** 最近访问页的标题。 */
  recentsTitle: string;
  /** 最近访问页的眉标。 */
  recentsEyebrow: string;
  /** 收藏页的标题。 */
  favoritesTitle: string;
  /** 收藏页空态。 */
  favoritesEmpty: string;
  /** 随机打开一本相册的动作名。 */
  randomLabel: string;
}

const PHOTO: WorkbenchCopy = {
  libraryTitle: "照片库",
  libraryEyebrow: "你的照片",
  libraryDescription: "照片、故事与每一次重逢",
  continueTitle: "继续浏览",
  continueButton: "继续浏览",
  positionVerb: "看到",
  finishedLabel: "已看完",
  finishVerb: "看完",
  markFinishedLabel: "标记为已看完",
  unreadTitle: "未浏览",
  unreadPageTitle: "未浏览的相册",
  unreadCountVerb: "没看",
  unreadEmptyHint:
    "照片都看过了，可以在「主页」随机翻翻，或去「收藏」里找回老朋友。",
  unreadEyebrow: "下一张的灵感",
  unreadCountLabel: "本等你翻看",
  unreadButton: "随机一本未浏览",
  unreadEmpty: "照片都看完啦 🎉",
  sectionTitle: "全部照片",
  recentsTitle: "最近浏览",
  recentsEyebrow: "浏览足迹",
  favoritesTitle: "我收藏的照片",
  favoritesEmpty: "还没有收藏照片",
  randomLabel: "随机翻翻",
};

const COMIC: WorkbenchCopy = {
  libraryTitle: "漫画库",
  libraryEyebrow: "你的漫画",
  libraryDescription: "漫画、章节与还没翻完的那一话",
  continueTitle: "继续阅读",
  continueButton: "继续阅读",
  positionVerb: "读到",
  finishedLabel: "已读完",
  finishVerb: "读完",
  markFinishedLabel: "标记为已读完",
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
  recentsTitle: "最近阅读",
  recentsEyebrow: "阅读足迹",
  favoritesTitle: "我收藏的漫画",
  favoritesEmpty: "还没有收藏漫画",
  randomLabel: "随机一本",
};

// 「全部相册」是逃生舱而不是第三个工作台：它的措辞取中性值，
// 不假装自己是照片或漫画。
const ALL: WorkbenchCopy = {
  libraryTitle: "全部相册",
  libraryEyebrow: "属于你的影像年鉴",
  libraryDescription: "照片、故事与每一次重逢",
  continueTitle: "继续",
  continueButton: "继续",
  positionVerb: "看到",
  finishedLabel: "已读完",
  finishVerb: "读完",
  markFinishedLabel: "标记为已读",
  unreadTitle: "未读",
  unreadPageTitle: "未读相册",
  unreadCountVerb: "没读",
  unreadEmptyHint:
    "列表空了，可以在「主页」随机翻翻，或去「收藏」里找回老朋友。",
  unreadEyebrow: "下一本的灵感",
  unreadCountLabel: "本等你翻开",
  unreadButton: "随机一本未读",
  unreadEmpty: "全部看完啦 🎉",
  sectionTitle: "全部图像",
  recentsTitle: "最近",
  recentsEyebrow: "浏览足迹",
  favoritesTitle: "收藏",
  favoritesEmpty: "还没有收藏",
  randomLabel: "随机一本",
};

/** 返回某个工作台模式对应的文案。 */
export function workbenchCopy(mode: AppMode): WorkbenchCopy {
  if (mode === "comic") return COMIC;
  if (mode === "photo") return PHOTO;
  return ALL;
}

/**
 * 按相册自身的用途挑措辞。
 *
 * 「全部相册」视图里两种相册混排，措辞必须跟着每一本相册走，
 * 不能整个页面统一成一种说法。
 */
export function copyForContentKind(
  mode: AppMode,
  contentKind?: ContentKind,
): WorkbenchCopy {
  if (mode === "all") {
    return contentKind === "comic" ? COMIC : PHOTO;
  }
  return workbenchCopy(mode);
}
