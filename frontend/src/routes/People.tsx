import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import EmptyState from "../components/common/EmptyState";
import PageHeading from "../components/common/PageHeading";
import RenditionImage from "../components/common/RenditionImage";
import PhotoViewer from "../components/wall/PhotoViewer";
import PhotoWall from "../components/wall/PhotoWall";
import PeopleMergeDialog from "../components/people/PeopleMergeDialog";
import { aiJobsApi, type PersonGroup } from "../api/aiJobs";
import { usePicks } from "../hooks/usePicks";
import { usePhotoStore, wallTargetHeight } from "../store/photoStore";
import { useUIStore } from "../store/uiStore";
import { albumRoute, homeRoute, peopleRoute } from "../utils/path";

export default function People() {
  const { personId } = useParams();
  return personId ? <PersonAlbum personId={personId} /> : <PeopleList />;
}

function PeopleList() {
  const client = useQueryClient();
  const [includeHidden, setIncludeHidden] = useState(false);
  const query = useQuery({
    queryKey: ["people", includeHidden],
    queryFn: () => aiJobsApi.people(includeHidden),
  });
  const jobs = useQuery({ queryKey: ["ai-jobs"], queryFn: aiJobsApi.list });
  const clear = useMutation({
    mutationFn: aiJobsApi.clearPeople,
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["people"] }),
        client.invalidateQueries({ queryKey: ["ai-jobs"] }),
      ]);
    },
  });
  const groups = query.data?.people ?? [];
  const totalGroups = query.data?.totalGroups ?? groups.length;

  return (
    <div className="h-full overflow-y-auto pb-12">
      <PageHeading
        eyebrow="离线智能相册"
        title="人物相册"
        description="按本机人脸特征生成可编辑的候选分组。应用不会识别真实姓名；你可以改名、合并、拆分或隐藏分组。"
        action={
          <Link className="btn btn-outline" to="/tasks">
            人物分析设置
          </Link>
        }
      />
      {query.isError ? (
        <p role="alert" className="page-shell mt-5 text-meta text-danger">
          人物列表加载失败，请稍后重试。
        </p>
      ) : null}
      {groups.length === 0 && !query.isLoading ? (
        <EmptyState
          title={
            jobs.data?.snapshot.settings.peopleEnabled
              ? "还没有人物候选组"
              : "人物分析默认关闭"
          }
          description={
            jobs.data?.snapshot.settings.peopleEnabled
              ? "请在任务中心运行人脸识别任务；分析只在本机处理。"
              : "前往任务中心显式启用人物分析，再启动人脸识别任务。"
          }
          action={
            <Link className="btn btn-outline" to="/tasks">
              打开任务中心
            </Link>
          }
        />
      ) : (
        <section className="page-shell mt-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-meta text-fg-muted">
              {totalGroups > groups.length
                ? `照片数最多的 ${groups.length.toLocaleString()} / 共 ${totalGroups.toLocaleString()} 组`
                : `${totalGroups.toLocaleString()} 组`}
              {" · 按照片数排序"}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-meta text-fg-muted">
                <input
                  type="checkbox"
                  checked={includeHidden}
                  onChange={(event) => setIncludeHidden(event.target.checked)}
                />
                显示隐藏分组
              </label>
              <button
                type="button"
                className="btn btn-outline"
                disabled={clear.isPending || groups.length === 0}
                onClick={() => {
                  if (
                    window.confirm(
                      "清除所有人脸分析结果、人物分组和手动修正？此操作不能撤销。",
                    )
                  ) {
                    clear.mutate();
                  }
                }}
              >
                {clear.isPending ? "清除中…" : "清除人物数据"}
              </button>
            </div>
          </div>
          {clear.isError ? (
            <p role="alert" className="mb-4 text-meta text-danger">
              清除失败。请确认没有人脸识别任务正在运行后重试。
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {groups.map((person) => (
              <PersonCard key={person.id} person={person} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function PersonCard({ person }: { person: PersonGroup }) {
  return (
    <Link
      to={peopleRoute(person.id)}
      className="group overflow-hidden rounded-xl border border-border-faint bg-bg-elevated transition-colors hover:border-border-strong"
    >
      <div className="relative aspect-[1.7/1] overflow-hidden bg-bg-subtle">
        {person.coverResourceId ? (
          <RenditionImage
            fileId={person.coverResourceId}
            alt=""
            displayWidth={560}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : null}
        <span className="absolute bottom-3 left-3 rounded-full bg-black/65 px-2.5 py-1 text-meta text-white backdrop-blur-sm">
          {person.photoCount.toLocaleString()} 张
        </span>
      </div>
      <div className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <h2 className="truncate font-display text-label font-medium text-fg">
            {person.name}
          </h2>
          <p className="mt-1 text-meta text-fg-muted">
            {person.faceCount.toLocaleString()} 张脸
            {person.hidden ? " · 已隐藏" : ""}
          </p>
        </div>
        <span className="text-meta text-fg-subtle">打开相册 →</span>
      </div>
    </Link>
  );
}

function PersonAlbum({ personId }: { personId: string }) {
  const facePageSize = 200;
  const navigate = useNavigate();
  const client = useQueryClient();
  const density = usePhotoStore((state) => state.density);
  const picks = usePicks();
  const pushToast = useUIStore((state) => state.pushToast);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [selectedFaces, setSelectedFaces] = useState<string[]>([]);
  const [visibleFaceCount, setVisibleFaceCount] = useState(facePageSize);
  const query = useInfiniteQuery({
    queryKey: ["person-media", personId],
    queryFn: ({ pageParam }) =>
      aiJobsApi.personMedia(personId, pageParam).then((result) => result.page),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
  });
  const person = query.data?.pages[0]?.person;
  const items = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  const faces = useMemo(
    () => query.data?.pages.flatMap((page) => page.faces) ?? [],
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? 0;
  const savePerson = useMutation({
    mutationFn: (body: { name?: string; hidden?: boolean }) =>
      aiJobsApi.updatePerson(personId, body),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["people"] }),
        client.invalidateQueries({ queryKey: ["person-media", personId] }),
      ]);
      pushToast({ kind: "success", message: "人物分组已更新" });
    },
    onError: () => pushToast({ kind: "error", message: "保存人物分组失败" }),
  });
  const merge = useMutation({
    mutationFn: (targetId: string) => aiJobsApi.mergePeople(personId, targetId),
    onSuccess: async (_result, targetId) => {
      await client.invalidateQueries({ queryKey: ["people"] });
      setMergeDialogOpen(false);
      navigate(peopleRoute(targetId));
    },
    onError: () => pushToast({ kind: "error", message: "合并分组失败" }),
  });
  const split = useMutation({
    mutationFn: () => aiJobsApi.splitPerson(personId, selectedFaces),
    onSuccess: async ({ personId: createdID }) => {
      setSelectedFaces([]);
      await client.invalidateQueries({ queryKey: ["people"] });
      await client.invalidateQueries({ queryKey: ["person-media", personId] });
      navigate(peopleRoute(createdID));
    },
    onError: () => pushToast({ kind: "error", message: "拆分选中人脸失败" }),
  });
  const loadMore = () => void query.fetchNextPage({ cancelRefetch: false });
  const toggleFace = (key: string) =>
    setSelectedFaces((current) =>
      current.includes(key)
        ? current.filter((value) => value !== key)
        : [...current, key],
    );

  useEffect(() => {
    setName(person?.name ?? "");
  }, [person?.id, person?.name]);

  if (query.isError || (!person && !query.isLoading)) {
    return (
      <div className="page-shell py-12 text-body text-fg-muted">
        人物分组已失效或照片加载失败。
        <Link className="ml-1 underline" to={homeRoute("photo")}>
          回照片库
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border-faint bg-bg">
        <div className="px-[clamp(20px,3vw,48px)]">
          <div className="album-bar">
            <div className="min-w-0 flex-1">
              <p className="page-eyebrow">人物相册 · 可编辑候选分组</p>
              <h1 className="album-bar__title truncate">
                {person?.name ?? "人物相册"}
              </h1>
            </div>
            <Link className="btn btn-sm btn-outline" to={peopleRoute()}>
              全部人物
            </Link>
          </div>
        </div>
      </header>
      <div className="shrink-0 space-y-3 border-b border-border-faint px-[clamp(20px,3vw,48px)] py-3">
        <p className="text-meta text-fg-muted">
          {person?.photoCount.toLocaleString() ?? 0} 张照片 ·{" "}
          {person?.faceCount.toLocaleString() ?? 0}{" "}
          张脸。分组只表示相似度候选，不代表身份确认。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              savePerson.mutate({ name });
            }}
          >
            <input
              className="w-48 rounded-md border border-border bg-bg-elevated px-3 py-2 text-body text-fg"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              placeholder={person?.name ?? "人物名称"}
              aria-label="人物名称"
            />
            <button
              className="btn btn-sm btn-outline"
              disabled={savePerson.isPending}
            >
              改名
            </button>
          </form>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            disabled={savePerson.isPending}
            onClick={() => savePerson.mutate({ hidden: !person?.hidden })}
          >
            {person?.hidden ? "取消隐藏" : "隐藏分组"}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            disabled={merge.isPending}
            onClick={() => setMergeDialogOpen(true)}
          >
            合并人物
          </button>
        </div>
        {faces.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-meta text-fg-muted">
              拆分选中的人脸（当前已加载照片）
            </summary>
            <div className="mt-2 grid max-h-40 grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
              {faces.slice(0, visibleFaceCount).map((face) => {
                const item = items.find(
                  (candidate) => candidate.id === face.resourceId,
                );
                return (
                  <label
                    key={face.key}
                    className="flex items-center gap-2 truncate text-meta text-fg"
                  >
                    <input
                      type="checkbox"
                      checked={selectedFaces.includes(face.key)}
                      disabled={
                        selectedFaces.length >= 200 &&
                        !selectedFaces.includes(face.key)
                      }
                      onChange={() => toggleFace(face.key)}
                    />
                    <span className="truncate">
                      {item?.name ?? face.resourceId} · 人脸{" "}
                      {face.faceIndex + 1}
                    </span>
                  </label>
                );
              })}
            </div>
            {faces.length > visibleFaceCount ? (
              <button
                type="button"
                className="btn btn-sm btn-outline mt-2"
                onClick={() =>
                  setVisibleFaceCount((count) => count + facePageSize)
                }
              >
                {`继续显示 ${Math.min(facePageSize, faces.length - visibleFaceCount)} 张脸（${visibleFaceCount}/${faces.length}）`}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-outline mt-2"
              disabled={selectedFaces.length === 0 || split.isPending}
              onClick={() => split.mutate()}
            >
              {split.isPending
                ? "拆分中…"
                : `拆分 ${selectedFaces.length} 张脸`}
            </button>
          </details>
        ) : null}
      </div>
      {items.length === 0 && !query.isLoading ? (
        <EmptyState
          title="这个人物分组暂时没有照片"
          description="媒体库或分析结果变化后，该分组会按当前有效照片显示。"
          dense
        />
      ) : (
        <div className="min-h-0 flex-1 px-[clamp(20px,3vw,48px)] pb-2 pt-3">
          <PhotoWall
            items={items}
            total={total}
            targetHeight={wallTargetHeight(density)}
            hasNextPage={query.hasNextPage ?? false}
            isLoadingMore={query.isFetchingNextPage}
            onLoadMore={loadMore}
            onOpen={(_item, index) => setViewerIndex(index)}
            albumLabel={(item) => item.albumName}
            isPicked={picks.isPicked}
            onTogglePick={(item) => {
              void picks
                .toggle(item.id)
                .catch(() =>
                  pushToast({ kind: "error", message: "精选操作失败" }),
                );
            }}
          />
        </div>
      )}
      {viewerIndex !== null && items[viewerIndex] ? (
        <PhotoViewer
          items={items}
          index={viewerIndex}
          albumName={items[viewerIndex].albumName}
          albumHref={albumRoute("photo", items[viewerIndex].albumId)}
          totalCount={total}
          hasNextPage={query.hasNextPage ?? false}
          isLoadingMore={query.isFetchingNextPage}
          loadMoreError={query.isFetchNextPageError}
          onLoadMore={loadMore}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          isPicked={picks.isPicked(items[viewerIndex].id)}
          onTogglePick={() => {
            void picks
              .toggle(items[viewerIndex].id)
              .catch(() =>
                pushToast({ kind: "error", message: "精选操作失败" }),
              );
          }}
        />
      ) : null}
      {mergeDialogOpen ? (
        <PeopleMergeDialog
          personId={personId}
          isMerging={merge.isPending}
          onClose={() => setMergeDialogOpen(false)}
          onMerge={(targetId) => merge.mutate(targetId)}
        />
      ) : null}
    </div>
  );
}
