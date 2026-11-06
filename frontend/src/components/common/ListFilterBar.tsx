import { useEffect, useId, useRef, useState } from "react";
import { useSearchStore, type SortKey } from "../../store/searchStore";
import { useUIStore } from "../../store/uiStore";
import { ChevronDownIcon, GridIcon, ListIcon, FilterIcon } from "./Icon";
import { useAppMode } from "../../hooks/useAppMode";
import type { AppMode } from "../../api/library";

// 共享 filter strip: 视图 chips (可选) + 总数 + 排序 + 视图模式
//
// 设计约定（与 .chip / .btn 共享组件层一致）：
// - 所有控件高度统一 30px，文字 13px，激活态 accent-soft + accent 字
// - 左：视图切换；右：最少图数 · 总数 · 排序 · 网格/列表
// - 控件之间用 gap-2 分组，不画分隔线，避免视觉噪声
interface ListFilterBarProps {
  // 视图 chips (全部 / 文件夹 / 集合 / 标签),不需要就传 undefined
  viewChips?: { key: string; label: string; count: number }[];
  // 当前激活的 view chip key
  activeViewKey?: string;
  onChangeView?: (key: string) => void;
  // 总数(用于 "共 N 项")
  totalCount: number;
  // 显示「最少图数」过滤(默认 true)。如果某页不希望显示(如纯 smart
  // 集合页,过滤不适用),传 false。
  showMinImageFilter?: boolean;
}

export function ListFilterBar({
  viewChips,
  activeViewKey,
  onChangeView,
  totalCount,
  showMinImageFilter = true,
}: ListFilterBarProps) {
  const sortBy = useSearchStore((s) => s.sortBy);
  const setSortBy = useSearchStore((s) => s.setSortBy);
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const minImageCount = useSearchStore((s) => s.minImageCount);
  const setMinImageCount = useSearchStore((s) => s.setMinImageCount);

  return (
    <div className="page-shell">
      <div className="filter-strip flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-1 flex-wrap min-w-0">
          {viewChips?.map((v) => {
            const active = activeViewKey === v.key;
            return (
              <button
                key={v.key}
                onClick={() => onChangeView?.(v.key)}
                aria-pressed={active}
                className="chip"
              >
                <span>{v.label}</span>
                <span className="tabular-nums text-meta opacity-70">
                  {v.count}
                </span>
              </button>
            );
          })}
          {/* 没有视图切换 chip 的页面（如未读 / 最近）：总数靠左，
              避免整条筛选条只剩右半边、左侧空一大片。 */}
          {!viewChips?.length && (
            <span className="text-meta text-fg-muted tabular-nums">
              共 {totalCount} 项
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {showMinImageFilter && (
            <MinImageFilter value={minImageCount} onChange={setMinImageCount} />
          )}
          {viewChips?.length ? (
            <span className="text-meta text-fg-muted tabular-nums">
              共 {totalCount} 项
            </span>
          ) : null}
          <SortMenu value={sortBy} onChange={setSortBy} />
          {/* 网格 / 列表：一条分段控件（跟主题切换同一套语言）。
              早先两个 30px 的方块各自带一圈边框，激活态只是把底色改成
              --bg-subtle，在浅色画布上几乎看不出差别 —— 两个图标悬在
              筛选条右端像两枚散落的方块。现在轨道有一个底，选中的那一段
              抬起来成为白底深色字。 */}
          <div
            role="group"
            aria-label="视图模式"
            className="inline-flex items-center shrink-0 rounded-md border border-border bg-bg-subtle/40 overflow-hidden"
          >
            <button
              onClick={() => setViewMode("grid")}
              title="网格"
              aria-label="网格视图"
              aria-pressed={viewMode === "grid"}
              className={`inline-flex items-center justify-center w-[34px] h-[32px] transition-colors ${
                viewMode === "grid"
                  ? "bg-bg-elevated text-fg shadow-xs"
                  : "text-fg-subtle hover:text-fg hover:bg-bg-subtle/60"
              }`}
            >
              <GridIcon size={14} />
            </button>
            <button
              onClick={() => setViewMode("list")}
              title="列表"
              aria-label="列表视图"
              aria-pressed={viewMode === "list"}
              className={`inline-flex items-center justify-center w-[34px] h-[32px] transition-colors ${
                viewMode === "list"
                  ? "bg-bg-elevated text-fg shadow-xs"
                  : "text-fg-subtle hover:text-fg hover:bg-bg-subtle/60"
              }`}
            >
              <ListIcon size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 排序项：按数量的说法跟着工作台走 —— 照片数「张」，漫画数「页」。
function sortOptions(mode: AppMode): { value: SortKey; label: string }[] {
  return [
    { value: "name", label: "按名称" },
    { value: "count", label: mode === "comic" ? "按页数" : "按张数" },
    { value: "recent", label: "按最近改" },
    { value: "viewed", label: "按最近看" },
  ];
}

function SortMenu({
  value,
  onChange,
}: {
  value: SortKey;
  onChange: (v: SortKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionsId = useId();
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (e.target instanceof Node && !ref.current?.contains(e.target))
        setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const { mode } = useAppMode();
  const options = sortOptions(mode);
  const cur = options.find((o) => o.value === value) ?? options[0];

  return (
    <div
      ref={ref}
      className="relative"
      onBlur={(e) => {
        if (
          !(e.relatedTarget instanceof Node) ||
          !e.currentTarget.contains(e.relatedTarget)
        ) {
          setOpen(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn btn-sm btn-outline"
        title="排序"
        aria-label="排序"
        aria-expanded={open}
        aria-controls={open ? optionsId : undefined}
      >
        <span>{cur.label}</span>
        <ChevronDownIcon size={11} />
      </button>
      {open && (
        <div
          id={optionsId}
          role="group"
          aria-label="排序选项"
          className="absolute right-0 top-full mt-1.5 min-w-[140px] bg-bg-elevated border border-border rounded-lg shadow-lg py-1 z-40 fade-up"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={o.value === value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className={`w-full text-left px-3 py-1.5 text-body transition-colors ${
                o.value === value
                  ? "text-fg font-medium"
                  : "text-fg-muted hover:bg-bg-subtle hover:text-fg"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// 最少图数过滤:小尺寸 inline 控件,带「≥」前缀和 Filter 图标。
//
// 未启用时只留一枚漏斗按钮:一排控件里杵着个「≥ 0」读不出任何意思,
// 0 本来就是「不过滤」。点一下才展开数字输入。
// 启用后(≥ N)保持完整形态,旁边一个「×」一键回到不过滤。
//
// 用 popover 数字步进 vs 直接 inline input:本项目用户调这个值的频次
// 极低(设一次就忘),inline 1 个 input 足够,不必为它做一个完整 popover。
function MinImageFilter({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const active = value > 0;
  const { mode } = useAppMode();
  // 计数单位跟着工作台走:照片说「张」,漫画说「页」。
  const unit = mode === "comic" ? "页" : "张";
  const label = `隐藏少于 N ${unit}的册`;
  const inputRef = useRef<HTMLInputElement>(null);
  // 漏斗按钮点开后输入框才挂上来，得主动把焦点送进去，
  // 否则用户还得再点一次才能输数字。
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);
  // 关闭编辑时把 draft 写回 store(允许"键入数字后点别处"这种 commit)
  function commit() {
    const n = parseInt(draft, 10);
    if (Number.isFinite(n) && n >= 0) onChange(n);
    else setDraft(String(value));
    setEditing(false);
  }
  // 未启用且没在编辑:只给一枚漏斗按钮。
  if (!active && !editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setEditing(true);
          setDraft("0");
        }}
        className="inline-flex items-center justify-center w-[34px] h-[34px] rounded-md border border-border text-fg-muted hover:bg-bg-subtle hover:text-fg transition-colors shrink-0"
        title={label}
        aria-label={`最少${unit}数`}
      >
        <FilterIcon size={12} className="shrink-0" />
      </button>
    );
  }
  return (
    <div
      className={`inline-flex items-center gap-1 h-[34px] px-2.5 rounded-md border transition-colors ${
        active
          ? "border-accent/40 bg-accent-soft text-accent"
          : "border-border text-fg-muted hover:bg-bg-subtle"
      }`}
      title={label}
    >
      <FilterIcon size={11} className="shrink-0" />
      <span className="text-meta whitespace-nowrap">≥</span>
      <input
        ref={inputRef}
        type="number"
        min={0}
        max={9999}
        value={editing ? draft : value}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
        onFocus={() => {
          setEditing(true);
          setDraft(String(value));
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setEditing(false);
            setDraft(String(value));
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-9 h-7 bg-transparent border-0 outline-none text-meta tabular-nums text-right focus:outline-none"
        aria-label={`最少${unit}数`}
      />
      {active && (
        <button
          onClick={() => onChange(0)}
          className="text-fg-subtle hover:text-fg text-body leading-none px-0.5"
          title="清除"
          aria-label="清除最小图数"
        >
          ×
        </button>
      )}
    </div>
  );
}
