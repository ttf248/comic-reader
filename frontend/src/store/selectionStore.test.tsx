import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { beforeEach, expect, it } from "vitest";
import {
  useSelectionScope,
  useSelectionStore,
  type SelectionItem,
} from "./selectionStore";
import { useSearchStore } from "./searchStore";

const item: SelectionItem = {
  id: "a_one",
  albumId: "a_one",
  title: "一本",
  imageCount: 3,
  contentKind: "comic",
};
beforeEach(() => {
  useSelectionStore.setState({
    scope: "",
    items: {},
    active: false,
    busy: false,
  });
  useSearchStore.getState().reset();
});

it("选择有界且整批失败不改变原选择，跨作用域清空", () => {
  const store = useSelectionStore.getState();
  store.ensureScope("one");
  store.start();
  store.toggle(item);
  expect(
    store.selectLoaded(
      Array.from({ length: 1001 }, (_, index) => ({
        ...item,
        id: `item-${index}`,
      })),
    ),
  ).toBe(false);
  expect(Object.keys(useSelectionStore.getState().items)).toEqual(["a_one"]);
  store.ensureScope("two");
  expect(useSelectionStore.getState().active).toBe(false);
  expect(useSelectionStore.getState().items).toEqual({});
});

function Scope() {
  useSelectionScope();
  const navigate = useNavigate();
  return <button onClick={() => navigate("/comic/favorites")}>换页</button>;
}
it("排序保留选择，筛选与页面导航清空选择", async () => {
  render(
    <MemoryRouter initialEntries={["/comic"]}>
      <Scope />
    </MemoryRouter>,
  );
  useSelectionStore.getState().start();
  useSelectionStore.getState().toggle(item);
  useSearchStore.getState().setSortBy("count");
  expect(useSelectionStore.getState().items[item.id]).toEqual(item);
  useSearchStore.getState().setQuery("新筛选");
  await waitFor(() => expect(useSelectionStore.getState().active).toBe(false));
  useSelectionStore.getState().start();
  useSelectionStore.getState().toggle(item);
  fireEvent.click(screen.getByText("换页"));
  expect(useSelectionStore.getState().items).toEqual({});
});

it("迟到的批量结果不清空新作用域，忙碌时禁止重复修改", () => {
  const store = useSelectionStore.getState();
  store.ensureScope("old");
  store.start();
  store.toggle(item);
  useSelectionStore.setState({ busy: true });
  expect(store.toggle(item)).toBe(false);
  store.ensureScope("new");
  store.finish("old");
  expect(useSelectionStore.getState().scope).toBe("new");
  expect(useSelectionStore.getState().busy).toBe(false);
});
