// 快捷键定义。
// 单一来源：所有快捷键在此集中声明，UI/帮助文档共用。

export type ShortcutHandler = (e: KeyboardEvent) => void;
export type ShortcutContext = "library" | "photo" | "image" | "video";

export interface Shortcut {
  id: string;
  /** 显示标签：用于 UI 列表 */
  label: string;
  /** 描述：用于帮助浮层 */
  description: string;
  /** 触发条件：包含 ctrl/alt/shift 等修饰键 */
  combo: string;
  /** 所属分组（用于 HelpOverlay） */
  group: "global" | "reader" | "photo" | "image" | "video";
  /**
   * 随工作台模式变化的措辞。
   *
   * 少数全局操作在照片与漫画工作台下该用不同的说法（「未读相册页」
   * 在照片工作台里是「未浏览相册页」）。缺省时用 description。
   */
  modeDescriptions?: Partial<Record<"photo" | "comic" | "all", string>>;
}

// 按页面和媒体类型声明快捷键；reader 分组由图片与视频阅读器共用。
// 列表须与 Toolbar/AppShell/Gallery/VideoPlayer/PageSlider 的处理函数一致。
// HelpOverlay 直接消费此表作为单一事实来源。
export const SHORTCUTS: Shortcut[] = [
  {
    id: "sidebar",
    label: "Ctrl+B",
    description: "折叠/展开侧边栏",
    combo: "ctrl+b",
    group: "global",
  },
  {
    id: "home",
    label: "Ctrl+H",
    description: "回到主页",
    combo: "ctrl+h",
    group: "global",
  },
  {
    id: "recents",
    label: "Ctrl+R",
    description: "最近访问",
    combo: "ctrl+r",
    group: "global",
  },
  {
    id: "favorites",
    label: "Ctrl+D",
    description: "我的收藏",
    combo: "ctrl+d",
    group: "global",
  },
  {
    id: "settings",
    label: "Ctrl+,",
    description: "设置",
    combo: "ctrl+,",
    group: "global",
  },
  {
    id: "scan",
    label: "Ctrl+S",
    description: "重新扫描",
    combo: "ctrl+s",
    group: "global",
  },
  {
    id: "search",
    label: "/",
    description: "聚焦搜索框",
    combo: "/",
    group: "global",
  },
  {
    id: "shuffle",
    label: "R",
    description: "随机一本",
    modeDescriptions: { photo: "随机翻翻" },
    combo: "r",
    group: "global",
  },
  {
    id: "unread",
    label: "U",
    description: "未读相册页",
    modeDescriptions: { photo: "未浏览相册页" },
    combo: "u",
    group: "global",
  },
  {
    id: "help",
    label: "?",
    description: "显示快捷键帮助",
    combo: "?",
    group: "global",
  },
  // 阅读器共用
  {
    id: "readerHelp",
    label: "? / Ctrl+/",
    description: "显示快捷键帮助",
    combo: "?",
    group: "reader",
  },
  {
    id: "nextAlbum",
    label: "N",
    description: "下一本（来自当前列表）",
    combo: "n",
    group: "reader",
  },
  {
    id: "prevAlbum",
    label: "P",
    description: "上一本（来自当前列表）",
    combo: "p",
    group: "reader",
  },
  {
    id: "favorite",
    label: "S",
    description: "收藏 / 取消收藏",
    combo: "s",
    group: "reader",
  },
  {
    id: "setCover",
    label: "U",
    description: "当前内容设为封面",
    combo: "u",
    group: "reader",
  },
  {
    id: "clearCover",
    label: "Shift+U",
    description: "清除自定义封面",
    combo: "shift+u",
    group: "reader",
  },
  {
    id: "fullscreen",
    label: "F11",
    description: "全屏切换",
    combo: "f11",
    group: "reader",
  },
  {
    id: "escape",
    label: "Esc",
    description: "关闭浮层 / 返回上一页",
    combo: "escape",
    group: "reader",
  },
  // 图片
  {
    id: "next",
    label: "→ / PageDown",
    description: "下一张",
    combo: "arrowright",
    group: "image",
  },
  {
    id: "prev",
    label: "← / PageUp",
    description: "上一张",
    combo: "arrowleft",
    group: "image",
  },
  {
    id: "first",
    label: "Home",
    description: "第一张",
    combo: "home",
    group: "image",
  },
  {
    id: "last",
    label: "End",
    description: "最后一张",
    combo: "end",
    group: "image",
  },
  {
    id: "gotoPage",
    label: "G",
    description: "跳到指定张（输入数字回车）",
    combo: "g",
    group: "image",
  },
  {
    id: "mode1",
    label: "1",
    description: "显示模式：单张",
    combo: "1",
    group: "image",
  },
  {
    id: "mode2",
    label: "2",
    description: "显示模式：连续滚动",
    combo: "2",
    group: "image",
  },
  {
    id: "mode3",
    label: "3",
    description: "显示模式：双张并排",
    combo: "3",
    group: "image",
  },
  {
    id: "fit",
    label: "F",
    description: "图片适配循环（适应→按宽→按高→原始）",
    combo: "f",
    group: "image",
  },
  {
    id: "direction",
    label: "L",
    description: "翻页方向（左→右 / 右→左）",
    combo: "l",
    group: "image",
  },
  {
    id: "zoomIn",
    label: "+ / =",
    description: "放大",
    combo: "+",
    group: "image",
  },
  {
    id: "zoomOut",
    label: "-",
    description: "缩小",
    combo: "-",
    group: "image",
  },
  {
    id: "zoomReset",
    label: "0",
    description: "实际大小 / 重置",
    combo: "0",
    group: "image",
  },
  {
    id: "rotate",
    label: "R",
    description: "旋转 90°",
    combo: "r",
    group: "image",
  },
  {
    id: "slideshow",
    label: "Space",
    description: "幻灯片播放/暂停",
    combo: "space",
    group: "image",
  },
  {
    id: "info",
    label: "I",
    description: "图片信息",
    combo: "i",
    group: "image",
  },
  {
    id: "overview",
    label: "T",
    description: "打开目录（整本缩略图）",
    combo: "t",
    group: "image",
  },
  // 视频
  {
    id: "videoPlay",
    label: "Space / K",
    description: "播放 / 暂停",
    combo: "space",
    group: "video",
  },
  {
    id: "videoBack",
    label: "←",
    description: "倒退 5 秒",
    combo: "arrowleft",
    group: "video",
  },
  {
    id: "videoForward",
    label: "→",
    description: "快进 5 秒",
    combo: "arrowright",
    group: "video",
  },
  {
    id: "videoVolumeUp",
    label: "↑",
    description: "音量提高 10%",
    combo: "arrowup",
    group: "video",
  },
  {
    id: "videoVolumeDown",
    label: "↓",
    description: "音量降低 10%",
    combo: "arrowdown",
    group: "video",
  },
  {
    id: "videoMute",
    label: "M",
    description: "静音 / 取消静音",
    combo: "m",
    group: "video",
  },
  {
    id: "videoPrev",
    label: "PageUp",
    description: "上一个视频",
    combo: "pageup",
    group: "video",
  },
  {
    id: "videoNext",
    label: "PageDown",
    description: "下一个视频",
    combo: "pagedown",
    group: "video",
  },
  {
    id: "videoFirst",
    label: "Home",
    description: "第一个视频",
    combo: "home",
    group: "video",
  },
  {
    id: "videoLast",
    label: "End",
    description: "最后一个视频",
    combo: "end",
    group: "video",
  },
  // 照片墙与大图预览
  {
    id: "photoPrev",
    label: "←",
    description: "上一张",
    combo: "arrowleft",
    group: "photo",
  },
  {
    id: "photoNext",
    label: "→",
    description: "下一张",
    combo: "arrowright",
    group: "photo",
  },
  {
    id: "photoFirst",
    label: "Home",
    description: "第一张",
    combo: "home",
    group: "photo",
  },
  {
    id: "photoLast",
    label: "End",
    description: "最后一张",
    combo: "end",
    group: "photo",
  },
  {
    id: "photoZoomIn",
    label: "+ / =",
    description: "放大",
    combo: "+",
    group: "photo",
  },
  {
    id: "photoZoomOut",
    label: "-",
    description: "缩小",
    combo: "-",
    group: "photo",
  },
  {
    id: "photoZoomReset",
    label: "0",
    description: "恢复适应屏幕",
    combo: "0",
    group: "photo",
  },
  {
    id: "photoFullscreen",
    label: "F",
    description: "全屏切换",
    combo: "f",
    group: "photo",
  },
  {
    id: "photoInfo",
    label: "I",
    description: "切换图片信息面板",
    combo: "i",
    group: "photo",
  },
  {
    id: "photoClose",
    label: "Esc",
    description: "关闭预览，回到照片墙",
    combo: "escape",
    group: "photo",
  },
];

// 保留控件激活、文本编辑和输入法行为，避免页面快捷键重复处理事件。
export function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return true;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    )
  ) {
    return true;
  }
  return (
    (event.key === " " || event.key === "Enter") &&
    target.closest(
      'button, a[href], summary, [role="button"], [role="link"]',
    ) !== null
  );
}

// 规范化按键名为可比较字符串：ctrl+a / shift+arrowleft / F5 / space
export function normalizeKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");

  // 先归一特殊键名（+ / = / ? / 空格），再统一小写
  let k = e.key;
  // `?` 在 US 布局上是 Shift+/，但 AZERTY/QWERTZ 等布局可能是独立键。
  // 把它视作字面字符注册，忽略 shift 前缀；这样两种布局都能命中。
  if (k === "?") {
    parts.push("?");
    return parts.join("+");
  }
  if (k === " ") k = "space";
  // shift+= 在大多数键盘产生 e.key === '+'；handler 表里只用 '+'，
  // 旧实现会拼出 "shift+" 命中不到。这里把 + / = 统一归一为 '+'，
  // 并丢掉 shift 前缀（让 `+` / `=` 都能命中 '+' handler）。
  const isPlus = k === "+" || k === "=";
  if (isPlus) {
    k = "+";
  } else {
    k = k.toLowerCase();
    if (e.shiftKey) parts.push("shift");
  }
  parts.push(k);
  return parts.join("+");
}
