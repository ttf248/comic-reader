import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { LibraryMediaItem } from "../../api/library";
import MixedMediaThumbnailGrid from "./MixedMediaThumbnailGrid";
import VideoThumbnailGrid from "./VideoThumbnailGrid";

const { retryCover } = vi.hoisted(() => ({ retryCover: vi.fn() }));
vi.mock("../../hooks/useVideoCover", () => ({
  useVideoCover: () => ({
    status: "error",
    enabled: true,
    url: "",
    retry: retryCover,
  }),
}));
vi.mock("react-virtuoso", () => ({
  VirtuosoGrid: ({
    data,
    itemContent,
  }: {
    data: (string | LibraryMediaItem | null)[];
    itemContent: (
      index: number,
      item: string | LibraryMediaItem | null,
    ) => ReactNode;
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));

beforeEach(() => vi.clearAllMocks());

it.each(["video", "mixed"] as const)(
  "%s 网格的封面重试和播放互不嵌套且分别生效",
  (kind) => {
    const onOpen = vi.fn();
    const item: LibraryMediaItem = {
      id: "f_clip",
      kind: "video",
      name: "clip.webm",
      index: 0,
      kindIndex: 0,
    };
    const paging = {
      hasNextPage: false,
      isLoadingMore: false,
      onLoadMore: vi.fn(),
    };
    const { container } = render(
      kind === "video" ? (
        <VideoThumbnailGrid
          videos={[item.id]}
          total={1}
          infos={{}}
          onOpen={onOpen}
          {...paging}
        />
      ) : (
        <MixedMediaThumbnailGrid
          items={[item]}
          total={1}
          gridClassName="grid-cols-2"
          videoInfos={{}}
          onOpen={onOpen}
          {...paging}
        />
      ),
    );
    const play = screen.getByRole("button", { name: /^播放/ });
    const retry = screen.getByRole("button", { name: "重试" });
    expect(play.contains(retry)).toBe(false);
    expect(container.querySelectorAll("button button")).toHaveLength(0);

    fireEvent.click(retry);
    expect(retryCover).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(play);
    expect(onOpen).toHaveBeenCalledWith(kind === "video" ? 0 : item);
  },
);
