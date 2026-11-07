import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import HoverPreview from "./HoverPreview";
import type { CardData } from "../album/AlbumCard";

// 照片相册的预览会去取这一本的前几张实拍。这组用例只关心措辞与
// 单位，媒体请求直接置空（取不到就退回封面）。
const mediaState: { items: { id: string; name: string; kind: string }[] } = {
  items: [],
};
vi.mock("../../hooks/useLibrary", () => ({
  useAlbumMedia: () => ({
    data: mediaState.items.length
      ? { pages: [{ items: mediaState.items }] }
      : undefined,
  }),
}));

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

  it("确实没看过时按侧给出不同说法", () => {
    const photo = renderPreview(card({ contentKind: "photo" }), null);
    expect(photo.getByText("尚未浏览")).toBeInTheDocument();
    photo.unmount();

    const comic = renderPreview(card({ contentKind: "comic" }), null);
    expect(comic.getByText("尚未阅读")).toBeInTheDocument();
  });

  it("不知道上次浏览时间时不瞎说「尚未浏览」", () => {
    // 库里的列表（首页的最近加入、集合页…）不带浏览时间。
    // 那一行要是写成「尚未浏览」，明明刚看过的相册会被说成没看过。
    const view = renderPreview(card({ contentKind: "photo" }));
    expect(view.queryByText("尚未浏览")).not.toBeInTheDocument();
  });

  it("封面计数单位跟着属性走：照片本相册、照片张、漫画卷", () => {
    const photo = renderPreview(
      card({ variant: "collection", contentKind: "photo", count: 3 }),
    );
    expect(photo.getByText("3 本相册")).toBeInTheDocument();
    photo.unmount();

    const comic = renderPreview(
      card({ variant: "collection", contentKind: "comic", count: 3 }),
    );
    expect(comic.getByText("3 卷")).toBeInTheDocument();
  });

  // 漫画卷的名字只写「第1卷」：预览里要说得清这一卷属于哪部作品。
  it("漫画卷的预览在卷名上方标出所属作品", () => {
    renderPreview(
      card({
        title: "第1卷",
        contentKind: "comic",
        parentName: "星海漫步",
      }),
    );

    expect(screen.getByText("星海漫步")).toBeInTheDocument();
    expect(screen.getByText("第1卷")).toBeInTheDocument();
  });

  it("照片相册的预览不标作品名", () => {
    renderPreview(card({ parentName: "某个相册" }));

    expect(screen.queryByText("某个相册")).not.toBeInTheDocument();
  });

  it("照片相册的预览铺这一本的真实照片，而不只是放大封面", () => {
    mediaState.items = [
      { id: "f_1", name: "a.jpg", kind: "image" },
      { id: "f_2", name: "b.jpg", kind: "image" },
      { id: "f_3", name: "c.jpg", kind: "image" },
      { id: "f_4", name: "d.jpg", kind: "image" },
    ];
    const view = renderPreview(card({ contentKind: "photo" }));
    // 缩略图按文件 ID 请求，图片 alt 为空，用 src 判定即可。
    expect(view.container.ownerDocument.querySelectorAll("img").length).toBeGreaterThan(
      0,
    );
    expect(
      view.container.ownerDocument.querySelector('img[src*="f_1"]'),
    ).not.toBeNull();
    mediaState.items = [];
    view.unmount();
  });
});
