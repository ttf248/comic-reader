import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSearchStore } from "../store/searchStore";
import { useUIStore } from "../store/uiStore";
import { useFavorites } from "../hooks/useFavorites";
import { useImageActivities } from "../hooks/useImageActivity";
import type { LibraryNodeSummary } from "../api/library";
import { useGalleryContextSync } from "../hooks/useGalleryContextSync";
import AlbumGrid, { type CardData } from "../components/album/AlbumGrid";
import EmptyState from "../components/common/EmptyState";
import {
  ChevronLeftIcon,
  StarIcon,
  ReaderIcon,
  ClockIcon,
  FolderIcon,
} from "../components/common/Icon";
import { thumbUrl } from "../api/thumbs";
import type { GalleryContextEntry } from "../utils/galleryContext";
import { useTagAlbums } from "../hooks/useLibrary";
import { useAppMode } from "../hooks/useAppMode";
import { nodeSummaryToCard } from "../utils/libraryCard";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { compareDatesDesc } from "../utils/date";
import { useViewedSort } from "../hooks/useHistory";
import { ListFilterBar } from "../components/common/ListFilterBar";
import ViewedSortNotice from "../components/common/ViewedSortNotice";

// 标签页：展示一个标签下的全部文件夹，支持排序、阅读进度、收藏。
export default function Tag() {
  const location = useLocation();
  const navigate = useNavigate();
  // 从原始路径读取并只解码一次，保留标签名称中的字面 %xx。
  const tag = decodeTagPath(location.pathname);

  const query = useSearchStore((s) => s.query);
  const sortBy = useSearchStore((s) => s.sortBy);
  const viewMode = useUIStore((s) => s.viewMode);
  const { favorites, toggle } = useFavorites();
  const pushToast = useUIStore((s) => s.pushToast);

  const [coverIdx, setCoverIdx] = useState(0);
  const albumsQuery = useTagAlbums(tag);
  const { mode } = useAppMode();
  const reducedMotion = useReducedMotion();
  const albums = useMemo(
    () => albumsQuery.data?.items ?? [],
    [albumsQuery.data],
  );
  const needsHistory = sortBy === "viewed" && albums.length > 0;
  const { query: historyQuery, compareViewed } = useViewedSort(needsHistory);

  const totalImages = useMemo(
    () => albums.reduce((sum, album) => sum + (album.imageCount ?? 0), 0),
    [albums],
  );
  const totalVideos = useMemo(
    () => albums.reduce((sum, album) => sum + (album.videoCount ?? 0), 0),
    [albums],
  );
  const totalMedia = totalImages + totalVideos;

  const progressPaths = useMemo(
    () => albums.map((album) => album.id),
    [albums],
  );
  const { data: progressMap } = useImageActivities(progressPaths);
  // 阅读进度只属于漫画相册：照片目录下的相册没有进度可言。
  const activityFor = useCallback(
    (album: LibraryNodeSummary) =>
      album.contentKind === "comic" ? progressMap?.[album.id] : undefined,
    [progressMap],
  );
  const readCount = useMemo(() => {
    let count = 0;
    for (const album of albums) {
      if (activityFor(album)?.status === "completed") count++;
    }
    return count;
  }, [albums, activityFor]);

  const recentDate = useMemo(() => {
    const dates = albums.map((a) => a.modTime).filter(Boolean) as string[];
    if (dates.length === 0) return null;
    return dates.sort().reverse()[0];
  }, [albums]);

  const filtered = useMemo(() => {
    let list = albums;
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((a) => a.name.toLowerCase().includes(q));
    }
    switch (sortBy) {
      case "count":
        return [...list].sort(
          (a, b) => (b.imageCount ?? 0) - (a.imageCount ?? 0),
        );
      case "recent":
        return [...list].sort(
          (a, b) =>
            compareDatesDesc(a.modTime, b.modTime) ||
            a.name.localeCompare(b.name),
        );
      case "viewed":
        return [...list].sort(
          (a, b) => compareViewed(a.id, b.id) || a.name.localeCompare(b.name),
        );
      default:
        return [...list].sort((a, b) => a.name.localeCompare(b.name));
    }
  }, [albums, query, sortBy, compareViewed]);

  const cards: CardData[] = filtered.map((album) => {
    const activity = activityFor(album);
    return {
      ...nodeSummaryToCard(album),
      progress: activity
        ? {
            index: activity.pageIndex,
            total: album.imageCount ?? 0,
          }
        : undefined,
    };
  });

  // 标签页作为上下文源
  const tagEntries = useMemo<GalleryContextEntry[]>(
    () =>
      cards.map((c) => ({
        key: c.to,
        to: c.to,
        name: c.title,
        imageCount: c.imageCount,
        videoCount: c.videoCount,
        contentKind: c.contentKind,
      })),
    [cards],
  );
  useGalleryContextSync({ type: "tag", tag }, tagEntries);

  // 头图：随机从 6 张里挑（每隔 4s 切一张，类似走马灯）
  useEffect(() => {
    if (reducedMotion || albums.length <= 1) return;
    const id = setInterval(
      () => setCoverIdx((i) => (i + 1) % Math.min(albums.length, 6)),
      5000,
    );
    return () => clearInterval(id);
  }, [albums.length, reducedMotion]);

  const cover = albums.length > 0 ? albums[coverIdx % albums.length] : null;
  const isFav = favorites.includes(`smart:${tag}`);

  if (albumsQuery.isLoading) {
    return (
      <div className="p-6">
        <EmptyState title="正在加载标签" description="正在读取相册摘要…" />
      </div>
    );
  }

  if (albums.length === 0) {
    return (
      <div className="min-h-full">
        <div className="page-shell pt-8 pb-5">
          <button
            onClick={() => navigate(-1)}
            className="btn btn-sm btn-ghost mb-4"
          >
            <ChevronLeftIcon size={13} />
            <span>返回</span>
          </button>
          <h1 className="page-title">标签：{tag}</h1>
        </div>
        <EmptyState
          title="未找到该标签"
          description="可能未扫描或标签名拼写有差异。"
        />
      </div>
    );
  }

  return (
    <div className="min-h-full">
      <section className="page-shell page-heading">
        <div className="tag-feature">
          <div className="min-w-0">
            <p className="page-eyebrow mb-3">由标签串起的故事</p>
            <h1 className="page-title break-words">{tag}</h1>
            <div className="mt-4">
              {" "}
              <button
                onClick={() =>
                  toggle(`smart:${tag}`).then(() => {
                    pushToast({
                      kind: "success",
                      message: isFav ? "已取消收藏" : "已加入收藏",
                    });
                  })
                }
                className={`inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md text-sm transition-colors ${
                  isFav
                    ? "bg-warning/10 text-warning hover:bg-warning/15"
                    : "bg-bg-elevated border border-border hover:bg-bg-subtle"
                }`}
              >
                <StarIcon size={13} filled={isFav} />
                <span>{isFav ? "已收藏" : "收藏标签"}</span>
              </button>
            </div>
            <div className="mt-7 grid grid-cols-2 md:grid-cols-4 gap-x-7 gap-y-4">
              {" "}
              <Stat
                icon={<FolderIcon size={13} />}
                label="作品数"
                value={albums.length}
              />
              <Stat
                icon={<ReaderIcon size={13} />}
                label="总媒体"
                value={totalMedia}
                detail={`图片 ${totalImages} · 视频 ${totalVideos}`}
              />
              {/* 阅读进度只属于漫画工作台：照片目录下的相册没有
                  「读完」这个状态，这一格在照片模式下不出现。 */}
              {mode === "comic" && (
                <Stat
                  icon={<ClockIcon size={13} />}
                  label="已读完"
                  value={`${readCount}/${albums.length}`}
                />
              )}
              <Stat
                icon={<StarIcon size={13} />}
                label="最近更新"
                value={
                  recentDate
                    ? new Date(recentDate).toLocaleDateString("zh-CN")
                    : "—"
                }
              />
            </div>
          </div>
          {cover?.coverImage && (
            <div className="tag-feature__image">
              <img
                key={cover.id}
                src={thumbUrl(cover.coverImage)}
                alt=""
                className="w-full h-full object-cover"
              />
            </div>
          )}
        </div>
      </section>

      {/* 作品列表 */}
      <section aria-label="作品列表" className="page-shell pt-8 pb-10">
        {needsHistory && <ViewedSortNotice query={historyQuery} />}
        <ListFilterBar totalCount={cards.length} showMinImageFilter={false} />
        {filtered.length === 0 ? (
          <EmptyState
            title="没有匹配的作品"
            description="试试修改搜索或排序条件。"
          />
        ) : (
          <AlbumGrid items={cards} variant={viewMode} />
        )}
      </section>
    </div>
  );
}

function decodeTagPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname.slice("/tags/".length));
  } catch {
    return "";
  }
}

function Stat({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  detail?: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[12.5px] text-fg-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-lg font-display font-semibold mt-1 tabular-nums">
        {value}
      </div>
      {detail && (
        <div className="text-[12.5px] text-fg-subtle mt-0.5">{detail}</div>
      )}
    </div>
  );
}
