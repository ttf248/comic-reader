import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useGalleryStore } from "../store/galleryStore";
import { useKeyboard } from "../hooks/useKeyboard";
import { albumsApi } from "../api/albums";
import { historyApi } from "../api/prefs";
import { syncHistoryCache } from "../utils/historyCache";
import { activityApi, isActivityNotFound } from "../api/activity";
import { useUIStore } from "../store/uiStore";
import { useFavorites } from "../hooks/useFavorites";
import { libraryApi } from "../api/library";
import { libraryQueryKeys, useLibraryNodes } from "../hooks/useLibrary";
import { fsApi } from "../api/fs";
import { useFsCapabilities } from "../hooks/useFsCapabilities";
import { fileManagerErrorMessage } from "../utils/fileManager";
import { apiErrorMessage } from "../utils/apiError";
import { toggleFullscreen as toggleFullscreenImpl } from "../utils/fullscreen";
import ImageGallery from "../components/gallery/ImageGallery";
import VideoPlayer from "../components/gallery/VideoPlayer";
import PageSlider from "../components/gallery/PageSlider";
import ImageInfoPanel from "../components/gallery/ImageInfoPanel";
import HelpOverlay from "../components/common/HelpOverlay";
import GalleryHeader from "../components/gallery/GalleryHeader";
import GalleryToolbar from "../components/gallery/GalleryToolbar";
import GalleryAlbumNav from "../components/gallery/GalleryAlbumNav";
import ContextMenu, { type AnyMenuItem } from "../components/album/ContextMenu";
import {
  ImageIcon,
  RefreshIcon,
  ArrowUpRightIcon,
} from "../components/common/Icon";
import { displayedPageIndex } from "../utils/progress";
import { albumRoute } from "../utils/path";
import { useSafeBack } from "../utils/navigation";
import {
  getGalleryContext,
  entryReaderUrl,
  type GalleryContextEntry,
} from "../utils/galleryContext";
import { usePrefs } from "../hooks/usePrefs";
import { useVideoActivity } from "../hooks/useVideoActivity";

// 画廊页面：从 URL 读取 path/index/name。
// 关闭时持久化阅读进度到后端。
//
// 视觉：沉浸式画廊 — 暗色背景让图片突出，常驻 UI 只留顶部（返回/名称/页码）+ 顶部右侧
//（全屏/菜单），其余控件在鼠标移动时浮出，2s 无操作后自动隐藏。
export default function Gallery() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);
  const queryClient = useQueryClient();

  const pathParam = params.get("path") ?? "";
  const initialIndex = Math.max(
    0,
    Math.floor(Number(params.get("index") ?? 0) || 0),
  );
  // type=video 走 VideoPlayer；其它（含未传）走 ImageGallery。
  // 视频播放进度将在独立模型中持久化，不能复用相册的页码进度。
  const typeParam = (params.get("type") ?? "image") as "image" | "video";
  const isVideo = typeParam === "video";
  const isVideoRef = useRef(isVideo);
  isVideoRef.current = isVideo;

  const [images, setImages] = useState<string[]>([]);
  const [loadedImagePath, setLoadedImagePath] = useState("");
  // 视频文件列表（type=video 时使用）
  const [videos, setVideos] = useState<string[]>([]);
  const [loadedVideoPath, setLoadedVideoPath] = useState("");
  // 相册里"另一种媒体"的数量：图片模式 = 视频数，视频模式 = 图片数。
  // 序列播完时用它提示相册里还有别的媒体，避免用户误以为已经看完。
  const [siblingCount, setSiblingCount] = useState(0);
  const [imageActivityReadyPath, setImageActivityReadyPath] = useState("");
  const [continuousRange, setContinuousRange] = useState({
    path: "",
    startIndex: 0,
    endIndex: 0,
  });

  const index = useGalleryStore((s) => s.index);
  const setIndex = useGalleryStore((s) => s.setIndex);
  const slideshow = useGalleryStore((s) => s.slideshow);
  const slideshowInterval = useGalleryStore((s) => s.slideshowInterval);
  const toggleSlideshow = useGalleryStore((s) => s.toggleSlideshow);
  const mode = useGalleryStore((s) => s.mode);
  const setMode = useGalleryStore((s) => s.setMode);

  const [showInfo, setShowInfo] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // 右键菜单位置(阅读器内任意位置右键都触发)。
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // 「阅读到末尾自动切换下一本」「切换时显示通知」两个阅读偏好。
  // 未加载前按服务端默认值处理（都是开启）。
  const { data: prefs } = usePrefs();
  const autoSwitchAlbum = prefs?.autoSwitchAlbum ?? true;
  const showSwitchNotif = prefs?.showSwitchNotif ?? true;
  const [markingRead, setMarkingRead] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [progressFailure, setProgressFailure] = useState<{
    key: string;
    operation: "restore" | "save";
  } | null>(null);
  const [retryingProgress, setRetryingProgress] = useState(false);
  const finishedRef = useRef(false);
  // 持有「最新」index/total；sendBeacon 关闭时从这里取最新值。
  // 同时记录 path，只有 images 有效时才更新 — 避免切到新 album 的 loading
  // 阶段把 path 也更新成新的，导致 sendBeacon 发往错的 album。
  const progressRef = useRef<{ path: string; index: number; total: number }>({
    path: "",
    index: 0,
    total: 0,
  });
  // 记录「上一个」pathParam；切 album 时用它来保存上一个的进度，
  // 而不是用 effect 闭包里的新 pathParam（会写错位置）。
  const lastPathRef = useRef<string>("");

  // 浮层显隐：鼠标移动时显出，2s 无动作后自动隐藏。
  // 不影响顶部常驻条（始终可见）。
  const [chromeVisible, setChromeVisible] = useState(true);
  const idleTimerRef = useRef<number | null>(null);
  const markActive = useCallback(() => {
    setChromeVisible(true);
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = window.setTimeout(() => {
      setChromeVisible(false);
    }, 2500);
  }, []);

  useEffect(() => {
    markActive();
    const onMove = () => markActive();
    const onKey = () => markActive();
    // 触屏：mousemove 不会触发，需要单独监听 touchstart / pointerdown
    const onTouch = () => markActive();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onTouch);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onTouch);
      if (idleTimerRef.current !== null)
        window.clearTimeout(idleTimerRef.current);
    };
  }, [markActive]);

  const { favorites, toggle: toggleFavorite } = useFavorites();
  const isFav = pathParam ? favorites.includes(pathParam) : false;
  // 服务端是否允许打开系统文件管理器（配置项 allowOsOpen）。
  const allowOsOpen = useFsCapabilities();

  // 当前相册是否已有自定义封面。摘要索引和媒体清单都来自同一份目录快照，
  // 因此阅读器无需为这个小状态额外请求含完整媒体数组的相册详情。
  const [hasCustomCover, setHasCustomCover] = useState(false);
  const albumSummaryQuery = useLibraryNodes(pathParam ? [pathParam] : []);
  const albumSummary = albumSummaryQuery.data?.items.find(
    (item) => item.id === pathParam,
  );
  const name =
    albumSummary?.displayName ||
    albumSummary?.name ||
    params.get("name") ||
    "画廊";

  // 返回：优先回到应用内的上一页；没有可回退历史时回到当前相册页。
  // 直接打开阅读器链接（刷新、复制链接到新标签页）时，navigate(-1) 会
  // 一路退出应用停在空白页，必须有兜底。
  const goBack = useSafeBack(pathParam ? albumRoute(pathParam) : "/");
  // 当前展示的文件路径。Gallery 中段才计算 isVideo/images/videos/index → current，
  // 但 onSetCover 要读这个值。放进 ref 让 callback 拿到最新值而不需要把 current
  // 提前到 useCallback 之前（避免引入 forward reference）。
  const currentRef = useRef<string | null>(null);

  useEffect(() => {
    setHasCustomCover(Boolean(albumSummary?.hasCustomCover));
  }, [albumSummary?.hasCustomCover, pathParam]);

  // 拉图 + 恢复阅读进度：依赖 pathParam 变化。
  //
  // 重要：必须在 pathParam 每次变化时都重新拉图。从 Album A 导航到 Album B 时，
  // 旧 images 在切换相册时不能继续作为当前页：每次 path 变化或显式重试都
  // 必须重新拉取当前相册的媒体清单。
  const imagesReady = images.length > 0 && loadedImagePath === pathParam;
  const videosReady = videos.length > 0 && loadedVideoPath === pathParam;
  const ready = isVideo ? videosReady : imagesReady;
  const videoItemIndex = isVideo
    ? Math.max(0, Math.min(initialIndex, Math.max(0, videos.length - 1)))
    : 0;
  const currentVideo = isVideo ? videos[videoItemIndex] : undefined;
  const videoActivityKey =
    isVideo && pathParam && currentVideo
      ? JSON.stringify([pathParam, currentVideo])
      : "";
  const progressKey = JSON.stringify([pathParam, isVideo, currentVideo ?? ""]);
  const activeProgressKey = useRef(progressKey);
  activeProgressKey.current = progressKey;
  const reportProgressFailure = useCallback(
    (operation: "restore" | "save") => {
      if (activeProgressKey.current === progressKey) {
        setProgressFailure({ key: progressKey, operation });
      }
    },
    [progressKey],
  );
  const clearProgressFailure = useCallback(
    (operation: "restore" | "save") => {
      setProgressFailure((failure) =>
        failure?.key === progressKey && failure.operation === operation
          ? null
          : failure,
      );
    },
    [progressKey],
  );
  const imageActivityPageIndex = displayedPageIndex(
    mode,
    index,
    images.length,
    continuousRange.path === pathParam ? continuousRange : undefined,
  );
  const imageActivityWritable =
    !isVideo &&
    imagesReady &&
    imageActivityReadyPath === pathParam &&
    images.length > 0;

  useEffect(() => {
    if (!imageActivityWritable) return;
    progressRef.current = {
      path: pathParam,
      index: imageActivityPageIndex,
      total: images.length,
    };
  }, [imageActivityPageIndex, imageActivityWritable, images.length, pathParam]);

  useEffect(() => {
    if (!pathParam) return;
    let cancelled = false;
    // 切到新 album 前，先把上一个 album 的进度刷一次（去抖的 save 会因为
    // images.length 变 0 而被清理掉，主动写一次更稳）。
    // 关键：用 lastPathRef（上一个 pathParam），不是闭包里的新 pathParam。
    if (lastPathRef.current) {
      const previous = progressRef.current;
      if (previous.path === lastPathRef.current && previous.total > 0) {
        activityApi
          .setImage(previous.path, previous.index, previous.total)
          .catch(() => {});
      }
    }
    lastPathRef.current = pathParam;
    setLoadError(null);
    setImageActivityReadyPath("");
    setLoadedImagePath("");
    setLoadedVideoPath("");
    setContinuousRange({ path: "", startIndex: 0, endIndex: 0 });
    finishedRef.current = false;
    setImages([]);
    setVideos([]);
    setSiblingCount(0);
    libraryApi
      .allMedia(pathParam)
      .then((page) => {
        if (cancelled) return;
        const imageList = page.items
          .filter((item) => item.kind === "image")
          .map((item) => item.id);
        const videoList = page.items
          .filter((item) => item.kind === "video")
          .map((item) => item.id);
        setSiblingCount(isVideo ? imageList.length : videoList.length);
        if (isVideo) {
          if (videoList.length > 0) {
            setLoadedVideoPath(pathParam);
            setVideos(videoList);
          } else {
            setLoadError("EMPTY");
          }
        } else {
          if (imageList.length > 0) {
            setLoadedImagePath(pathParam);
            setImages(imageList);
          } else {
            setLoadError("EMPTY");
          }
        }
      })
      .catch((e) => {
        if (cancelled) return;
        // 后端 message 是英文机器文案：按错误码翻成中文，未知错误用兜底文案。
        setLoadError(apiErrorMessage(e, "无法读取媒体（网络或服务异常）"));
      });
    return () => {
      cancelled = true;
    };
  }, [pathParam, reloadKey, isVideo]);

  useEffect(() => {
    if (!ready) return;
    const list = isVideo ? videos : images;
    if (!isVideo) {
      setIndex(Math.max(0, Math.min(list.length - 1, initialIndex)));
    }
    // 切到新 album 时重置缩放/旋转（视频模式不需要；切视频时由
    // <video key=src> 自然重挂载）
    if (!isVideo) {
      useGalleryStore.getState().resetView();
    }
    if (!pathParam) return;
    // URL 显式带 index= 时表示「用户点了某张图/某条链接」,跳过 progress 恢复
    // — 否则会从后端图片活动拉出上次位置把 initialIndex 顶掉,
    // 导致「点任意图都跳到上次看到的那张」(Album 详情缩略图 / AlbumCard
    // hover preview 跳进来都会撞这个)。
    const hasExplicitIndex = params.has("index");
    if (hasExplicitIndex) {
      if (!isVideo) setImageActivityReadyPath(pathParam);
      return;
    }
    if (isVideo) return;
    let cancelled = false;
    activityApi
      .getImage(pathParam)
      .then((rp) => {
        if (cancelled) return;
        // pageIndex 表示已展示的最末页；双页模式恢复时对齐到跨页左侧。
        const pageIndex = Math.max(0, Math.min(list.length - 1, rp.pageIndex));
        const anchorIndex =
          useGalleryStore.getState().mode === "double"
            ? pageIndex - (pageIndex % 2)
            : pageIndex;
        setIndex(anchorIndex);
        setImageActivityReadyPath(pathParam);
        clearProgressFailure("restore");
      })
      .catch((error) => {
        if (!cancelled && isActivityNotFound(error)) {
          setImageActivityReadyPath(pathParam);
          clearProgressFailure("restore");
        } else if (!cancelled) {
          reportProgressFailure("restore");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pathParam, isVideo]);

  // 标题和图片总数来自相册摘要，不用 URL 提示或当前视频列表改写访问记录。
  const historyReady = ready && albumSummary?.kind === "album";
  const historyName = albumSummary?.displayName || albumSummary?.name || "";
  const historyImageCount = albumSummary?.imageCount ?? 0;
  useEffect(() => {
    if (!pathParam || !historyReady) return;
    historyApi
      .add({
        albumId: pathParam,
        name: historyName,
        imageCount: historyImageCount,
      })
      .then(({ history }) => syncHistoryCache(queryClient, history))
      .catch(() => {});
  }, [pathParam, historyName, historyImageCount, queryClient, historyReady]);

  // 防抖持久化阅读进度
  //
  // 这里不负责关闭信息面板：imageActivityPageIndex 在连续模式下取决于
  // 「可见区末页」，面板开合会改变画布宽度 → 可见区重排 → 该值跟着变，
  // 两者互相触发会让面板一打开就被关掉。关闭面板另由下面的 currentMediaId 驱动。
  useEffect(() => {
    // 视频的 currentTime 不是相册页码，写入独立的 video activity。
    if (!imageActivityWritable || !pathParam) return;
    const total = images.length;
    const t = setTimeout(() => {
      activityApi
        .setImage(pathParam, imageActivityPageIndex, total)
        .then(() => {
          clearProgressFailure("save");
          // 活动 API 会通知首页仪表盘刷新；这里同时让 Recents / Favorites
          // 的批量活动和 Album 详情缓存失效，回到列表/详情时立刻看到新进度。
          queryClient.invalidateQueries({
            queryKey: ["activity-query", "image"],
          });
          queryClient.invalidateQueries({
            queryKey: ["activity", "image", pathParam],
          });
        })
        .catch(() => reportProgressFailure("save"));
    }, 600);
    return () => clearTimeout(t);
  }, [
    imageActivityPageIndex,
    imageActivityWritable,
    pathParam,
    images.length,
    queryClient,
    clearProgressFailure,
    reportProgressFailure,
  ]);

  // 切换到另一张图片/另一个视频时关闭信息面板。
  //
  // 判据是「当前媒体的资源 ID」而不是页码：连续模式下画布宽度变化会让
  // 可见区末页跟着变，用页码当判据会导致面板一打开就被自己关掉。
  // 这里不能直接引用下面才声明的 `current`（const 有暂时性死区），
  // 所以按同样的规则在这里另算一份。
  const currentMediaId = (isVideo ? currentVideo : images[index]) ?? null;
  useEffect(() => {
    setShowInfo(false);
  }, [currentMediaId]);

  // 视频的播放位置（毫秒）由 useVideoActivity 单独管：恢复 → 节流写入 →
  // 补写，和图片的页码进度是两套模型。
  const videoActivity = useVideoActivity({
    isVideo,
    albumId: pathParam,
    itemId: currentVideo,
    ready: videosReady,
    activityKey: videoActivityKey,
    onRestored: () => clearProgressFailure("restore"),
    onRestoreFailed: () => reportProgressFailure("restore"),
    onSaved: () => clearProgressFailure("save"),
    onSaveFailed: () => reportProgressFailure("save"),
  });

  async function retryProgress() {
    if (retryingProgress) return;
    if (progressFailure?.operation === "restore") {
      setReloadKey((key) => key + 1);
      return;
    }
    setRetryingProgress(true);
    try {
      if (isVideo) {
        // 视频位置由 hook 自己落盘：成功时它会清掉提示，失败时上报。
        await videoActivity.retrySave();
        return;
      }
      const progress = progressRef.current;
      if (!imageActivityWritable || progress.path !== pathParam) return;
      await activityApi.setImage(progress.path, progress.index, progress.total);
      queryClient.invalidateQueries({
        queryKey: ["activity-query", "image"],
      });
      queryClient.invalidateQueries({
        queryKey: ["activity", "image", pathParam],
      });
      clearProgressFailure("save");
    } catch {
      reportProgressFailure("save");
    } finally {
      setRetryingProgress(false);
    }
  }

  const scrollContinuousTo = useCallback(
    (targetIndex: number) => {
      if (images.length === 0) return;
      // ImageGallery 通过 VirtuosoHandle 监听 store.index 并完成真实滚动；不再
      // 查询可能尚未被虚拟列表挂载的 DOM 节点。
      setIndex(Math.max(0, Math.min(images.length - 1, targetIndex)));
    },
    [images.length, setIndex],
  );

  const onContinuousVisibleRangeChange = useCallback(
    (startIndex: number, endIndex: number) => {
      if (useGalleryStore.getState().mode !== "continuous") return;
      if (images.length === 0) return;
      const nextStartIndex = Math.max(
        0,
        Math.min(images.length - 1, Math.floor(startIndex)),
      );
      const nextEndIndex = Math.max(
        nextStartIndex,
        Math.min(images.length - 1, Math.floor(endIndex)),
      );
      setContinuousRange({
        path: pathParam,
        startIndex: nextStartIndex,
        endIndex: nextEndIndex,
      });
      if (useGalleryStore.getState().index !== nextStartIndex) {
        setIndex(nextStartIndex);
      }
    },
    [images.length, pathParam, setIndex],
  );

  // 切到连续模式后,容器需要滚到当前 index 对应的那张图。
  // ImageGallery 挂载 Virtuoso 后需要用当前 index 完成首次定位，避免用户
  // (尤其从 saved progress 恢复)看到的是 index 0,跟 slider / 计数对不上。
  // 用 ref 标记只在「首次进入 continuous」时跑一次，后续切页由 index 驱动。
  // 注意:首次 mount 模式就是 continuous (galleryStore 从 localStorage 恢复)
  // 也要触发,所以不能用 prevModeRef (初始值就是 continuous,判断失效)。
  const continuousScrolledRef = useRef(false);
  useEffect(() => {
    if (
      !continuousScrolledRef.current &&
      mode === "continuous" &&
      imagesReady &&
      images.length > 0
    ) {
      continuousScrolledRef.current = true;
      // queueMicrotask 确保 Virtuoso ref 已挂载，再由 ImageGallery 滚到目标项。
      queueMicrotask(() => scrollContinuousTo(index));
    } else if (mode !== "continuous") {
      // 离开 continuous 后,允许下次再进入时重新滚一次
      continuousScrolledRef.current = false;
    }
  }, [mode, imagesReady, images.length, index, scrollContinuousTo]);

  // 滚到最后一张：自动标记为「已读」一次。
  useEffect(() => {
    if (isVideo) return;
    if (markingRead) return;
    if (!imageActivityWritable || !pathParam) return;
    if (imageActivityPageIndex < images.length - 1) {
      finishedRef.current = false;
      return;
    }
    if (finishedRef.current) return;
    finishedRef.current = true;
    setMarkingRead(true);
    activityApi
      .setImage(pathParam, images.length - 1, images.length)
      .then(() => {
        clearProgressFailure("save");
        pushToast({ kind: "success", message: "已读完 🎉", ttl: 1500 });
      })
      .catch(() => reportProgressFailure("save"))
      .finally(() => setMarkingRead(false));
  }, [
    imageActivityPageIndex,
    imageActivityWritable,
    images.length,
    pathParam,
    isVideo,
    markingRead,
    pushToast,
    clearProgressFailure,
    reportProgressFailure,
  ]);

  useEffect(() => {
    const flushCurrentActivity = () => {
      // 视频位置由 useVideoActivity 自己补写（它有独立的会话状态机）。
      if (isVideoRef.current) return;
      // pagehide 覆盖刷新/关闭页签；cleanup 覆盖 SPA 卸载。
      // 只发送已完成恢复、且属于当前相册的最后有效图片活动。
      const cur = progressRef.current;
      if (cur.path && cur.total > 0) {
        activityApi.keepalive({
          albumId: cur.path,
          mediaKind: "image",
          pageIndex: cur.index,
          pageCount: cur.total,
        });
        progressRef.current = { path: "", index: 0, total: 0 };
      }
    };
    window.addEventListener("pagehide", flushCurrentActivity);
    return () => {
      window.removeEventListener("pagehide", flushCurrentActivity);
      flushCurrentActivity();
    };
  }, []);

  useEffect(() => {
    const off = () => setShowHelp(true);
    window.addEventListener("gallery:open-help", off as EventListener);
    return () =>
      window.removeEventListener("gallery:open-help", off as EventListener);
  }, []);

  useEffect(() => {
    if (isVideo || !slideshow) return;
    const t = setInterval(() => {
      const cur = useGalleryStore.getState().index;
      const step = mode === "double" ? 2 : 1;
      if (cur + step < images.length) {
        setIndex(cur + step);
      } else {
        // 末尾:对齐手动 next() 的反馈(避免幻灯片 loop 回 0 与
        // 手动翻页的"已是最后一张"行为割裂),toast + 自动停。
        onReachEnd();
      }
    }, slideshowInterval);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo, slideshow, slideshowInterval, images.length, setIndex, mode]);

  // 视频项由 URL 的 index 参数定位（以 initialIndex 为真相源），
  // 切视频必须改 URL 的 index 参数，
  // 用 replace:true 避免一路 next 把 history 撑爆。
  const goToVideo = useCallback(
    (targetIdx: number) => {
      if (!isVideo) return;
      const i = Math.max(0, Math.min(videos.length - 1, targetIdx));
      const next = new URLSearchParams(params);
      next.set("index", String(i));
      navigate(`/gallery?${next.toString()}`, { replace: true });
    },
    [isVideo, videos.length, params, navigate],
  );

  function prev() {
    if (isVideo) {
      const cur = Math.max(
        0,
        Math.min(initialIndex, Math.max(0, videos.length - 1)),
      );
      if (cur > 0) goToVideo(cur - 1);
      return;
    }
    if (mode === "continuous") {
      scrollStep(-1);
      return;
    }
    if (mode === "double") {
      if (index > 0) setIndex(Math.max(0, index - 2));
    } else if (index > 0) {
      setIndex(index - 1);
    }
  }
  // 已到末尾的统一反馈：toast + 自动停幻灯片。
  // 用 ref 持有,避免 setInterval 闭包捕获旧的 onReachEnd 引用
  // (slideshow effect 的 deps 不包含 pushToast/toggleSlideshow,这些会
  // 因 user 操作 stale,但回调需要读最新 store + push 最新 toast)。
  const onReachEndRef = useRef<() => void>(() => {});
  onReachEndRef.current = () => {
    // 「阅读到末尾自动切换下一本」：读完直接进入上下文里的下一本相册，
    // 幻灯片也跟着继续（不当作异常终止）。
    if (
      autoSwitchAlbum &&
      goAdjacent(1, { notify: showSwitchNotif, albumsOnly: true })
    ) {
      return;
    }
    pushToast({
      kind: "info",
      message: isVideo
        ? siblingCount > 0
          ? `已是最后一个视频 · 相册里另有 ${siblingCount} 张图片`
          : "已是最后一个视频"
        : siblingCount > 0
          ? `图片已看完 · 还有 ${siblingCount} 个视频`
          : "已是最后一张",
      ttl: 1500,
    });
    if (useGalleryStore.getState().slideshow) {
      toggleSlideshow();
      pushToast({ kind: "info", message: "幻灯片已自动停止" });
    }
  };
  const onReachEnd = useCallback(() => onReachEndRef.current(), []);

  function next() {
    if (isVideo) {
      const cur = Math.max(
        0,
        Math.min(initialIndex, Math.max(0, videos.length - 1)),
      );
      if (cur < videos.length - 1) {
        goToVideo(cur + 1);
        return;
      }
      onReachEnd();
      return;
    }
    if (mode === "continuous") {
      scrollStep(1);
      return;
    }
    if (mode === "double") {
      if (index + 2 < images.length) {
        setIndex(index + 2);
        return;
      }
      if (index < images.length - 1) {
        setIndex(Math.max(0, images.length - 2));
        return;
      }
      onReachEnd();
      return;
    }
    if (index < images.length - 1) {
      setIndex(index + 1);
      return;
    }
    onReachEnd();
  }

  function scrollStep(dir: -1 | 1) {
    const container = document.querySelector(
      "[data-image-gallery]",
    ) as HTMLDivElement | null;
    if (!container) return;
    const delta = container.clientHeight * 0.9 * dir;
    container.scrollBy({ top: delta, behavior: "smooth" });
  }

  const jumpTo = useCallback(
    (zeroBased: number) => {
      if (isVideo) {
        goToVideo(zeroBased);
        return;
      }
      const i = Math.max(0, Math.min(images.length - 1, zeroBased));
      setIndex(i);
      // continuous 模式：setIndex 不会自动滚动，单独触发一次
      if (useGalleryStore.getState().mode === "continuous") {
        scrollContinuousTo(i);
      }
    },
    [isVideo, images.length, scrollContinuousTo, setIndex, goToVideo],
  );

  // 跳本：上一本 / 下一本。
  //
  // - 相册继续在阅读器里读（不必回到相册首页再点「开始浏览」）；
  //   集合没有阅读器入口，回到它的首页。
  // - notify=false 时不弹「下一本：xxx」提示（跟随「切换时显示通知」设置）。
  // - albumsOnly=true 时跳过集合，只找相册（自动切换下一本用）。
  const goAdjacent = useCallback(
    (
      direction: 1 | -1,
      options?: { notify?: boolean; albumsOnly?: boolean },
    ) => {
      const notify = options?.notify ?? true;
      const albumsOnly = options?.albumsOnly ?? false;
      const ctx = getGalleryContext();
      if (!ctx || ctx.list.length <= 1 || !pathParam) {
        if (notify) {
          pushToast({
            kind: "info",
            message: "当前无可用的「上一本 / 下一本」列表",
            ttl: 1500,
          });
        }
        return false;
      }
      const curIdx = ctx.list.findIndex((it) => it.key === pathParam);
      const base = curIdx >= 0 ? curIdx : ctx.index;
      const n = ctx.list.length;
      for (let step = 1; step <= n; step++) {
        const nextIdx = (((base + direction * step) % n) + n) % n;
        const nextEntry: GalleryContextEntry | undefined = ctx.list[nextIdx];
        if (!nextEntry) continue;
        const readerUrl = entryReaderUrl(nextEntry);
        if (albumsOnly && !readerUrl) continue;
        if (albumsOnly) {
          // 跳到没有可读媒体的相册没有意义：图片模式跳进纯视频相册只会
          // 看到「没有图片」。数量未知（undefined）时不跳过。
          const count = isVideo ? nextEntry.videoCount : nextEntry.imageCount;
          if (count === 0) continue;
        }
        const dirLabel = direction === 1 ? "下一本" : "上一本";
        if (notify) {
          pushToast({
            kind: "info",
            message: `${dirLabel}：${nextEntry.name}`,
            ttl: 1200,
          });
        }
        try {
          sessionStorage.setItem(
            "local-gallery-context",
            JSON.stringify({
              ...ctx,
              index: nextIdx,
              openedAt: Date.now(),
            }),
          );
        } catch {
          // ignore
        }
        setShowInfo(false);
        setMode(useGalleryStore.getState().mode);
        navigate(readerUrl ?? nextEntry.to, { replace: false });
        return true;
      }
      if (notify) {
        pushToast({
          kind: "info",
          message: "当前无可用的「上一本 / 下一本」列表",
          ttl: 1500,
        });
      }
      return false;
    },
    [pathParam, pushToast, navigate, setMode, isVideo],
  );

  const onToggleFavorite = useCallback(() => {
    if (!pathParam) return;
    toggleFavorite(pathParam)
      .then(() => {
        const was = favorites.includes(pathParam);
        pushToast({
          kind: "success",
          message: was ? "已取消收藏" : "已加入收藏",
          ttl: 1200,
        });
      })
      .catch(() => pushToast({ kind: "error", message: "收藏失败" }));
  }, [pathParam, favorites, toggleFavorite, pushToast]);

  // 在系统文件管理器里定位当前这一份媒体文件。
  // 服务端对文件资源走 explorer /select 的方式打开所在目录并高亮该文件，
  // 这正是"我正在看的就是磁盘上这一份"的诉求。
  const onOpenInExplorer = useCallback(() => {
    const id = currentRef.current;
    if (!id) return;
    void fsApi
      .openInExplorer(id)
      .then(() =>
        pushToast({
          kind: "success",
          message: "已请求打开文件",
          ttl: 1200,
        }),
      )
      .catch((error: unknown) =>
        pushToast({
          kind: "error",
          message: fileManagerErrorMessage(error),
        }),
      );
  }, [pushToast]);

  // 把当前展示的图片/视频设为本相册的封面。成功后统一失效摘要查询，
  // 卡片、搜索和阅读器的封面状态会从同一个新 revision 重新读取。
  //
  // 注：current 是在组件后段计算的（依赖 isVideo / images / videos / index），
  // 因此这里在 callback 内通过 useGalleryStore.getState() 读 index、images、videos
  // 实时算 current，避免依赖数组出现 forward reference；每次按键都拿到当前真实文件。
  const onSetCover = useCallback(() => {
    if (!pathParam) return;
    const cur = currentRef.current;
    if (!cur) return;
    albumsApi
      .setCover(pathParam, cur)
      .then(() => {
        setHasCustomCover(true);
        void queryClient.invalidateQueries({ queryKey: libraryQueryKeys.root });
        pushToast({ kind: "success", message: "已设为封面", ttl: 1200 });
      })
      .catch((e) => {
        pushToast({
          kind: "error",
          message: apiErrorMessage(e, "设置封面失败"),
        });
      });
  }, [pathParam, queryClient, pushToast]);

  // 清除自定义封面：回退到扫描器默认（images[0] / videos[0]）。
  const onClearCover = useCallback(() => {
    if (!pathParam) return;
    albumsApi
      .clearCover(pathParam)
      .then(() => {
        setHasCustomCover(false);
        void queryClient.invalidateQueries({ queryKey: libraryQueryKeys.root });
        pushToast({ kind: "success", message: "已恢复默认封面", ttl: 1200 });
      })
      .catch((e) => {
        pushToast({
          kind: "error",
          message: apiErrorMessage(e, "清除封面失败"),
        });
      });
  }, [pathParam, queryClient, pushToast]);

  useKeyboard({
    // 视频方向键和空格由 VideoPlayer 处理，不注册图片操作。
    ...(isVideo
      ? {}
      : {
          arrowleft: prev,
          arrowright: next,
          "+": () => useGalleryStore.getState().zoomIn(),
          "-": () => useGalleryStore.getState().zoomOut(),
          "=": () => useGalleryStore.getState().zoomIn(),
          "0": () => useGalleryStore.getState().zoomReset(),
          r: () => useGalleryStore.getState().rotate(90),
          space: () => useGalleryStore.getState().toggleSlideshow(),
          i: () => setShowInfo((v) => !v),
          "1": () => useGalleryStore.getState().setMode("single"),
          "2": () => useGalleryStore.getState().setMode("continuous"),
          "3": () => useGalleryStore.getState().setMode("double"),
          f: () => useGalleryStore.getState().cycleFit(),
          l: () => {
            const cur = useGalleryStore.getState().direction;
            useGalleryStore
              .getState()
              .setDirection(cur === "ltr" ? "rtl" : "ltr");
          },
        }),
    pageup: prev,
    pagedown: next,
    home: () => {
      if (isVideo) {
        goToVideo(0);
      } else if (useGalleryStore.getState().mode === "continuous") {
        scrollContinuousTo(0);
      } else {
        setIndex(0);
      }
    },
    end: () => {
      if (isVideo) {
        if (videos.length > 0) goToVideo(videos.length - 1);
      } else if (useGalleryStore.getState().mode === "continuous") {
        scrollContinuousTo(images.length - 1);
      } else {
        setIndex(images.length - 1);
      }
    },
    f11: () => toggleFullscreenImpl(),
    "ctrl+/": () => setShowHelp((v) => !v),
    "?": () => setShowHelp((v) => !v),
    n: () => goAdjacent(1, { notify: showSwitchNotif }),
    p: () => goAdjacent(-1, { notify: showSwitchNotif }),
    s: () => onToggleFavorite(),
    u: () => onSetCover(),
    "shift+u": () => onClearCover(),
    escape: () => {
      if (showHelp) setShowHelp(false);
      else if (showInfo) setShowInfo(false);
      // 仅在当前媒体就绪后返回；视频不依赖图片列表。
      else if (ready) goBack();
    },
  });

  if (!ready) {
    return (
      // 阅读器画布恒为深色：加载态、空态、失败态都跟着深色走，
      // 否则浅色主题下会先闪一屏白底，再跳到黑色画布。
      <div className="flex flex-col h-full bg-neutral-950">
        {/* 顶部条：返回 / 名称（常驻） */}
        <div className="px-4 h-9 text-xs text-white/60 border-b border-white/10 bg-neutral-900/60 flex items-center gap-3">
          <button
            type="button"
            onClick={goBack}
            className="px-1.5 py-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white"
            aria-label="返回"
          >
            ←
          </button>
          <span className="font-medium text-white/85 truncate">{name}</span>
        </div>
        <div className="flex-1 flex items-center justify-center px-6">
          {!pathParam ? (
            <div className="text-center">
              <div className="font-display text-[20px] font-semibold text-white/90">
                无可显示的图片
              </div>
              <div className="text-[13px] text-white/50 mt-1.5">未指定相册路径</div>
            </div>
          ) : loadError ? (
            <div className="text-center max-w-sm">
              <div className="font-display text-[20px] font-semibold text-white/90 mb-2">
                {loadError === "EMPTY"
                  ? isVideo
                    ? "这个文件夹没有视频"
                    : "这个文件夹没有图片"
                  : "加载失败"}
              </div>
              <div className="text-[13px] leading-relaxed text-white/60 mb-6">
                {loadError === "EMPTY"
                  ? isVideo
                    ? "可以换个文件夹，或检查视频是否已被移动/删除。"
                    : "可以换个文件夹，或检查文件是否已被移动/删除。"
                  : loadError}
              </div>
              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={goBack}
                  className="px-4 h-9 text-[13px] rounded-md border border-white/15 bg-white/10 hover:bg-white/15 text-white/85 transition-colors"
                >
                  返回
                </button>
                <button
                  type="button"
                  onClick={() => setReloadKey((k) => k + 1)}
                  className="px-4 h-9 text-[13px] rounded-md bg-accent text-accent-contrast hover:opacity-90 transition-opacity"
                >
                  重试
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 text-[13px] text-white/60">
              <div
                className="w-5 h-5 rounded-full border-2 border-white/40 border-t-transparent animate-spin"
                aria-hidden
              />
              <span>正在加载图片…</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // 显示给用户看的 item index（1 / 2 那种）。
  // 视频模式下 current / itemIndex 基于 URL 的 initialIndex，和图片阅读页码
  // 状态保持隔离。
  const current = (isVideo ? currentVideo : images[index]) ?? null;
  // 把 current 同步进 ref,让 onSetCover (声明在前) 拿到最新值。
  currentRef.current = current;
  const total = isVideo ? videos.length : images.length;
  const itemIndex = videoItemIndex;

  return (
    <div
      className="relative flex bg-neutral-950 overflow-hidden select-none"
      style={{ height: "100vh" }}
      onMouseMove={markActive}
      onContextMenu={(e) => {
        // 屏蔽浏览器默认右键菜单(图片另存为等),改用我们自己的。
        // 子组件 (ImageGallery/VideoPlayer) 内部各自 preventDefault + 标记
        // 是图片区,这里统一捕获后弹自定义菜单。
        e.preventDefault();
        if (!pathParam) return;
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* 舞台：画布 + 顶栏 + 浮层控件 + 底部进度条。
          信息面板打开时（md+）这一列横向收缩，面板成为独立的一栏；
          窄屏时面板改为浮在顶栏下方的整宽浮层，不遮挡顶栏。 */}
      <div className="relative flex-1 min-w-0">
        {/* 暗色画布层：让图片有「画廊」氛围 */}
        {/* flex flex-col 是关键：让 ImageGallery 内部的 `flex-1` + `min-h-0`
          容器拿到约束高度,连续模式才能在容器内纵向滚动,
          而不是被外层 overflow-hidden 裁掉。 */}
        <div className="absolute inset-0 flex flex-col">
          {isVideo ? (
            <VideoPlayer
              src={current ?? ""}
              initialPositionSec={
                videoActivity.resume.key === videoActivityKey
                  ? videoActivity.resume.seconds
                  : undefined
              }
              onMetaLoaded={videoActivity.onMetaLoaded}
              onProgress={videoActivity.onProgress}
              onEnded={() => {
                // onEnded 只会在视频模式下触发（<VideoPlayer> 仅在 isVideo 时渲染）。
                // 从 URL 的 initialIndex 派生当前 item 索引。
                videoActivity.markCompleted();
                const cur = Math.max(
                  0,
                  Math.min(initialIndex, Math.max(0, videos.length - 1)),
                );
                if (cur < videos.length - 1) {
                  goToVideo(cur + 1);
                } else {
                  pushToast({
                    kind: "success",
                    message: "已看完 🎉",
                    ttl: 1500,
                  });
                }
              }}
            />
          ) : (
            <ImageGallery
              images={images}
              onVisibleRangeChange={onContinuousVisibleRangeChange}
              onClickNavigate={(dir) => {
                if (dir === -1) prev();
                else if (dir === 1) next();
              }}
            />
          )}
        </div>

        {/* 顶部常驻条：返回 / 名称 / 页码 / 全屏 / 菜单 */}
        {progressFailure?.key === progressKey && (
          <div
            role="alert"
            className="absolute top-16 left-3 right-3 z-30 mx-auto flex max-w-xl items-center justify-between gap-3 rounded-md border border-white/10 bg-neutral-900/95 backdrop-blur-md p-3 text-sm text-white/85 shadow-lg"
          >
            <span>
              {progressFailure.operation === "restore"
                ? "无法恢复上次进度，已暂停保存，避免覆盖原记录。"
                : "阅读进度未保存，请重试。"}
            </span>
            <button
              type="button"
              disabled={retryingProgress}
              onClick={() => void retryProgress()}
              className="shrink-0 rounded border border-white/20 px-3 py-1 text-white/85 hover:bg-white/10 disabled:opacity-50"
            >
              {retryingProgress ? "重试中…" : "重试进度"}
            </button>
          </div>
        )}
        <GalleryHeader
          name={name}
          index={index}
          itemIndex={isVideo ? itemIndex : undefined}
          total={total}
          isFavorite={isFav}
          onBack={goBack}
          onToggleFavorite={onToggleFavorite}
          onToggleInfo={() => setShowInfo((v) => !v)}
          onToggleHelp={() => setShowHelp((v) => !v)}
          onPrev={prev}
          onNext={next}
          onPrevAlbum={() => goAdjacent(-1, { notify: showSwitchNotif })}
          onNextAlbum={() => goAdjacent(1, { notify: showSwitchNotif })}
          onSetCover={onSetCover}
          onClearCover={onClearCover}
          hasCustomCover={hasCustomCover}
          onJumpToFirst={isVideo ? () => goToVideo(0) : () => setIndex(0)}
          onJumpToLast={
            isVideo
              ? () => {
                  if (videos.length > 0) goToVideo(videos.length - 1);
                }
              : () => setIndex(Math.max(0, images.length - 1))
          }
        />

        {/* 阅读控制：底部浮动工具条（翻页 / 模式 / 适配 / 缩放 / 旋转）
            常驻显示 —— 淡出等于把功能藏起来。
            视频模式不显示（视频有原生 controls）。 */}
        {!isVideo && (
          <GalleryToolbar
            onPrev={prev}
            onNext={next}
            atStart={index <= 0}
            atEnd={index >= images.length - 1}
          />
        )}

        {/* 跨卷导航：画面左侧竖排，低频但需要常驻可见 */}
        {!isVideo && (
          <GalleryAlbumNav
            visible={chromeVisible}
            onPrevAlbum={() => goAdjacent(-1, { notify: showSwitchNotif })}
            onNextAlbum={() => goAdjacent(1, { notify: showSwitchNotif })}
          />
        )}

        {/* 底部进度条 + 跳转：常驻显示。
            它是被动信息（当前在第几张）+ 长相册的主要导航手段（拖拽刮擦 +
            浮出缩略图条），按 idle 淡出会让用户在一本 300 张的漫画里
            彻底失去位置感 —— 而它本身只占 44px。
            视频模式下隐藏（<video> 自带 controls）。 */}
        {!isVideo && (
          <div className="absolute bottom-0 inset-x-0 z-10">
            <PageSlider
              total={images.length}
              index={index}
              onJump={jumpTo}
              images={images}
            />
          </div>
        )}
      </div>

      {showInfo && !isVideo && current && (
        <ImageInfoPanel absPath={current} onClose={() => setShowInfo(false)} />
      )}
      <HelpOverlay
        context={isVideo ? "video" : "image"}
        open={showHelp}
        onClose={() => setShowHelp(false)}
      />
      {/* 右键菜单：阅读器内任意位置右键都弹出。
          「设为封面」「清除自定义封面」用与 GalleryHeader 同一份 handler，
          保证快捷键 U / ⇧U 与菜单行为完全一致。 */}
      {contextMenu && pathParam && current && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={
            [
              {
                id: "set-cover",
                label: "设为封面 (U)",
                icon: <ImageIcon />,
              },
              hasCustomCover
                ? {
                    id: "clear-cover",
                    label: "清除自定义封面 (⇧U)",
                    icon: <RefreshIcon />,
                  }
                : {
                    id: "clear-cover-disabled",
                    label: "清除自定义封面",
                    disabled: true,
                  },
              { id: "separator", separator: true },
              {
                id: "explorer",
                label: "在资源管理器中打开",
                icon: <ArrowUpRightIcon />,
                disabled: !allowOsOpen,
              },
            ] satisfies AnyMenuItem[]
          }
          onSelect={(id) => {
            setContextMenu(null);
            if (id === "set-cover") onSetCover();
            else if (id === "clear-cover") onClearCover();
            else if (id === "explorer") onOpenInExplorer();
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
