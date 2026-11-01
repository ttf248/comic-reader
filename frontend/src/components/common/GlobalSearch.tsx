import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useSearchStore } from "../../store/searchStore";
import { SearchIcon } from "./Icon";
import { useDebounce } from "../../hooks/useDebounce";
import { albumsApi, type SearchHit } from "../../api/albums";
import { thumbUrl } from "../../api/thumbs";
import { albumRoute, tagRoute } from "../../utils/path";

// 全局搜索框：输入时显示下拉建议（来自后端 /api/search）。
//   - 空结果时返回静默，仅同步过滤本地视图
//   - 回车跳转主页
export default function GlobalSearch() {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounced = useDebounce(query, 200);
  const searchTerm = debounced.trim();
  const searchEnabled = searchTerm.length >= 2;
  const searchQuery = useQuery({
    queryKey: ["library", "search", searchTerm],
    queryFn: () => albumsApi.search(searchTerm, 10),
    enabled: searchEnabled,
    staleTime: 30_000,
    retry: false,
  });
  const hits = searchQuery.data?.results ?? [];

  useEffect(() => {
    setActiveIndex(hits.length > 0 ? 0 : -1);
  }, [searchTerm, hits.length]);

  function onPick(hit: SearchHit) {
    setOpen(false);
    setActiveIndex(-1);
    setQuery("");
    if (hit.kind === "smartCollection" && hit.path.startsWith("smart:")) {
      navigate(tagRoute(hit.path.slice("smart:".length)));
      return;
    }
    navigate(albumRoute(hit.path));
  }

  function moveActive(step: -1 | 1) {
    if (hits.length === 0) return;
    setOpen(true);
    setActiveIndex((index) => {
      const next = index < 0 ? (step > 0 ? 0 : hits.length - 1) : index + step;
      return (next + hits.length) % hits.length;
    });
  }

  return (
    <div className="relative w-full max-w-md">
      <div className="input-focus-ring flex items-center gap-2 bg-bg-subtle rounded-md px-3 h-9 focus-within:bg-bg-elevated focus-within:border focus-within:border-border-strong">
        <SearchIcon size={14} className="text-fg-subtle shrink-0" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            switch (e.key) {
              case "ArrowDown":
                e.preventDefault();
                moveActive(1);
                break;
              case "ArrowUp":
                e.preventDefault();
                moveActive(-1);
                break;
              case "Enter": {
                const activeHit = hits[activeIndex];
                if (open && activeHit) {
                  e.preventDefault();
                  onPick(activeHit);
                } else {
                  setOpen(false);
                  navigate("/");
                }
                break;
              }
              case "Escape":
                setOpen(false);
                setActiveIndex(-1);
                setQuery("");
                break;
            }
          }}
          placeholder="搜索文件夹 / 标签…"
          className="flex-1 bg-transparent border-0 outline-none text-sm placeholder:text-fg-subtle"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="global-search-results"
          aria-expanded={open && searchEnabled}
          aria-activedescendant={
            activeIndex >= 0 ? `global-search-result-${activeIndex}` : undefined
          }
        />
        <kbd className="hidden sm:inline-block kbd">/</kbd>
      </div>

      {open && hits.length > 0 && (
        <div
          id="global-search-results"
          role="listbox"
          className="absolute top-full left-0 right-0 mt-1.5 bg-bg-elevated border border-border rounded-lg shadow-lg overflow-hidden z-30 fade-up py-1"
        >
          {hits.map((h, index) => (
            <button
              key={h.path}
              onMouseDown={() => onPick(h)}
              id={`global-search-result-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`flex items-center gap-3 w-full px-3 py-2 text-left transition-colors ${
                index === activeIndex
                  ? "bg-bg-subtle text-fg"
                  : "hover:bg-bg-subtle"
              }`}
            >
              {h.coverImage ? (
                <img
                  src={thumbUrl(h.coverImage)}
                  alt=""
                  className="w-8 h-10 object-cover rounded border border-border-faint"
                />
              ) : (
                <div className="w-8 h-10 bg-bg-subtle rounded border border-border-faint" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{h.name}</div>
                <div className="text-[11px] text-fg-subtle truncate">
                  {h.kind === "album"
                    ? h.virtual
                      ? "本目录媒体"
                      : "文件夹"
                    : h.kind === "smartCollection"
                      ? "标签"
                      : "集合"}
                  {" · "}
                  {h.count} {h.kind === "album" ? "张" : "卷"}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 无结果提示：用户至少敲了 2 个字符才显示，避免抖动 */}
      {open && searchEnabled && searchQuery.isFetching && (
        <div className="absolute top-full left-0 right-0 mt-1.5 bg-bg-elevated border border-border rounded-lg shadow-lg overflow-hidden z-30 fade-up">
          <div className="px-3 py-2.5 text-[12px] text-fg-muted">搜索中…</div>
        </div>
      )}

      {open && searchEnabled && searchQuery.isError && !searchQuery.isFetching && (
        <div className="absolute top-full left-0 right-0 mt-1.5 bg-bg-elevated border border-border rounded-lg shadow-lg overflow-hidden z-30 fade-up">
          <div className="px-3 py-2.5 text-[12px] text-fg-muted">
            搜索暂不可用，请稍后重试
          </div>
        </div>
      )}

      {/* 无结果提示：用户至少敲了 2 个字符且请求完成才显示，避免把加载误报为无结果。 */}
      {open && searchEnabled && !searchQuery.isFetching && !searchQuery.isError && hits.length === 0 && (
        <div className="absolute top-full left-0 right-0 mt-1.5 bg-bg-elevated border border-border rounded-lg shadow-lg overflow-hidden z-30 fade-up">
          <div className="px-3 py-2.5 text-[12px] text-fg-muted">
            没有匹配「{searchTerm}」的文件夹或标签
          </div>
        </div>
      )}
    </div>
  );
}
