import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import {
  aiJobsApi,
  type SemanticSearchHit,
  type SemanticSearchRequest,
} from "../api/aiJobs";
import { albumsApi, type SearchHit } from "../api/albums";
import type { LibraryFeedItem } from "../api/library";
import EmptyState from "../components/common/EmptyState";
import PageHeading from "../components/common/PageHeading";
import PhotoWall from "../components/wall/PhotoWall";
import PhotoViewer from "../components/wall/PhotoViewer";
import { SearchIcon } from "../components/common/Icon";
import { usePicks } from "../hooks/usePicks";
import { usePhotoStore, wallTargetHeight } from "../store/photoStore";
import { useUIStore } from "../store/uiStore";
import { albumRoute } from "../utils/path";

type ScoredFeedItem = LibraryFeedItem & {
  similarity?: number;
  matchReasons?: SemanticSearchHit["matchReasons"];
};
type SearchMode = "text" | "image";

interface SubmittedSearch {
  request: SemanticSearchRequest;
  image?: File;
  token: number;
}

export default function SemanticSearch() {
  const density = usePhotoStore((state) => state.density);
  const picks = usePicks();
  const pushToast = useUIStore((state) => state.pushToast);
  const [mode, setMode] = useState<SearchMode>("text");
  const [text, setText] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [imageFile, setImageFile] = useState<File | undefined>();
  const [similarResourceId, setSimilarResourceId] = useState("");
  const [albumText, setAlbumText] = useState("");
  const [album, setAlbum] = useState<SearchHit | undefined>();
  const [year, setYear] = useState("");
  const [locationId, setLocationId] = useState("");
  const [personId, setPersonId] = useState("");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [pickedOnly, setPickedOnly] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitted, setSubmitted] = useState<SubmittedSearch | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const statusQuery = useQuery({
    queryKey: ["ai-embedding-status"],
    queryFn: aiJobsApi.embeddingStatus,
    refetchInterval: 30_000,
  });
  const locationsQuery = useQuery({
    queryKey: ["gps-locations", "semantic-filter"],
    queryFn: () => aiJobsApi.locations().then((result) => result.page.items),
    staleTime: 60_000,
  });
  const peopleQuery = useQuery({
    queryKey: ["people", false],
    queryFn: () => aiJobsApi.people(false),
    staleTime: 60_000,
  });
  const albumQuery = useQuery({
    queryKey: ["semantic-album-filter", albumText],
    queryFn: () => albumsApi.search(albumText, "photo", 12),
    enabled: !album && albumText.trim().length >= 2,
  });
  const submittedQuery = useInfiniteQuery({
    queryKey: ["semantic-search", submitted?.token],
    enabled: submitted !== null,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      if (!submitted) throw new Error("search query is missing");
      return aiJobsApi.semanticSearch(
        { ...submitted.request, offset: pageParam, limit: 60 },
        submitted.image,
      );
    },
    getNextPageParam: (page) =>
      page.nextOffset < page.total ? page.nextOffset : undefined,
  });

  const hits = useMemo<SemanticSearchHit[]>(
    () => submittedQuery.data?.pages.flatMap((page) => page.results) ?? [],
    [submittedQuery.data],
  );
  const items = useMemo<ScoredFeedItem[]>(
    () =>
      hits.map(({ item, similarity, matchReasons }) => ({
        ...item,
        similarity,
        matchReasons,
      })),
    [hits],
  );
  const total = submittedQuery.data?.pages[0]?.total ?? 0;
  const status = statusQuery.data?.status;
  const embeddingReady = Boolean(status?.runtimeReady && status.modelValid);
  const hasSemanticQuery =
    mode === "text"
      ? Boolean(text.trim())
      : Boolean(similarResourceId || imageFile);
  const hasSearchCondition = Boolean(
    hasSemanticQuery ||
    ocrText.trim() ||
    album ||
    year ||
    locationId ||
    personId ||
    favoriteOnly ||
    pickedOnly,
  );
  const advancedFilterCount =
    Number(Boolean(album)) +
    Number(Boolean(year.trim())) +
    Number(Boolean(locationId)) +
    Number(Boolean(personId)) +
    Number(favoriteOnly) +
    Number(pickedOnly);

  const search = (resourceId?: string, file?: File) => {
    const request: SemanticSearchRequest = {
      kind: "photo",
      ...(mode === "text" && !resourceId && text.trim()
        ? { text: text.trim() }
        : {}),
      ...(ocrText.trim() ? { ocrText: ocrText.trim() } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(album ? { albumId: album.path } : {}),
      ...(year.trim() ? { year: year.trim() } : {}),
      ...(locationId ? { locationId } : {}),
      ...(personId ? { personId } : {}),
      ...(favoriteOnly ? { favoriteOnly: true } : {}),
      ...(pickedOnly ? { pickedOnly: true } : {}),
    };
    setSubmitted({ request, image: file, token: Date.now() });
    setViewerIndex(null);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasSemanticQuery && !embeddingReady) return;
    if (similarResourceId) {
      search(similarResourceId);
      return;
    }
    if (mode === "image" && imageFile) {
      search(undefined, imageFile);
      return;
    }
    if (mode === "text") setSimilarResourceId("");
    search();
  };

  const findSimilar = (item: ScoredFeedItem) => {
    setMode("image");
    setImageFile(undefined);
    setSimilarResourceId(item.id);
    search(item.id);
  };

  const loadMore = () =>
    void submittedQuery.fetchNextPage({ cancelRefetch: false });
  const selected = viewerIndex === null ? undefined : items[viewerIndex];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 overflow-y-auto pb-4">
        <PageHeading
          eyebrow="本地 AI · 组合检索"
          title="智能搜索"
          description="组合中文语义、图片文字、相册、年份与 GPS 条件，在本机照片库中查找。"
        />
        <section className="page-shell mt-5">
          <form
            className="rounded-xl border border-border bg-bg-elevated p-4 shadow-xs sm:p-5"
            onSubmit={onSubmit}
          >
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="搜索方式"
            >
              <button
                type="button"
                aria-pressed={mode === "text"}
                onClick={() => {
                  setMode("text");
                  setSimilarResourceId("");
                }}
                className={`rounded-full px-3.5 py-2 text-meta transition-colors ${mode === "text" ? "bg-accent text-accent-contrast" : "bg-bg-subtle text-fg-muted hover:text-fg"}`}
              >
                中文描述
              </button>
              <button
                type="button"
                aria-pressed={mode === "image"}
                onClick={() => setMode("image")}
                className={`rounded-full px-3.5 py-2 text-meta transition-colors ${mode === "image" ? "bg-accent text-accent-contrast" : "bg-bg-subtle text-fg-muted hover:text-fg"}`}
              >
                以图搜图
              </button>
            </div>

            {mode === "text" ? (
              <label className="mt-4 block">
                <span className="sr-only">中文搜索描述</span>
                <input
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  maxLength={512}
                  placeholder="例如：夜晚街道上的霓虹灯、海边散步的人"
                  className="h-12 w-full rounded-lg border border-border bg-bg px-4 text-body text-fg placeholder:text-fg-subtle focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus/20"
                />
              </label>
            ) : (
              <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-bg-subtle px-4 py-4">
                {similarResourceId ? (
                  <p className="text-body text-fg">
                    正在用当前照片查找相似图片。
                    <button
                      type="button"
                      className="ml-2 text-meta text-fg-muted underline underline-offset-2"
                      onClick={() => setSimilarResourceId("")}
                    >
                      改为上传图片
                    </button>
                  </p>
                ) : (
                  <label className="flex flex-wrap items-center gap-3 text-body text-fg">
                    <span className="btn btn-sm btn-outline">选择图片</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(event) =>
                        setImageFile(event.target.files?.[0])
                      }
                    />
                    <span className="min-w-0 truncate text-meta text-fg-muted">
                      {imageFile?.name ?? "支持常见图片格式，单张不超过 64 MiB"}
                    </span>
                  </label>
                )}
              </div>
            )}

            <label className="mt-3 block">
              <span className="mb-1.5 block text-meta text-fg-muted">
                图片中的文字
              </span>
              <input
                value={ocrText}
                onChange={(event) => setOcrText(event.target.value)}
                maxLength={200}
                placeholder="例如：车站名称、招牌或照片里的日期"
                className="h-10 w-full rounded-lg border border-border bg-bg px-3 text-body text-fg placeholder:text-fg-subtle focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus/20"
              />
              <span className="mt-1 block text-meta text-fg-subtle">
                需先运行文字识别；自动忽略中文标点与断行，长中文查询会尝试修正一个常见错字。无需
                Chinese-CLIP。
              </span>
            </label>

            <div className="mt-4">
              <button
                type="button"
                aria-expanded={advancedOpen}
                aria-controls="semantic-advanced-filters"
                onClick={() => setAdvancedOpen((open) => !open)}
                className="flex min-h-10 w-full items-center justify-between rounded-lg border border-border-faint bg-bg-subtle px-3 text-left text-meta font-medium text-fg hover:bg-bg-strong sm:w-auto sm:min-w-64"
              >
                <span>高级筛选</span>
                <span className="flex items-center gap-2 text-fg-muted">
                  {advancedFilterCount > 0
                    ? `${advancedFilterCount} 项已生效`
                    : "相册 · 年份 · 地点 · 人物"}
                  <span aria-hidden="true">{advancedOpen ? "−" : "+"}</span>
                </span>
              </button>
              {advancedOpen ? (
                <div
                  id="semantic-advanced-filters"
                  className="mt-3 rounded-lg border border-border-faint bg-bg-subtle/60 p-3"
                >
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <label className="min-w-0 text-meta text-fg-muted">
                      <span className="mb-1.5 block">限定相册</span>
                      {album ? (
                        <button
                          type="button"
                          className="flex h-10 w-full items-center justify-between rounded-md border border-border bg-bg px-3 text-left text-body text-fg"
                          onClick={() => {
                            setAlbum(undefined);
                            setAlbumText("");
                          }}
                        >
                          <span className="truncate">{album.name}</span>
                          <span
                            aria-hidden="true"
                            className="ml-2 text-fg-subtle"
                          >
                            ×
                          </span>
                        </button>
                      ) : (
                        <input
                          value={albumText}
                          onChange={(event) => setAlbumText(event.target.value)}
                          placeholder="输入相册名搜索"
                          className="h-10 w-full rounded-md border border-border bg-bg px-3 text-body text-fg placeholder:text-fg-subtle"
                        />
                      )}
                      {!album &&
                        (albumQuery.data?.results ?? [])
                          .filter((hit) => hit.kind === "album")
                          .slice(0, 5)
                          .map((hit) => (
                            <button
                              key={hit.path}
                              type="button"
                              className="mt-1 block w-full truncate rounded-md bg-bg-elevated px-3 py-2 text-left text-body text-fg hover:bg-bg-strong"
                              onClick={() => {
                                setAlbum(hit);
                                setAlbumText("");
                              }}
                            >
                              {hit.name}
                            </button>
                          ))}
                    </label>
                    <label className="text-meta text-fg-muted">
                      <span className="mb-1.5 block">拍摄年份</span>
                      <input
                        inputMode="numeric"
                        value={year}
                        onChange={(event) =>
                          setYear(
                            event.target.value.replace(/\D/g, "").slice(0, 4),
                          )
                        }
                        placeholder="例如 2024"
                        className="h-10 w-full rounded-md border border-border bg-bg px-3 text-body text-fg placeholder:text-fg-subtle"
                      />
                    </label>
                    <label className="text-meta text-fg-muted">
                      <span className="mb-1.5 block">GPS 地点</span>
                      <select
                        value={locationId}
                        onChange={(event) => setLocationId(event.target.value)}
                        className="h-10 w-full rounded-md border border-border bg-bg px-3 text-body text-fg"
                      >
                        <option value="">所有地点</option>
                        {(locationsQuery.data ?? []).map((location) => (
                          <option key={location.id} value={location.id}>
                            {location.name} · {location.fileCount} 张
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-meta text-fg-muted">
                      <span className="mb-1.5 block">人物</span>
                      <select
                        value={personId}
                        onChange={(event) => setPersonId(event.target.value)}
                        className="h-10 w-full rounded-md border border-border bg-bg px-3 text-body text-fg"
                      >
                        <option value="">所有人物</option>
                        {(peopleQuery.data?.people ?? []).map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-meta text-fg-muted">
                      <input
                        type="checkbox"
                        checked={favoriteOnly}
                        onChange={(event) =>
                          setFavoriteOnly(event.target.checked)
                        }
                      />
                      仅来自收藏相册
                    </label>
                    <label className="flex items-center gap-2 text-meta text-fg-muted">
                      <input
                        type="checkbox"
                        checked={pickedOnly}
                        onChange={(event) =>
                          setPickedOnly(event.target.checked)
                        }
                      />
                      仅精选照片
                    </label>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={
                  submittedQuery.isFetching ||
                  (hasSemanticQuery && !embeddingReady) ||
                  !hasSearchCondition
                }
                className="btn btn-primary"
              >
                <SearchIcon size={14} />
                {submittedQuery.isFetching ? "搜索中…" : "搜索照片"}
              </button>
              {status ? (
                <span className="text-meta text-fg-subtle">
                  {status.device === "cuda"
                    ? `${status.gpuName ?? "NVIDIA GPU"} · CUDA ${status.cudaVersion ?? "可用"}`
                    : status.runtimeReady
                      ? "CPU 推理"
                      : "本机运行环境未就绪"}
                  {" · "}
                  {status.coverage.indexed.toLocaleString()} /{" "}
                  {status.coverage.total.toLocaleString()} 张已索引
                </span>
              ) : null}
            </div>
          </form>

          {statusQuery.isError ? (
            <p role="alert" className="mt-3 text-meta text-danger">
              本机 AI 状态读取失败，请检查后端服务。
            </p>
          ) : null}
          {status && (!status.runtimeReady || !status.modelValid) ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-meta text-fg-muted">
              <span>
                {!status.runtimeReady
                  ? "Chinese-CLIP 运行环境尚未就绪。"
                  : "Chinese-CLIP 权重缺失或校验未通过。"}{" "}
                权重目录：cacheDir/derived/ai/models/。
              </span>
              <Link to="/tasks" className="btn btn-sm btn-outline">
                查看任务中心
              </Link>
            </div>
          ) : null}
        </section>
      </div>

      <div className="min-h-0 flex-1 px-[clamp(20px,3vw,48px)] pb-2">
        {submittedQuery.isError ? (
          <div
            role="alert"
            className="flex h-full items-center justify-center text-body text-danger"
          >
            {semanticErrorMessage(submittedQuery.error)}
          </div>
        ) : items.length > 0 ? (
          <PhotoWall
            items={items}
            total={Math.max(total, items.length)}
            targetHeight={wallTargetHeight(density)}
            hasNextPage={submittedQuery.hasNextPage ?? false}
            isLoadingMore={submittedQuery.isFetchingNextPage}
            onLoadMore={loadMore}
            onOpen={(_item, index) => setViewerIndex(index)}
            albumLabel={(item) => item.albumName}
            itemBadge={(item) => {
              const reasons = item.matchReasons ?? [];
              const labels = reasons.flatMap((reason) => {
                if (reason === "semantic") {
                  return item.similarity === undefined
                    ? ["语义"]
                    : [`语义 ${item.similarity.toFixed(2)}`];
                }
                if (reason === "similar_image") {
                  return item.similarity === undefined
                    ? ["以图相似"]
                    : [`以图 ${item.similarity.toFixed(2)}`];
                }
                if (reason === "ocr_exact") return ["文字匹配"];
                return ["文字近似"];
              });
              return labels.length > 0
                ? labels.join(" · ")
                : item.similarity === undefined
                  ? undefined
                  : `相似度 ${item.similarity.toFixed(2)}`;
            }}
            isPicked={picks.isPicked}
            onTogglePick={(item) => {
              void picks
                .toggle(item.id)
                .catch(() =>
                  pushToast({ kind: "error", message: "精选操作失败" }),
                );
            }}
          />
        ) : submitted && !submittedQuery.isLoading ? (
          <EmptyState
            title={
              total === 0 &&
              (submitted.request.text ||
                submitted.request.resourceId ||
                submitted.image)
                ? "还没有可搜索的向量"
                : total === 0 && submitted.request.ocrText
                  ? "还没有可搜索的文字结果"
                  : "没有匹配的照片"
            }
            description={
              total === 0
                ? submitted.request.text ||
                  submitted.request.resourceId ||
                  submitted.image
                  ? "请先到任务中心运行语义向量任务。"
                  : submitted.request.ocrText
                    ? "请先到任务中心运行文字识别任务。"
                    : "当前相册、年份与地点条件下没有照片。"
                : "试试调整描述，或放宽相册、年份与地点筛选。"
            }
            action={
              total === 0 &&
              (submitted.request.text ||
                submitted.request.resourceId ||
                submitted.image ||
                submitted.request.ocrText) ? (
                <Link to="/tasks" className="btn btn-outline">
                  打开任务中心
                </Link>
              ) : undefined
            }
          />
        ) : (
          <EmptyState
            title="输入条件开始搜索"
            description="语义结果按相似度排列；文字或结构化筛选不需要 CLIP。"
            icon={<SearchIcon size={24} />}
            dense
          />
        )}
      </div>

      {selected && (
        <PhotoViewer
          items={items}
          index={viewerIndex ?? 0}
          albumName={selected.albumName}
          albumHref={albumRoute("photo", selected.albumId)}
          totalCount={total}
          hasNextPage={submittedQuery.hasNextPage ?? false}
          isLoadingMore={submittedQuery.isFetchingNextPage}
          loadMoreError={submittedQuery.isFetchNextPageError}
          onLoadMore={loadMore}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          isPicked={picks.isPicked(selected.id)}
          onTogglePick={() => {
            void picks
              .toggle(selected.id)
              .catch(() =>
                pushToast({ kind: "error", message: "精选操作失败" }),
              );
          }}
          onFindSimilar={() => findSimilar(selected)}
        />
      )}
    </div>
  );
}

function semanticErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "ai_model_missing")
      return "本机模型缺失或校验失败，请检查任务中心的模型状态。";
    if (error.code === "ai_runtime_unavailable")
      return "本机 AI 运行环境不可用，请检查 Python 3.11 与 CUDA 安装。";
  }
  return "语义搜索暂不可用，请稍后重试。";
}
