import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useSearchStore } from "../store/searchStore";
import { useUIStore } from "../store/uiStore";
import { useUnreadAlbums } from "../hooks/useUnreadAlbums";
import { useGalleryContextSync } from "../hooks/useGalleryContextSync";
import AlbumGrid from "../components/album/AlbumGrid";
import { ListFilterBar } from "../components/common/ListFilterBar";
import EmptyState from "../components/common/EmptyState";
import { SparkleIcon, ShuffleIcon } from "../components/common/Icon";
import type { GalleryContextEntry } from "../utils/galleryContext";
import { albumRoute } from "../utils/path";
import { compareDatesDesc } from "../utils/date";

// 未读列表:跟 Recents / Favorites 同形,但源数据是「还没翻开过的相册」。
//
// 设计目标:
//  1. 一眼看到「还有 N 本没看」,鼓励往下翻
//  2. 提供「随机一本未读」快捷按钮,直接跳进第一本 — 配合用户「随便翻翻」
//     的核心场景
//  3. 全部看完时给一个明确「🎉 看完了」空态,而不是灰底 placeholder
export default function Unread() {
  const navigate = useNavigate();
  const viewMode = useUIStore((s) => s.viewMode);
  const query = useSearchStore((s) => s.query);
  const sortBy = useSearchStore((s) => s.sortBy);
  const minImageCount = useSearchStore((s) => s.minImageCount);
  const pushToast = useUIStore((s) => s.pushToast);
  const { cards, count, total, isLoading } = useUnreadAlbums();

  const filtered = useMemo(() => {
    const list = cards
      .filter((it) => {
        if (!query) return true;
        const q = query.toLowerCase();
        return `${it.title} ${it.subtitle ?? ""}`.toLowerCase().includes(q);
      })
      // 最小图数过滤(全局 filter)
      .filter((it) => {
        if (minImageCount <= 0) return true;
        return (it.count ?? 0) >= minImageCount;
      });
    switch (sortBy) {
      case "count":
        return list.sort((a, b) => b.count - a.count);
      case "name":
        return list.sort((a, b) => a.title.localeCompare(b.title));
      case "recent":
        return list.sort(
          (a, b) =>
            compareDatesDesc(a.modTime, b.modTime) ||
            a.title.localeCompare(b.title),
        );
      case "viewed":
      default:
        return list;
    }
  }, [cards, query, sortBy, minImageCount]);

  // 跨卷翻页(N / P)需要这个 list,跟 Recents/Favorites 一致
  const entries = useMemo<GalleryContextEntry[]>(
    () => filtered.map((c) => ({ key: c.to, to: c.to, name: c.title })),
    [filtered],
  );
  useGalleryContextSync({ type: "unread" }, entries);

  function onShuffleUnread() {
    if (filtered.length === 0) {
      pushToast({ kind: "info", message: "没有未读相册可跳" });
      return;
    }
    const pick = filtered[Math.floor(Math.random() * filtered.length)];
    navigate(albumRoute(pick.to.replace(/^\/albums\//, "")));
  }

  return (
    <div className="min-h-full">
      <section className="px-6 lg:px-10 pt-10 pb-6 max-w-[1400px] mx-auto w-full">
        <div className="flex items-center gap-2 mb-1">
          <SparkleIcon size={13} className="text-fg-muted" />
          <span className="text-[11px] uppercase tracking-[0.14em] text-fg-muted">
            未读
          </span>
        </div>
        <h1 className="font-display text-[32px] leading-[1.1] font-semibold tracking-tight">
          未读相册
        </h1>
        <p className="text-sm text-fg-muted mt-2 tabular-nums flex items-center gap-3 flex-wrap">
          <span>
            还有 <span className="text-fg">{count}</span> 本没看
            <span className="text-fg-subtle/60 mx-1.5">·</span>
            全库 <span className="text-fg">{total}</span> 本
          </span>
          {count > 0 && (
            <button
              onClick={onShuffleUnread}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-accent/40 text-accent hover:bg-accent/10 text-xs transition-colors"
              title="从未读里随机挑一本"
            >
              <ShuffleIcon size={11} />
              随机一本未读
            </button>
          )}
        </p>
      </section>

      {count > 0 && <ListFilterBar totalCount={filtered.length} />}

      {isLoading && count === 0 ? (
        <div className="px-6 lg:px-10 max-w-[1400px] mx-auto text-sm text-fg-muted">
          加载中…
        </div>
      ) : count === 0 ? (
        <EmptyState
          title={total === 0 ? "尚未加载图像库" : "全部看完啦 🎉"}
          description={
            total === 0
              ? "先去设置里指定一个媒体根目录,然后回来扫一遍就有了。"
              : "未读列表为空,可以在「主页」随机翻一卷,或去「收藏」里找回老朋友。"
          }
          icon={<SparkleIcon size={20} />}
          action={
            total === 0 ? (
              <button
                onClick={() => navigate("/settings")}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-accent text-accent-fg hover:bg-accent-hover text-sm"
              >
                去设置
              </button>
            ) : (
              <button
                onClick={() => navigate("/")}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md border border-border hover:bg-bg-subtle text-sm"
              >
                回主页
              </button>
            )
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="没有匹配的未读相册"
          description={query ? `没有匹配"${query}"的结果` : ""}
          action={
            <button
              onClick={() => useSearchStore.getState().reset()}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md border border-border hover:bg-bg-subtle text-sm"
            >
              清除筛选
            </button>
          }
        />
      ) : (
        <section className="max-w-[1400px] mx-auto w-full">
          <div className="px-6 lg:px-10 pb-10">
            <AlbumGrid items={filtered} variant={viewMode} />
          </div>
        </section>
      )}
      <div className="h-12" />
    </div>
  );
}
