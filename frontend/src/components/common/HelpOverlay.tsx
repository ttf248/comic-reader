import { useEffect, useId, useRef, useState } from "react";
import {
  SHORTCUTS,
  type Shortcut,
  type ShortcutContext,
} from "../../utils/shortcuts";
import { useAppMode } from "../../hooks/useAppMode";
import { CloseIcon, SearchIcon, KeyboardIcon } from "./Icon";

interface Props {
  open: boolean;
  onClose: () => void;
  context: ShortcutContext;
  /**
   * 配色档：
   *   theme  —— 跟随应用主题（页面内的普通快捷键面板）
   *   reader —— 阅读器暗场。阅读器画布恒为深色，浅色卡片浮在上面就像
   *              "黑底里嵌了一块白板"；信息面板已经是暗的，菜单再是
   *              浅的，两块浮层自己就打架。
   */
  tone?: "theme" | "reader";
}

// 按当前页面显示全局操作，或阅读器共用操作及对应媒体操作。
const GROUP_ORDER: Array<{
  key: Shortcut["group"];
  title: string;
}> = [
  { key: "global", title: "全局" },
  { key: "photo", title: "照片墙" },
  { key: "reader", title: "阅读器" },
  { key: "image", title: "图片" },
  { key: "video", title: "视频" },
];

// 帮助浮层：可搜索的快捷键列表 + 分类。
// 视觉上：更大留白，单列紧凑列表；搜索框即时过滤。
//
// 数据源：直接消费 SHORTCUTS（按 group 字段分组）。新增/删除快捷键时，
// 只需修改 shortcuts.ts，HelpOverlay 自动同步。
export default function HelpOverlay({
  open,
  onClose,
  context,
  tone = "theme",
}: Props) {
  const [q, setQ] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const dark = tone === "reader";
  // 少数全局操作的措辞随工作台模式变化（照片工作台讲「未浏览」）。
  const { mode } = useAppMode();

  const describe = (s: Shortcut) =>
    s.modeDescriptions?.[mode] ?? s.description;

  // 只在某个工作台模式下存在的快捷键，在另一个模式下不列出：
  // 未读页属于漫画，照片模式下按 U 什么也不会发生。
  const inCurrentMode = (s: Shortcut) =>
    !s.modes || s.modes.includes(mode);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const previous = document.activeElement;
    dialog.showModal();
    searchRef.current?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        previous !== document.body
      ) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const lc = q.trim().toLowerCase();

  if (!open) return null;

  const matches = (s: Shortcut) => {
    if (!lc) return true;
    return (
      s.id.toLowerCase().includes(lc) ||
      describe(s).toLowerCase().includes(lc) ||
      s.label.toLowerCase().includes(lc)
    );
  };

  // 按 group 字段分组，渲染顺序由 GROUP_ORDER 决定
  // 照片墙是主页面的一种形态：全局操作照旧，再多一组大图预览的操作。
  const activeGroups: Shortcut["group"][] =
    context === "library"
      ? ["global"]
      : context === "photo"
        ? ["global", "photo"]
        : ["reader", context];
  const filteredGroups = GROUP_ORDER.filter((g) => activeGroups.includes(g.key))
    .map((g) => ({
      title: g.title,
      items: SHORTCUTS.filter(
        (s) => s.group === g.key && matches(s) && inCurrentMode(s),
      ),
    }))
    .filter((g) => g.items.length > 0);

  const total = filteredGroups.reduce((s, g) => s + g.items.length, 0);

  return (
    <dialog
      ref={dialogRef}
      data-tone={dark ? "reader" : undefined}
      className={`fixed inset-0 m-auto w-[680px] max-w-[94vw] max-h-[80dvh] overflow-hidden rounded-xl border p-0 shadow-lg scale-fade ${
        dark
          ? "border-overlay-border bg-overlay-panel text-overlay-fg backdrop:bg-overlay-scrim backdrop:backdrop-blur-sm"
          : "border-border bg-bg-elevated text-fg backdrop:bg-overlay-scrim backdrop:backdrop-blur-sm"
      }`}
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled)",
          ),
        ).filter(
          (control) =>
            control.tabIndex >= 0 && control.getClientRects().length > 0,
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (document.activeElement === (event.shiftKey ? first : last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="flex max-h-[80dvh] flex-col">
        <header
          className={`flex items-center justify-between px-6 h-14 border-b ${
            dark ? "border-white/10" : "border-border-faint"
          }`}
        >
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-accent-soft flex items-center justify-center text-accent">
              <KeyboardIcon size={14} />
            </div>
            <div>
              <h2 id={titleId} className="font-display text-[15px] font-semibold">
                快捷键
              </h2>
              <p
                className={`text-[12.5px] mt-0.5 ${
                  dark ? "text-white/60" : "text-fg-subtle"
                }`}
              >
                按 <kbd className={dark ? "kbd-light" : "kbd"}>?</kbd> 随时唤起
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors ${
              dark
                ? "text-white/60 hover:text-white hover:bg-white/10"
                : "text-fg-muted hover:text-fg hover:bg-bg-subtle"
            }`}
            aria-label="关闭"
          >
            <CloseIcon size={14} />
          </button>
        </header>

        <div
          className={`px-6 py-3 border-b ${
            dark ? "border-white/10" : "border-border-faint"
          }`}
        >
          <div
            className={`input-focus-ring flex items-center gap-2 rounded-md px-3 h-9 ${
              dark
                ? "bg-white/10 focus-within:bg-white/15 focus-within:border focus-within:border-white/25"
                : "bg-bg-subtle focus-within:bg-bg-elevated focus-within:border focus-within:border-border-strong"
            }`}
          >
            <SearchIcon
              size={13}
              className={`shrink-0 ${dark ? "text-white/50" : "text-fg-subtle"}`}
            />
            <input
              ref={searchRef}
              aria-label="搜索快捷键"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索快捷键…"
              className={`flex-1 h-full bg-transparent border-0 outline-none text-[13.5px] ${
                dark
                  ? "text-white placeholder:text-white/45"
                  : "placeholder:text-fg-subtle"
              }`}
            />
            {q && (
              <button
                onClick={() => {
                  setQ("");
                  searchRef.current?.focus({ preventScroll: true });
                }}
                className={`inline-flex h-7 items-center px-2 -mr-2 rounded text-[12.5px] transition-colors ${
                  dark
                    ? "text-white/60 hover:text-white hover:bg-white/10"
                    : "text-fg-subtle hover:text-fg hover:bg-bg-subtle"
                }`}
              >
                清除
              </button>
            )}
          </div>
        </div>

        {/* 列表可滚动，但 Windows 上的滚动条只在悬停时出现 ——
            底部渐隐让"下面还有"这件事看得见，而不是把最后一行切一半。 */}
        <div
          className={`flex-1 overflow-auto p-6 grid grid-cols-1 ${
            filteredGroups.length > 1 ? "md:grid-cols-2" : ""
          } gap-x-10 gap-y-6 scroll-thin [mask-image:linear-gradient(to_bottom,#000_calc(100%-24px),transparent)]`}
        >
          {total === 0 && (
            <div
              className={`col-span-full text-center text-[13px] py-12 ${
                dark ? "text-white/60" : "text-fg-muted"
              }`}
            >
              没有匹配「{q}」的快捷键
            </div>
          )}
          {filteredGroups.map((g) => (
            <div key={g.title}>
              <h3
                className={`text-[13px] font-semibold mb-3 ${
                  dark ? "text-white" : "text-fg"
                }`}
              >
                {g.title}
              </h3>
              <ul className="space-y-1">
                {g.items.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between text-[13px] py-1.5"
                  >
                    <span className={dark ? "text-white/75" : "text-fg-muted"}>
                      {describe(s)}
                    </span>
                    <kbd
                      className={`shrink-0 ml-3 ${dark ? "kbd-light" : "kbd"}`}
                    >
                      {s.label}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </dialog>
  );
}
