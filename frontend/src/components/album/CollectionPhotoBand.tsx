import { useMemo, useState } from "react";
import { useMediaFeed } from "../../hooks/useMediaFeed";
import { usePicks } from "../../hooks/usePicks";
import { useUIStore } from "../../store/uiStore";
import PhotoStrip from "../wall/PhotoStrip";
import PhotoViewer from "../wall/PhotoViewer";
import { albumRoute } from "../../utils/path";

interface Props {
  /** 集合的资源 ID。 */
  collectionId: string;
  /** 集合名：预览带没有内容时说清是哪个集合。 */
  collectionName: string;
}

/**
 * 集合页的照片带。
 *
 * 集合页原先只有一张裱起来的封面拼贴与一排子相册卡，读起来像
 * 「文件夹管理页」：先看图例，再看条目。这里补一条真正的照片带 ——
 * 直接把集合里各相册的照片铺出来，用户一眼看到的是内容，而不是
 * 内容长什么样。
 *
 * 照片带同时是快捷入口：点一张就打开大图，标题写清它出自哪本相册，
 * 点标题就回到那本。
 */
export default function CollectionPhotoBand({
  collectionId,
  collectionName,
}: Props) {
  const pushToast = useUIStore((s) => s.pushToast);
  const picks = usePicks();
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const query = useMemo(
    () =>
      ({
        kind: "photo" as const,
        scope: "collection" as const,
        parent: collectionId,
      }),
    [collectionId],
  );
  const feed = useMediaFeed(query);
  const items = feed.items;

  if (items.length === 0) return null;

  return (
    <section className="page-shell pt-8">
      <div className="section-heading">
        <h2 className="section-title">照片带</h2>
        <span className="section-meta">
          来自这里的 {feed.albums.length} 本相册
        </span>
      </div>
      <PhotoStrip
        items={items}
        targetHeight={200}
        maxRows={2}
        albumLabel={(item) => item.albumName}
        onOpen={(_item, index) => setViewerIndex(index)}
      />

      {viewerIndex !== null && items[viewerIndex] && (
        <PhotoViewer
          items={items}
          index={viewerIndex}
          albumName={items[viewerIndex].albumName || collectionName}
          albumHref={albumRoute("photo", items[viewerIndex].albumId)}
          totalCount={feed.total}
          onIndexChange={(index) => setViewerIndex(index)}
          onClose={() => setViewerIndex(null)}
          isPicked={picks.isPicked(items[viewerIndex].id)}
          onTogglePick={() => {
            const item = items[viewerIndex];
            if (!item) return;
            void picks
              .toggle(item.id)
              .catch(() =>
                pushToast({ kind: "error", message: "精选操作失败" }),
              );
          }}
        />
      )}
    </section>
  );
}
