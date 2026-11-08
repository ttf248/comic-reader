interface Props {
  hasNextPage?: boolean;
  isFetchingNextPage: boolean;
  isError: boolean;
  load: () => void;
}
export default function ListPagination({
  hasNextPage,
  isFetchingNextPage,
  isError,
  load,
}: Props) {
  if (!hasNextPage) return null;
  return (
    <div className="flex justify-center py-5" role="status">
      <button
        className="btn btn-outline"
        disabled={isFetchingNextPage}
        onClick={load}
      >
        {isFetchingNextPage
          ? "正在加载…"
          : isError
            ? "加载失败，重试"
            : "加载更多"}
      </button>
    </div>
  );
}
