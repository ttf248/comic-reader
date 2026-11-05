import { useCallback, useEffect, useRef, useState } from "react";
import { imageUrl } from "../../api/images";
import { shouldIgnoreShortcut } from "../../utils/shortcuts";

interface Props {
  total: number;
  index: number;
  onJump: (i: number) => void;
  /** 可选：连续模式时用，标记「当前可视」图片列表（用于缩略图条）。 */
  images?: string[];
}

// 页数跳转条：
// - 左：页数输入（直接敲数字回车跳）
// - 中：横向拖拽进度条
// - 右：上一页 / 下一页按钮 + 「第 N / 总 M」
// - 拖拽时浮出 5-6 张缩略图条，让翻页所见即所得
// 设计目标：让 100+ 页的合集不再「翻到手酸」。
//
// 用词与全局一致：漫画侧的图片按「页」计数（相册卡片也写「X 页」），
// 照片侧才用「张」。
export default function PageSlider({ total, index, onJump, images }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const safeIndex = Math.max(0, Math.min(total - 1, index));
  const effective = scrubIndex ?? safeIndex;
  const pct = total > 1 ? (effective / (total - 1)) * 100 : 0;

  // 进入编辑态时预填当前页。
  //
  // 预填与进入编辑必须在同一次状态更新里完成：若等输入框挂载后再 setDraft，
  // 受控值会在下一次渲染写回 input.value，把光标顶到末尾，随后的 select()
  // 选中的其实还是旧值，用户的输入会被追加到预填值后面（"1" + "100" =
  // "1100"，跳到最后一页）。
  const startEditing = useCallback(() => {
    setDraft(String(safeIndex + 1));
    setEditing(true);
  }, [safeIndex]);

  // 输入框挂载后聚焦并全选：直接敲数字即覆盖预填值。
  useEffect(() => {
    if (!editing) return;
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
    return () => cancelAnimationFrame(id);
  }, [editing]);

  // 全局快捷键：G 进入输入态（与 vim/git 习惯一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || shouldIgnoreShortcut(e)) return;
      if (e.key === "g" && !editing) {
        e.preventDefault();
        startEditing();
      } else if (e.key === "Escape" && editing) {
        e.preventDefault();
        setEditing(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, startEditing]);

  function commit() {
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n)) {
      setEditing(false);
      return;
    }
    const clamped = Math.max(1, Math.min(total, n));
    onJump(clamped - 1);
    setEditing(false);
  }

  // 拖拽时把「最新 scrubIndex」同步写进 ref：onUp 闭包里读 ref，
  // 而不是闭包创建时的 scrubIndex（那个永远是 null —— React setState
  // 是异步的，el.addEventListener('pointerup', onUp) 在 pointerup 触发时
  // 看到的还是创建时的旧值，导致「拖到中段松手不跳转」）。
  const scrubIndexRef = useRef<number | null>(null);

  function onTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (total <= 1) return;
    const el = trackRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const update = (clientX: number) => {
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const ratio = rect.width === 0 ? 0 : x / rect.width;
      const i = Math.round(ratio * (total - 1));
      scrubIndexRef.current = i;
      setScrubIndex(i);
    };
    update(e.clientX);
    const onMove = (ev: PointerEvent) => update(ev.clientX);
    const onUp = (ev: PointerEvent) => {
      // 拖拽结束时真正跳转：从 ref 读最新值，避开闭包陷阱
      const finalIdx = scrubIndexRef.current;
      if (finalIdx !== null) onJump(finalIdx);
      scrubIndexRef.current = null;
      setScrubIndex(null);
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  // 缩略图条：拖拽时显示 5 张（当前 ± 2）；非拖拽时用当前页 + 1/2 截图概览
  const showStrip = scrubIndex !== null && images && images.length > 0;
  const strip = showStrip
    ? [-2, -1, 0, 1, 2]
        .map((d) => scrubIndex + d)
        .filter((i) => i >= 0 && i < images.length)
    : [safeIndex, Math.min(safeIndex + 1, total - 1)].filter(
        (i, idx, arr) => arr.indexOf(i) === idx,
      );

  return (
    <div className="relative h-11 flex items-center gap-3 px-3 sm:px-5 text-white/85 select-none scrim-bottom">
      {/* 缩略图条：拖拽时浮现 */}
      {showStrip && (
        <div
          className="absolute -top-[110px] left-1/2 -translate-x-1/2 z-10 flex items-end gap-1.5 pointer-events-none"
          aria-hidden
        >
          {strip.map((i) => {
            const isCenter = i === scrubIndex;
            return (
              <div
                key={i}
                className={`bg-overlay-panel border-2 rounded overflow-hidden shadow-lg transition-all ${
                  isCenter
                    ? "border-white scale-105"
                    : "border-white/30 opacity-80"
                }`}
                style={{ width: 56, height: 80 }}
              >
                {images[i] ? (
                  <img
                    src={imageUrl(images[i])}
                    alt={`第 ${i + 1} 页`}
                    className="w-full h-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="w-full h-full bg-overlay-panel-strong" />
                )}
              </div>
            );
          })}
          <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[12.5px] text-white/75 tabular-nums">
            第 {scrubIndex + 1} / {total} 页
          </div>
        </div>
      )}

      {/* 张数输入 / 显示 */}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          aria-label="跳转到第几页"
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          onBlur={commit}
          autoFocus
          className="w-12 h-7 px-1.5 text-center text-[12.5px] tabular-nums bg-overlay-panel/80 text-white rounded border border-overlay-border outline-none"
          inputMode="numeric"
        />
      ) : (
        <button
          onClick={startEditing}
          className="min-w-[44px] h-7 px-1.5 rounded text-[12.5px] tabular-nums text-white/85 hover:bg-white/10 transition-colors"
          title="跳转到指定页 (G)"
        >
          {safeIndex + 1}
        </button>
      )}
      <span className="text-white/70 text-[12.5px] tabular-nums">/ {total}</span>

      {/* 进度条 */}
      <div className="flex-1 relative h-9 flex items-center group">
        <div
          ref={trackRef}
          onPointerDown={onTrackPointerDown}
          className="relative h-1 w-full bg-white/15 rounded-full cursor-pointer group-hover:h-1.5 transition-all"
        >
          <div
            className="absolute left-0 top-0 h-full bg-white/85 rounded-full"
            style={{ width: `${pct}%` }}
          />
          {/* 拖动手柄 */}
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-md transition-transform"
            style={{
              left: `calc(${pct}% - 6px)`,
              transform:
                scrubIndex !== null
                  ? "translateY(-50%) scale(1.3)"
                  : "translateY(-50%)",
            }}
          />
        </div>
      </div>

      {/* 快捷键提示 */}
      <span className="text-[12.5px] text-white/55 hidden md:inline">
        <kbd className="kbd-light">G</kbd> 跳转
      </span>
    </div>
  );
}
