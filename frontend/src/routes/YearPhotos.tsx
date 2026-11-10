import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMediaFeed } from "../hooks/useMediaFeed";
import { usePicks } from "../hooks/usePicks";
import { useUIStore } from "../store/uiStore";
import { usePhotoStore, wallTargetHeight } from "../store/photoStore";
import PhotoWall from "../components/wall/PhotoWall";
import PhotoViewer from "../components/wall/PhotoViewer";
import ContextMenu from "../components/album/ContextMenu";
import EmptyState from "../components/common/EmptyState";
import { FolderIcon, GridIcon } from "../components/common/Icon";
import { albumRoute, homeRoute } from "../utils/path";

/**
 * 按年份浏览照片。
 *
 * 年份是照片工作台的一条主索引：用户想看「2024 年的照片」时，不必先
 * 猜中是哪一本相册、再一层层点进去。这一页直接把该年份下各相册的
 * 照片铺成一面墙，每张都带着它出自哪本相册，看完能一键回到原相册。
 *
 * 墙与相册里的照片墙是同一个组件 —— 排布规则、密度档位、悬停信息层
 * 都一致，用户不需要学第二套。
 */
export default function YearPhotos() {
  const { year = "" } = useParams();
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);
  const density = usePhotoStore((s) => s.density);
  const picks = usePicks();

  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    itemId: string;
    albumId: string;
  } | null>(null);

  const feedQuery = useMemo(
    () => ({ kind: "photo" as const, scope: "year" as const, year }),
    [year],
  );
  const feed = useMediaFeed(feedQuery);
  const items = feed.items;
  const total = feed.total;

  const label = year === "other" ? "其他年份" : `${year} 年`;

  const togglePick = useCallback(
    (id: string) => {
      void picks
        .toggle(id)
        .catch(() => pushToast({ kind: "error", message: "精选操作失败" }));
    },
    [picks, pushToast],
  );

  const loadMore = useCallback(() => {
    void feed.fetchNextPage({ cancelRefetch: false });
  }, [feed]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border-faint bg-bg">
        <div className="px-[clamp(20px,3vw,48px)]">
          <div className="album-bar">
            <div className="min-w-0 flex-1">
              {/* 眉标说清这一页是什么：年份是浏览入口，
                  与相册页的「这一本」不是一回事。 */}
              <p className="page-eyebrow">按年份浏览</p>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h1 className="album-bar__title truncate">{label}</h1>
                <div className="album-bar__meta tabular-nums">
                  <span>
                    <span className="text-fg font-medium">{total}</span> 张
                  </span>
                  {feed.albums.length > 0 && (
                    <>
                      <span className="text-fg-subtle">·</span>
                      <span>
                        来自{" "}
                        <span className="text-fg font-medium">
                          {feed.albums.length}
                        </span>{" "}
                        本相册
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* 回到照片库：年份页是首页那一条路的中段，
                  浏览器后退之外还要有一条明确的回路。 */}
              <button
                type="button"
                onClick={() => navigate(homeRoute("photo"))}
                className="btn btn-sm btn-outline"
              >
                照片库
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* 来源集合：年份对应的那个集合是这一页的「结构视图」——
          照片墙看的是内容，集合看的是它由哪几本相册组成。两条路
          各管一件事，入口摆在一起，用户不必猜哪一个是哪一个。 */}
      {feed.sources.length > 0 && (
        <div className="px-[clamp(20px,3vw,48px)] pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-meta text-fg-subtle">来源</span>
            {feed.sources.map((source) => (
              <Link
                key={source.id}
                to={albumRoute("photo", source.id)}
                className="chip hover:bg-bg-subtle"
              >
                <span>{source.name}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 px-[clamp(20px,3vw,48px)] pb-2">
        {feed.isError && items.length === 0 ? (
          <div className="flex h-full items-center justify-center text-body text-fg-muted">
            照片加载失败，请重试。
          </div>
        ) : items.length === 0 && !feed.isLoading ? (
          <EmptyState
            title={`${label}没有照片`}
            description="换一个年份看看，或者回照片库里挑一本相册。"
            dense
            action={
              <button
                className="btn btn-outline"
                onClick={() => navigate(homeRoute("photo"))}
              >
                回照片库
              </button>
            }
          />
        ) : (
          <PhotoWall
            items={items}
            total={total}
            targetHeight={wallTargetHeight(density)}
            hasNextPage={feed.hasNextPage ?? false}
            isLoadingMore={feed.isFetchingNextPage}
            onLoadMore={loadMore}
            onOpen={(_item, index) => setViewerIndex(index)}
            /* 跨相册的墙：照片要说出自己出自哪本相册，
               用户才知道自己看的是哪一本里的哪一张。 */
            albumLabel={(item) => item.albumName}
            isPicked={picks.isPicked}
            onTogglePick={(item) => togglePick(item.id)}
            onContextMenu={(item, event) => {
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              setContextMenu({
                x: event.clientX,
                y: event.clientY,
                itemId: item.id,
                albumId: item.albumId,
              });
            }}
          />
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            {
              id: "open",
              label: "查看大图",
              icon: <GridIcon size={12} />,
            },
            {
              id: "album",
              label: "在相册中打开",
              icon: <FolderIcon size={12} />,
            },
          ]}
          onSelect={(id) => {
            const menu = contextMenu;
            setContextMenu(null);
            if (id === "open") {
              const index = items.findIndex((it) => it.id === menu.itemId);
              if (index >= 0) setViewerIndex(index);
              return;
            }
            if (id === "album") {
              navigate(albumRoute("photo", menu.albumId));
            }
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {viewerIndex !== null && items[viewerIndex] && (
        <PhotoViewer
          items={items}
          index={viewerIndex}
          /* 年份墙的照片来自不同相册：标题给当前这张的出处。 */
          albumName={items[viewerIndex].albumName || label}
          /* 标题点一下就回到那本：这是「看年份」与「看相册」之间的桥。 */
          albumHref={albumRoute("photo", items[viewerIndex].albumId)}
          totalCount={total}
          onIndexChange={(index) => setViewerIndex(index)}
          onClose={() => setViewerIndex(null)}
          isPicked={picks.isPicked(items[viewerIndex].id)}
          onTogglePick={() => togglePick(items[viewerIndex].id)}
        />
      )}
    </div>
  );
}
