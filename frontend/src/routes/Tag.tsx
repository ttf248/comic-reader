import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, Navigate } from "react-router-dom";
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
  FolderSearchIcon,
} from "../components/common/Icon";
import { thumbUrl } from "../api/thumbs";
import type { GalleryContextEntry } from "../utils/galleryContext";
import { useTagAlbums } from "../hooks/useLibrary";
import { useAppMode } from "../hooks/useAppMode";
import { mediaCountParts } from "../utils/mediaCount";
import { nodeSummaryToCard } from "../utils/libraryCard";
import { decodePathTail, homeRoute } from "../utils/path";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { compareDatesDesc } from "../utils/date";
import { workbenchCopy } from "../utils/workbench";
import { useViewedSort } from "../hooks/useHistory";
import { ListFilterBar } from "../components/common/ListFilterBar";
import ViewedSortNotice from "../components/common/ViewedSortNotice";

// 标签页：展示一个标签下的全部文件夹，支持排序、阅读进度、收藏。
export default function Tag() {
  const location = useLocation();
  const navigate = useNavigate();
  // 从原始路径读取并只解码一次，保留标签名称中的字面 %xx。
  const tag = decodePathTail(location.pathname, "/tags/");

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
        parentName: c.parentName,
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

  // 标签页必须带标签名（/tags/<标签>）。只到 /tags 时没有标签可讲，
  // 回到工作台首页 —— 与其摆一个空的「标签：」，不如给个能逛的地方。
  if (!tag) {
    return <Navigate to={homeRoute(mode)} replace />;
  }

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
          {/* 页头与有内容时同一套：眉标说这是什么，标题就是标签名。
              原来写成「标签：xxx」——冒号加前缀像是表单字段，
              与有内容时的页头也不是一套。 */}
          <p className="page-eyebrow">由标签串起的故事</p>
          <h1 className="page-title page-title--sm break-words mt-1">
            {tag}
          </h1>
        </div>
        {/* 页头已经写着是哪个标签，空态再说一遍「未找到该标签」是同一句话
            说两次。这里只说结论，并给出下一步。 */}
        <EmptyState
          title="这个标签下没有相册"
          description="可能还没扫描到，或者标签名拼写有差异。"
          icon={<FolderSearchIcon size={20} />}
          action={
            <button
              onClick={() => navigate(homeRoute(mode))}
              className="btn btn-primary"
            >
              回到{workbenchCopy(mode).libraryTitle}
            </button>
          }
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
            <h1 className="page-title page-title--sm break-words">{tag}</h1>
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
                className={`inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md text-body transition-colors ${
                  isFav
                    ? "bg-favorite/10 text-favorite hover:bg-favorite/15"
                    : "bg-bg-elevated border border-border hover:bg-bg-subtle"
                }`}
              >
                <StarIcon size={13} filled={isFav} />
                <span>{isFav ? "已收藏" : "收藏标签"}</span>
              </button>
            </div>
            <div
              /* 统计三项收成一组：铺满整行时三列各自隔着一两百像素，
                 读起来像三处互不相干的数字，而不是这一页的三项事实。 */
              className={`mt-7 grid grid-cols-2 gap-x-7 gap-y-4 max-w-[560px] ${
                mode === "comic" ? "md:grid-cols-4" : "md:grid-cols-3"
              }`}
            >
              {" "}
              <Stat
                icon={<FolderIcon size={13} />}
                /* 词跟着侧走：标签下挂的是叶级相册，漫画侧的一叶是一卷，
                   计数单位说「卷」；照片侧说「相册」。 */
                label={mode === "comic" ? "卷数" : "相册数"}
                value={albums.length}
              />
              <Stat
                icon={<ReaderIcon size={13} />}
                label="总媒体"
                value={totalMedia}
                /* 拆分跟着侧走：照片说「张」，漫画说「页」——
                   漫画的媒体就是页，写「图片 13」既用错了词，也没有单位。
                   写法与卡片上的「19 张 · 1 个视频」同一套。 */
                detail={mediaCountParts({
                  imageCount: totalImages,
                  videoCount: totalVideos,
                  contentKind: mode,
                }).label}
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

      {/* 标签下的相册列表 */}
      <section aria-label="相册列表" className="page-shell pt-8 pb-10">
        {needsHistory && <ViewedSortNotice query={historyQuery} />}
        <ListFilterBar totalCount={cards.length} showMinImageFilter={false} />
        {filtered.length === 0 ? (
          <EmptyState
            /* 标签下挂的是叶级相册，两侧都叫「相册」——
               漫画侧写成「作品」会指向另一类东西。 */
            title="没有匹配的相册"
            description="试试修改搜索或排序条件。"
            /* 筛选条就在上面，空态紧跟着它说清楚即可。 */
            dense
          />
        ) : (
          <AlbumGrid items={cards} variant={viewMode} />
        )}
      </section>
    </div>
  );
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
      <div className="flex items-center gap-1.5 text-meta text-fg-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-section font-display font-semibold mt-1 tabular-nums">
        {value}
      </div>
      {detail && (
        <div className="text-meta text-fg-subtle mt-0.5">{detail}</div>
      )}
    </div>
  );
}
