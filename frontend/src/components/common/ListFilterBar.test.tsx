import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ListFilterBar } from "./ListFilterBar";
import { useSearchStore } from "../../store/searchStore";
import { useAppModeStore } from "../../store/appModeStore";

beforeEach(() => {
  useSearchStore.getState().reset();
  useAppModeStore.setState({ preference: "photo" });
});

it("选择排序后恢复按钮焦点并更新排序", () => {
  render(<ListFilterBar totalCount={10} />);
  const trigger = screen.getByRole("button", { name: "排序" });
  trigger.focus();
  fireEvent.click(trigger);
  const option = screen.getByRole("button", { name: "按最近看" });
  option.focus();
  fireEvent.click(option);
  expect(useSearchStore.getState().sortBy).toBe("viewed");
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("button", { name: "按最近看" })).toBeNull();
});

it("Esc 取消后恢复按钮焦点并保留原排序", async () => {
  render(<ListFilterBar totalCount={10} />);
  const trigger = screen.getByRole("button", { name: "排序" });
  trigger.focus();
  fireEvent.click(trigger);
  const option = screen.getByRole("button", { name: "按最近看" });
  option.focus();
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  fireEvent.keyDown(option, { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(useSearchStore.getState().sortBy).toBe("name");
  expect(screen.queryByRole("button", { name: "按最近看" })).toBeNull();
});

it("离开排序区域时收起选项，保留新目标焦点", () => {
  render(
    <>
      <ListFilterBar totalCount={10} />
      <button type="button">外部操作</button>
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "排序" }));
  const option = screen.getByRole("button", { name: "按最近看" });
  option.focus();
  const outside = screen.getByRole("button", { name: "外部操作" });
  act(() => outside.focus());
  expect(screen.queryByRole("button", { name: "按最近看" })).toBeNull();
  expect(outside).toHaveFocus();
});

it("点击外部关闭选项且不恢复排序按钮焦点", async () => {
  render(
    <>
      <ListFilterBar totalCount={10} />
      <input aria-label="外部输入" />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "排序" }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const outside = screen.getByRole("textbox", { name: "外部输入" });
  fireEvent.mouseDown(outside);
  outside.focus();
  expect(screen.queryByRole("button", { name: "按最近看" })).toBeNull();
  expect(outside).toHaveFocus();
});

it("公开展开状态及当前选中的排序项", () => {
  render(<ListFilterBar totalCount={10} />);
  const trigger = screen.getByRole("button", { name: "排序" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  const options = screen.getByRole("group", { name: "排序选项" });
  expect(trigger).toHaveAttribute("aria-controls", options.id);
  expect(
    within(options).getByRole("button", { name: "按名称", pressed: true }),
  ).toBeInTheDocument();
  // 排序项：按名称 / 按张数 / 按最近改 / 按拍摄时间 / 按最近看。
  expect(
    within(options).getAllByRole("button", { pressed: false }),
  ).toHaveLength(4);
});

it("日期排序项跟着工作台说话：照片侧按拍摄时间，漫画侧按加入时间", () => {
  render(<ListFilterBar totalCount={10} />);
  fireEvent.click(screen.getByRole("button", { name: "排序" }));
  const photo = within(screen.getByRole("group", { name: "排序选项" }));
  expect(photo.getByRole("button", { name: "按拍摄时间" })).toHaveAttribute(
    "title",
    "按拍摄时间排序，没有拍摄时间的相册按文件修改时间",
  );
  expect(photo.queryByRole("button", { name: "按加入时间" })).toBeNull();

  // 换到漫画侧再摆一次：两次渲染各自独立，避免焦点跨实例漂移。
  cleanup();
  useAppModeStore.setState({ preference: "comic" });
  render(<ListFilterBar totalCount={10} />);
  fireEvent.click(screen.getByRole("button", { name: "排序" }));
  const comic = within(screen.getByRole("group", { name: "排序选项" }));
  expect(comic.getByRole("button", { name: "按加入时间" })).toHaveAttribute(
    "title",
    "按目录日期排序，没有目录日期时按文件修改时间",
  );
  expect(comic.queryByRole("button", { name: "按拍摄时间" })).toBeNull();
});

it("刚展开就卸载时不留下待注册的监听任务", () => {
  vi.useFakeTimers();
  const { unmount } = render(<ListFilterBar totalCount={10} />);
  try {
    fireEvent.click(screen.getByRole("button", { name: "排序" }));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});

it("未启用时最少页数只留漏斗按钮，点开后才出现输入框", () => {
  render(<ListFilterBar totalCount={10} />);
  // 0 本来就是「不过滤」，摆一个「≥ 0」在筛选条里读不出任何意思。
  expect(screen.queryByRole("spinbutton")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /最少/ }));
  const input = screen.getByRole("spinbutton");
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "12" } });
  fireEvent.blur(input);
  expect(useSearchStore.getState().minImageCount).toBe(12);
});

it("启用后显示当前阈值并可一键清除", () => {
  useSearchStore.getState().setMinImageCount(8);
  render(<ListFilterBar totalCount={10} />);
  expect(screen.getByRole("spinbutton")).toHaveValue(8);
  fireEvent.click(screen.getByRole("button", { name: "清除最小图数" }));
  expect(useSearchStore.getState().minImageCount).toBe(0);
  expect(screen.queryByRole("spinbutton")).toBeNull();
});
