import { useEffect, useMemo } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchStore } from "../store/searchStore";
import { useFavorites } from "../hooks/useFavorites";
import { useGalleryContextSync } from "../hooks/useGalleryContextSync";
import { historyApi } from "../api/prefs";
import { useViewedSort } from "../hooks/useHistory";
import { ListFilterBar } from "../components/common/ListFilterBar";
import ViewedSortNotice from "../components/common/ViewedSortNotice";
import { syncHistoryCache } from "../utils/historyCache";
import { useUIStore } from "../store/uiStore";
import type { CardData } from "../components/album/AlbumGrid";
import AlbumGrid from "../components/album/AlbumGrid";
import AlbumGridSkeleton from "../components/album/AlbumGridSkeleton";
import YearTimeline from "../components/home/YearTimeline";
import {
  groupAlbumsAndCollectionsByYear,
  type AlbumLike,
  type CollectionLike,
} from "../utils/albumGrouping";
import EmptyState from "../components/common/EmptyState";
import { albumRoute, decodeFavPath, decodePathTail, homeRoute, readerRoute } from "../utils/path";
import { collectionUnit, workbenchCopy } from "../utils/workbench";
import CardCover from "../components/album/CardCover";
import { useAppMode } from "../hooks/useAppMode";
import { useSafeBack } from "../utils/navigation";
import { compareDatesDesc } from "../utils/date";
import { ChevronLeftIcon, StarIcon } from "../components/common/Icon";
import PhotoAlbum from "./PhotoAlbum";
import {
  LibraryRevisionChangedError,
  type ContentKind,
  type LibraryNodeSummary,
} from "../api/library";
import { useLibraryChildren, useLibraryNodes } from "../hooks/useLibrary";
import type { GalleryContextEntry } from "../utils/galleryContext";

interface CollectionDetail {
  path: string;
  name: string;
  displayName?: string;
  sourceRoot?: string;
  sourceName?: string;
  modTime?: string;
  coverImage: string;
  coverImages?: string[];
  imageCount: number;
  videoCount: number;
  albums: AlbumLike[];
  collections: CollectionLike[];
  /**
   * 集合的内容属性：照片「本」，漫画「卷」。
   * 集合继承所属目录的属性，计数单位跟着那一侧走。
   */
  contentKind: ContentKind;
}

function toAlbumLike(summary: LibraryNodeSummary): AlbumLike {
  return {
    path: summary.id,
    name: summary.name,
    displayName: summary.displayName,
    imageCount: summary.imageCount ?? 0,
    videoCount: summary.videoCount,
    coverImage: summary.coverImage ?? "",
    coverKind: summary.coverKind,
    tags: summary.tags,
    sourceRoot: summary.sourceRoot,
    sourceName: summary.sourceName,
    virtual: summary.virtual,
    modTime: summary.modTime,
    contentKind: summary.contentKind,
  };
}

function toCollectionLike(summary: LibraryNodeSummary): CollectionLike {
  return {
    path: summary.id,
    name: summary.name,
    displayName: summary.displayName,
    albumCount: summary.albumCount ?? 0,
    imageCount: summary.imageCount,
    videoCount: summary.videoCount,
    coverImage: summary.coverImage,
    coverImages: summary.coverImages,
    sourceRoot: summary.sourceRoot,
    sourceName: summary.sourceName,
    contentKind: summary.contentKind,
  };
}

/**
 * 相册入口页。
 *
 * 三种落点：
 *  - 集合：继续浏览子相册（保留原有的目录浏览）；
 *  - 照片相册：直接进入照片墙，不再有「开始浏览」这一步；
 *  - 漫画相册：直接进入阅读器。
 *
 * 相册是哪种内容类型由服务端决定（它继承所属媒体根的属性），
 * 这里只负责按类型分派。
 */
export default function Album() {
  const location = useLocation();
  const navigate = useNavigate();
  const { mode } = useAppMode();
  // 返回：应用内还有历史就回退，否则回主页（直接打开相册链接时
  // navigate(-1) 会一路退出应用，停在空白页）。
  const goBack = useSafeBack(homeRoute(mode));
  const queryClient = useQueryClient();
  // 资源 ID 从原始路径切段并解码一次：useParams 已经解过一次，
  // 再解会把 ID 里的字面 %xx 破坏掉。
  const resourceID = decodePathTail(location.pathname, "/albums/");

  const query = useSearchStore((s) => s.query);
  const sortBy = useSearchStore((s) => s.sortBy);
  const viewMode = useUIStore((s) => s.viewMode);
  const { toggle: toggleFav, favorites } = useFavorites();
  const pushToast = useUIStore((s) => s.pushToast);

  const nodeIds = useMemo(() => (resourceID ? [resourceID] : []), [resourceID]);
  const nodeQuery = useLibraryNodes(nodeIds);
  const refetchNode = nodeQuery.refetch;
  const node = nodeQuery.data?.items[0];
  // 集合的子节点按集合自己的属性查：集合继承所属目录的属性，
  // 用当前工作台去查会把另一侧的成员过滤掉，集合看起来是空的。
  const childrenQuery = useLibraryChildren(
    node?.kind === "collection" ? node.id : "",
    node?.contentKind ?? mode,
    nodeQuery.data?.revision,
  );
  const revisionChanged =
    childrenQuery.error instanceof LibraryRevisionChangedError;

  useEffect(() => {
    if (revisionChanged) void refetchNode();
  }, [refetchNode, revisionChanged]);

  const detail = useMemo<CollectionDetail | null>(() => {
    if (!node || node.kind !== "collection") return null;
    if (!childrenQuery.data) return null;
    const albums: AlbumLike[] = [];
    const collections: CollectionLike[] = [];
    for (const child of childrenQuery.data.items) {
      if (child.kind === "album") albums.push(toAlbumLike(child));
      else collections.push(toCollectionLike(child));
    }
    return {
      path: node.id,
      name: node.name,
      displayName: node.displayName,
      sourceRoot: node.sourceRoot,
      sourceName: node.sourceName,
      modTime: node.modTime,
      coverImage: node.coverImage ?? "",
      coverImages: node.coverImages,
      imageCount: node.imageCount ?? 0,
      videoCount: node.videoCount ?? 0,
      albums,
      collections,
      contentKind: node.contentKind,
    };
  }, [childrenQuery.data, node]);

  const isLoading =
    revisionChanged || nodeQuery.isLoading || childrenQuery.isLoading;

  // 访问记录：相册被打开过就记一条，最近列表据此排序。
  const historyAlbumId = node?.kind === "album" ? node.id : "";
  const historyAlbumName =
    node?.kind === "album"
      ? node.virtual
        ? node.location || node.displayName || node.name
        : node.displayName || node.name
      : "";
  const historyImageCount = node?.kind === "album" ? node.imageCount ?? 0 : 0;
  useEffect(() => {
    if (!historyAlbumId) return;
    historyApi
      .add({
        albumId: historyAlbumId,
        name: historyAlbumName,
        imageCount: historyImageCount,
      })
      .then(({ history }) => syncHistoryCache(queryClient, history))
      .catch(() => {});
  }, [historyAlbumId, historyAlbumName, historyImageCount, queryClient]);

  // 相册页必须带资源 ID（/albums/<id>）。只到 /albums 时没有具体的东西
  // 可打开，回到工作台首页 —— 与其摆一个「找不到此文件夹」，不如给个
  // 能逛的地方。
  if (!resourceID) {
    return <Navigate to={homeRoute(mode)} replace />;
  }

  if (isLoading) {
    // 骨架而不是转圈：数据到达后卡片直接落在骨架的位置上，页面不会先
    // 空一段再整块跳出来。
    return <AlbumGridSkeleton variant={viewMode} label="正在加载文件夹" />;
  }

  if (!node) {
    return (
      <EmptyState
        title="找不到此文件夹"
        description="资源可能已移动，或者媒体库尚未完成扫描。"
        action={
          <button onClick={() => navigate("/")} className="btn btn-outline">
            返回主页
          </button>
        }
      />
    );
  }

  if (node.kind === "album") {
    // 漫画相册直接进入阅读器；照片相册直接进入照片墙。
    if (node.contentKind === "comic") {
      return <Navigate to={readerRoute(node.id)} replace />;
    }
    return <PhotoAlbum album={node} />;
  }

  if (!detail) {
    return (
      <EmptyState
        title="找不到此文件夹"
        description="资源可能已移动，或者媒体库尚未完成扫描。"
        action={
          <button onClick={() => navigate("/")} className="btn btn-outline">
            返回主页
          </button>
        }
      />
    );
  }

  const isFav = favorites.includes(detail.path);
  return (
    <CollectionView
      detail={detail}
      query={query}
      sortBy={sortBy}
      viewMode={viewMode}
      onBack={goBack}
      isFavorite={isFav}
      onToggleFav={async () => {
        try {
          await toggleFav(detail.path);
          pushToast({
            kind: "success",
            message: isFav ? "已取消收藏" : "已加入收藏",
          });
        } catch {
          pushToast({ kind: "error", message: "操作失败" });
        }
      }}
    />
  );
}

/**
 * 集合页的页头。
 *
 * 集合是「一堆相册」而不是一本相册，所以它的身份由封面拼贴 + 数量
 * 来说明：拼贴给出直观印象，数量给出规模，两者相邻才能一眼判断
 * 「这里有多少东西、值不值得点进去」。
 *
 * 数量说的是「这一页列出来的东西」：直属相册与直属子集合各算各的。
 * 服务端的 albumCount 是全部后代的相册数，拿它当页头数量会和下面的
 * 网格对不上（网格只列直属子项）——两处数字必须说同一件事。
 */
function CollectionHead({
  detail,
  isFavorite,
  onToggleFav,
  onBack,
}: {
  detail: CollectionDetail;
  isFavorite: boolean;
  onToggleFav: () => void;
  onBack: () => void;
}) {
  const copy = workbenchCopy(detail.contentKind);
  const albumCount = detail.albums.length;
  const collectionCount = detail.collections.length;
  // 集合在照片侧叫「集合」，在漫画侧叫「作品」—— 首页的作品索引也是
  // 同一个词。两处用同一个词，用户才认得出这是同一类东西。
  const isComic = detail.contentKind === "comic";
  return (
    <div className="page-shell page-heading">
      <button onClick={onBack} className="btn btn-sm btn-ghost mb-5 -ml-2">
        <ChevronLeftIcon size={13} />
        <span>返回</span>
      </button>
      <div className="detail-head">
        <div
          className={`detail-head__cover${
            isComic ? " detail-head__cover--book" : ""
          }`}
        >
          <CardCover
            data={{
              variant: "collection",
              title: detail.name,
              coverPath: detail.coverImage,
              covers: detail.coverImages,
            }}
          />
        </div>
        <div className="min-w-0">
          <p className="page-eyebrow">{isComic ? "作品" : "集合"}</p>
          <h1 className="detail-head__title mt-2">{detail.name}</h1>
          <div className="detail-head__meta">
            <span>
              <span className="detail-head__value">{albumCount}</span>{" "}
              {collectionUnit(detail.contentKind)}
            </span>
            {collectionCount > 0 && (
              <>
                <span className="text-fg-subtle">·</span>
                <span>
                  <span className="detail-head__value">{collectionCount}</span>{" "}
                  {isComic ? "个子作品" : "个子集合"}
                </span>
              </>
            )}
            {detail.imageCount > 0 && (
              <>
                <span className="text-fg-subtle">·</span>
                <span>
                  <span className="detail-head__value">
                    {detail.imageCount}
                  </span>{" "}
                  {copy.mediaUnit}
                </span>
              </>
            )}
            {detail.videoCount > 0 && (
              <>
                <span className="text-fg-subtle">·</span>
                <span>
                  <span className="detail-head__value">
                    {detail.videoCount}
                  </span>{" "}
                  个视频
                </span>
              </>
            )}
            {detail.sourceName && (
              <>
                <span className="text-fg-subtle">·</span>
                <span>来自 {detail.sourceName}</span>
              </>
            )}
          </div>
        </div>
        <div className="detail-head__actions">
          <button
            type="button"
            onClick={onToggleFav}
            className={`inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-body transition-colors ${
              isFavorite
                ? "bg-favorite/10 text-favorite hover:bg-favorite/15"
                : /* 页头很宽，按钮贴着最右边会被当成页脚的杂项。
                     给它一条实一点的描边与正文色，它才读得出是动作。 */
                  "border border-border hover:bg-bg-subtle text-fg"
            }`}
          >
            <StarIcon size={13} filled={isFavorite} />
            <span>{isFavorite ? "已收藏" : "收藏"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function CollectionView({
  detail,
  query,
  sortBy,
  viewMode,
  onBack,
  onToggleFav,
  isFavorite,
}: {
  detail: CollectionDetail;
  query: string;
  // 复用全局 SortKey:Album 详情也支持「最近看」('viewed' 用 history 排序)
  sortBy: "name" | "count" | "recent" | "viewed";
  viewMode: "grid" | "list";
  onBack: () => void;
  onToggleFav: () => void;
  isFavorite: boolean;
}) {
  // 集合:把直属于本层的 Albums + 嵌套子集合 Collections 都展平成统一
  // 的 CardData 列表渲染。子集合(5 层嵌套的中间层)用 variant=
  // 'collection' 区分,点击继续下钻。
  const allCards: CardData[] = useMemo(() => {
    const albumCards: CardData[] = detail.albums.map((a) => ({
      id: "a:" + a.path,
      variant: "album",
      // 散图在集合内已有父目录做上下文，标题回到语义名：否则 "2011年"
      // 集合里会出现一张同样叫 "2011年" 的卡片（location 就是父目录名）。
      // 标题用「散图」而不是服务端的「本目录媒体」：后者是技术叫法，
      // 在界面上读不出这是什么。
      title: a.virtual ? "散图" : a.name,
      subtitle: a.virtual ? "" : (a.tags ?? []).join(" · "),
      count: a.imageCount,
      imageCount: a.imageCount,
      videoCount: a.videoCount ?? 0,
      modTime: a.modTime,
      coverPath: a.coverImage,
      coverKind: a.coverKind,
      to: albumRoute(a.contentKind, a.path),
      sourceRoot: a.sourceRoot,
      sourceName: a.sourceName,
      // 集合里的相册要带上属性：漫画卷在集合里同样显示进度与已读完徽标。
      contentKind: a.contentKind,
    }));
    const collCards: CardData[] = detail.collections.map((sub) => {
      return {
        id: "c:" + sub.path,
        variant: "collection",
        title: sub.name,
        displayTitle: sub.displayName,
        subtitle: sub.contentKind === "comic" ? "子作品" : "子集合",
        count: sub.albumCount,
        coverPath: sub.coverImage ?? "",
        covers: sub.coverImages,
        to: albumRoute(sub.contentKind, sub.path),
        sourceRoot: sub.sourceRoot,
        sourceName: sub.sourceName,
        modTime: detail.modTime,
        contentKind: sub.contentKind,
      };
    });
    return [...albumCards, ...collCards];
  }, [detail]);
  const needsHistory = sortBy === "viewed" && detail.albums.length > 0;
  const { query: historyQuery, compareViewed } = useViewedSort(needsHistory);

  const filtered = useMemo(() => {
    const items = allCards.filter(
      (c) => !query || c.title.toLowerCase().includes(query.toLowerCase()),
    );
    switch (sortBy) {
      case "count":
        return items.sort((a, b) => b.count - a.count);
      case "recent":
        return items.sort(
          (a, b) =>
            compareDatesDesc(a.modTime, b.modTime) ||
            a.title.localeCompare(b.title),
        );
      case "viewed":
        return items.sort(
          (a, b) =>
            compareViewed(decodeFavPath(a.to), decodeFavPath(b.to)) ||
            a.title.localeCompare(b.title),
        );
      default:
        return items.sort((a, b) => a.title.localeCompare(b.title));
    }
  }, [allCards, query, sortBy, compareViewed]);

  const cards = filtered;

  // 子集合页时间线:对当前集合下的子 album/子 collection 重新分桶,跟首页视觉一致。
  const yearGroups = useMemo(() => {
    return groupAlbumsAndCollectionsByYear(detail.albums, detail.collections);
  }, [detail]);

  // 时间线只在「真的有年份可分」时才出现。
  //
  // 多数子集合(如 2024年、B站、散图)里的子相册并不带 4 位年份,
  // 全落进「其他」桶:一张大年卡加一个「其他」独占一整行,比例失衡,
  // 而且这一条索引筛不出任何东西——它是装饰,不是索引。
  // 至少两个真实年份桶才说明这批内容真的按年份铺开了。
  const realYearBuckets = yearGroups.filter((g) => g.year !== null).length;

  // 集合页面作为上下文源
  const collEntries = useMemo<GalleryContextEntry[]>(
    () =>
      cards.map((c) => ({
        key: c.to,
        to: c.to,
        name: c.title,
        // 集合下是子相册，不能直接翻页：跳本时要跳过它。
        kind: c.variant === "collection" ? "collection" : "album",
        imageCount: c.imageCount,
        videoCount: c.videoCount,
        contentKind: c.contentKind,
      })),
    [cards],
  );
  useGalleryContextSync(
    { type: "collection", parentPath: detail.path },
    collEntries,
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <CollectionHead
        detail={detail}
        isFavorite={isFavorite}
        onToggleFav={onToggleFav}
        onBack={onBack}
      />
      <div className="flex-1 min-h-0 overflow-auto">
        {needsHistory && <ViewedSortNotice query={historyQuery} />}
        <ListFilterBar totalCount={cards.length} showMinImageFilter={false} />
        {/* 时间线只在 ≥2 个真实年份桶时才有意义:
            - 大多数子集合(如 2023年、B站、散图)子相册基本不带 4 位年份,
              全部进「其他」桶,1 张大年卡独享一整行,视觉比例严重失衡。
            - 只有用户刻意把子相册命名成「2024国庆」之类,时间线才能
              真正按年分组,这时显示时间线才有用。 */}
        {realYearBuckets >= 2 && (
          <div className="py-6">
            <div className="page-shell flex items-center gap-3 mb-4">
              <h2 className="section-title">时间线</h2>
              <span className="section-meta">
                按年份浏览 — 当前集合下的子相册/子集合
              </span>
            </div>
            {/* 年份卡与下面的网格共用同一条左缘：这里少一层容器，
                整条索引会比网格左移一截。 */}
            <div className="page-shell">
              <YearTimeline groups={yearGroups} />
            </div>
          </div>
        )}

        {cards.length === 0 ? (
          <EmptyState
            title="无匹配结果"
            description="试试修改搜索条件或排序。"
          />
        ) : (
          /* 网格与页头共用同一条留白线：之前这里少了一层容器，
             卡片贴到了侧栏边上，与其它页面的左缘对不齐。 */
          <section className="page-shell">
            <div className="pb-10">
              <AlbumGrid items={cards} variant={viewMode} />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
