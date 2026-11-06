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
  /**
   * 单张媒体的计数单位：照片「张」，漫画「页」。
   *
   * 漫画里一张图就是「一页」，与阅读器的「第 N 页 / 共 N 页」说法一致；
   * 照片说「张」。
   */
  mediaUnit: string;
  /**
   * 「上次 X」里的动词：照片「浏览」，漫画「阅读」。
   *
   * 进度与未读属于漫画；照片没有「读完」这回事，所以它只能说「浏览」。
   */
  lastSeenVerb: string;
  /** 从未看过时的说法：照片「尚未浏览」，漫画「尚未阅读」。 */
  neverSeenLabel: string;
  /**
   * 集合 / 标签的计数单位：照片「本」，漫画「卷」。
   *
   * 那个数字是「里面有多少本相册」，不是图片数。
   */
  collectionUnit: string;
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

/**
 * 照片工作台专有的文案。
 *
 * 照片没有进度与未读，但同样有「下一步可以做什么」：
 * 最近加入的照片与随手看看的一本，是它与漫画侧对称的首屏专区。
 */
export interface PhotoCopy extends WorkbenchCopy {
  /** 「最近加入」专区的标题。 */
  recentlyAddedTitle: string;
  /** 该专区的眉标。 */
  recentlyAddedEyebrow: string;
  /** 该专区的计数单位。 */
  recentlyAddedCountLabel: string;
  /** 「随手看看」专区的标题。 */
  serendipityTitle: string;
  /** 该专区的提示语。 */
  serendipityHint: string;
  /** 换一本的按钮文案。 */
  serendipityButton: string;
  /** 换一本进行中的文案。 */
  serendipityLoading: string;
  /** 打开这本的按钮文案。 */
  serendipityOpenButton: string;
  /** 「接着看」专区的标题。 */
  resumeTitle: string;
  /** 「接着看」专区的眉标。 */
  resumeEyebrow: string;
  /** 「接着看」专区的提示语。 */
  resumeHint: string;
  /** 「接着看」的主按钮文案。 */
  resumeButton: string;
  /** 「接着看」里表示「上次看过」的措辞。 */
  resumeLastSeenLabel: string;
  /** 「接着看」队列项的计数说明。 */
  resumeCountLabel: string;
}

const PHOTO: PhotoCopy = {
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
  mediaUnit: "张",
  lastSeenVerb: "浏览",
  neverSeenLabel: "尚未浏览",
  collectionUnit: "本",
  recentlyAddedTitle: "最近加入",
  recentlyAddedEyebrow: "刚进门的照片",
  recentlyAddedCountLabel: "本新照片",
  serendipityTitle: "随手看看",
  serendipityHint: "不一定是你在找的那本",
  serendipityButton: "换一本",
  serendipityLoading: "找一本…",
  serendipityOpenButton: "打开看看",
  resumeTitle: "接着看",
  resumeEyebrow: "回到刚才那本",
  resumeHint: "上次看过的那本",
  resumeButton: "接着看",
  resumeLastSeenLabel: "上次浏览",
  resumeCountLabel: "本最近看过",
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
  mediaUnit: "页",
  lastSeenVerb: "阅读",
  neverSeenLabel: "尚未阅读",
  collectionUnit: "卷",
};

/**
 * 集合与标签卡片的计数单位。
 *
 * 那个数字是「里面有多少本相册」，不是图片数：照片侧说「本」，
 * 漫画侧说「卷」。用「张」会让人以为那是图片数量。
 *
 * 取值来自词表本身，词表是唯一真相源。
 */
export function collectionUnit(mode: "photo" | "comic"): string {
  return workbenchCopy(mode).collectionUnit;
}

/**
 * 单张媒体的计数单位：照片「张」，漫画「页」。
 *
 * 漫画里一张图就是「一页」，与阅读器的「第 N 页」说法一致。
 */
export function mediaUnit(mode: "photo" | "comic"): string {
  return workbenchCopy(mode).mediaUnit;
}

/**
 * 封面卡片的默认画幅。
 *
 * 照片是方的（展陈墙，1:1）；漫画是竖的（书脊，4:5）。
 * 两个工作台看起来像两套产品，这条就是其中最直观的一条。
 *
 * 漫画侧用 4:5 而不是更瘦的 2:3：书架上的书脊确实瘦，但封面一旦
 * 太瘦，横向的素材会被裁掉一半以上 —— 裁剩的那一条既认不出内容，
 * 也不像一张封面。4:5 仍是竖版（与照片侧的方形分得开），却能留住
 * 画面里真正有信息的那部分。
 */
export function coverRatioForMode(mode: "photo" | "comic"): "1/1" | "4/5" {
  return mode === "comic" ? "4/5" : "1/1";
}

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

/**
 * 照片工作台的专有文案。
 *
 * 与漫画文案一样不随模式切换：这些措辞只出现在照片工作台的专有区块里。
 */
export function photoCopy(): PhotoCopy {
  return PHOTO;
}
