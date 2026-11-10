import { beforeEach, expect, it } from "vitest";
import {
  selectedPhotoEntries,
  usePhotoSelectionStore,
} from "./photoSelectionStore";

beforeEach(() => {
  usePhotoSelectionStore.setState({
    scope: "",
    active: false,
    busy: false,
    entries: {},
  });
});

it("换作用域就清空选择：上一本相册里勾的东西不该留到下一本", () => {
  const store = usePhotoSelectionStore.getState();
  store.ensureScope("album:a");
  store.start();
  store.toggle({ id: "f_1", name: "1.jpg" });

  usePhotoSelectionStore.getState().ensureScope("album:b");
  expect(usePhotoSelectionStore.getState().active).toBe(false);
  expect(Object.keys(usePhotoSelectionStore.getState().entries)).toHaveLength(0);
});

it("同一作用域内重复 ensureScope 不清空", () => {
  const store = usePhotoSelectionStore.getState();
  store.ensureScope("album:a");
  store.start();
  store.toggle({ id: "f_1", name: "1.jpg" });

  usePhotoSelectionStore.getState().ensureScope("album:a");
  expect(usePhotoSelectionStore.getState().active).toBe(true);
  expect(Object.keys(usePhotoSelectionStore.getState().entries)).toHaveLength(1);
});

it("勾选与取消勾选", () => {
  const store = usePhotoSelectionStore.getState();
  store.ensureScope("album:a");
  store.toggle({ id: "f_1", name: "1.jpg" });
  expect(usePhotoSelectionStore.getState().entries.f_1).toBeTruthy();

  usePhotoSelectionStore.getState().toggle({ id: "f_1", name: "1.jpg" });
  expect(usePhotoSelectionStore.getState().entries.f_1).toBeUndefined();
});

it("提交期间不允许改动选择", () => {
  const store = usePhotoSelectionStore.getState();
  store.ensureScope("album:a");
  store.setBusy(true);
  expect(store.toggle({ id: "f_1", name: "1.jpg" })).toBe(false);
  expect(store.clear()).toBeUndefined();
  expect(usePhotoSelectionStore.getState().entries.f_1).toBeUndefined();
});

it("退出选择清空已勾选的条目", () => {
  const store = usePhotoSelectionStore.getState();
  store.ensureScope("album:a");
  store.start();
  store.toggle({ id: "f_1", name: "1.jpg" });

  usePhotoSelectionStore.getState().clear();
  expect(usePhotoSelectionStore.getState().active).toBe(false);
  expect(Object.keys(usePhotoSelectionStore.getState().entries)).toHaveLength(0);
});

it("选中的条目带着做对比需要的字段", () => {
  const store = usePhotoSelectionStore.getState();
  store.ensureScope("album:a");
  store.toggle({
    id: "f_1",
    name: "1.jpg",
    albumId: "a_1",
    albumName: "旅行",
    kind: "image",
    width: 4000,
    height: 3000,
  });

  const entries = selectedPhotoEntries(usePhotoSelectionStore.getState().entries);
  expect(entries).toHaveLength(1);
  expect(entries[0].albumName).toBe("旅行");
  expect(entries[0].width).toBe(4000);
});
