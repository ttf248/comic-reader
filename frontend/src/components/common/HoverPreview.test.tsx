import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HoverPreview from "./HoverPreview";
import type { CardData } from "../album/AlbumCard";

// 悬停预览是两侧共用的组件：它的措辞与单位必须跟着这张卡自己的
// 内容属性走，而不是跟着当前工作台走。
// 照片相册不该出现「阅读」「阅读进度」，漫画相册才显示进度。
function card(overrides: Partial<CardData> = {}): CardData {
  return {
    id: "album-1",
    variant: "album",
    title: "周末记录",
    count: 12,
    imageCount: 12,
    videoCount: 0,
    coverPath: "cover-main",
    to: "/photo/albums/album-1",
    contentKind: "photo",
    ...overrides,
  };
}

function renderPreview(data: CardData, lastSeenAt?: string | null) {
  const anchor = new DOMRect(0, 0, 100, 100);
  return render(
    <HoverPreview data={data} anchorRect={anchor} lastSeenAt={lastSeenAt} />,
  );
}

describe("HoverPreview 按内容属性取词", () => {
  it("照片相册说浏览，不出现阅读与阅读进度", () => {
    renderPreview(
      card({ contentKind: "photo", progress: { index: 3, total: 12 } }),
      "2024-05-01T00:00:00Z",
    );

    expect(screen.getByText(/上次浏览/)).toBeInTheDocument();
    expect(screen.queryByText(/阅读/)).not.toBeInTheDocument();
    expect(screen.queryByText("阅读进度")).not.toBeInTheDocument();
  });

  it("漫画相册说阅读，并显示阅读进度", () => {
    renderPreview(
      card({ contentKind: "comic", progress: { index: 3, total: 12 } }),
      "2024-05-01T00:00:00Z",
    );

    expect(screen.getByText(/上次阅读/)).toBeInTheDocument();
    expect(screen.getByText("阅读进度")).toBeInTheDocument();
  });

  it("没看过时按侧给出不同说法", () => {
    const photo = renderPreview(card({ contentKind: "photo" }));
    expect(photo.getByText("尚未浏览")).toBeInTheDocument();
    photo.unmount();

    const comic = renderPreview(card({ contentKind: "comic" }));
    expect(comic.getByText("尚未阅读")).toBeInTheDocument();
  });

  it("封面计数单位跟着属性走：照片本、照片张、漫画卷", () => {
    const photo = renderPreview(
      card({ variant: "collection", contentKind: "photo", count: 3 }),
    );
    expect(photo.getByText("3 本")).toBeInTheDocument();
    photo.unmount();

    const comic = renderPreview(
      card({ variant: "collection", contentKind: "comic", count: 3 }),
    );
    expect(comic.getByText("3 卷")).toBeInTheDocument();
  });
});
