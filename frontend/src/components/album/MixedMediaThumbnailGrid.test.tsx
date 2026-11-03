import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LibraryMediaItem } from "../../api/library";
import type { VideoInfo } from "../../api/videos";
import MixedMediaThumbnailGrid from "./MixedMediaThumbnailGrid";

interface VirtualizedProps {
  data: readonly (LibraryMediaItem | null)[];
  itemContent: (index: number, item: LibraryMediaItem | null) => ReactNode;
}

vi.mock("./VirtualMediaGrid", () => ({
  default: ({ data, itemContent }: VirtualizedProps) => (
    <div data-testid="mixed-virtual-grid">
      {data.map((item, index) => (
        <div key={item?.id ?? index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));

vi.mock("../common/VideoCoverImage", () => ({
  default: ({ alt }: { alt: string }) => <img src="video-cover" alt={alt} />,
}));

const items: LibraryMediaItem[] = [
  {
    id: "f_image",
    kind: "image",
    name: "page.jpg",
    index: 0,
    kindIndex: 0,
  },
  {
    id: "f_video",
    kind: "video",
    name: "clip.mp4",
    index: 1,
    kindIndex: 0,
  },
];

describe("MixedMediaThumbnailGrid", () => {
  it("按统一媒体序号展示图片和视频，并把点击项原样交给父级", () => {
    const onOpen = vi.fn();
    const infos: Record<string, VideoInfo> = {
      f_video: {
        path: "f_video",
        name: "clip.mp4",
        dir: "album",
        size: 100,
        mtime: "",
        format: ".mp4",
        duration: 12.5,
      },
    };

    render(
      <MixedMediaThumbnailGrid
        items={items}
        total={2}
        gridSize="lg"
        videoInfos={infos}
        hasNextPage={false}
        isLoadingMore={false}
        onLoadMore={vi.fn()}
        onOpen={onOpen}
      />,
    );

    expect(
      screen.getByRole("button", { name: "打开第 1 张" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "播放clip.mp4" }),
    ).toBeInTheDocument();
    expect(screen.getByText("clip.mp4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "播放clip.mp4" }));
    expect(onOpen).toHaveBeenCalledWith(items[1]);
  });
});
