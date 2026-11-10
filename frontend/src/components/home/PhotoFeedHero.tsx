import { useCallback, useMemo, useRef, useState } from "react";
import { useMediaFeed } from "../../hooks/useMediaFeed";
import { usePicks } from "../../hooks/usePicks";
import { useUIStore } from "../../store/uiStore";
import PhotoStrip from "../wall/PhotoStrip";
import PhotoViewer from "../wall/PhotoViewer";
import { ShuffleIcon } from "../common/Icon";
import { albumRoute } from "../../utils/path";

/**
 * 首页的照片墙：跨相册随手取一批照片铺成一面墙。
 *
 * 早先这一块是「随手看看」的相册面板：一张封面缩略图加两行字。照片
 * 本身被挤成了配角，首页看不见照片。现在它直接铺照片 —— 首页第一眼
 * 看见的就是照片本身，而不是关于照片的说明。
 *
 * 取的是随机相册而不是最近加入：随机才有「随手」的意思，连着几次
 * 进来看到的都是新的一批。
 *
 * 「换一批」换的是取材的种子而不是重新请求：同一个种子给同一批照片，
 * 换种子才真的换得掉 —— 重新请求有可能再抽到同一批相册，等于没换。
 */
export default function PhotoFeedHero() {
  const pushToast = useUIStore((s) => s.pushToast);
  const picks = usePicks();
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  // 种子带一个自增序号：连点两次「换一批」也不会撞回同一批。
  const seedCounter = useRef(0);

  const [seed, setSeed] = useState(() => `feed-${Date.now()}`);
  const feedQuery = useMemo(
    () => ({ kind: "photo" as const, scope: "random" as const, seed }),
    [seed],
  );
  // 换批次时保留上一批照片：新一批到达之前墙上不闪空。
  const feed = useMediaFeed(feedQuery, true, { keepPrevious: true });

  const reshuffle = useCallback(() => {
    seedCounter.current += 1;
    setSeed(`feed-${Date.now()}-${seedCounter.current}`);
  }, []);

  const togglePick = useCallback(
    (id: string) => {
      void picks
        .toggle(id)
        .catch(() => pushToast({ kind: "error", message: "精选操作失败" }));
    },
    [picks, pushToast],
  );

  const refreshing = feed.isFetching && feed.items.length > 0;

  return (
    <section className="page-shell pt-9" data-testid="photo-feed-hero">
      <div className="section-heading">
        <h2 className="section-title">随手看看</h2>
        <span className="section-meta">跨相册的照片</span>
        <button
          type="button"
          onClick={reshuffle}
          disabled={refreshing}
          className="chip ml-auto disabled:opacity-60"
          title="换一批照片"
        >
          <ShuffleIcon size={12} />
          <span>{refreshing ? "换一批…" : "换一批"}</span>
        </button>
      </div>

      {feed.items.length === 0 && !feed.isLoading ? (
        <p className="pb-4 text-body text-fg-muted">照片库还是空的。</p>
      ) : (
        <PhotoStrip
          items={feed.items}
          targetHeight={190}
          maxRows={2}
          albumLabel={(item) => item.albumName}
          onOpen={(_item, index) => setViewerIndex(index)}
        />
      )}

      {viewerIndex !== null && feed.items[viewerIndex] && (
        <PhotoViewer
          items={feed.items}
          index={viewerIndex}
          /* 这一墙的照片来自不同相册：标题说清出处，
             点一下就回到那本。 */
          albumName={feed.items[viewerIndex].albumName}
          albumHref={albumRoute("photo", feed.items[viewerIndex].albumId)}
          totalCount={feed.items.length}
          onIndexChange={(index) => setViewerIndex(index)}
          onClose={() => setViewerIndex(null)}
          isPicked={picks.isPicked(feed.items[viewerIndex].id)}
          onTogglePick={() => togglePick(feed.items[viewerIndex].id)}
        />
      )}
    </section>
  );
}
