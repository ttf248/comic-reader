import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSearchStore } from "../store/searchStore";
import { useUIStore } from "../store/uiStore";
import { useFavorites } from "../hooks/useFavorites";
import { useImageActivities } from "../hooks/useImageActivity";
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
  const readCount = useMemo(() => {
    if (!progressMap) return 0;
    return progressPaths.filter((id) => progressMap[id]?.status === "completed")
      .length;
  }, [progressMap, progressPaths]);

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

  const cards: CardData[] = filtered.map((album) => ({
    ...nodeSummaryToCard(album),
    progress: progressMap?.[album.id]
      ? {
          index: progressMap[album.id].pageIndex,
          total: album.imageCount ?? 0,
        }
      : undefined,
  }));

  // 标签页作为上下文源
  const tagEntries = useMemo<GalleryContextEntry[]>(
    () =>
      cards.map((c) => ({
        key: c.to,
        to: c.to,
        name: c.title,
        imageCount: c.imageCount,
        videoCount: c.videoCount,
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
        <div className="px-6 lg:px-10 pt-8 pb-5">
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1 text-xs text-fg-subtle hover:text-fg mb-4 transition-colors"
          >
            <ChevronLeftIcon size={12} />
            <span>返回</span>
          </button>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            标签：{tag}
          </h1>
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
      {/* Hero — 头图 + 概览 */}
      <section className="relative">
        <div className="relative h-56 lg:h-72 overflow-hidden bg-bg-elevated">
          {cover?.coverImage && (
            <img
              key={cover.id}
              src={thumbUrl(cover.coverImage)}
              alt=""
              className="absolute inset-0 w-full h-full object-cover scale-fade"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/40 to-transparent" />
        </div>

        <div className="max-w-[1400px] mx-auto px-6 lg:px-10 -mt-20 relative z-10">
          <div className="flex items-end gap-6 flex-wrap">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.18em] text-fg-subtle font-medium mb-2">
                标签
              </div>
              <h1 className="font-display text-[36px] lg:text-[44px] leading-[1.05] font-semibold tracking-[-0.02em] text-fg">
                {tag}
              </h1>
            </div>
            <div className="flex items-center gap-2 mb-3">
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
          </div>

          {/* 数据条 */}
          <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-x-8 gap-y-3 max-w-2xl">
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
            <Stat
              icon={<ClockIcon size={13} />}
              label="已读"
              value={`${readCount}/${albums.length}`}
            />
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
      </section>

      {/* 作品列表 */}
      <section
        aria-label="作品列表"
        className="max-w-[1400px] mx-auto pt-8 pb-10"
      >
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
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-fg-subtle">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-lg font-display font-semibold mt-1 tabular-nums">
        {value}
      </div>
      {detail && (
        <div className="text-[10px] text-fg-subtle mt-0.5">{detail}</div>
      )}
    </div>
  );
}
